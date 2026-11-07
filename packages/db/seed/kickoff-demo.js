#!/usr/bin/env bun
/**
 * Kickoff mini-demo overlay: ONE sample field agent, FIVE stores, a bounded window (default seven days).
 *
 * Why this exists: the bulk sample seed cannot be shrunk (counts are index-coupled across modules) and must
 * never be reset on a shared database. This helper adds only a small coverage plan for one assignee, and it
 * does so ONLY through the public coverage domain commands (plans/create, setAssignment, saveOutlets, saveSlots,
 * submit, approve, activation/activate). Nothing here writes coverage rows with SQL and nothing copies an approval
 * snapshot or signature: the approval hash/signature is produced by the real `plans/approve` command.
 *
 * Safety contract
 *  - Default is a read-only DRY RUN. `apply` is explicit, and the CLI additionally requires
 *    `--confirm-database <current database name>` so a wrong DATABASE_URL cannot be applied by accident.
 *  - Apply is ONE transaction holding an advisory lock; any refusal rolls back everything (all or nothing).
 *  - Idempotent: every command carries a deterministic key from the real `coverage_commands` ledger; a rerun
 *    replays the stored responses and changes nothing. A different store set under the same window is refused
 *    by the domain as `idempotency_conflict`.
 *  - Additive only: never updates/deletes rows it does not own. Anything unowned that overlaps the window
 *    (a live plan, slots, planned visits, executions) or any suspended/revoked/foreign-bound device of the
 *    agent makes the run FAIL CLOSED with a machine-readable conflict list.
 *  - Approval is NOT automatic. Without `approve: true` the plan stops at `submitted` and the sample
 *    supervisor must approve it. With `approve: true` the direct supervisor identity (resolved from the agent's
 *    employee assignment, never chosen by the caller) issues the real approve command, plus activate once the plan's
 *    effective date has arrived (the domain refuses earlier; the API scheduler activates approved plans when due).
 *  - The van/truck leg is read-only: see `vanReadiness`. The helper never plans a trip.
 *
 * Sample-only contract (fail closed)
 *  - This helper impersonates the assignee and the direct supervisor (`actorFor`) and issues PUBLIC coverage commands
 *    on their behalf. That is only acceptable for the invented sample company, so every identity and fixture it
 *    touches must carry a VERIFIED sample ownership marker (`verifiedSample`): a `sample_data_rows` row of the seed
 *    batch whose key and ids re-derive exactly as `store.js` derives them (the same check `resetDemo` makes). The
 *    email address is never trusted. Required: assignee profile + login user + employee assignment + org unit,
 *    supervisor profile + login user, every store (outlet), and the van seller profile + login user (with only
 *    marked vehicles/trips considered). Anything unmarked is a conflict, and the apply path re-checks both actors
 *    inside the transaction right before impersonating them. Production authorization is never loosened: the
 *    commands run through the normal coverage domain with the real capabilities of those sample roles.
 *
 * No credentials are read. The CLI takes DATABASE_URL from the environment and never prints it.
 */
import { createHash } from "node:crypto";
import { createDb, tx } from "../src/client.js";
import { BATCH, rowId } from "./store.js";

export const DEFAULT_ASSIGNEE = "agent@sunpride.test";
export const DEFAULT_VAN_SELLER = "van@sunpride.test";
const KEY_VERSION = "kickoff-demo:v1";
const DAY_MS = 86_400_000;
const LIVE_PLAN_STATUSES = ["draft", "submitted", "approved", "active"];

/** Manila (UTC+8, no DST) civil date for an instant. @param {number} ms */
export const manilaDate = (ms) =>
  new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
/** @param {string} date */
const midnightMs = (date) => Date.parse(`${date}T00:00:00+08:00`);
/** @param {string} date @param {number} n */
export const addDays = (date, n) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);

export class KickoffConflict extends Error {
  /** @param {any} report */
  constructor(report) {
    super(
      `Kickoff demo refused: ${report.conflicts.map((/** @type {any} */ c) => c.code).join(", ")}`,
    );
    this.name = "KickoffConflict";
    this.report = report;
  }
}

