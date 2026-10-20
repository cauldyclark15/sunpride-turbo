// SEAM(AVAILABILITY): replace this source/policy adapter with the governed F-220 reader at integration.
import { ApiError } from "../../core/errors.js";
import { addDays, pct, dateOf, kpi } from "./measures.js";
import { readStores, readVisits, visitSummary, readPeople } from "./data.js";
import { readSales } from "./measures.js";

/** F-602 canonical stocking and turnover-weighted distribution, shared with stock and S&OP.
 * @param {any[]} stores @param {Map<string,any>} observation @param {Map<string,number>} weight @param {string} productId */
export function distributionFor(stores, observation, weight, productId) {
  const checked = stores.filter((o) =>
    ["available", "low_stock", "out_of_stock", "not_carried"].includes(
      observation.get(`${o.id}:${productId}`)?.status,
    ),
  );
  const stocking = stores.filter((o) =>
    ["available", "low_stock"].includes(
      observation.get(`${o.id}:${productId}`)?.status,
    ),
  );
  const complete = checked.length === stores.length && stores.length > 0;
  const totalWeight = stores.every((o) => weight.has(o.id))
    ? stores.reduce((n, o) => n + (weight.get(o.id) ?? 0), 0)
    : null;
  return {
    productId,
    universe: stores.length,
    measured: checked.length,
    unmeasured: stores.length - checked.length,
    stocking: stocking.length,
    numericDistributionPct: complete
      ? pct(stocking.length, stores.length)
      : null,
    stockingObservedPct: pct(stocking.length, stores.length),
    weightedDistributionPct:
      complete && totalWeight !== null
        ? pct(
            stocking.reduce((n, o) => n + (weight.get(o.id) ?? 0), 0),
            totalWeight,
          )
        : null,
  };
}

/** F-602 SEAM(AVAILABILITY): replace this local adapter with F-220's governed reader at integration.
 * Stocking != buying. Missing/stale observations never become a measured absence.
 * Strict ND/WD/OSA stay unknown until their whole denominator is measured.
 * @param {any} db @param {any} p @param {any} s */
