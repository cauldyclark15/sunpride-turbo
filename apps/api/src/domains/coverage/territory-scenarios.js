// F-224: territory rebalancing. Draft outlet moves between territories, simulate the before/after workload
// (outlets, potential, service and travel minutes, capacity) for every affected territory, compare on a map and
// table, then a DIFFERENT person publishes. Publication goes through the ORG outlet assignment writer
// (effective-dated, scope and signed-plan locks), never a parallel membership write; the moved outlets then
// enter the destination's next PJP generation (F-201/F-202).
import { tx } from "@sunpride/db/client";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { actorFor } from "../../core/context.js";
import { invalid, conflict, notFound, forbidden } from "../../core/errors.js";
import { currentActor } from "../van/access.js";
import { assignmentCommand } from "../org/outlets.js";
import { ORG_LOCK } from "../org/identity.js";
import { required } from "../org/model.js";
import { manilaDate } from "./model.js";

const hash = (/** @type {any} */ v) => sha256Hex(canonicalJson(v));
/** SAMPLE planning defaults; every value is editable per scenario and stored with it. */
export const DEFAULTS = {
  dayMinutes: 480,
  sellingDays: 24,
  serviceMinutes: 20,
  visitsPer4Weeks: 4,
  travelKmh: 20,
  roadFactor: 1.3,
};
/** @param {any} a */
function assumptions(a = {}) {
  /** @param {string} k @param {number} lo @param {number} hi */
  const n = (k, lo, hi) => {
    const v = a[k] ?? /** @type {any} */ (DEFAULTS)[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi)
      throw invalid(`Assumption ${k} must be between ${lo} and ${hi}`);
    return v;
  };
  return {
    dayMinutes: n("dayMinutes", 60, 720),
    sellingDays: n("sellingDays", 1, 28),
    serviceMinutes: n("serviceMinutes", 1, 240),
    visitsPer4Weeks: n("visitsPer4Weeks", 1, 28),
    travelKmh: n("travelKmh", 5, 80),
    roadFactor: n("roadFactor", 1, 3),
  };
}
/** @param {number[]} a @param {number[]} b */
function km(a, b) {
  const r = Math.PI / 180,
    dLat = (b[0] - a[0]) * r,
    dLon = (b[1] - a[1]) * r;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
/** Nearest-neighbour loop over pinned stores, straight-line km. Provisional until a road engine exists.
 * @param {number[][]} pts */
export function tourKm(pts) {
  if (pts.length < 2) return 0;
  const left = pts.slice(1);
  let at = pts[0],
    total = 0;
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++)
      if (km(at, left[i]) < km(at, left[best])) best = i;
    total += km(at, left[best]);
    at = left.splice(best, 1)[0];
  }
  return total + km(at, pts[0]);
}
/** Workload of one territory's store set. Pure; exported for tests.
 * @param {any[]} stores @param {number} people @param {ReturnType<typeof assumptions>} a */
export function workload(stores, people, a) {
  const pinned = stores.filter((s) => s.lat != null);
  const visits = stores.reduce((n, s) => n + s.visits, 0);
  const service = stores.reduce((n, s) => n + s.visits * s.service, 0);
  const avgVisits = stores.length ? visits / stores.length : 0;
  // One full loop per visit round, scaled by road factor; unpinned stores add no travel (flagged).
  const travel = Math.round(
    ((tourKm(pinned.map((s) => [s.lat, s.lon])) * a.roadFactor) / a.travelKmh) *
      60 *
      avgVisits,
  );
  const capacity = people * a.dayMinutes * a.sellingDays;
  const knownPotential = stores.filter((s) => s.potential != null);
  return {
    outlets: stores.length,
    potential: knownPotential.reduce((n, s) => n + s.potential, 0),
    potentialMissing: stores.length - knownPotential.length,
    visits,
    serviceMinutes: Math.round(service),
    travelMinutes: travel,
    unpinned: stores.length - pinned.length,
    people,
    capacityMinutes: capacity,
    loadPct: capacity
      ? Math.round(((service + travel) / capacity) * 100)
      : null,
  };
}

