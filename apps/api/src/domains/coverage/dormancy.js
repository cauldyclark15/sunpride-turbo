// F-210: dormancy is "no authoritative purchase across N of this outlet's own purchase/visit cycles".
// Cycle length comes from the effective PJP class frequency, then the outlet assignment cadence,
// then the effective dormancy policy fallback. The prior-period "lost" store insight stays separate.
import { tx } from "@sunpride/db/client";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { invalid, conflict, notFound } from "../../core/errors.js";
import { currentActor } from "../van/access.js";
import { scopeFor } from "../analytics/measures.js";
import { localDate, manilaDate, DAY, uuid } from "./model.js";
import { required } from "../org/model.js";

const hash = (/** @type {any} */ v) => sha256Hex(canonicalJson(v));
const KINDS = ["recovery_visit", "win_back_offer", "owner_review", "close"];
const day = (/** @type {any} */ d) => /** @type {string} */ (dayOrNull(d));
const dayOrNull = (/** @type {any} */ d) =>
  d == null
    ? null
    : typeof d === "string"
      ? d.slice(0, 10)
      : new Date(+d + 8 * 3600000).toISOString().slice(0, 10);
const daysBetween = (/** @type {string} */ a, /** @type {string} */ b) =>
  Math.round((localDate(b) - localDate(a)) / DAY);

/** @param {any} row */
export function dormancyPolicyHash(row) {
  return hash({
    orgUnitId: row.org_unit_id,
    version: row.version,
    label: row.label,
    sourceRef: row.source_ref,
    missedCycles: row.missed_cycles,
    fallbackCycleDays: row.fallback_cycle_days,
    effectiveFrom: +new Date(row.effective_from),
  });
}

/** Nearest effective policy on the unit or its effective ancestors. @param {any} db @param {string} unit @param {number} at */
export async function dormancyPolicyFor(db, unit, at) {
  const rows = await db`with recursive up(id,depth) as (
      select ${unit}::uuid,0
      union all select coalesce((select e.parent_id from org_unit_parent_edges e where e.unit_id=up.id and e.deleted_at is null and e.effective_from<=${new Date(at)} and (e.effective_to is null or e.effective_to>${new Date(at)}) order by e.effective_from desc limit 1),(select u.parent_id from org_units u where u.id=up.id)),depth+1
      from up where depth<20 and up.id is not null)
    select p.*,up.depth from dormancy_policies p join up on up.id=p.org_unit_id
    where p.effective_from<=${new Date(at)} and (p.effective_to is null or p.effective_to>${new Date(at)})
    order by up.depth limit 2`;
  const p = rows[0];
  if (!p) return null;
  if (dormancyPolicyHash(p) !== p.content_hash)
    throw conflict("The published dormancy policy changed");
  return p;
}

/** Cadence for one outlet, with its source named for the owner. @param {any} db @param {any} store @param {any} policy @param {number} at */
async function cycleFor(db, store, policy, at) {
  if (store.classification) {
    const [c] = await db`with recursive up(id,depth) as (
        select ${store.owner_unit_id}::uuid,0
        union all select (select u.parent_id from org_units u where u.id=up.id),depth+1 from up where depth<20 and up.id is not null)
      select p.interval_weeks from outlet_class_visit_policies p join up on up.id=p.org_unit_id
      where p.class_key=${store.classification} and p.effective_from<=${new Date(at)} and (p.effective_to is null or p.effective_to>${new Date(at)})
      order by up.depth limit 1`;
    // SEAM(MASTERS): outlets.classification is today's class key; MASTERS owns the effective history.
    if (c) return { days: c.interval_weeks * 7, source: "class_frequency" };
  }
  if (Number(store.cycle_days) > 0)
    return { days: Number(store.cycle_days), source: "outlet_cadence" };
  return { days: policy.fallback_cycle_days, source: "policy_fallback" };
}