/**
 * @typedef {{assigneeEmail?:string, assigneeProfileId?:string, vanSellerEmail?:string, vanSellerProfileId?:string, from?:string, days?:number, storesPerDay?:number,
 *   stores?:string[], approve?:boolean, allowInactiveDevices?:boolean, now?:number}} KickoffOptions
 */

/** @param {KickoffOptions} o */
function normalize(o = {}) {
  const now = o.now ?? Date.now();
  const today = manilaDate(now);
  const from = o.from ?? today;
  const days = o.days ?? 7;
  const storesPerDay = o.storesPerDay ?? 5;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || manilaDate(midnightMs(from)) !== from)
    throw new Error("from must be a real YYYY-MM-DD Manila date");
  if (!Number.isInteger(days) || days < 1 || days > 31)
    throw new Error("days must be 1..31");
  if (!Number.isInteger(storesPerDay) || storesPerDay < 1 || storesPerDay > 20)
    throw new Error("storesPerDay must be 1..20");
  for (const id of [o.assigneeProfileId, o.vanSellerProfileId])
    if (id != null && !UUID.test(id)) throw new Error("profile ids must be UUIDs");
  if (o.stores && o.stores.length !== storesPerDay)
    throw new Error("stores must list exactly storesPerDay outlet codes");
  return {
    now,
    today,
    from,
    days,
    storesPerDay,
    stores: o.stores ?? null,
    approve: o.approve === true,
    allowInactiveDevices: o.allowInactiveDevices === true,
    assigneeEmail: (o.assigneeEmail ?? DEFAULT_ASSIGNEE).toLowerCase(),
    assigneeProfileId: o.assigneeProfileId?.toLowerCase() ?? null,
    vanSellerEmail: (o.vanSellerEmail ?? DEFAULT_VAN_SELLER).toLowerCase(),
    vanSellerProfileId: o.vanSellerProfileId?.toLowerCase() ?? null,
  };
}

/** One plan per calendar month because the domain's plan period never crosses a month.
 * @param {string} from @param {number} days */
export function segments(from, days) {
  /** @type {{month:string, from:string, to:string, dates:string[]}[]} */
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i),
      month = date.slice(0, 7);
    const last = out[out.length - 1];
    if (last?.month === month) {
      last.dates.push(date);
      last.to = addDays(date, 1);
    } else out.push({ month, from: date, to: addDays(date, 1), dates: [date] });
  }
  return out;
}

/** Deterministic per-step command key; independent of the store choice on purpose. */
const commandKey = (/** @type {string} */ assigneeId, /** @type {any} */ seg, /** @type {string} */ step) =>
  `${KEY_VERSION}:${assigneeId}:${seg.from}:${seg.to}:${step}`;

/**
 * Ids (of `table`) whose sample ownership marker is verified: marker row in the seed batch, key `<table>:<k>`, row id
 * equal to the seed's deterministic id for that key and marker id equal to the deterministic marker id. Mirrors the
 * validation `resetDemo` performs, so a forged or foreign marker does not pass by accident.
 * @param {any} db @param {string} table @param {(string|null|undefined)[]} ids @returns {Promise<Set<string>>}
 */
export async function verifiedSample(db, table, ids) {
  const list = [...new Set(ids.filter((i) => i != null).map(String))];
  /** @type {Set<string>} */ const ok = new Set();
  if (!list.length) return ok;
  const rows = await db`select id::text as id,key,row_id from sample_data_rows
    where batch=${BATCH} and table_name=${table} and row_id in ${db(list)}`;
  const prefix = `${table}:`;
  for (const m of rows) {
    if (!String(m.key).startsWith(prefix)) continue;
    if (rowId(table, String(m.key).slice(prefix.length)) !== m.row_id) continue;
    if (rowId("sample_data_rows", m.key) !== m.id) continue;
    ok.add(m.row_id);
  }
  return ok;
}
/** @param {any} db @param {string} table @param {string|null|undefined} id */
const isSample = async (db, table, id) => id != null && (await verifiedSample(db, table, [id])).has(String(id));
/** A profile may be impersonated only if the profile AND its login user are verified sample rows.
 * @param {any} db @param {{id:string,user_id:string}} p */