/** Current facts for the affected territories, gated by outlet.assign at each current owner.
 * @param {any} c @param {string[]} territoryIds */
async function facts(c, territoryIds) {
  const db = c.db;
  const territories =
    await db`select t.id,t.name,t.status,o.org_unit_id from territories t left join lateral (select org_unit_id from territory_ownerships x where x.territory_id=t.id and x.deleted_at is null and x.effective_from<=now() and (x.effective_to is null or x.effective_to>now()) order by effective_from desc limit 1) o on true
      where t.id in ${db(territoryIds)} and t.deleted_at is null`;
  if (territories.length !== territoryIds.length)
    throw notFound("Territory not found");
  for (const t of territories) {
    if (!t.org_unit_id || t.status !== "active")
      throw invalid(`${t.name} has no active owner`);
    await requireCapability(c, "outlet.assign", t.org_unit_id);
  }
  const stores =
    await db`select s.id,s.code,s.name,s.territory_id,s.sales_potential,s.classification,s.cycle_days,s.owner_unit_id,
      (select a.id from outlet_assignments a where a.outlet_id=s.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) order by effective_from desc limit 1) as assignment_id,
      p.latitude,p.longitude
      from analytics_store_scope s
      left join lateral (select latitude,longitude from outlet_pins x where x.outlet_id=s.id and x.status='verified' and x.effective_from<=now() and (x.effective_to is null or x.effective_to>now()) order by effective_from desc limit 1) p on true
      where s.territory_id in ${db(territoryIds)} and s.status='active' order by s.code limit 5001`;
  if (stores.length > 5000)
    throw conflict("More than 5,000 stores in the affected territories");
  const policies =
    await db`select distinct on (t.id,p.class_key) t.id territory_id,p.class_key,p.interval_weeks,p.service_minutes
      from territories t join lateral (select x.org_unit_id from territory_ownerships x where x.territory_id=t.id and x.deleted_at is null and x.effective_from<=now() and (x.effective_to is null or x.effective_to>now()) limit 1) own on true
      cross join lateral (with recursive up(id,depth) as (select own.org_unit_id,0 union all select u.parent_id,depth+1 from up join org_units u on u.id=up.id where depth<20 and u.parent_id is not null) select * from up) up
      join outlet_class_visit_policies p on p.org_unit_id=up.id and p.effective_from<=now() and (p.effective_to is null or p.effective_to>now())
      where t.id in ${db(territoryIds)} order by t.id,p.class_key,up.depth`;
  const people =
    await db`select territory_id,count(distinct profile_id)::int n from territory_salespeople where territory_id in ${db(territoryIds)} and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now()) group by 1`;
  return { territories, stores, policies, people };
}

/** @param {any} f @param {{outletId:string,toTerritoryId:string}[]} moves @param {ReturnType<typeof assumptions>} a */
export function simulateFacts(f, moves, a) {
  const to = new Map(moves.map((m) => [m.outletId, m.toTerritoryId]));
  const peopleBy = new Map(
    f.people.map((/** @type {any} */ p) => [p.territory_id, p.n]),
  );
  /** @param {any} s @param {string} territoryId */
  const shape = (s, territoryId) => {
    // SEAM(MASTERS): today's class key; the destination's class frequency applies after a move.
    const pol = f.policies.find(
      (/** @type {any} */ p) =>
        p.territory_id === territoryId && p.class_key === s.classification,
    );
    return {
      lat: s.latitude,
      lon: s.longitude,
      potential: s.sales_potential == null ? null : Number(s.sales_potential),
      visits: pol
        ? 4 / pol.interval_weeks
        : Number(s.cycle_days) > 0
          ? 28 / Number(s.cycle_days)
          : a.visitsPer4Weeks,
      service: pol ? pol.service_minutes : a.serviceMinutes,
    };
  };
  return f.territories
    .map((/** @type {any} */ t) => {
      const before = f.stores.filter(
        (/** @type {any} */ s) => s.territory_id === t.id,
      );
      const after = f.stores.filter(
        (/** @type {any} */ s) => (to.get(s.id) ?? s.territory_id) === t.id,
      );
      const n = peopleBy.get(t.id) ?? 0;
      return {
        territoryId: t.id,
        name: t.name,
        before: workload(
          before.map((/** @type {any} */ s) => shape(s, t.id)),
          n,
          a,
        ),
        after: workload(
          after.map((/** @type {any} */ s) => shape(s, t.id)),
          n,
          a,
        ),
        movedIn: moves.filter((m) => m.toTerritoryId === t.id).length,
        movedOut: before.filter(
          (/** @type {any} */ s) => to.has(s.id) && to.get(s.id) !== t.id,
        ).length,
        pins: after
          .filter((/** @type {any} */ s) => s.latitude != null)
          .map((/** @type {any} */ s) => ({
            code: s.code,
            lat: s.latitude,
            lon: s.longitude,
            moved: to.has(s.id),
          })),
      };
    })
    .sort((/** @type {any} */ x, /** @type {any} */ y) =>
      x.name.localeCompare(y.name),
    );
}

