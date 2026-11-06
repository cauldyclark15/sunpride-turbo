import { tx } from "@sunpride/db/client";
import { ApiError, forbidden } from "../../core/errors.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { scopeFilterForActor } from "../org/scope.js";
import { currentActor } from "../van/access.js";
import {
  uuid,
  refuse,
  text,
  choice,
  date,
  today,
  integer,
  dayString,
} from "../van/model.js";
import { registerFor } from "./model.js";
import {
  CASH_KINDS,
  cashReasonsFor,
  CASH_KIND_LABELS,
  listMovements,
  recordCashMovement,
  expectedCash,
} from "./cash.js";
import {
  OVERRIDE_KINDS,
  listOverrides,
  listSupervisors,
  logOfficeOverride,
  setSupervisorPin,
  verifyOnline,
} from "./overrides.js";
import {
  generateZ,
  readingModel,
  readingPrintModel,
  zView,
} from "./readings.js";
import { loadTillDay } from "./till-days.js";

/** Office and supervisors only: expected cash and variance are not for the cashier being counted. @param {any} db @param {any} actor */
async function requireOffice(db, actor) {
  if (
    !roleHas(actor.role, "van.cash.approve") &&
    !roleHas(actor.role, "admin.manage")
  )
    throw forbidden("Supervisors and the office only");
}
/** @param {any} db @param {any} actor */
async function scopeIds(db, actor) {
  const scope = await scopeFilterForActor(db, actor);
  return {
    all: scope.unitIds === null,
    ids: scope.unitIds?.length
      ? scope.unitIds
      : ["00000000-0000-0000-0000-000000000000"],
  };
}
/** @param {any} p */
const money = (p) => (p == null ? null : String(p));

