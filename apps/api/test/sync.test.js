import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  recordChange,
  registerOp,
  registerProjection,
} from "../src/core/sync.js";
import {
  boundDevice,
  profileStore,
  signedPost,
  startHarness,
} from "./harness.js";

/** @type {import('./harness.js').Harness} */
let h;
/** @type {ReturnType<typeof profileStore>} */
let profiles;
let visitCalls = 0;
const ITEMS = ["a", "b", "c", "d", "e"];

beforeAll(async () => {
  h = await startHarness();
  profiles = profileStore(h);
  registerOp("test.visit", async (ctx) => {
    visitCalls++;
    const id = /** @type {string} */ (ctx.payload.clientVisitId);
    await ctx.change("visit", id, `unit:${ctx.actor.orgUnitId}`);
    if (ctx.payload.reject) ctx.reject(String(ctx.payload.reject));
    return { entityId: id, eventIds: [`ev-${id}`] };
  });
  registerOp("location.record", () => ({ entityId: null }));
  registerProjection("test.bundle", {
    params: (p) => {
      if (typeof p.dayFrom !== "string") throw new Error("dayFrom required");
      return p;
    },
    snapshot: (ctx) => {
      const start = ctx.state ?? 0;
      const rows = ITEMS.slice(start, start + ctx.limit);
      const next = start + ctx.limit < ITEMS.length ? start + ctx.limit : null;
      return { data: { dayFrom: ctx.params.dayFrom, rows }, next };
    },
    entities: ["visit"],
    load: (_ctx, _entity, ids) =>
      new Map(
        ids
          .filter((id) => !id.startsWith("gone"))
          .map((id) => [id, { id, state: "checked-in" }]),
      ),
  });
});
afterAll(async () => {
  await h?.close();
});

/** @param {Awaited<ReturnType<typeof boundDevice>>} d @param {any[]} operations */
const pushBody = (d, operations, scopeId = d.profile.orgUnitId) => ({
  version: 2,
  app: d.app,
  deviceId: d.deviceId,
  scopeId,
  operations,
});
/** @param {Record<string, unknown>} payload @param {Partial<{clientOpId: string, dependsOn: string[], opType: string}>} [o] */
const op = (payload, o = {}) => ({
  clientOpId: o.clientOpId ?? crypto.randomUUID(),
  opType: o.opType ?? "test.visit",
  clientTime: 1792368000000,
  dependsOn: o.dependsOn ?? [],
  payload,
});
/** @param {Awaited<ReturnType<typeof boundDevice>>} d */
const who = (d) => ({ access: d.access, deviceId: d.deviceId, key: d.key });