/** @param {any} c @param {any} b @param {number|null} [from] */
async function build(c, b, from = null) {
  const a = assumptions(b.assumptions);
  if (!Array.isArray(b.moves) || b.moves.length < 1 || b.moves.length > 100)
    throw invalid("Move 1 to 100 stores");
  const moves = b.moves.map((/** @type {any} */ m) => ({
    outletId: required(m?.outletId, "Store", 64),
    toTerritoryId: required(m?.toTerritoryId, "Destination territory", 64),
  }));
  if (
    new Set(moves.map((/** @type {any} */ m) => m.outletId)).size !==
    moves.length
  )
    throw invalid("Each store moves once per scenario");
  const srcRows =
    await c.db`select id,territory_id from analytics_store_scope where id in ${c.db(moves.map((/** @type {any} */ m) => m.outletId))} and status='active'`;
  if (srcRows.length !== moves.length) throw invalid("Choose active stores");
  for (const m of moves) {
    const s = srcRows.find((/** @type {any} */ r) => r.id === m.outletId);
    if (!s.territory_id)
      throw invalid("A store without a territory cannot be moved here");
    if (s.territory_id === m.toTerritoryId)
      throw invalid("A store is already in that territory");
  }
  const ids = [
    ...new Set([
      ...srcRows.map((/** @type {any} */ r) => r.territory_id),
      ...moves.map((/** @type {any} */ m) => m.toTerritoryId),
    ]),
  ];
  if (ids.length > 20)
    throw invalid("A scenario touches at most 20 territories");
  const f = await facts(c, ids);
  if (from != null) {
    // Same rule the ORG writer enforces at publish: an approved/active plan holding the store or its
    // route locks membership until that plan ends. Say so now, with the first free day.
    const locked =
      await c.db`select o.name,max(p.effective_to) as until from coverage_plans p join coverage_plan_outlets x on x.plan_id=p.id
        join analytics_store_scope o on o.id in ${c.db(moves.map((/** @type {any} */ m) => m.outletId))} and (x.outlet_id=o.id or (o.route_id is not null and x.route_id=o.route_id))
        where p.deleted_at is null and p.status in ('approved','active') and p.effective_to>${new Date(from)} group by o.name order by o.name`;
    if (locked.length)
      throw conflict(
        `${locked.map((/** @type {any} */ l) => `${l.name} is in an approved coverage plan until ${dayText(l.until)}`).join("; ")}. Choose a start day after that.`,
        "plan_locked",
      );
  }
  const sim = simulateFacts(f, moves, a);
  // The publish must see the same current memberships it was simulated against.
  const fingerprint = hash(
    f.stores
      .map((/** @type {any} */ s) => [s.id, s.territory_id, s.assignment_id])
      .sort(),
  );
  return { a, moves, sim, fingerprint };
}

/** @param {any} ctx */
export async function simulateScenario(ctx) {
  await requireCapability(ctx, "outlet.assign");
  const r = await build(ctx, ctx.body ?? {});
  return { assumptions: r.a, territories: r.sim, provisionalTravel: true };
}