/** Daily detection and recovery. Idempotent: one open case per outlet. @param {any} db @param {number} now */
export async function detectDormancy(db, now) {
  const today = manilaDate(now);
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(hashtextextended('coverage:dormancy-detect',0))`;
    // Authoritative included purchases: the same order-line facts every sales screen uses.
    const stores =
      await t`with last as (select store_id,max(service_date) as last_purchase from analytics_sales_facts where store_id is not null and sales_centavos>0 and service_date<=${today}::date group by store_id)
      select s.id,s.owner_unit_id,s.classification,s.cycle_days,l.last_purchase from analytics_store_scope s join last l on l.store_id=s.id
      where s.status='active' and s.owner_unit_id is not null order by s.id limit 50001`;
    if (stores.length > 50000)
      throw conflict("Dormancy detection exceeds 50,000 buying stores");
    const result = { evaluated: 0, opened: 0, recovered: 0, noPolicy: 0 };
    /** @type {Map<string,any>} */ const policies = new Map();
    for (const s of stores) {
      result.evaluated++;
      const last = day(s.last_purchase);
      const [open] =
        await t`select * from outlet_dormancy_cases where outlet_id=${s.id} and status='open' for update`;
      if (open && last && last > day(open.last_purchase_on)) {
        await t`update outlet_dormancy_cases set status='recovered',recovered_on=${today}::date,recovery_purchase_on=${last}::date,updated_at=now() where id=${open.id}`;
        result.recovered++;
        continue;
      }
      if (open) continue;
      if (!policies.has(s.owner_unit_id))
        policies.set(
          s.owner_unit_id,
          await dormancyPolicyFor(t, s.owner_unit_id, now),
        );
      const policy = policies.get(s.owner_unit_id);
      if (!policy) {
        result.noPolicy++;
        continue;
      }
      const cycle = await cycleFor(t, s, policy, now),
        missed = Math.floor(daysBetween(last, today) / cycle.days);
      if (missed < policy.missed_cycles) continue;
      // An owner-closed case for this same purchase gap is not reopened until a new purchase.
      const [closed] =
        await t`select 1 from outlet_dormancy_cases where outlet_id=${s.id} and status='closed' and last_purchase_on=${last}::date`;
      if (closed) continue;
      await t`insert into outlet_dormancy_cases(outlet_id,org_unit_id,policy_id,policy_version,policy_hash,cycle_days,cycle_source,threshold_cycles,missed_cycles,last_purchase_on,detected_on)
        values(${s.id},${s.owner_unit_id},${policy.id},${policy.version},${policy.content_hash},${cycle.days},${cycle.source},${policy.missed_cycles},${missed},${last}::date,${today}::date)`;
      result.opened++;
    }
    return result;
  });
}

/** @param {any} ctx @param {any} body */
export async function saveDormancyPolicy(ctx, body) {
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor),
      c = { ...ctx, db, actor },
      unit = uuid(body.orgUnitId);
    await requireCapability(c, "masterdata.manage", unit);
    const from = localDate(body.fromDate);
    if (from < localDate(manilaDate(ctx.now)))
      throw invalid("Dormancy policies cannot be backdated");
    const n = body.missedCycles,
      f = body.fallbackCycleDays;
    if (!Number.isSafeInteger(n) || n < 1 || n > 12)
      throw invalid("Missed cycles must be a whole number from 1 to 12");
    if (!Number.isSafeInteger(f) || f < 7 || f > 120)
      throw invalid("Fallback cycle must be 7 to 120 days");
    const label = required(body.label, "Policy label", 160),
      sourceRef = required(body.sourceRef, "Source or assumption", 500);
    await db`select pg_advisory_xact_lock(hashtextextended(${"dormancy-policy:" + unit},0))`;
    const rows =
      await db`select * from dormancy_policies where org_unit_id=${unit} order by version desc limit 1001 for update`;
    if (
      rows.some((/** @type {any} */ p) => +new Date(p.effective_from) >= from)
    )
      throw conflict("A policy already starts on or after that day");
    const row = {
      org_unit_id: unit,
      version: (rows[0]?.version ?? 0) + 1,
      label,
      source_ref: sourceRef,
      missed_cycles: n,
      fallback_cycle_days: f,
      effective_from: new Date(from),
    };
    if (rows[0] && rows[0].effective_to == null)
      await db`update dormancy_policies set effective_to=${new Date(from)},updated_at=now() where id=${rows[0].id}`;
    const [saved] =
      await db`insert into dormancy_policies(org_unit_id,version,label,source_ref,missed_cycles,fallback_cycle_days,content_hash,effective_from,created_by)
      values(${unit},${row.version},${label},${sourceRef},${n},${f},${dormancyPolicyHash(row)},${row.effective_from},${actor.profileId}) returning id,version`;
    return saved;
  });
}

/** @param {any} ctx @param {any} body */
export async function dormancyAction(ctx, body) {
  if (!KINDS.includes(body?.kind)) throw invalid("Choose a supported action");
  const key = required(body.idempotencyKey, "Idempotency key", 100),
    note = required(body.note, "Action note", 1000),
    request = hash({
      caseId: body.caseId,
      kind: body.kind,
      note,
      dueOn: body.dueOn ?? null,
    });
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor),
      c = { ...ctx, db, actor };
    await requireCapability(c, "dormancy.act");
    const [kase] =
      await db`select k.*,s.owner_unit_id from outlet_dormancy_cases k join analytics_store_scope s on s.id=k.outlet_id where k.id=${uuid(body.caseId)} for update of k`;
    if (!kase) throw notFound("Dormancy case not found");
    // Current persisted owner gates the action, never the unit recorded at detection.
    await requireCapability(c, "dormancy.act", kase.owner_unit_id);
    const [old] =
      await db`select * from outlet_dormancy_actions where actor_id=${actor.profileId} and client_key=${key}`;
    if (old) {
      if (old.request_hash !== request)
        throw conflict(
          "This action key was already used for a different action",
          "idempotency_conflict",
        );
      return { id: old.id, status: kase.status };
    }
    if (kase.status !== "open")
      throw conflict("This dormancy case is no longer open");
    let due = null;
    if (body.kind === "recovery_visit" || body.kind === "win_back_offer") {
      due = required(body.dueOn, "Due day", 10);
      if (localDate(due) < localDate(manilaDate(ctx.now)))
        throw invalid("The follow-up day cannot be in the past");
    }
    const [a] =
      await db`insert into outlet_dormancy_actions(case_id,kind,note,due_on,actor_id,client_key,request_hash)
      values(${kase.id},${body.kind},${note},${due},${actor.profileId},${key},${request}) returning id`;
    if (body.kind === "close")
      await db`update outlet_dormancy_cases set status='closed',closed_reason=${note},closed_by=${actor.profileId},closed_at=now(),updated_at=now() where id=${kase.id}`;
    ctx.platform?.publish?.("coverage");
    return { id: a.id, status: body.kind === "close" ? "closed" : "open" };
  });
}

/** Owner read: open cases first, with comparison, trend and the next action. @param {any} ctx */
export async function readDormancy(ctx) {
  return tx(ctx.db, async (db) => {
    const c = { ...ctx, db },
      s = await scopeFor(c),
      ids = s.ids.length ? s.ids : [null],
      today = manilaDate(ctx.now),
      from = manilaDate(ctx.now - 27 * DAY),
      priorFrom = manilaDate(ctx.now - 55 * DAY),
      trendFrom = manilaDate(ctx.now - 55 * DAY);
    const cases =
      await db`select k.*,s.name,s.code,s.territory_name,(select max(service_date) from analytics_sales_facts f where f.store_id=k.outlet_id and f.sales_centavos>0) as latest_purchase,
        (select coalesce(json_agg(json_build_object('kind',a.kind,'note',a.note,'dueOn',a.due_on,'actor',p.name,'at',a.created_at) order by a.created_at),'[]') from outlet_dormancy_actions a join profiles p on p.id=a.actor_id where a.case_id=k.id) as actions,
        (select min(service_date) from planned_visits v where v.outlet_id=k.outlet_id and v.status='planned' and v.deleted_at is null and v.service_date>=${today}::date) as next_visit
      from outlet_dormancy_cases k join analytics_store_scope s on s.id=k.outlet_id
      where s.owner_unit_id in ${db(ids)} and (${s.ownProfileId}::uuid is null or exists(select 1 from territory_salespeople ts where ts.territory_id=s.territory_id and ts.profile_id=${s.ownProfileId} and ts.deleted_at is null and ts.effective_from<=now() and (ts.effective_to is null or ts.effective_to>now()))) and (k.status='open' or k.detected_on>=${priorFrom}::date or k.recovered_on>=${priorFrom}::date)
      order by (k.status='open') desc,k.missed_cycles desc,k.last_purchase_on,k.id limit 2001`;
    if (cases.length > 2000)
      throw conflict(
        "Too many dormancy cases for one screen; choose a smaller area",
      );
    const count = (/** @type {(k:any)=>boolean} */ f) => cases.filter(f).length,
      inWindow = (
        /** @type {any} */ d,
        /** @type {string} */ a,
        /** @type {string} */ b,
      ) => d != null && day(d) >= a && day(d) <= b;
    const priorTo = manilaDate(ctx.now - 28 * DAY);
    const weeks = [];
    for (let w = localDate(trendFrom); w <= localDate(today); w += 7 * DAY) {
      const a = manilaDate(w),
        b = manilaDate(Math.min(w + 6 * DAY, localDate(today)));
      weeks.push({
        weekStart: a,
        opened: count((k) => inWindow(k.detected_on, a, b)),
        recovered: count((k) => inWindow(k.recovered_on, a, b)),
      });
    }
    const policies =
      await db`select p.*,u.name as unit_name,a.name as author from dormancy_policies p join org_units u on u.id=p.org_unit_id join profiles a on a.id=p.created_by where p.org_unit_id in ${db(ids)} and (p.effective_to is null or p.effective_to>now()) order by u.name,p.version desc limit 500`;
    return {
      asOf: today,
      canAct: roleHas(ctx.actor.role, "dormancy.act"),
      canConfigure: roleHas(ctx.actor.role, "masterdata.manage"),
      summary: {
        open: count((k) => k.status === "open"),
        openedLast28: count((k) => inWindow(k.detected_on, from, today)),
        openedPrior28: count((k) =>
          inWindow(k.detected_on, priorFrom, priorTo),
        ),
        recoveredLast28: count((k) => inWindow(k.recovered_on, from, today)),
        recoveredPrior28: count((k) =>
          inWindow(k.recovered_on, priorFrom, priorTo),
        ),
        withoutAction: count((k) => k.status === "open" && !k.actions.length),
      },
      trend: weeks,
      cases: cases.map((/** @type {any} */ k) => ({
        id: k.id,
        storeId: k.outlet_id,
        name: k.name,
        code: k.code,
        territory: k.territory_name ?? "Unassigned",
        status: k.status,
        lastPurchaseOn: day(k.last_purchase_on),
        missedCycles:
          k.status === "open"
            ? Math.floor(
                daysBetween(day(k.last_purchase_on), today) / k.cycle_days,
              )
            : k.missed_cycles,
        thresholdCycles: k.threshold_cycles,
        cycleDays: k.cycle_days,
        cycleSource: k.cycle_source,
        detectedOn: day(k.detected_on),
        recoveredOn: day(k.recovered_on),
        recoveryPurchaseOn: day(k.recovery_purchase_on),
        closedReason: k.closed_reason,
        nextVisit: day(k.next_visit),
        policyVersion: k.policy_version,
        actions: k.actions.map((/** @type {any} */ a) => ({
          ...a,
          dueOn: day(a.dueOn),
          at: +new Date(a.at),
        })),
      })),
      policies: policies.map((/** @type {any} */ p) => ({
        id: p.id,
        unitName: p.unit_name,
        version: p.version,
        label: p.label,
        sourceRef: p.source_ref,
        missedCycles: p.missed_cycles,
        fallbackCycleDays: p.fallback_cycle_days,
        from: +new Date(p.effective_from),
        to: p.effective_to ? +new Date(p.effective_to) : null,
        author: p.author,
      })),
      units: (
        await db`select id,name from org_units where id in ${db(ids)} and deleted_at is null and status='active' order by name limit 500`
      ).map((/** @type {any} */ u) => ({ id: u.id, name: u.name })),
    };
  });
}

/** @param {any} router @param {any} platform */
export function installDormancy(router, platform) {
  router.get(
    "/api/v1/coverage/dormancy",
    (/** @type {any} */ c) => readDormancy(c),
    { auth: "required" },
  );
  router.post(
    "/api/v1/coverage/dormancy/policy",
    (/** @type {any} */ c) => saveDormancyPolicy(c, c.body ?? {}),
    { auth: "required" },
  );
  router.post(
    "/api/v1/coverage/dormancy/action",
    (/** @type {any} */ c) => dormancyAction({ ...c, platform }, c.body ?? {}),
    { auth: "required" },
  );
  router.post(
    "/api/v1/coverage/dormancy/detect",
    async (/** @type {any} */ c) => {
      await tx(c.db, async (db) => {
        const actor = await currentActor(db, c.actor);
        await requireCapability({ ...c, db, actor }, "masterdata.manage");
      });
      const r = await detectDormancy(c.db, c.now);
      await platform.publish?.("coverage");
      return r;
    },
    { auth: "required" },
  );
  platform.registerJob("coverage.dormancy", async () => {
    await detectDormancy(platform.db, Date.now());
    await platform.publish?.("coverage");
  });
  // After the 00:30 analytics rebuild, so the sales facts it reads are current.
  platform.scheduler?.daily?.(
    "01:10",
    "Asia/Manila",
    "coverage.dormancy",
    async (/** @type {any} */ ctx) => {
      await detectDormancy(ctx.db, Date.now());
      await platform.publish?.("coverage");
    },
  );
}