/** Till days, X/Z, cash movements, supervisor PINs, overrides (lane ZDAY). @param {any} router @param {any} platform */
export function installZday(router, platform) {
  /**
   * Idempotent office command, same pattern as the other storepos commands: one request key = one result.
   * @param {string} path @param {string} capability @param {(db:any, actor:any, body:any, c:any)=>Promise<any>} work
   * @param {string[]} [topics]
   */
  const command = (path, capability, work, topics = ["storepos", "van"]) =>
    router.post(`/api/v1/storepos/${path}`, async (/** @type {any} */ c) => {
      const body = c.body;
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new ApiError(
          "invalid_request",
          400,
          "Use an object command body",
        );
      const response = await tx(c.db, async (/** @type {any} */ db) => {
        const actor = await currentActor(db, c.actor);
        await requireCapability({ db, actor }, capability);
        await db`select set_config('sunpride.actor',${actor.userId},true)`;
        const key = uuid(body.requestKey),
          hash = sha256Hex(
            canonicalJson({ path, params: c.params ?? {}, body }),
          );
        await db`select pg_advisory_xact_lock(hashtextextended(${actor.profileId + key},0))`;
        const [old] =
          await db`select * from store_pos_commands where actor_profile_id=${actor.profileId} and request_key=${key}`;
        if (old) {
          if (old.payload_hash !== hash)
            throw new ApiError(
              "idempotency_conflict",
              409,
              "Request key was reused",
            );
          return old.response;
        }
        const result = await work(db, actor, body, c);
        await db`insert into store_pos_commands(actor_profile_id,request_key,payload_hash,response) values(${actor.profileId},${key},${hash},${result})`;
        await platform.recordChange(db, {
          entity: "storepos",
          entityId: result.id ?? result.dayId ?? key,
          scopeKey: `unit:${actor.orgUnitId}`,
        });
        if (result.bundleFor)
          await platform.recordChange(db, {
            entity: "van.bundle",
            entityId: result.bundleFor,
            scopeKey: `profile:${result.bundleFor}`,
          });
        return result;
      });
      for (const t of topics) c.publish(t);
      return response;
    });

  // ---- day-end ---------------------------------------------------------
  command(
    "days/:id/start-closing",
    "van.cash.approve",
    async (db, actor, _b, c) => {
      const day = await loadTillDay(db, uuid(c.params.id), true);
      const r = await registerFor(
        db,
        actor,
        day.register_id,
        "van.cash.approve",
      );
      if (day.status !== "open") refuse("This day is not open");
      const open = await openSessions(db, day.id);
      if (open.length)
        refuse(
          `Close ${open.length} open cashier session${open.length > 1 ? "s" : ""} first`,
        );
      await db`update store_till_days set status='closing',closing_at=now(),closing_by=${actor.profileId},updated_at=now() where id=${day.id}`;
      void r;
      return { id: day.id, dayId: day.id, status: "closing" };
    },
  );
  command("days/:id/reopen", "van.cash.approve", async (db, actor, b, c) => {
    const day = await loadTillDay(db, uuid(c.params.id), true);
    await registerFor(db, actor, day.register_id, "van.cash.approve");
    if (day.status !== "closing")
      refuse("Only a day waiting for its Z can be reopened");
    text(b.reason, 300, true);
    await db`update store_till_days set status='open',closing_at=null,closing_by=null,updated_at=now() where id=${day.id}`;
    return { id: day.id, dayId: day.id, status: "open" };
  });
  command("days/:id/z", "van.cash.approve", async (db, actor, _b, c) => {
    const day = await loadTillDay(db, uuid(c.params.id), true);
    const r = await registerFor(db, actor, day.register_id, "van.cash.approve");
    const readId = crypto.randomUUID();
    const z = await generateZ(db, r, actor, {
      dayId: day.id,
      readId,
      at: Date.now(),
    });
    await logOfficeOverride(db, r, actor, {
      kind: "z_reading",
      tillDayId: day.id,
      refType: "z_reading",
      refId: z.id,
      reason: "Z reading at the office",
    });
    return {
      id: z.id,
      dayId: day.id,
      readId,
      docNumber: z.docNumber,
      zCounter: z.zCounter,
      printModel: readingPrintModel(z.model),
    };
  });

  // ---- sessions --------------------------------------------------------
  command("sessions/force-close", "van.cash.approve", async (db, actor, b) => {
    const [s] =
      await db`select * from store_shifts where id=${uuid(b.sessionId)} for update`;
    if (!s) refuse("Choose a cashier session", "not_found");
    const r = await registerFor(db, actor, s.register_id, "van.cash.approve");
    if (s.cashier_id === actor.profileId)
      throw forbidden("A second person must close your session");
    const [closed] =
      await db`select 1 from store_shift_closures where shift_id=${s.id}`;
    if (closed) refuse("This session is already closed");
    const [day] =
      await db`select status from store_till_days where id=${s.till_day_id}`;
    if (day?.status === "z_done") refuse("This day already has its Z reading");
    const reason = text(b.reason, 300, true);
    const expected = await expectedCash(db, s.id);
    const declared = expected > 0n ? expected : 0n;
    const id = crypto.randomUUID();
    await db`insert into store_shift_closures(id,shift_id,declared_centavos,expected_centavos,variance_centavos,needs_review,closed_at,kind,forced_by,force_reason) values(${id},${s.id},${String(declared)},${String(expected)},0,true,now(),'forced',${actor.profileId},${reason})`;
    await logOfficeOverride(db, r, actor, {
      kind: "force_close",
      tillDayId: s.till_day_id,
      shiftId: s.id,
      refType: "session",
      refId: s.id,
      reason,
      cashierProfileId: s.cashier_id,
    });
    return { id: s.id, closureId: id, bundleFor: s.cashier_id };
  });

  // ---- cash from the office --------------------------------------------
  command("cash-movements", "van.cash.approve", async (db, actor, b) => {
    const [s] =
      await db`select * from store_shifts where id=${uuid(b.sessionId)} for update`;
    if (!s) refuse("Choose a cashier session", "not_found");
    const r = await registerFor(db, actor, s.register_id, "van.cash.approve");
    const [closed] =
      await db`select 1 from store_shift_closures where shift_id=${s.id}`;
    if (closed) refuse("This session is already closed");
    const id = crypto.randomUUID();
    const out = await recordCashMovement(
      {
        db,
        register: r,
        shift: s,
        actor,
        payload: b,
        now: Date.now(),
        op: { clientOpId: id },
      },
      { id, officeActor: actor },
    );
    return { id, ...out };
  });
  command(
    "supervisors/pin",
    "admin.manage",
    async (db, actor, b) => ({
      ...(await setSupervisorPin(db, actor, b)),
    }),
    ["storepos"],
  );

  // ---- online supervisor check (handheld is online) --------------------
  router.post("/api/v1/storepos/overrides/verify", verifyOnline);

  // ---- reads -----------------------------------------------------------
  router.get("/api/v1/storepos/cash-reasons", async (/** @type {any} */ c) => {
    const actor = await currentActor(c.db, c.actor);
    await requireCapability({ ...c, actor }, "van.read");
    return {
      kinds: await Promise.all(
        CASH_KINDS.map(async (k) => ({
          kind: k,
          label: CASH_KIND_LABELS[k],
          reasons: await cashReasonsFor(c.db, actor.organizationId ?? "sunpride", k),
        })),
      ),
    };
  });
  router.get("/api/v1/storepos/supervisors", async (/** @type {any} */ c) =>
    tx(c.db, async (/** @type {any} */ db) => {
      const actor = await currentActor(db, c.actor);
      return { supervisors: await listSupervisors(db, actor) };
    }),
  );
  router.get("/api/v1/storepos/overrides", async (/** @type {any} */ c) =>
    tx(c.db, async (/** @type {any} */ db) => {
      const actor = await currentActor(db, c.actor);
      await requireCapability({ db, actor }, "van.read");
      await requireOffice(db, actor);
      const q = c.url.searchParams;
      const scope = await scopeFilterForActor(db, actor);
      const kind = q.get("kind");
      if (kind) choice(kind, OVERRIDE_KINDS);
      const rows = await listOverrides(db, actor, {
        registerId: q.get("registerId") ? uuid(q.get("registerId")) : null,
        kind,
        from: q.get("from") ? date(q.get("from")) : null,
        to: q.get("to") ? date(q.get("to")) : null,
        scopeUnitIds: scope.unitIds,
      });
      return { overrides: rows };
    }),
  );
  router.get("/api/v1/storepos/cash-movements", async (/** @type {any} */ c) =>
    tx(c.db, async (/** @type {any} */ db) => {
      const actor = await currentActor(db, c.actor);
      await requireOffice(db, actor);
      const q = c.url.searchParams;
      if (q.get("sessionId")) {
        const [s] =
          await db`select register_id from store_shifts where id=${uuid(q.get("sessionId"))}`;
        if (!s) refuse("Choose a cashier session", "not_found");
        await registerFor(db, actor, s.register_id, "van.cash.approve");
        return {
          movements: await listMovements(db, {
            shiftId: q.get("sessionId") ?? "",
          }),
        };
      }
      const day = await loadTillDay(db, uuid(q.get("dayId")));
      await registerFor(db, actor, day.register_id, "van.cash.approve");
      return { movements: await listMovements(db, { dayId: day.id }) };
    }),
  );
  router.get("/api/v1/storepos/days", async (/** @type {any} */ c) =>
    tx(c.db, async (/** @type {any} */ db) => {
      const actor = await currentActor(db, c.actor);
      await requireCapability({ db, actor }, "van.read");
      await requireOffice(db, actor);
      const q = c.url.searchParams;
      const to = q.get("to") ? date(q.get("to")) : today();
      const from = q.get("from")
        ? date(q.get("from"))
        : new Date(Date.parse(to) - 6 * 86400000).toISOString().slice(0, 10);
      if (
        Date.parse(to) < Date.parse(from) ||
        (Date.parse(to) - Date.parse(from)) / 86400000 > 92
      )
        refuse("Choose up to 93 days");
      const sc = await scopeIds(db, actor);
      const registerId = q.get("registerId") ? uuid(q.get("registerId")) : null;
      const rows =
        await db`select d.id,d.register_id,d.business_date::text as business_date,d.status,d.doc_number,d.opened_at,d.z_done_at,r.name as register_name,r.terminal_code,l.name as store_name,
          (select count(*)::int from store_shifts s where s.till_day_id=d.id) as sessions,
          (select count(*)::int from store_shifts s left join store_shift_closures c on c.shift_id=s.id where s.till_day_id=d.id and c.id is null) as open_sessions,
          (select coalesce(sum((x.receipt->>'totalMinor')::bigint),0)::text from store_sales x join orders o on o.id=x.order_id join store_shifts h on h.id=x.shift_id where h.till_day_id=d.id and o.status<>'voided') as net_sales,
          (select count(*)::int from store_reversals v join store_shifts h on h.id=v.shift_id where h.till_day_id=d.id and v.status='pending') as pending_reversals,
          z.id as z_id,z.doc_number as z_doc,z.z_counter
          from store_till_days d join store_registers r on r.id=d.register_id join inventory_locations l on l.id=r.location_id left join store_z_readings z on z.till_day_id=d.id
          where d.business_date between ${from}::date and ${to}::date and (${sc.all} or l.org_unit_id in ${db(sc.ids)}) and (${registerId}::uuid is null or d.register_id=${registerId})
          order by d.business_date desc,r.name limit 501`;
      return {
        from,
        to,
        truncated: rows.length > 500,
        days: rows.slice(0, 500).map((/** @type {any} */ d) => ({
          id: d.id,
          registerId: d.register_id,
          registerName: d.register_name,
          terminal: d.terminal_code,
          storeName: d.store_name,
          businessDate: d.business_date,
          status: d.status,
          number: d.doc_number,
          sessions: d.sessions,
          openSessions: d.open_sessions,
          pendingReversals: d.pending_reversals,
          netSalesCentavos: d.net_sales,
          zId: d.z_id,
          zNumber: d.z_doc,
          zCounter: d.z_counter == null ? null : Number(d.z_counter),
          canZ:
            (d.status === "open" || d.status === "closing") &&
            d.open_sessions === 0 &&
            d.pending_reversals === 0 &&
            d.sessions > 0,
        })),
      };
    }),
  );
  router.get("/api/v1/storepos/days/:id", async (/** @type {any} */ c) =>
    tx(c.db, async (/** @type {any} */ db) => {
      const actor = await currentActor(db, c.actor);
      await requireCapability({ db, actor }, "van.read");
      await requireOffice(db, actor);
      const day = await loadTillDay(db, uuid(c.params.id));
      await registerFor(db, actor, day.register_id, "van.read");
      const fresh = await readingModel(
        db,
        day.id,
        day.status === "z_done" ? "z" : "x",
      );
      const { sessions } = fresh;
      const [typedZ] =
        await db`select * from store_z_readings where till_day_id=${day.id}`;
      const model = typedZ
        ? { ...typedZ.model, sessions: fresh.model.sessions }
        : fresh.model;
      // Blind count: the cashier being counted never sees expected or variance, even in the office view.
      const mine = new Set(
        sessions
          .filter((/** @type {any} */ s) => s.cashier_id === actor.profileId)
          .map((/** @type {any} */ s) => s.id),
      );
      const sessionViews = model.sessions.map((/** @type {any} */ s) =>
        mine.has(s.id)
          ? { ...s, expected: null, declared: null, variance: null }
          : s,
      );
      const movements = await listMovements(db, { dayId: day.id });
      const sc = await scopeFilterForActor(db, actor);
      const overrides = await listOverrides(db, actor, {
        registerId: day.register_id,
        from: dayString(day.business_date),
        to: dayString(day.business_date),
        scopeUnitIds: sc.unitIds,
      });
      const xReads =
        await db`select r.id,r.sequence::text,r.captured_at,p.name as cashier from store_reads r join store_shifts s on s.id=r.shift_id join profiles p on p.id=s.cashier_id where r.kind='x' and s.till_day_id=${day.id} order by r.captured_at desc limit 100`;
      const [z] =
        await db`select * from store_z_readings where till_day_id=${day.id}`;
      const [legacy] = z
        ? []
        : await db`select id,sequence::text,snapshot,captured_at from store_reads where register_id=${day.register_id} and kind='z' and snapshot->>'date'=${dayString(day.business_date)}`;
      const openCount = sessions.filter(
        (/** @type {any} */ s) => !s.closure_id,
      ).length;
      const [pending] =
        await db`select count(*)::int as n from store_reversals v join store_shifts h on h.id=v.shift_id where h.till_day_id=${day.id} and v.status='pending'`;
      const publicModel = {
        ...model,
        sessions: sessionViews,
        journal: undefined,
      };
      return {
        day: {
          id: day.id,
          registerId: day.register_id,
          businessDate: dayString(day.business_date),
          status: day.status,
          number: day.doc_number,
          canZ:
            (day.status === "open" || day.status === "closing") &&
            openCount === 0 &&
            pending.n === 0 &&
            sessions.length > 0 &&
            roleHas(actor.role, "van.cash.approve"),
          openSessions: openCount,
          pendingReversals: pending.n,
        },
        reading: publicModel,
        printModel: readingPrintModel(model),
        movements,
        overrides,
        xReads: xReads.map((/** @type {any} */ x) => ({
          id: x.id,
          sequence: x.sequence,
          capturedAt: +new Date(x.captured_at),
          cashier: x.cashier,
        })),
        z: z
          ? zView(z)
          : legacy
            ? {
                legacy: true,
                id: legacy.id,
                readId: legacy.id,
                zCounter: Number(legacy.sequence),
                businessDate: legacy.snapshot.date,
                netSalesCentavos: money(legacy.snapshot.salesCentavos),
                typed: false,
              }
            : null,
      };
    }),
  );
  router.get(
    "/api/v1/storepos/days/:id/reading",
    async (/** @type {any} */ c) =>
      tx(c.db, async (/** @type {any} */ db) => {
        const actor = await currentActor(db, c.actor);
        await requireOffice(db, actor);
        const day = await loadTillDay(db, uuid(c.params.id));
        await registerFor(db, actor, day.register_id, "van.read");
        // Read-only: nothing is written, nothing is numbered, no accumulator moves.
        const { model } = await readingModel(db, day.id, "x");
        return {
          reading: { ...model, journal: undefined },
          printModel: readingPrintModel(model),
        };
      }),
  );
  router.get("/api/v1/storepos/z-readings", async (/** @type {any} */ c) =>
    tx(c.db, async (/** @type {any} */ db) => {
      const actor = await currentActor(db, c.actor);
      await requireOffice(db, actor);
      const q = c.url.searchParams;
      const to = q.get("to") ? date(q.get("to")) : today();
      const from = q.get("from")
        ? date(q.get("from"))
        : new Date(Date.parse(to) - 30 * 86400000).toISOString().slice(0, 10);
      const sc = await scopeIds(db, actor);
      const registerId = q.get("registerId") ? uuid(q.get("registerId")) : null;
      const typed =
        await db`select z.* from store_z_readings z join store_registers r on r.id=z.register_id join inventory_locations l on l.id=r.location_id where z.business_date between ${from}::date and ${to}::date and (${sc.all} or l.org_unit_id in ${db(sc.ids)}) and (${registerId}::uuid is null or z.register_id=${registerId}) order by z.business_date desc,z.z_counter desc limit 501`;
      const legacy =
        await db`select x.id,x.register_id,x.sequence::text,x.snapshot,x.captured_at from store_reads x join store_registers r on r.id=x.register_id join inventory_locations l on l.id=r.location_id where x.kind='z' and not exists(select 1 from store_z_readings z where z.read_id=x.id) and x.snapshot->>'date' between ${from} and ${to} and (${sc.all} or l.org_unit_id in ${db(sc.ids)}) and (${registerId}::uuid is null or x.register_id=${registerId}) order by x.captured_at desc limit 501`;
      return {
        readings: typed.slice(0, 500).map(zView),
        legacy: legacy.slice(0, 500).map((/** @type {any} */ x) => ({
          legacy: true,
          id: x.id,
          readId: x.id,
          registerId: x.register_id,
          zCounter: Number(x.sequence),
          businessDate: x.snapshot.date,
          netSalesCentavos: money(x.snapshot.salesCentavos),
          typed: false,
        })),
      };
    }),
  );
  router.get("/api/v1/storepos/z-readings/:id", async (/** @type {any} */ c) =>
    tx(c.db, async (/** @type {any} */ db) => {
      const actor = await currentActor(db, c.actor);
      await requireOffice(db, actor);
      const [z] =
        await db`select * from store_z_readings where id=${uuid(c.params.id)}`;
      if (!z) throw new ApiError("not_found", 404, "Z reading not found");
      await registerFor(db, actor, z.register_id, "van.read");
      // Reprint: the SAME stored numbers, marked as a copy.
      return {
        reading: zView(z),
        printModel: { ...readingPrintModel(z.model), reprint: true },
      };
    }),
  );
  void integer;
}
/** @param {any} db @param {string} dayId */
async function openSessions(db, dayId) {
  return db`select s.id from store_shifts s left join store_shift_closures c on c.shift_id=s.id where s.till_day_id=${dayId} and c.id is null`;
}