export async function availabilityModel(db, p, s) {
  s.availabilityReads ??= new Map();
  const key = JSON.stringify([p.from, p.to, p.channel, s.ownProfileId]);
  if (s.availabilityReads.has(key)) return s.availabilityReads.get(key);
  const work = load(db, p, s);
  s.availabilityReads.set(key, work);
  return work;
}
/** @param {any} db @param {any} p @param {any} s */
async function load(db, p, s) {
  const stores = (await readStores(db, s, p.channel)).filter(
    (/** @type {any} */ o) => o.status === "active",
  );
  const ids = stores.map((/** @type {any} */ o) => o.id),
    end = p.to + "T23:59:59.999+08:00";
  const [policies, assigned, weights] = await Promise.all([
    db`select distinct on(org_unit_id) * from analytics_cockpit_policies where org_unit_id in ${db(s.ids.length ? s.ids : [null])} and effective_from<=${end} and (effective_to is null or effective_to>${end}) order by org_unit_id,effective_from desc`,
    db`select a.outlet_id,ap.product_id from outlet_assortments a join outlet_assortment_products ap on ap.outlet_assortment_id=a.id and ap.deleted_at is null where a.outlet_id in ${db(ids.length ? ids : [null])} and a.deleted_at is null and a.effective_from<=${end} and (a.effective_to is null or a.effective_to>${end})`,
    db`select outlet_id,turnover_centavos,source_ref from analytics_turnover_weights where outlet_id in ${db(ids.length ? ids : [null])} and effective_from<=${end} and (effective_to is null or effective_to>${end})`,
  ]);
  // No policy means setup required, not a hidden default.
  const freshness = Math.max(
    0,
    ...policies.map((/** @type {any} */ r) => r.freshness_days),
  );
  const observations = freshness
    ? await db`select distinct on(a.outlet_id,a.product_id) a.*,audit.assignee_profile_id from merchandising_availability a
    join merchandising_audits audit on audit.id=a.audit_id and audit.deleted_at is null
    where a.deleted_at is null and a.outlet_id in ${db(ids.length ? ids : [null])} and a.org_unit_id in ${db(s.ids.length ? s.ids : [null])}
    and a.service_date between ${addDays(p.to, -freshness + 1)} and ${p.to}
    and (${s.ownProfileId}::uuid is null or audit.assignee_profile_id=${s.ownProfileId})
    order by a.outlet_id,a.product_id,a.service_date desc,a.created_at desc,a.id desc`
    : [];
  const fresh = observations.filter((/** @type {any} */ a) => {
    const o = stores.find((/** @type {any} */ o) => o.id === a.outlet_id);
    const policy = policies.find(
      (/** @type {any} */ r) => r.org_unit_id === o?.owner_unit_id,
    );
    return (
      policy &&
      dateOf(a.service_date) >= addDays(p.to, 1 - policy.freshness_days)
    );
  });
  const present = (/** @type {any} */ a) =>
    ["available", "low_stock"].includes(a?.status);
  const measured = (/** @type {any} */ a) =>
    ["available", "low_stock", "out_of_stock", "not_carried"].includes(
      a?.status,
    );
  const observation = new Map(
    fresh.map((/** @type {any} */ a) => [`${a.outlet_id}:${a.product_id}`, a]),
  );
  const weight = new Map(
    weights.map((/** @type {any} */ w) => [
      w.outlet_id,
      Number(w.turnover_centavos),
    ]),
  );
  const products = [
    ...new Set([
      ...assigned.map((/** @type {any} */ a) => a.product_id),
      ...fresh.map((/** @type {any} */ a) => a.product_id),
    ]),
  ];
  const labels =
    await db`select id,name from products where id in ${db(products.length ? products : [null])}`;
  const distribution = products.map((productId) => ({
    ...distributionFor(stores, observation, weight, productId),
    label:
      labels.find((/** @type {any} */ p) => p.id === productId)?.name ??
      "Unknown product",
  }));
  const rows = stores.map((/** @type {any} */ o) => {
    const lines = assigned.filter(
      (/** @type {any} */ a) => a.outlet_id === o.id,
    );
    const checked = lines.filter((/** @type {any} */ a) =>
      measured(observation.get(`${o.id}:${a.product_id}`)),
    );
    const stocked = lines.filter((/** @type {any} */ a) =>
      present(observation.get(`${o.id}:${a.product_id}`)),
    );
    return {
      storeId: o.id,
      label: o.name,
      territoryId: o.territory_id,
      territory: o.territory_name ?? "Unassigned",
      required: lines.length,
      checked: checked.length,
      available: stocked.length,
      osa:
        lines.length && checked.length === lines.length
          ? pct(stocked.length, lines.length)
          : null,
      observedOsa: pct(stocked.length, checked.length),
      completenessPct: pct(checked.length, lines.length),
      frequencyTarget: Math.ceil(p.days / Number(o.cycle_days ?? 7)),
    };
  });
  const required = rows.reduce(
      (/** @type {number} */ n, /** @type {any} */ r) => n + r.required,
      0,
    ),
    checked = rows.reduce(
      (/** @type {number} */ n, /** @type {any} */ r) => n + r.checked,
      0,
    ),
    available = rows.reduce(
      (/** @type {number} */ n, /** @type {any} */ r) => n + r.available,
      0,
    );
  return {
    rows,
    distribution,
    observations: fresh,
    required,
    checked,
    osa: required > 0 && checked === required ? pct(available, required) : null,
    completenessPct: pct(checked, required),
    setupRequired: !policies.length,
    definitionVersion: "commercial/v1",
    definition:
      "ND: fresh observed stocking outlets / validated universe; WD: same stocking weighted by governed outlet turnover. OSA: available assigned MSL lines / all assigned MSL lines, unknown until fully measured.",
  };
}
/** F-602 one national → territory → rep → outlet dataset, reusing canonical visits/sales.
 * @param {any} ctx @param {any} p @param {any} s */
