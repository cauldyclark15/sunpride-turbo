import { observePush } from "../domains/integrity/detectors.js";
import { ambient, tx } from "@sunpride/db/client";
import {
  enforcePartnerOp,
  enforcePartnerPull,
} from "../domains/partners/boundary.js";
import { reauthorizeDevice, verifyDeviceProof } from "./devices.js";
import { ApiError, conflict, invalid } from "./errors.js";
import { publish as publishTopic } from "./realtime.js";
import { enqueue as enqueueJob } from "./jobs.js";
import { nextDayClose, scopeOf } from "./scope.js";
import {
  b64url,
  canonicalJson,
  isPlainObject,
  isUuid,
  safeEqual,
  sha256Hex,
  unb64url,
} from "./util.js";

/**
 * Mobile sync engine (contract §5, wire D4/D5).
 *
 * @typedef {import('./context.js').Actor} Actor
 * @typedef {{ clientOpId: string, opType: string, clientTime: number, dependsOn: string[], payload: Record<string, unknown> }} Operation
 * @typedef {{ entityId?: string|null, eventIds?: string[], movementId?: string|null }} AckPart
 * @typedef {{
 *   db: any, actor: Actor, device: any, app: string, op: Operation, payload: Record<string, unknown>, now: number,
 *   change: (entity: string, entityId: string, scopeKey: string, op?: 'upsert'|'tombstone') => Promise<number>,
 *   publish: (topic: string) => void, enqueue: (job: import('./context.js').JobSpec) => Promise<string|null>,
 *   reject: (code: string) => never,
 * }} OpCtx
 * @typedef {(ctx: OpCtx) => Promise<AckPart|void>|AckPart|void} OpHandler
 * @typedef {{ db: any, actor: Actor, device: any, app: string, params: any, limit: number, highWater: number,
 *   state: any, scope: Awaited<ReturnType<typeof scopeOf>>, now: number }} ProjectionCtx
 * @typedef {{
 *   params?: (params: any) => any,
 *   snapshot: (ctx: ProjectionCtx) => Promise<{ data: any, next: any }>|{ data: any, next: any },
 *   scopeKeys?: (ctx: ProjectionCtx) => Promise<string[]>|string[],
 *   entities?: string[],
 *   load?: (ctx: ProjectionCtx, entity: string, ids: string[]) => Promise<Map<string, any>>|Map<string, any>,
 *   leaseExpiresAt?: (ctx: ProjectionCtx) => number,
 * }} Projection
 */

export const MAX_OPS = 20;
export const MAX_LOCATION_OPS = 100;
export const MAX_SNAPSHOT_LIMIT = 100;
export const MAX_DELTA_LIMIT = 50;
export const PAGE_CURSOR_TTL_MS = 60 * 60 * 1000;
export const SINCE_CURSOR_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Closed per-op rejection codes (D5). */
export const OP_CODES = Object.freeze([
  "invalid_request",
  "invalid_plan",
  "out_of_scope",
  "dependency_missing",
  "invalid_transition",
  "call_open",
  "mcp_order",
  "wrong_date",
  "idempotency_conflict",
  "evidence_pending_review",
  "unsupported_operation",
  "load_not_posted",
  "stock_conflict",
  "mock_location_refused",
  "place_mismatch",
  "places_unavailable",
]);
/** Advisory lock making change_log seq order equal commit order. */
const CHANGE_LOCK = 4310002;

/** @type {Map<string, OpHandler>} */
const ops = new Map();
/** @type {Map<string,(db:any,actor:any,op:any)=>Promise<void>>} */
const opGuards = new Map();
/** SP-0169: hooks that run in their own transaction after a permanent per-op refusal (e.g. fiscal: record the
 * refused document number as spoiled so the series has no gap). Keyed by name so a re-install replaces, never doubles.
 * `applies` is a cheap synchronous check, so ordinary refusals never open another transaction.
 * @typedef {{applies:(op:any)=>boolean, run:(t:any,actor:any,device:any,op:any,code:string)=>Promise<any>}} RejectHook */
/** @type {Map<string,RejectHook>} */
const rejectHooks = new Map();
/** @param {string} name @param {RejectHook} hook */
export function registerRejectHook(name, hook) {
  rejectHooks.set(name, hook);
}
/** @type {Map<string, Projection>} */
const projections = new Map();