const sampleIdentity = async (db, p) => (await isSample(db, "profiles", p.id)) && (await isSample(db, "users", p.user_id));

/** Exact profile id wins over email: physical-test phones belong to trial profiles, never assume base accounts.
 * @param {any} db @param {{id?:string|null,email?:string}} ref */
async function person(db, ref) {
  const [p] = ref.id
    ? await db`select p.id,p.user_id,p.email,p.name,p.role,p.status,p.org_unit_id from profiles p
        where p.id=${ref.id} and p.deleted_at is null`
    : await db`select p.id,p.user_id,p.email,p.name,p.role,p.status,p.org_unit_id from profiles p
        where lower(p.email)=${ref.email} and p.deleted_at is null`;
  return p ?? null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read-only preflight. Returns the full report; `ok` is false when any conflict exists.
 * @param {any} db @param {ReturnType<typeof normalize>} o */
async function preflight(db, o) {
  /** @type {{code:string, detail:any}[]} */
  const conflicts = [];
  /** @param {string} code @param {any} [detail] */
  const refuse = (code, detail = null) => conflicts.push({ code, detail });
  const segs = segments(o.from, o.days);
  const report = {
    mode: o.approve ? "approve" : "submit-only",
    window: { from: o.from, days: o.days, dates: segs.flatMap((s) => s.dates) },
    segments: segs.map((s) => ({ month: s.month, from: s.from, to: s.to, days: s.dates.length })),
    assignee: /** @type {any} */ (null),
    approver: /** @type {any} */ (null),
    stores: /** @type {any[]} */ ([]),
    ownedPlans: /** @type {any[]} */ ([]),
    devices: /** @type {any[]} */ ([]),
    conflicts,
    van: /** @type {any} */ (null),
    ok: false,
  };
  if (o.from < o.today) refuse("window_in_past", { from: o.from, today: o.today });

  /** Read-only van target report; a non-sample van target is a conflict, never a quiet skip. */
  const finish = async () => {
    report.van = await vanReadiness(db, o, segs);
    for (const code of report.van.conflicts) refuse(code, { email: o.vanSellerEmail, profileId: o.vanSellerProfileId });
    report.ok = conflicts.length === 0;
    return report;
  };
  const agent = await person(db, { id: o.assigneeProfileId, email: o.assigneeEmail });
  if (!agent || agent.status !== "active" || !agent.user_id || agent.role !== "sales") {
    refuse("assignee_unavailable", { email: o.assigneeEmail, profileId: o.assigneeProfileId });
    return finish();
  }
  if (!(await sampleIdentity(db, agent))) {
    refuse("assignee_not_sample", { profileId: agent.id });
    return finish();
  }
  const at = new Date(Math.max(midnightMs(o.from), o.now));
  const [emp] = await db`select e.* from employee_assignments e where e.profile_id=${agent.id} and e.deleted_at is null
    and e.effective_from<=${at} and (e.effective_to is null or e.effective_to>${at})`;
  if (!emp?.org_unit_id) {
    refuse("assignee_has_no_employee_assignment", { email: o.assigneeEmail });
    return finish();
  }
  if (!(await isSample(db, "employee_assignments", emp.id)) || !(await isSample(db, "org_units", emp.org_unit_id))) {
    refuse("assignee_assignment_not_sample", { employeeAssignmentId: emp.id, orgUnitId: emp.org_unit_id });
    return finish();
  }
  report.assignee = { profileId: agent.id, email: agent.email, name: agent.name, orgUnitId: emp.org_unit_id };

  // The direct supervisor is the only legitimate approver (coverage approvalCapacity). Never caller-chosen.
  const [sup] = emp.supervisor_id
    ? await db`select id,user_id,email,name,role,status,org_unit_id from profiles where id=${emp.supervisor_id} and deleted_at is null`
    : [];
  if (!sup || sup.status !== "active" || !sup.user_id || !["manager", "admin", "super_admin", "approver"].includes(sup.role))
    refuse("approver_unavailable", { supervisorId: emp.supervisor_id ?? null });
  else if (!(await sampleIdentity(db, sup))) refuse("approver_not_sample", { supervisorId: sup.id });
  else report.approver = { profileId: sup.id, email: sup.email, name: sup.name, role: sup.role };

  // ---- ownership: plans this helper already created (real command ledger; its own plans carry no seed markers) ----
  const ownedIds = new Set();
  for (const seg of segs) {
    const [cmd] = await db`select response from coverage_commands where actor_id=${agent.id}
      and command_key=${commandKey(agent.id, seg, "create")}`;
    if (cmd?.response?._id) ownedIds.add(cmd.response._id);
  }
  if (ownedIds.size) {
    report.ownedPlans = await db`select id,local_month,version,status,effective_from,effective_to,
      (approval_signature is not null) as approved from coverage_plans where id in ${db([...ownedIds])}`;
  }
  const owned = [...ownedIds];
  const notOwned = owned.length
    ? db`and cp.id not in ${db(owned)}`
    : db``;

  // ---- unowned live plan overlapping any segment (would also block approval of that unowned plan later) ----
  for (const seg of segs) {
    const rows = await db`select cp.id,cp.local_month,cp.version,cp.status from coverage_plans cp
      where cp.assignee_profile_id=${agent.id} and cp.deleted_at is null and cp.status in ${db(LIVE_PLAN_STATUSES)}
      and cp.effective_from<${new Date(midnightMs(seg.to))} and coalesce(cp.active_through,cp.effective_to)>${new Date(midnightMs(seg.from))}
      ${notOwned}`;
    for (const r of rows)
      refuse("unowned_plan_overlaps_window", { planId: r.id, month: r.local_month, version: r.version, status: r.status, segment: [seg.from, seg.to] });
  }
  // ---- unowned slots / planned visits / executions on the window dates ----
  const dates = report.window.dates;
  const ownedPlanSql = owned.length ? db`and plan_id not in ${db(owned)}` : db``;
  const [slots] = await db`select count(*)::int n from coverage_plan_slots where assignee_profile_id=${agent.id}
    and service_date in ${db(dates)} and deleted_at is null ${ownedPlanSql}`;
  const [visits] = await db`select count(*)::int n from planned_visits where assignee_profile_id=${agent.id}
    and service_date in ${db(dates)} and deleted_at is null ${ownedPlanSql}`;
  const [execs] = await db`select count(*)::int n from visit_executions where assignee_profile_id=${agent.id}
    and service_date in ${db(dates)} and deleted_at is null`;
  if (slots.n) refuse("unowned_slots_on_window", { count: slots.n });
  if (visits.n) refuse("unowned_planned_visits_on_window", { count: visits.n });
  if (execs.n) refuse("executions_on_window", { count: execs.n });

  // ---- device restrictions: refuse on anything that could strand or mis-bind the installed phone ----
  const devices = await db`select id,app,status,bound_subject,org_unit_id from registered_devices where profile_id=${agent.id}`;
  report.devices = devices.map((/** @type {any} */ d) => ({ id: d.id, app: d.app, status: d.status }));
  for (const d of devices) {
    // Opt-in only: revoked/suspended rows left by earlier phone swaps cannot be stranded by a plan. They are reported
    // (never edited); an ACTIVE device that is foreign-bound or in another unit still refuses below.
    if (d.status !== "active" && o.allowInactiveDevices) continue;
    if (d.status !== "active")
      refuse("device_not_active", { deviceId: d.id, app: d.app, status: d.status });
    else if (d.bound_subject && d.bound_subject !== agent.user_id)
      refuse("device_bound_to_other_subject", { deviceId: d.id, app: d.app });
    else if (d.org_unit_id && d.org_unit_id !== emp.org_unit_id)
      refuse("device_scope_differs_from_assignee_unit", { deviceId: d.id, app: d.app });
  }

  // ---- the five stores ----
  report.stores = await pickStores(db, o, agent.id, emp.org_unit_id, at);
  if (o.stores) {
    const missing = o.stores.filter((c) => !report.stores.some((s) => s.code === c));
    if (missing.length) {
      // Say WHY when the store exists but is not verified sample data (never silently substitute another store).
      const found = await db`select id,code from outlets where code in ${db(missing)} and deleted_at is null`;
      const sample = await verifiedSample(db, "outlets", found.map((/** @type {any} */ r) => r.id));
      const foreign = found.filter((/** @type {any} */ r) => !sample.has(r.id)).map((/** @type {any} */ r) => r.code);
      if (foreign.length) refuse("store_not_sample", { codes: foreign });
      const rest = missing.filter((c) => !foreign.includes(c));
      if (rest.length) refuse("requested_store_not_eligible", { codes: rest });
    }
  } else if (report.stores.length < o.storesPerDay)
    refuse("not_enough_eligible_stores", { found: report.stores.length, needed: o.storesPerDay });

  return finish();
}

/** Stores the agent can really check in to: single effective assignment on an active route the agent walks, owned by
 * the agent's unit, at most one customer link. The domain re-validates everything on apply.
 * @param {any} db @param {ReturnType<typeof normalize>} o @param {string} agentId @param {string} unitId @param {Date} at */
async function pickStores(db, o, agentId, unitId, at) {
  const codeFilter = o.stores ? db`and o.code in ${db(o.stores)}` : db``;
  const rows = await db`select o.id,o.code,o.name,a.territory_id,a.route_id,a.sequence
    from outlets o
    join outlet_assignments a on a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=${at} and (a.effective_to is null or a.effective_to>${at})
    join territories t on t.id=a.territory_id and t.status='active' and t.deleted_at is null
    join territory_ownerships own on own.territory_id=a.territory_id and own.deleted_at is null and own.org_unit_id=${unitId}
      and own.effective_from<=${at} and (own.effective_to is null or own.effective_to>${at})
    join territory_salespeople ts on ts.territory_id=a.territory_id and ts.profile_id=${agentId} and ts.deleted_at is null
      and ts.effective_from<=${at} and (ts.effective_to is null or ts.effective_to>${at})
    join routes r on r.id=a.route_id and r.status='active' and r.deleted_at is null
    join route_territories rt on rt.route_id=r.id and rt.territory_id=a.territory_id and rt.deleted_at is null
      and rt.effective_from<=${at} and (rt.effective_to is null or rt.effective_to>${at})
    join route_salespeople rp on rp.route_id=r.id and rp.profile_id=${agentId} and rp.deleted_at is null
      and rp.effective_from<=${at} and (rp.effective_to is null or rp.effective_to>${at})
    where o.status='active' and o.deleted_at is null ${codeFilter}
      and exists(select 1 from sample_data_rows m where m.batch=${BATCH} and m.table_name='outlets' and m.row_id=o.id::text)
      and (select count(*) from outlet_assignments x where x.outlet_id=o.id and x.deleted_at is null
           and x.effective_from<=${at} and (x.effective_to is null or x.effective_to>${at}))=1
      and (select count(*) from outlet_customer_links l where l.outlet_id=o.id and l.deleted_at is null
           and l.effective_from<=${at} and (l.effective_to is null or l.effective_to>${at}))<=1
    order by a.sequence nulls last,o.code limit 500`;
  // The marker is re-derived and verified in code (SQL above only narrows); unverified stores never reach the plan.
  const sample = await verifiedSample(db, "outlets", rows.map((/** @type {any} */ r) => r.id));
  /** @type {{outletId:string,code:string,name:string,territoryId:string,routeId:string}[]} */
  const list = rows
    .filter((/** @type {any} */ r) => sample.has(r.id))
    .slice(0, o.stores ? 500 : o.storesPerDay)
    .map((/** @type {any} */ r) => ({
      outletId: r.id, code: r.code, name: r.name, territoryId: r.territory_id, routeId: r.route_id,
    }));
  const order = o.stores ?? null;
  return order ? order.map((c) => list.find((s) => s.code === c)).filter((s) => s !== undefined) : list;
}

/** Read-only. The van/truck leg is NOT created here: `trips/plan` refuses while the truck still holds stock.
 * @param {any} db @param {ReturnType<typeof normalize>} o @param {ReturnType<typeof segments>} segs */
async function vanReadiness(db, o, segs) {
  const seller = await person(db, { id: o.vanSellerProfileId, email: o.vanSellerEmail });
  const dates = segs.flatMap((s) => s.dates);
  const out = { seller: /** @type {string|null} */ (null), trips: /** @type {any[]} */ ([]), vehicles: /** @type {any[]} */ ([]),
    blockers: /** @type {string[]} */ ([]), conflicts: /** @type {string[]} */ ([]), createdByHelper: false };
  if (!seller || seller.status !== "active") {
    out.seller = seller?.email ?? null;
    out.blockers.push("van_seller_unavailable");
    return out;
  }
  // Fail closed: a non-sample van seller (or one whose login is not sample) is never read, let alone reported on.
  if (!seller.user_id || !(await sampleIdentity(db, seller))) {
    out.conflicts.push("van_seller_not_sample");
    out.blockers.push("van_seller_not_sample");
    return out;
  }
  out.seller = seller.email;
  const tripRows = await db`select id,trip_number,service_date::text as service_date,status from van_trips
    where salesperson_profile_id=${seller.id} and service_date in ${db(dates)} and deleted_at is null order by service_date`;
  const sampleTrips = await verifiedSample(db, "van_trips", tripRows.map((/** @type {any} */ t) => t.id));
  out.trips = tripRows
    .filter((/** @type {any} */ t) => sampleTrips.has(t.id))
    .map((/** @type {any} */ t) => ({ tripNumber: t.trip_number, date: t.service_date.slice(0, 10), status: t.status }));
  const vehicleRows = await db`select v.id,v.vehicle_code as code,
    exists(select 1 from inventory_balances b where b.location_id=v.truck_location_id and b.physical_base<>0 and b.deleted_at is null) as holds_stock
    from vehicles v where v.org_unit_id=${seller.org_unit_id} and v.status='active' and v.deleted_at is null order by v.vehicle_code`;
  const sampleVehicles = await verifiedSample(db, "vehicles", vehicleRows.map((/** @type {any} */ v) => v.id));
  out.vehicles = vehicleRows.filter((/** @type {any} */ v) => sampleVehicles.has(v.id)).map((/** @type {any} */ v) => ({ code: v.code, holds_stock: v.holds_stock }));
  if (!out.vehicles.length) out.blockers.push("no_active_vehicle_in_seller_unit");
  for (const v of out.vehicles)
    if (v.holds_stock) out.blockers.push(`truck_holds_stock:${v.code} (trips/plan refuses until it is unloaded)`);
  const have = new Set(out.trips.map((t) => t.date));
  const missing = dates.filter((d) => !have.has(d));
  if (missing.length) out.blockers.push(`no_trip_for:${missing.join(",")}`);
  return out;
}

/** Dry run: read-only, never throws on conflicts. @param {any} db @param {KickoffOptions} [options] */
export async function planKickoffDemo(db, options = {}) {
  const o = normalize(options);
  return { dryRun: true, ...(await preflight(db, o)) };
}

/** The coverage domain is loaded lazily so a dry run needs none of the API. The org identity hooks supply the real
 * org-subtree scope check (`unitInScope`); only those READ-ONLY scope hooks are installed (not `loadProfile`, which can
 * write), and the previous hooks are restored afterwards. */
async function loadDomain() {
  const base = new URL("../../../apps/api/src/", import.meta.url);
  const [cov, caps, sync, hookMod, identity] = await Promise.all([
    import(new URL("domains/coverage/index.js", base).href),
    import(new URL("core/capabilities.js", base).href),
    import(new URL("core/sync.js", base).href),
    import(new URL("core/hooks.js", base).href),
    import(new URL("domains/org/identity.js", base).href),
  ]);
  return {
    command: cov.command,
    recordChange: sync.recordChange,
    /** @param {any} p */
    actorFor: (p) => ({
      userId: p.user_id,
      profileId: p.id,
      role: p.role,
      orgUnitId: p.org_unit_id ?? null,
      capabilities: new Set(caps.capabilitiesFor(p.role)),
      subject: p.user_id,
      name: p.name ?? null,
    }),
    /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
    async withScopeHooks(fn) {
      const scope = identity.identityHooks({});
      const keys = ["unitInScope", "scopeUnitIds", "rootUnitId"];
      const saved = Object.fromEntries(keys.map((k) => [k, hookMod.hooks[k]]));
      hookMod.setHooks(Object.fromEntries(keys.map((k) => [k, scope[k]])));
      try {
        return await fn();
      } finally {
        hookMod.setHooks(saved);
      }
    },
  };
}

/**
 * Apply the overlay in one transaction. Throws KickoffConflict (report attached) when anything is unowned or unsafe.
 * @param {any} db @param {KickoffOptions} [options] @param {{coverage?:any}} [deps]
 */
export async function applyKickoffDemo(db, options = {}, deps = {}) {
  const o = normalize(options);
  const domain = deps.coverage ?? (await loadDomain());
  return tx(db, (t) => domain.withScopeHooks(async () => {
    await t`select pg_advisory_xact_lock(hashtextextended(${`${KEY_VERSION}:${o.assigneeProfileId ?? o.assigneeEmail}`}, 0))`;
    const report = await preflight(t, o);
    if (!report.ok) throw new KickoffConflict({ applied: false, ...report });
    const agent = await person(t, { id: report.assignee.profileId });
    const sup = await person(t, { id: report.approver.profileId });
    const [{ n: ledgerBefore }] = await t`select count(*)::int n from coverage_commands where actor_id in ${t([agent.id, sup.id])}`;
    const platform = { recordChange: domain.recordChange };
    // Defence in depth: preflight already proved this, but impersonation is the dangerous step, so re-prove it here
    // inside the same transaction. Never build an actor from an unverified profile.
    for (const [code, who] of /** @type {const} */ ([["assignee_not_sample", agent], ["approver_not_sample", sup]]))
      if (!(await sampleIdentity(t, who)))
        throw new KickoffConflict({ applied: false, conflicts: [{ code, detail: { profileId: who.id } }], ok: false });
    const agentActor = domain.actorFor(agent);
    const supActor = domain.actorFor(sup);
    /** @param {any} actor @param {string} path @param {any} seg @param {string} step @param {any} body */
    const run = (actor, path, seg, step, body) =>
      domain.command(
        { db: t, now: o.now, actor, publish: async () => {} },
        platform,
        path,
        { ...body, idempotencyKey: commandKey(agent.id, seg, step) },
      );
    const plans = [];
    for (const seg of segments(o.from, o.days)) {
      const created = await run(agentActor, "plans/create", seg, "create", {
        assigneeProfileId: agent.id,
        localMonth: seg.month,
        effectiveFromDate: seg.from,
      });
      const planId = created._id;
      await run(agentActor, "plans/setAssignment", seg, "assign", {
        planId,
        effectiveFrom: midnightMs(seg.from),
        effectiveTo: midnightMs(seg.to),
        reason: "Kickoff demo window",
      });
      await run(agentActor, "plans/saveOutlets", seg, "outlets", {
        planId,
        outlets: report.stores.map((s, i) => ({
          outletId: s.outletId,
          territoryId: s.territoryId,
          routeId: s.routeId,
          frequency: "custom",
          preferredWeekdays: [],
          customLocalDates: seg.dates,
          sequence: i + 1,
          priority: 1,
          expectedDurationMinutes: 15,
          requiredObjectives: ["sell"],
        })),
      });
      await run(agentActor, "plans/saveSlots", seg, "slots", {
        planId,
        slots: seg.dates.flatMap((date) =>
          report.stores.map((s, i) => ({
            slotKey: `kickoff:${date}:${i + 1}`,
            serviceDate: date,
            kind: "outlet_visit",
            outletId: s.outletId,
            routeId: s.routeId,
            sequence: i + 1,
            expectedDurationMinutes: 15,
            requiredObjectives: ["sell"],
            intents: ["sell"],
          })),
        ),
      });
      await run(agentActor, "plans/submit", seg, "submit", { planId });
      let approved = null,
        activated = null;
      if (o.approve) {
        approved = await run(supActor, "plans/approve", seg, "approve", { planId });
        // The domain refuses to activate before the plan's effective date. An approved plan is activated by the API's
        // own `coverage.activation` scheduler (activateDue) once the date arrives, or by rerunning this helper then.
        if (midnightMs(seg.from) <= o.now)
          activated = await run(supActor, "activation/activate", seg, "activate", { planId });
      }
      plans.push({ segment: seg, planId, approved, activated });
    }
    const [{ n: ledgerAfter }] = await t`select count(*)::int n from coverage_commands where actor_id in ${t([agent.id, sup.id])}`;
    const verify = await readBack(t, plans.map((p) => p.planId));
    return {
      applied: true,
      replayed: ledgerAfter === ledgerBefore,
      commandsAdded: ledgerAfter - ledgerBefore,
      mode: report.mode,
      window: report.window,
      assignee: report.assignee,
      approver: report.approver,
      stores: report.stores.map((s) => s.code),
      plans: plans.map((p) => p.planId),
      activation: plans.map((p) => (p.activated ? "activated" : p.approved ? "pending_effective_date_scheduler" : "not_approved")),
      verify,
      van: report.van,
    };
  }));
}

/** Read-back used by apply and tests. @param {any} db @param {string[]} planIds */
export async function readBack(db, planIds) {
  const plans = await db`select id,local_month,status,effective_from,effective_to,approval_capacity,
    (approval_signature is not null) as signed from coverage_plans where id in ${db(planIds)} order by local_month`;
  const [slots] = await db`select count(*)::int n from coverage_plan_slots where plan_id in ${db(planIds)} and deleted_at is null`;
  const perDay = await db`select service_date::text as d,count(*)::int n from planned_visits where plan_id in ${db(planIds)} and status='planned' group by 1 order by 1`;
  return {
    plans: plans.map((/** @type {any} */ p) => ({ id: p.id, month: p.local_month, status: p.status, signed: p.signed, capacity: p.approval_capacity })),
    slots: slots.n,
    plannedVisitsPerDay: Object.fromEntries(perDay.map((/** @type {any} */ r) => [r.d.slice(0, 10), r.n])),
  };
}

// --------------------------------------------------------------------------------------------- CLI
/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, any>} */ const a = { apply: false, approve: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v == null || v.startsWith("--")) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === "--apply") a.apply = true;
    else if (k === "--approve-as-supervisor") a.approve = true;
    else if (k === "--allow-inactive-devices") a.allowInactiveDevices = true;
    else if (k === "--from") a.from = val();
    else if (k === "--days") a.days = Number(val());
    else if (k === "--stores") a.stores = val().split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--assignee") a.assigneeEmail = val();
    else if (k === "--assignee-id") a.assigneeProfileId = val();
    else if (k === "--van-seller-id") a.vanSellerProfileId = val();
    else if (k === "--van-seller") a.vanSellerEmail = val();
    else if (k === "--confirm-database") a.confirmDatabase = val();
    else throw new Error(`Unknown option ${k}`);
  }
  return a;
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required (it is never printed).");
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));
  const db = createDb(url, { max: 2 });
  let code = 0;
  try {
    const [{ name }] = await db`select current_database() as name`;
    if (!args.apply) {
      const r = await planKickoffDemo(db, args);
      console.log(JSON.stringify({ database: name, ...r }, null, 2));
      code = r.ok ? 0 : 1;
    } else {
      if (args.confirmDatabase !== name) {
        console.error(`Refusing to apply: --confirm-database must equal the connected database name (${name}).`);
        process.exit(2);
      }
      const r = await applyKickoffDemo(db, args);
      console.log(JSON.stringify({ database: name, ...r }, null, 2));
    }
  } catch (e) {
    if (e instanceof KickoffConflict) {
      console.log(JSON.stringify({ database: "(connected)", ...e.report }, null, 2));
    } else console.error(String(/** @type {any} */ (e)?.message ?? e));
    code = 1;
  } finally {
    await db.close();
  }
  process.exit(code);
}