/** @param {any} ctx */
export async function saveScenario(ctx) {
  const b = ctx.body ?? {};
  const key = required(b.idempotencyKey, "Idempotency key", 100),
    name = required(b.name, "Scenario name", 120);
  const effectiveOn = required(b.effectiveOn, "Effective day", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveOn))
    throw invalid("Effective day must be YYYY-MM-DD");
  const request = hash({
    name,
    effectiveOn,
    moves: b.moves,
    assumptions: b.assumptions ?? null,
  });
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor),
      c = { ...ctx, db, actor };
    await requireCapability(c, "outlet.assign");
    const [old] =
      await db`select id,content_hash,request_hash from territory_scenarios where prepared_by=${actor.profileId} and client_key=${key}`;
    if (old) {
      if (old.request_hash !== request)
        throw conflict(
          "This key was already used for a different scenario",
          "idempotency_conflict",
        );
      return { id: old.id, contentHash: old.content_hash };
    }
    const today = manilaDate(ctx.now);
    if (effectiveOn <= today)
      throw invalid("A territory move starts tomorrow or later");
    const r = await build(c, b, Date.parse(effectiveOn + "T00:00:00+08:00"));
    const contentHash = hash({
      name,
      effectiveOn,
      moves: r.moves,
      assumptions: r.a,
      fingerprint: r.fingerprint,
    });
    const [s] =
      await db`insert into territory_scenarios(name,effective_on,assumptions,moves,simulation,input_fingerprint,content_hash,prepared_by,client_key,request_hash)
      values(${name},${effectiveOn},${r.a},${r.moves},${r.sim},${r.fingerprint},${contentHash},${actor.profileId},${key},${request}) returning id`;
    return { id: s.id, contentHash };
  });
}

/** A different person publishes through the ORG assignment writer. @param {any} ctx */
export async function publishScenario(ctx) {
  const b = ctx.body ?? {};
  return tx(ctx.db, async (t) => {
    await t`select pg_advisory_xact_lock(${ORG_LOCK})`;
    const actor = ctx.user ? await actorFor(t, ctx.user.id) : null;
    const c = { ...ctx, db: t, actor, now: Date.now() };
    await requireCapability(c, "outlet.assign");
    const [s] =
      await t`select * from territory_scenarios where id=${required(b.scenarioId, "Scenario", 64)}::uuid for update`;
    if (!s) throw notFound("Scenario not found");
    if (s.status === "published") {
      if (s.published_by === actor?.profileId)
        return {
          status: "published",
          assignments: uuidList(s.assignment_ids).length,
        };
      throw conflict("This scenario was already published");
    }
    if (s.status !== "draft") throw conflict("This scenario is not a draft");
    if (s.prepared_by === actor?.profileId)
      throw forbidden("A different person must publish this territory change");
    if (b.contentHash !== s.content_hash)
      throw conflict(
        "The scenario changed since you reviewed it",
        "stale_scenario",
      );
    const r = await build(c, { moves: s.moves, assumptions: s.assumptions });
    if (r.fingerprint !== s.input_fingerprint)
      throw conflict(
        "Territory memberships changed since the simulation: simulate again",
        "stale_scenario",
      );
    const from = Date.parse(dayText(s.effective_on) + "T00:00:00+08:00");
    if (from <= c.now)
      throw conflict("The effective day has passed: save a new scenario");
    // ORG owns membership: its writer re-checks scope, ownership cover and signed-plan locks.
    const ids = await assignmentCommand(c, "batchAssign", {
      assignments: s.moves.map((/** @type {any} */ m) => ({
        outletId: m.outletId,
        territoryId: m.toTerritoryId,
      })),
      effectiveFrom: from,
      reason: `F-224 territory scenario "${s.name}"`,
    });
    await t`update territory_scenarios set status='published',published_by=${actor?.profileId},published_at=now(),assignment_ids=${t.array(ids, "UUID")},updated_at=now() where id=${s.id}`;
    ctx.platform?.publish?.("coverage");
    return { status: "published", assignments: ids.length };
  });
}