/** Per-op business refusal; becomes `{status:"rejected", code}` without failing the batch.
 * `retryable` marks a temporary refusal (nothing is stored; the device keeps the op and
 * sends it again later, e.g. address search unreachable while verifying a place). */
export class OpRejected extends Error {
  /** @param {string} code @param {boolean} [retryable] */
  constructor(code, retryable = false) {
    super(code);
    this.code = OP_CODES.includes(code) ? code : "invalid_request";
    this.retryable = retryable;
  }
}

/** Optional domain guard runs inside the transaction before receipt replay (F-223/F-613).
 * @param {string} opType @param {OpHandler} handler @param {(db:any,actor:any,op:any)=>Promise<void>} [guard] */
export function registerOp(opType, handler, guard) {
  if (ops.has(opType)) throw new Error(`op ${opType} already registered`);
  ops.set(opType, handler);
  if (guard) opGuards.set(opType, guard);
}

/** @param {string} name @param {Projection|Projection['snapshot']} handler */
export function registerProjection(name, handler) {
  if (projections.has(name))
    throw new Error(`projection ${name} already registered`);
  projections.set(
    name,
    typeof handler === "function" ? { snapshot: handler } : handler,
  );
}

/** Test/reset helper. */
export function clearSyncRegistry() {
  ops.clear();
  opGuards.clear();
  rejectHooks.clear();
  projections.clear();
}

/**
 * Append a change row. Call it LAST in the writing transaction: it takes a transaction-level
 * advisory lock so change_log seq order matches commit order (delta readers never skip rows).
 * @param {any} db transaction handle (a pool handle resolves to the open transaction on this path)
 * @param {{ entity: string, entityId: string, scopeKey: string, op?: 'upsert'|'tombstone' }} change
 * @returns {Promise<number>} seq (the entity revision)
 */
export async function recordChange(db, change) {
  // SP-0169: inside a transaction this path holds, record on it.
  const t = ambient(db);
  await t`select pg_advisory_xact_lock(${CHANGE_LOCK})`;
  const [row] = await t`
    insert into change_log (entity, entity_id, scope_key, op)
    values (${change.entity}, ${change.entityId}, ${change.scopeKey}, ${change.op ?? "upsert"})
    returning seq`;
  return Number(row.seq);
}

/** @param {any} db */
async function highWater(db) {
  // Waiting on the change lock means no writer holds an unpublished seq below the answer.
  return await tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(${CHANGE_LOCK})`;
    const [row] =
      await t`select coalesce(max(seq), 0)::bigint as hw from change_log`;
    return Number(row.hw);
  });
}

// ---------------------------------------------------------------------------- cursors

/** @param {Record<string,string|undefined>} env */
function cursorSecret(env) {
  const secret = env.SYNC_CURSOR_SECRET;
  if (!secret || secret.length < 32)
    throw new ApiError(
      "sync_unavailable",
      503,
      "Sync is not configured",
      false,
      { action: "hold" },
    );
  return secret;
}

/** @param {string} secret @param {string} body */
function mac(secret, body) {
  const h = new Bun.CryptoHasher("sha256", secret);
  h.update(body);
  return b64url(new Uint8Array(h.digest()));
}

/** @param {string} secret @param {Record<string, unknown>} payload */
export function signCursor(secret, payload) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${mac(secret, body)}`;
}

const cursorInvalid = () =>
  new ApiError("cursor_invalid", 409, "Sync cursor rejected", false, {
    action: "rebootstrap",
  });

/**
 * @param {string} secret @param {unknown} token @param {'page'|'since'} kind
 * @param {{ sub: string, dev: string, app: string, fp: string, rq: string }} binding
 */
export function readCursor(secret, token, kind, binding) {
  if (typeof token !== "string" || token.length > 8192) throw cursorInvalid();
  const parts = token.split(".");
  if (parts.length !== 2) throw cursorInvalid();
  const [body, sig] = /** @type {[string, string]} */ (parts);
  /** @type {any} */
  let value = null;
  try {
    const sigBytes = unb64url(sig);
    // Canonical MAC spelling only: unused low bits of the last char must not verify twice.
    if (
      sigBytes.length !== 32 ||
      b64url(sigBytes) !== sig ||
      !safeEqual(mac(secret, body), sig)
    )
      throw new Error("mac");
    value = JSON.parse(new TextDecoder().decode(unb64url(body)));
  } catch {
    throw cursorInvalid();
  }
  if (!isPlainObject(value)) throw cursorInvalid();
  /** @type {any} */
  const c = value;
  if (c.v !== 2 || c.k !== kind) throw cursorInvalid();
  if (
    c.sub !== binding.sub ||
    c.dev !== binding.dev ||
    c.app !== binding.app ||
    c.rq !== binding.rq
  )
    throw cursorInvalid();
  if (c.fp !== binding.fp)
    throw new ApiError("scope_changed", 409, "Your access changed", false, {
      action: "rebootstrap",
    });
  if (!Number.isSafeInteger(c.exp) || c.exp <= Date.now())
    throw new ApiError("cursor_expired", 409, "Sync cursor expired", false, {
      action: "rebootstrap",
    });
  return c;
}