describe("push engine", () => {
  test("applied, then duplicate with the original ack, then idempotency_conflict", async () => {
    const d = await boundDevice(h, profiles);
    const visitId = crypto.randomUUID();
    const first = op({ clientVisitId: visitId });
    const r1 = await signedPost(
      h,
      who(d),
      "/api/sync/push",
      pushBody(d, [first]),
    );
    expect(r1.res.status).toBe(200);
    expect(Object.keys(r1.body).sort()).toEqual([
      "results",
      "serverTime",
      "version",
    ]);
    const res1 = r1.body.results[0];
    expect(Object.keys(res1).sort()).toEqual([
      "ack",
      "clientOpId",
      "code",
      "opType",
      "retryable",
      "status",
    ]);
    expect(res1).toMatchObject({
      clientOpId: first.clientOpId,
      opType: "test.visit",
      status: "applied",
      code: null,
      retryable: false,
    });
    expect(res1.ack).toMatchObject({
      entityId: visitId,
      eventIds: [`ev-${visitId}`],
      movementId: null,
    });
    expect(Number.isSafeInteger(res1.ack.serverTime)).toBe(true);
    const calls = visitCalls;

    await Bun.sleep(5);
    const r2 = await signedPost(
      h,
      who(d),
      "/api/sync/push",
      pushBody(d, [first]),
    );
    expect(r2.body.results[0]).toEqual({ ...res1, status: "duplicate" });
    expect(visitCalls).toBe(calls); // handler did not run again

    const changed = { ...first, payload: { clientVisitId: visitId, extra: 1 } };
    const r3 = await signedPost(
      h,
      who(d),
      "/api/sync/push",
      pushBody(d, [changed]),
    );
    expect(r3.body.results[0]).toEqual({
      clientOpId: first.clientOpId,
      opType: "test.visit",
      status: "rejected",
      code: "idempotency_conflict",
      retryable: false,
      ack: null,
    });
    const receipts =
      await h.db`select count(*)::int as n from op_receipts where client_op_id = ${first.clientOpId}`;
    expect(receipts[0].n).toBe(1);
    const changes =
      await h.db`select count(*)::int as n from change_log where entity_id = ${visitId}`;
    expect(changes[0].n).toBe(1);
  });

  test("a per-op rejection does not fail the batch and leaves no writes", async () => {
    const d = await boundDevice(h, profiles);
    const rejectedVisit = crypto.randomUUID();
    const a = op({ clientVisitId: crypto.randomUUID() });
    const b = op({ clientVisitId: rejectedVisit, reject: "call_open" });
    const c = op(
      { clientVisitId: crypto.randomUUID() },
      { dependsOn: [a.clientOpId] },
    );
    const dep = op(
      { clientVisitId: crypto.randomUUID() },
      { dependsOn: [b.clientOpId] },
    );
    const unknown = op({}, { opType: "nope.unknown" });
    const malformed = {
      clientOpId: "not-a-uuid",
      opType: "test.visit",
      clientTime: 1,
      dependsOn: [],
      payload: {},
    };
    const r = await signedPost(
      h,
      who(d),
      "/api/sync/push",
      pushBody(d, [a, b, c, dep, unknown, malformed]),
    );
    expect(r.res.status).toBe(200);
    expect(
      r.body.results.map((/** @type {any} */ x) => [x.status, x.code]),
    ).toEqual([
      ["applied", null],
      ["rejected", "call_open"],
      ["applied", null],
      ["rejected", "dependency_missing"],
      ["rejected", "unsupported_operation"],
      ["rejected", "invalid_request"],
    ]);
    const leaked =
      await h.db`select count(*)::int as n from change_log where entity_id = ${rejectedVisit}`;
    expect(leaked[0].n).toBe(0);
    const receipt =
      await h.db`select count(*)::int as n from op_receipts where client_op_id = ${b.clientOpId}`;
    expect(receipt[0].n).toBe(0);
  });

  test("21 business ops are refused; 100 location pings are allowed, 101 are not", async () => {
    const d = await boundDevice(h, profiles);
    const many = Array.from({ length: 21 }, () =>
      op({ clientVisitId: crypto.randomUUID() }),
    );
    const r = await signedPost(h, who(d), "/api/sync/push", pushBody(d, many));
    expect(r.res.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_request");
    const none =
      await h.db`select count(*)::int as n from op_receipts where device_id = ${d.deviceId}`;
    expect(none[0].n).toBe(0);

    const pings = Array.from({ length: 100 }, () =>
      op({ lat: 1 }, { opType: "location.record" }),
    );
    const ok = await signedPost(
      h,
      who(d),
      "/api/sync/push",
      pushBody(d, pings),
    );
    expect(ok.res.status).toBe(200);
    expect(ok.body.results.length).toBe(100);
    expect(ok.body.results.map((/** @type {any} */ x) => x.clientOpId)).toEqual(
      pings.map((p) => p.clientOpId),
    );
    const tooMany = [...pings, op({ lat: 1 }, { opType: "location.record" })];
    const no = await signedPost(
      h,
      who(d),
      "/api/sync/push",
      pushBody(d, tooMany),
    );
    expect(no.res.status).toBe(400);
    const mixed = [
      ...pings.slice(0, 20),
      op({ clientVisitId: crypto.randomUUID() }),
    ];
    const nomix = await signedPost(
      h,
      who(d),
      "/api/sync/push",
      pushBody(d, mixed),
    );
    expect(nomix.res.status).toBe(400);
  });

  test("wrong scopeId is a whole-request scope_changed", async () => {
    const d = await boundDevice(h, profiles);
    const r = await signedPost(
      h,
      who(d),
      "/api/sync/push",
      pushBody(
        d,
        [op({ clientVisitId: crypto.randomUUID() })],
        crypto.randomUUID(),
      ),
    );
    expect(r.res.status).toBe(409);
    expect(r.body.error).toEqual({
      code: "scope_changed",
      retryable: false,
      retryAfterMs: null,
      action: "hold",
    });
  });

  test("concurrent identical pushes apply once", async () => {
    const d = await boundDevice(h, profiles);
    const same = op({ clientVisitId: crypto.randomUUID() });
    const [x, y] = await Promise.all([
      signedPost(h, who(d), "/api/sync/push", pushBody(d, [same])),
      signedPost(h, who(d), "/api/sync/push", pushBody(d, [same])),
    ]);
    const statuses = [
      x.body.results[0].status,
      y.body.results[0].status,
    ].sort();
    expect(statuses).toEqual(["applied", "duplicate"]);
    expect(x.body.results[0].ack).toEqual(y.body.results[0].ack);
  });
});

describe("pull", () => {
  /** @param {Awaited<ReturnType<typeof boundDevice>>} d @param {{ since?: string|null, pageCursor?: string|null, limit?: number }} o */
  const pullBody = (d, o) => ({
    version: 2,
    app: d.app,
    deviceId: d.deviceId,
    since: o.since ?? null,
    pageCursor: o.pageCursor ?? null,
    scopes: [
      {
        scopeId: d.profile.orgUnitId,
        projection: "test.bundle",
        params: { dayFrom: "2026-10-19" },
      },
    ],
    limit: o.limit ?? 2,
  });

  test("snapshot pages then a final cursor; delta after a change_log row; tamper rejected", async () => {
    const d = await boundDevice(h, profiles);
    const p1 = await signedPost(h, who(d), "/api/sync/pull", pullBody(d, {}));
    expect(p1.res.status).toBe(200);
    expect(Object.keys(p1.body).sort()).toEqual([
      "bundles",
      "hasMore",
      "nextCursor",
      "nextPageCursor",
      "serverTime",
      "snapshotId",
      "version",
    ]);
    expect(p1.body.hasMore).toBe(true);
    expect(p1.body.nextCursor).toBeNull();
    expect(typeof p1.body.nextPageCursor).toBe("string");
    const b1 = p1.body.bundles[0];
    expect(Object.keys(b1).sort()).toEqual(
      [
        "authorization",
        "changes",
        "complete",
        "data",
        "mode",
        "offlineLease",
        "params",
        "projection",
        "scopeFingerprint",
        "scopeId",
      ].sort(),
    );
    expect(b1).toMatchObject({
      mode: "snapshot",
      complete: false,
      changes: [],
      data: { dayFrom: "2026-10-19", rows: ["a", "b"] },
    });
    expect(Object.keys(b1.authorization).sort()).toEqual([
      "epoch",
      "expiresAt",
      "grantId",
    ]);

    const p2 = await signedPost(
      h,
      who(d),
      "/api/sync/pull",
      pullBody(d, { pageCursor: p1.body.nextPageCursor }),
    );
    expect(p2.body.snapshotId).toBe(p1.body.snapshotId);
    expect(p2.body.bundles[0].data.rows).toEqual(["c", "d"]);
    const p3 = await signedPost(
      h,
      who(d),
      "/api/sync/pull",
      pullBody(d, { pageCursor: p2.body.nextPageCursor }),
    );
    expect(p3.body.bundles[0]).toMatchObject({
      complete: true,
      data: { rows: ["e"] },
    });
    expect(p3.body.hasMore).toBe(false);
    expect(p3.body.nextPageCursor).toBeNull();
    const since = p3.body.nextCursor;
    expect(typeof since).toBe("string");

    // Empty delta still yields a cursor.
    const empty = await signedPost(
      h,
      who(d),
      "/api/sync/pull",
      pullBody(d, { since }),
    );
    expect(empty.res.status).toBe(200);
    expect(empty.body).toMatchObject({
      snapshotId: null,
      nextPageCursor: null,
      hasMore: false,
    });
    expect(empty.body.bundles[0]).toMatchObject({
      mode: "delta",
      complete: true,
      data: null,
      changes: [],
    });
    expect(typeof empty.body.nextCursor).toBe("string");

    const scopeKey = `unit:${d.profile.orgUnitId}`;
    const seen = await tx(h.db, (t) =>
      recordChange(t, { entity: "visit", entityId: "v-1", scopeKey }),
    );
    const gone = await tx(h.db, (t) =>
      recordChange(t, {
        entity: "visit",
        entityId: "gone-2",
        scopeKey,
        op: "tombstone",
      }),
    );
    await tx(h.db, (t) =>
      recordChange(t, {
        entity: "visit",
        entityId: "other-scope",
        scopeKey: "unit:someone-else",
      }),
    );
    await tx(h.db, (t) =>
      recordChange(t, {
        entity: "invoice",
        entityId: "wrong-entity",
        scopeKey,
      }),
    );
    const delta = await signedPost(
      h,
      who(d),
      "/api/sync/pull",
      pullBody(d, { since: empty.body.nextCursor }),
    );
    expect(delta.body.bundles[0].changes).toEqual([
      {
        entity: "visit",
        id: "v-1",
        revision: seen,
        op: "upsert",
        value: { id: "v-1", state: "checked-in" },
      },
      {
        entity: "visit",
        id: "gone-2",
        revision: gone,
        op: "tombstone",
        value: null,
      },
    ]);
    const after = await signedPost(
      h,
      who(d),
      "/api/sync/pull",
      pullBody(d, { since: delta.body.nextCursor }),
    );
    expect(after.body.bundles[0].changes).toEqual([]);

    // Delta paging: limit 1 over two rows.
    const paged = await signedPost(
      h,
      who(d),
      "/api/sync/pull",
      pullBody(d, { since: empty.body.nextCursor, limit: 1 }),
    );
    expect(paged.body.hasMore).toBe(true);
    expect(
      paged.body.bundles[0].changes.map((/** @type {any} */ c) => c.id),
    ).toEqual(["v-1"]);
    const paged2 = await signedPost(
      h,
      who(d),
      "/api/sync/pull",
      pullBody(d, { since: paged.body.nextCursor, limit: 1 }),
    );
    expect(
      paged2.body.bundles[0].changes.map((/** @type {any} */ c) => c.id),
    ).toEqual(["gone-2"]);

    // Tampered cursor (flip one body character) and swapped kinds.
    const [body, mac] = since.split(".");
    const flipped = `${body.slice(0, -1)}${body.endsWith("A") ? "B" : "A"}.${mac}`;
    const bad = await signedPost(
      h,
      who(d),
      "/api/sync/pull",
      pullBody(d, { since: flipped }),
    );
    expect(bad.res.status).toBe(409);
    expect(bad.body.error).toEqual({
      code: "cursor_invalid",
      retryable: false,
      retryAfterMs: null,
      action: "rebootstrap",
    });
    const badMac = await signedPost(
      h,
      who(d),
      "/api/sync/pull",
      pullBody(d, {
        since: `${body}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`,
      }),
    );
    expect(badMac.res.status).toBe(409);
    const wrongKind = await signedPost(
      h,
      who(d),
      "/api/sync/pull",
      pullBody(d, { since: p1.body.nextPageCursor }),
    );
    expect(wrongKind.body.error.code).toBe("cursor_invalid");

    // Another device's cursor is not accepted.
    const other = await boundDevice(h, profiles, {
      orgUnitId: d.profile.orgUnitId,
    });
    const foreign = await signedPost(
      h,
      who(other),
      "/api/sync/pull",
      pullBody(other, { since }),
    );
    expect(foreign.body.error.code).toBe("cursor_invalid");
  });

  test("missing secret fails closed", async () => {
    const d = await boundDevice(h, profiles);
    const saved = h.env.SYNC_CURSOR_SECRET;
    h.env.SYNC_CURSOR_SECRET = undefined;
    try {
      const r = await signedPost(h, who(d), "/api/sync/pull", pullBody(d, {}));
      expect(r.res.status).toBe(503);
      expect(r.body.error).toEqual({
        code: "sync_unavailable",
        retryable: false,
        retryAfterMs: null,
        action: "hold",
      });
      h.env.SYNC_CURSOR_SECRET = "too-short";
      const r2 = await signedPost(h, who(d), "/api/sync/pull", pullBody(d, {}));
      expect(r2.res.status).toBe(503);
    } finally {
      h.env.SYNC_CURSOR_SECRET = saved;
    }
  });

  test("unknown projection and wrong scope are typed refusals", async () => {
    const d = await boundDevice(h, profiles);
    const body = pullBody(d, {});
    body.scopes[0] = {
      scopeId: d.profile.orgUnitId,
      projection: "nope.bundle",
      params: { dayFrom: "2026-10-19" },
    };
    const r = await signedPost(h, who(d), "/api/sync/pull", body);
    expect(r.res.status).toBe(400);
    expect(r.body.error.code).toBe("unsupported_projection");
    const body2 = pullBody(d, {});
    body2.scopes[0] = {
      scopeId: crypto.randomUUID(),
      projection: "test.bundle",
      params: { dayFrom: "2026-10-19" },
    };
    const r2 = await signedPost(h, who(d), "/api/sync/pull", body2);
    expect(r2.res.status).toBe(409);
    expect(r2.body.error.code).toBe("scope_changed");
  });
});