export async function coverageAvailabilityPage(ctx, p, s) {
  const profile = ctx.url.searchParams.get("profileId");
  const people = await readPeople(ctx.db, s, p.channel);
  if (
    profile &&
    !people.some((/** @type {any} */ person) => person.id === profile)
  )
    throw new ApiError(
      "out_of_scope",
      403,
      "This person is outside your team.",
    );
  const scope = profile ? { ...s, ownProfileId: profile } : s;
  const [av, facts, sales, prior, priorVisits] = await Promise.all([
    availabilityModel(ctx.db, p, scope),
    readVisits(ctx.db, p, scope),
    readSales(ctx.db, p, scope, "store"),
    availabilityModel(ctx.db, { ...p, ...p.compare }, scope),
    readVisits(ctx.db, { ...p, ...p.compare }, scope),
  ]);
  const rows = av.rows.map((/** @type {any} */ o) => {
    const visits = facts.visits.filter(
      (/** @type {any} */ v) => v.outlet_id === o.storeId,
    );
    const planned = facts.planned.filter(
      (/** @type {any} */ v) => v.outlet_id === o.storeId,
    );
    const v = visitSummary({ visits, planned, coaching: [] });
    return {
      ...o,
      visited: v.visited,
      covered: visits.some((/** @type {any} */ v) => v.closed),
      billed:
        (sales.rows.find((/** @type {any} */ r) => r.key === o.storeId)
          ?.sales ?? 0) > 0,
      adherence: v.compliance,
      frequencyAchieved: visits.filter((/** @type {any} */ v) => v.closed)
        .length,
      strikeRatePct: v.strikeRate,
      priorOsa:
        prior.rows.find((/** @type {any} */ old) => old.storeId === o.storeId)
          ?.osa ?? null,
      nextAction:
        o.osa === null
          ? "Complete shelf checks"
          : o.osa < 100
            ? "Restore missing lines"
            : v.missed
              ? "Recover missed call"
              : "Maintain coverage",
    };
  });
  const covered = rows.filter((/** @type {any} */ r) => r.covered).length;
  const priorCovered = new Set(
    priorVisits.visits
      .filter((/** @type {any} */ v) => v.closed)
      .map((/** @type {any} */ v) => v.outlet_id),
  ).size;
  const trend = [];
  // Bounded last 13 weekly as-of snapshots; never infer a missing measurement as zero.
  for (let i = 12; i >= 0; i--) {
    const date = addDays(p.to, -7 * i);
    if (date < p.from) continue;
    const point = await availabilityModel(ctx.db, { ...p, to: date }, scope);
    trend.push({
      date,
      osa: point.osa,
      completenessPct: point.completenessPct,
    });
  }
  return {
    ...av,
    observations: undefined,
    rows,
    people: people
      .filter((/** @type {any} */ person) => person.role === "sales")
      .map((/** @type {any} */ person) => ({
        id: person.id,
        label: person.name,
      })),
    universe: rows.length,
    covered,
    billed: rows.filter((/** @type {any} */ r) => r.billed).length,
    kpis: [
      kpi(
        "universe",
        "Validated outlet universe",
        rows.length,
        "count",
        null,
        prior.rows.length,
        "Active currently authorized outlets; accounting customers are not outlets.",
      ),
      kpi(
        "coverage",
        "Covered universe",
        pct(covered, rows.length),
        "pct",
        100,
        pct(priorCovered, prior.rows.length),
        "Distinct outlets with completed calls / validated outlet universe.",
      ),
      kpi(
        "osa",
        "On-shelf availability",
        av.osa,
        "pct",
        100,
        prior.osa,
        av.definition,
      ),
      kpi(
        "completeness",
        "MSL measurement completeness",
        av.completenessPct,
        "pct",
        100,
        prior.completenessPct,
        "Fresh assigned MSL checks / all assigned MSL lines. Missing checks are unknown availability.",
      ),
    ],
    trend,
  };
}