// ---------------------------------------------------------------------------- push

/** @param {unknown} op @returns {op is Operation} */
function validOperation(op) {
  return (
    isPlainObject(op) &&
    isUuid(op.clientOpId) &&
    typeof op.opType === "string" &&
    /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/.test(op.opType) &&
    op.opType.length <= 64 &&
    Number.isSafeInteger(op.clientTime) &&
    /** @type {number} */ (op.clientTime) >= 0 &&
    Array.isArray(op.dependsOn) &&
    op.dependsOn.length <= MAX_LOCATION_OPS &&
    op.dependsOn.every(isUuid) &&
    isPlainObject(op.payload)
  );
}

/** @param {any} op @param {string} status @param {string|null} code @param {any} ack @param {boolean} [retryable] */
const result = (op, status, code, ack, retryable = false) => ({
  clientOpId:
    isPlainObject(op) && typeof op.clientOpId === "string"
      ? op.clientOpId
      : null,
  opType: isPlainObject(op) && typeof op.opType === "string" ? op.opType : null,
  status,
  code,
  retryable,
  ack,
});

/** @param {unknown} e */
const isUniqueViolation = (e) => {
  const err = /** @type {any} */ (e);
  return (
    err &&
    (err.errno === "23505" ||
      err.code === "23505" ||
      /duplicate key/.test(String(err.message)))
  );
};

/** @param {any} t @param {Actor} actor @param {string} deviceId @param {string} clientOpId */
async function findReceipt(t, actor, deviceId, clientOpId) {
  const rows = await t`
    select payload_hash, status, code, ack from op_receipts
    where subject = ${actor.subject} and device_id = ${deviceId} and client_op_id = ${clientOpId}`;
  return rows[0] ?? null;
}

/** @param {any} v */
const asJson = (v) => (typeof v === "string" ? JSON.parse(v) : v);

/**
 * @param {import('./context.js').Ctx} ctx @param {Operation} op @param {string} deviceId
 */