/** The preparer withdraws a draft that will not be published. @param {any} ctx */
export async function discardScenario(ctx) {
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor);
    const [s] =
      await db`select * from territory_scenarios where id=${required(ctx.body?.scenarioId, "Scenario", 64)}::uuid for update`;
    if (!s) throw notFound("Scenario not found");
    if (s.prepared_by !== actor.profileId)
      throw forbidden("Only the preparer can discard a draft");
    if (s.status === "discarded") return { status: "discarded" };
    if (s.status !== "draft")
      throw conflict("A published scenario cannot be discarded");
    await db`update territory_scenarios set status='discarded',updated_at=now() where id=${s.id}`;
    ctx.platform?.publish?.("coverage");
    return { status: "discarded" };
  });
}

/** Bun.SQL returns uuid[] as Postgres array text; accept both. @param {any} v @returns {string[]} */
export function uuidList(v) {
  if (Array.isArray(v)) return v.map(String);
  return String(v ?? "")
    .replace(/[{}]/g, "")
    .split(",")
    .filter(Boolean);
}

/** @param {any} d */
function dayText(d) {
  return typeof d === "string"
    ? d.slice(0, 10)
    : new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** Scenarios whose territories the caller may change, plus pickers. @param {any} ctx */
export async function readScenarios(ctx) {
  await requireCapability(ctx, "report.read");
  const db = ctx.db;
  const role = ctx.actor?.role;
  const canPlan = !!role && roleHas(role, "outlet.assign");
  const territories =
    await db`select t.id,t.name,o.org_unit_id from territories t join lateral (select org_unit_id from territory_ownerships x where x.territory_id=t.id and x.deleted_at is null and x.effective_from<=now() and (x.effective_to is null or x.effective_to>now()) limit 1) o on true where t.deleted_at is null and t.status='active' order by t.name limit 500`;
  const mine = [];
  for (const t of territories) {
    try {
      await requireCapability(
        ctx,
        canPlan ? "outlet.assign" : "report.read",
        t.org_unit_id,
      );
      mine.push({ id: t.id, name: t.name });
    } catch {}
  }
  const ids = mine.map((t) => t.id);
  const stores = ids.length
    ? await db`select id,code,name,territory_id from analytics_store_scope where territory_id in ${db(ids)} and status='active' order by name limit 3000`
    : [];
  const rows =
    await db`select s.*,pp.name prepared_name,pb.name published_name from territory_scenarios s join profiles pp on pp.id=s.prepared_by left join profiles pb on pb.id=s.published_by order by s.created_at desc limit 50`;
  const visible = rows.filter((/** @type {any} */ s) =>
    s.simulation.every((/** @type {any} */ t) => ids.includes(t.territoryId)),
  );
  return {
    canPlan,
    me: ctx.actor?.profileId ?? null,
    defaults: DEFAULTS,
    territories: mine,
    stores: stores.map((/** @type {any} */ s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      territoryId: s.territory_id,
    })),
    scenarios: visible.map((/** @type {any} */ s) => ({
      id: s.id,
      name: s.name,
      effectiveOn: dayText(s.effective_on),
      status: s.status,
      moves: s.moves.length,
      preparedBy: s.prepared_name,
      preparedById: s.prepared_by,
      publishedBy: s.published_name,
      contentHash: s.content_hash,
      assumptions: s.assumptions,
      territories: s.simulation,
    })),
  };
}

/** @param {any} router */
export function installTerritoryScenarios(router) {
  router.get("/api/v1/coverage/territory-scenarios", (/** @type {any} */ c) =>
    readScenarios(c),
  );
  router.post(
    "/api/v1/coverage/territory-scenarios/simulate",
    (/** @type {any} */ c) => simulateScenario(c),
  );
  router.post(
    "/api/v1/coverage/territory-scenarios/save",
    (/** @type {any} */ c) => saveScenario(c),
  );
  router.post(
    "/api/v1/coverage/territory-scenarios/discard",
    (/** @type {any} */ c) => discardScenario(c),
  );
  router.post(
    "/api/v1/coverage/territory-scenarios/publish",
    (/** @type {any} */ c) => publishScenario(c),
  );
}