async function applyOne(ctx, op, deviceId) {
  const handler = ops.get(op.opType);
  if (!handler) return result(op, "rejected", "unsupported_operation", null);
  const hash = sha256Hex(
    canonicalJson({
      opType: op.opType,
      payload: op.payload,
      clientTime: op.clientTime,
      dependsOn: op.dependsOn,
    }),
  );
  /** @type {string[]} */
  const topics = [];
  const attempt = () =>
    tx(ctx.db, async (t) => {
      // D2: reauthorize person, role, scope, device and binding before replay lookup.
      const { actor, device } = await reauthorizeDevice(
        t,
        /** @type {Actor} */ (ctx.actor),
        deviceId,
      );
      await enforcePartnerOp(t, actor, op);
      await opGuards.get(op.opType)?.(t, actor, op);
      const existing = await findReceipt(t, actor, deviceId, op.clientOpId);
      if (existing) {
        if (existing.payload_hash !== hash)
          return result(op, "rejected", "idempotency_conflict", null);
        return result(op, "duplicate", null, asJson(existing.ack));
      }
      for (const dep of op.dependsOn) {
        const r = await t`
          select 1 from op_receipts where subject = ${actor.subject} and device_id = ${deviceId}
            and client_op_id = ${dep} and status = 'applied'`;
        if (!r.length) throw new OpRejected("dependency_missing");
      }
      const now = Date.now();
      /** @type {OpCtx} */
      const opCtx = {
        db: t,
        actor,
        device,
        app: device.app,
        op,
        payload: op.payload,
        now,
        change: (entity, entityId, scopeKey, kind = "upsert") =>
          recordChange(t, { entity, entityId, scopeKey, op: kind }),
        publish: (topic) => void topics.push(topic),
        enqueue: (job) => enqueueJob(t, job),
        reject: (code) => {
          throw new OpRejected(code);
        },
      };
      const part = (await handler(opCtx)) ?? {};
      const [{ st }] =
        await t`select (extract(epoch from now()) * 1000)::bigint as st`;
      const ack = {
        entityId: part.entityId ?? null,
        eventIds: Array.isArray(part.eventIds) ? part.eventIds : [],
        movementId: part.movementId ?? null,
        serverTime: Number(st),
      };
      await t`
        insert into op_receipts (subject, device_id, client_op_id, payload_hash, op_type, status, ack)
        values (${actor.subject}, ${deviceId}, ${op.clientOpId}, ${hash}, ${op.opType}, 'applied', ${ack})`;
      return result(op, "applied", null, ack);
    });
  try {
    const r = await attempt();
    for (const topic of topics) await publishTopic(ctx.db, topic);
    return r;
  } catch (e) {
    if (e instanceof OpRejected) {
      const r = result(op, "rejected", e.code, null, e.retryable);
      const hooks = e.retryable
        ? []
        : [...rejectHooks.values()].filter((h) => h.applies(op));
      if (!hooks.length) return r;
      // SP-0169: a permanent refusal is final for this op; let domains clean up after it (outside the rolled-back tx).
      /** @type {Record<string,any>} */ const extra = {};
      for (const hook of hooks)
        try {
          const out = await tx(ctx.db, async (/** @type {any} */ t) => {
            const { actor, device } = await reauthorizeDevice(
              t,
              /** @type {Actor} */ (ctx.actor),
              deviceId,
            );
            return hook.run(t, actor, device, op, e.code);
          });
          if (isPlainObject(out)) Object.assign(extra, out);
        } catch (err) {
          console.error("reject hook failed", op.opType, err);
        }
      return { ...r, ...extra };
    }
    if (isUniqueViolation(e)) {
      // A concurrent request with the same clientOpId committed first: answer from its receipt.
      topics.length = 0;
      return await attempt();
    }
    throw e;
  }
}

/** @param {import('./context.js').Ctx} ctx */
async function push(ctx) {
  ctx.v2 = true;
  const body = ctx.body;
  if (!isPlainObject(body) || body.version !== 2)
    throw new ApiError(
      "version_unsupported",
      426,
      "Protocol version 2 required",
      false,
      { action: "update" },
    );
  if (!Array.isArray(body.operations) || body.operations.length === 0)
    throw invalid("operations must be a non-empty array");
  const allPings = body.operations.every(
    (o) => isPlainObject(o) && o.opType === "location.record",
  );
  const max = allPings ? MAX_LOCATION_OPS : MAX_OPS;
  if (body.operations.length > max)
    throw invalid(`At most ${max} operations per batch`);
  const device = await verifyDeviceProof(ctx);
  const actor = /** @type {Actor} */ (ctx.actor);
  const scope = await scopeOf(ctx.db, actor);
  if (body.scopeId !== scope.id)
    throw conflict("Your scope changed", "scope_changed");
  /** @type {Array<ReturnType<typeof result>>} */
  const results = [];
  for (const op of body.operations) {
    if (!validOperation(op)) {
      results.push(result(op, "rejected", "invalid_request", null));
      continue;
    }
    results.push(await applyOne(ctx, op, device.id));
  }
  // F-221: outside rolled-back business transactions, but never let malformed clean requests dilute the rate.
  await observePush(
    ctx,
    body.operations.filter(
      (/** @type {any} */ op, /** @type {number} */ index) => {
        const outcome = results[index];
        return (
          validOperation(op) &&
          outcome &&
          (["applied", "duplicate"].includes(outcome.status) ||
            outcome.code === "mock_location_refused")
        );
      },
    ),
  );
  return { version: 2, serverTime: Date.now(), results };
}

// ---------------------------------------------------------------------------- pull

/** @param {unknown} scopes */
function readScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 8)
    throw invalid("scopes must be 1-8 entries");
  return scopes.map((s) => {
    if (
      !isPlainObject(s) ||
      typeof s.scopeId !== "string" ||
      typeof s.projection !== "string"
    )
      throw invalid("Invalid scope entry");
    const handler = projections.get(s.projection);
    if (!handler)
      throw invalid(
        `Unknown projection ${s.projection}`,
        "unsupported_projection",
      );
    const raw = s.params === undefined ? {} : s.params;
    if (!isPlainObject(raw)) throw invalid("params must be an object");
    const params = handler.params ? handler.params(raw) : raw;
    return {
      scopeId: s.scopeId,
      projection: s.projection,
      rawParams: raw,
      params,
      handler,
    };
  });
}

/** @param {import('./context.js').Ctx} ctx */
async function pull(ctx) {
  ctx.v2 = true;
  const secret = cursorSecret(ctx.env); // fail closed before any proof/nonce work
  const body = ctx.body;
  if (!isPlainObject(body) || body.version !== 2)
    throw new ApiError(
      "version_unsupported",
      426,
      "Protocol version 2 required",
      false,
      { action: "update" },
    );
  const device = await verifyDeviceProof(ctx);
  const actor = /** @type {Actor} */ (ctx.actor);
  const scope = await scopeOf(ctx.db, actor);
  const scopes = readScopes(body.scopes);
  for (const s of scopes)
    if (s.scopeId !== scope.id)
      throw conflict("Your scope changed", "scope_changed");
  if (
    body.since !== null &&
    body.since !== undefined &&
    body.pageCursor !== null &&
    body.pageCursor !== undefined
  )
    throw invalid("Send since or pageCursor, not both");
  const isDelta = body.since !== null && body.since !== undefined;
  const partner = await enforcePartnerPull(ctx.db, actor, scopes, isDelta);
  const maxLimit = isDelta ? MAX_DELTA_LIMIT : MAX_SNAPSHOT_LIMIT;
  const rawLimit = /** @type {unknown} */ (body.limit);
  let limit = maxLimit;
  if (rawLimit !== undefined && rawLimit !== null) {
    if (
      typeof rawLimit !== "number" ||
      !Number.isSafeInteger(rawLimit) ||
      rawLimit < 1
    )
      throw invalid("Invalid limit");
    limit = Math.min(rawLimit, maxLimit);
  }
  const binding = {
    sub: actor.subject,
    dev: device.id,
    app: device.app,
    fp: scope.fingerprint,
    rq: sha256Hex(
      canonicalJson(scopes.map((s) => [s.scopeId, s.projection, s.rawParams])),
    ),
  };
  const now = Date.now();
  /** @param {typeof scopes[number]} s @param {any} state @param {number} hw @returns {ProjectionCtx} */
  const pctx = (s, state, hw) => ({
    db: ctx.db,
    actor,
    device,
    app: device.app,
    params: s.params,
    limit,
    highWater: hw,
    state,
    scope,
    now,
  });
  /** @param {typeof scopes[number]} s @param {ProjectionCtx} p */
  const leaseOf = (s, p) =>
    Math.min(
      partner?.leaseExpiresAt ?? Number.MAX_SAFE_INTEGER,
      s.handler.leaseExpiresAt
        ? s.handler.leaseExpiresAt(p)
        : nextDayClose(now),
    );
  /** @param {typeof scopes[number]} s @param {ProjectionCtx} p @param {'snapshot'|'delta'} mode @param {boolean} complete @param {any} data @param {any[]} changes */
  const bundle = (s, p, mode, complete, data, changes) => {
    const lease = leaseOf(s, p);
    return {
      scopeId: s.scopeId,
      scopeFingerprint: scope.fingerprint,
      projection: s.projection,
      params: s.rawParams,
      mode,
      complete,
      authorization: {
        grantId: crypto.randomUUID(),
        epoch: scope.epoch,
        expiresAt: lease,
      },
      offlineLease: { expiresAt: lease },
      data,
      changes,
    };
  };

  if (isDelta) {
    const c = readCursor(secret, body.since, "since", binding);
    if (
      !Array.isArray(c.pos) ||
      c.pos.length !== scopes.length ||
      !c.pos.every(
        (/** @type {unknown} */ n) =>
          Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0,
      )
    )
      throw cursorInvalid();
    const hw = await highWater(ctx.db);
    const bundles = [];
    const pos = [...c.pos];
    let hasMore = false;
    for (let i = 0; i < scopes.length; i++) {
      const s = /** @type {typeof scopes[number]} */ (scopes[i]);
      const p = pctx(s, null, hw);
      const keys = s.handler.scopeKeys
        ? await s.handler.scopeKeys(p)
        : [`unit:${actor.orgUnitId ?? "none"}`, `profile:${actor.profileId}`];
      const entities = s.handler.entities ?? null;
      const from = /** @type {number} */ (pos[i]);
      const rows = entities
        ? await ctx.db`
            select seq, entity, entity_id, op from change_log
            where seq > ${from} and seq <= ${hw} and scope_key in ${ctx.db(keys)} and entity in ${ctx.db(entities)}
            order by seq limit ${limit + 1}`
        : await ctx.db`
            select seq, entity, entity_id, op from change_log
            where seq > ${from} and seq <= ${hw} and scope_key in ${ctx.db(keys)}
            order by seq limit ${limit + 1}`;
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      hasMore ||= more;
      pos[i] = more ? Number(page[page.length - 1].seq) : hw;
      /** @type {Map<string, Set<string>>} */
      const upserts = new Map();
      for (const r of page)
        if (r.op === "upsert") {
          const set = upserts.get(r.entity) ?? new Set();
          set.add(r.entity_id);
          upserts.set(r.entity, set);
        }
      /** @type {Map<string, Map<string, any>>} */
      const values = new Map();
      for (const [entity, ids] of upserts)
        values.set(
          entity,
          s.handler.load
            ? await s.handler.load(p, entity, [...ids])
            : new Map([...ids].map((id) => [id, { id }])),
        );
      const changes = page.map((/** @type {any} */ r) => {
        const value =
          r.op === "upsert"
            ? values.get(r.entity)?.get(r.entity_id)
            : undefined;
        const visible = value !== undefined && value !== null;
        return {
          entity: r.entity,
          id: r.entity_id,
          revision: Number(r.seq),
          op: visible ? "upsert" : "tombstone",
          value: visible ? value : null,
        };
      });
      bundles.push(bundle(s, p, "delta", true, null, changes));
    }
    return {
      version: 2,
      serverTime: Date.now(),
      snapshotId: null,
      nextPageCursor: null,
      nextCursor: signCursor(secret, {
        v: 2,
        k: "since",
        ...binding,
        pos,
        exp: Date.now() + SINCE_CURSOR_TTL_MS,
      }),
      hasMore,
      bundles,
    };
  }

  /** @type {{ hw: number, sid: string, st: Array<{ s: any, d: boolean }> }} */
  let snap;
  if (body.pageCursor !== null && body.pageCursor !== undefined) {
    const c = readCursor(secret, body.pageCursor, "page", binding);
    if (
      !Number.isSafeInteger(c.hw) ||
      !Array.isArray(c.st) ||
      c.st.length !== scopes.length ||
      typeof c.sid !== "string"
    )
      throw cursorInvalid();
    snap = { hw: c.hw, sid: c.sid, st: c.st };
  } else {
    snap = {
      hw: await highWater(ctx.db),
      sid: crypto.randomUUID(),
      st: scopes.map(() => ({ s: null, d: false })),
    };
  }
  const bundles = [];
  for (let i = 0; i < scopes.length; i++) {
    const s = /** @type {typeof scopes[number]} */ (scopes[i]);
    const st = /** @type {{ s: any, d: boolean }} */ (snap.st[i]);
    if (st.d) continue;
    const p = pctx(s, st.s, snap.hw);
    const page = await s.handler.snapshot(p);
    const next = page.next ?? null;
    snap.st[i] = { s: next, d: next === null };
    bundles.push(bundle(s, p, "snapshot", next === null, page.data, []));
  }
  const hasMore = snap.st.some((x) => !x.d);
  // Every bundle of a multi-page snapshot is complete only on the final page.
  if (hasMore) for (const b of bundles) b.complete = false;
  return {
    version: 2,
    serverTime: Date.now(),
    snapshotId: snap.sid,
    nextPageCursor: hasMore
      ? signCursor(secret, {
          v: 2,
          k: "page",
          ...binding,
          hw: snap.hw,
          sid: snap.sid,
          st: snap.st,
          exp: Date.now() + PAGE_CURSOR_TTL_MS,
        })
      : null,
    nextCursor: hasMore
      ? null
      : signCursor(secret, {
          v: 2,
          k: "since",
          ...binding,
          pos: scopes.map(() => snap.hw),
          exp: Date.now() + SINCE_CURSOR_TTL_MS,
        }),
    hasMore,
    bundles,
  };
}

/** @param {import('./router.js').Router} router */
export function installSync(router) {
  router.post("/api/sync/pull", pull, { v2: true });
  router.post("/api/sync/push", push, { v2: true });
}
