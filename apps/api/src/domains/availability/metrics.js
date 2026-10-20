import { invalid } from "../../core/errors.js";
import { readStores, readVisits } from "../analytics/data.js";
import { kpi, pct, dates } from "../analytics/measures.js";
import { dateOf, midnight, bounded } from "../fieldsync/model.js";
import { accessOutlet, uuid, text, date } from "../visits/shared.js";
import { releasesAt, manage, markSample, audit } from "./masters.js";
import { distribution, ids, quantity, stocking } from "./rules.js";
import { orderFacts } from "./calls.js";

/** F-214: publication freezes eligibility and weight inputs. Zero/missing weights remain unknown.
 * @param {any} ctx */
export async function createUniverse(ctx) {
  await manage(ctx);
  const p = ctx.body;
  date(p.serviceDate);
  if (
    !Array.isArray(p.members) ||
    !p.members.length ||
    p.members.length > 10000 ||
    typeof p.sample !== "boolean"
  )
    throw invalid("Choose 1–10,000 validated stores");
  ids(
    p.members.map((/** @type {any} */ m) => m.outletId),
    10000,
  );
  const members = [];
  for (const m of p.members) {
    const { outlet } = await accessOutlet(ctx, m.outletId, "masterdata.manage");
    // SEAM(MASTERS): F-011 validated census is the authority. Legacy approved
    // enrolments qualify; marked sample census may explicitly demonstrate the flow.
    const [marked] =
      await ctx.db`select 1 from sample_data_rows where table_name='outlets' and row_id=${outlet.id} limit 1`;
    if (
      outlet.status !== "active" ||
      (outlet.enrolment_status !== "approved" && !(p.sample && marked))
    )
      throw invalid("Universe contains an unvalidated or inactive store");
    const weight = m.turnoverWeight == null ? null : quantity(m.turnoverWeight);
    if (weight === 0)
      throw invalid("Turnover weight must be positive or unknown");
    members.push({
      outletId: outlet.id,
      turnoverWeight: weight,
      validationRef: text(m.validationRef, 300),
    });
  }
  const [row] =
    await ctx.db`insert into availability_universes(label,service_date,members,source_ref,sample,actor_subject) values (${text(p.label, 160)},${p.serviceDate},${members},${text(p.sourceRef, 300)},${p.sample},${ctx.actor.subject}) returning id`;
  if (p.sample)
    await markSample(
      ctx.db,
      "availability_universes",
      row.id,
      `universe-${row.id}`,
    );
  await audit(ctx, "availability.universe_published", row.id);
  ctx.publish("analytics");
  return { id: row.id, count: members.length };
}
/** @param {any} db @param {any} p @param {any} s */
async function metrics(db, p, s) {
  const [universe] =
    await db`select * from availability_universes where service_date<=${p.to} order by sample asc,service_date desc,created_at desc,id desc limit 1`;
  if (!universe)
    return {
      universe: null,
      rows: [],
      depths: [],
      required: 0,
      checked: 0,
      present: 0,
      osa: null,
      completeness: null,
      covered: 0,
      frequencyAchieved: null,
      billed: null,
      callMetrics: [],
      billedStatus: "SAP billing feed unknown",
      calls: 0,
      strike: null,
      linesPerCall: null,
      nd: null,
      wd: null,
      trend: dates(p.from, p.to).map((date) => ({
        date,
        osa: null,
        completeness: null,
      })),
    };
  const stores = await readStores(db, s, p.channel),
    byId = new Map(stores.map((/** @type {any} */ o) => [o.id, o]));
  const rules = await releasesAt(db, "rules", midnight(p.to) + 86_400_000 - 1);
  const policy = rules.length === 1 ? rules[0].payload : null;
  const fresh =
    !!policy &&
    !!universe &&
    midnight(p.to) - midnight(dateOf(universe.service_date)) <=
      policy.universeFreshnessDays * 86_400_000;
  const members =
    universe?.members.filter((/** @type {any} */ m) => byId.has(m.outletId)) ??
    [];
  const outletIds = members.map((/** @type {any} */ m) => m.outletId);
  const checks = outletIds.length
    ? bounded(
        await db`select c.* from availability_checks c join analytics_people pe on pe.id=c.profile_id
    where c.outlet_id in ${db(outletIds)} and c.device_time<${new Date(midnight(p.to) + 86_400_000)}
      and c.org_unit_id in ${db(s.ids.length ? s.ids : [null])} and pe.current_unit_id in ${db(s.ids.length ? s.ids : [null])}
      and (${s.ownProfileId}::uuid is null or c.profile_id=${s.ownProfileId})
    order by device_time desc,id desc limit 30001`,
        30000,
      )
    : [];
  const productIds = new Set(
    checks.flatMap((/** @type {any} */ c) =>
      c.lines.map((/** @type {any} */ l) => l.productId),
    ),
  );
  for (const r of await releasesAt(db, "msl", midnight(p.to) + 86_400_000 - 1))
    for (const l of r.payload.lines) productIds.add(l.productId);
  const products = productIds.size
    ? await db`select id,code,name from products where id in ${db([...productIds])} and deleted_at is null`
    : [];
  /** @type {any[]} */ const rows = [];
  for (const product of products) {
    const observed = new Map();
    for (const c of checks) {
      if (
        !policy ||
        midnight(p.to) + 86_400_000 - new Date(c.device_time).getTime() >
          policy.freshnessDays * 86_400_000
      )
        continue;
      const l = c.lines.find(
        (/** @type {any} */ l) => l.productId === product.id,
      );
      // Latest explicit not_checked supersedes an older present answer too.
      if (l && !observed.has(c.outlet_id)) observed.set(c.outlet_id, l);
    }
    const d = distribution(members, observed);
    rows.push({
      productId: product.id,
      code: product.code,
      name: product.name,
      ...d,
      ndPct: fresh ? d.ndPct : null,
      wdPct: fresh ? d.wdPct : null,
      shelfGaps: members
        .filter(
          (/** @type {any} */ m) =>
            observed.get(m.outletId)?.state !== "present",
        )
        .map((/** @type {any} */ m) => ({
          outletId: m.outletId,
          name: byId.get(m.outletId)?.name,
          state: observed.get(m.outletId)?.state ?? "unknown",
          backroomBase: observed.get(m.outletId)?.backroomBase ?? null,
        })),
      gaps: members
        .filter(
          (/** @type {any} */ m) => stocking(observed.get(m.outletId)) !== true,
        )
        .map((/** @type {any} */ m) => ({
          outletId: m.outletId,
          name: byId.get(m.outletId)?.name,
          state:
            stocking(observed.get(m.outletId)) == null ? "unknown" : "absent",
        })),
    });
  }
  const periodChecks = checks.filter(
    (/** @type {any} */ c) => dateOf(c.service_date) >= p.from,
  );
  // Last checklist per physical call, not one favorable SKU at a time.
  const calls = new Map();
  for (const c of periodChecks)
    if (!calls.has(`${c.profile_id}:${c.call_key}`))
      calls.set(`${c.profile_id}:${c.call_key}`, c);
  const lastChecks = [...calls.values()];
  const required = lastChecks.reduce((n, c) => n + c.required_count, 0),
    checked = lastChecks.reduce((n, c) => n + c.checked_count, 0),
    present = lastChecks.reduce((n, c) => n + c.present_count, 0);
  const facts = await readVisits(db, p, s),
    orders = await orderFacts(db, outletIds, s, p.from, p.to);
  const completed = facts.visits.filter(
    (/** @type {any} */ v) =>
      v.closed && byId.has(v.outlet_id) && outletIds.includes(v.outlet_id),
  );
  const completedIds = new Set(completed.map((/** @type {any} */ v) => v.id));
  const linkedLines = orders.filter(
    (/** @type {any} */ l) => l.visit_id && completedIds.has(l.visit_id),
  );
  const orderedCalls = new Set(
    linkedLines.map((/** @type {any} */ l) => l.visit_id),
  );
  const covered = new Set(completed.map((/** @type {any} */ v) => v.outlet_id));
  // SEAM(CALLFLOW): a non-void POS checkout is the van's completed physical call.
  // callKey is the frozen sale/cart identity; multiple SKU lines are not multiple calls.
  const vanCalls = new Map();
  for (const line of orders.filter(
    (/** @type {any} */ l) => l.source === "van",
  )) {
    covered.add(line.outlet_id);
    if (!vanCalls.has(line.order_id))
      vanCalls.set(line.order_id, {
        profileId: line.profile_id,
        territoryId: byId.get(line.outlet_id)?.territory_id,
        orders: 1,
        lines: 0,
      });
    vanCalls.get(line.order_id).lines++;
  }
  const totalCalls = completed.length + vanCalls.size;
  const totalOrderedCalls = orderedCalls.size + vanCalls.size;
  const totalOrderLines =
    linkedLines.length +
    [...vanCalls.values()].reduce((n, c) => n + c.lines, 0);
  const frequencies = members.map((/** @type {any} */ m) => ({
    outletId: m.outletId,
    planned: facts.planned.filter(
      (/** @type {any} */ v) => v.outlet_id === m.outletId,
    ).length,
    actual:
      completed.filter((/** @type {any} */ v) => v.outlet_id === m.outletId)
        .length +
      new Set(
        orders
          .filter(
            (/** @type {any} */ l) =>
              l.source === "van" && l.outlet_id === m.outletId,
          )
          .map((/** @type {any} */ l) => l.order_id),
      ).size,
  }));
  const scheduled = frequencies.filter((/** @type {any} */ f) => f.planned > 0);
  const depths = members.map((/** @type {any} */ m) => ({
    ...frequencies.find((/** @type {any} */ f) => f.outletId === m.outletId),
    outletId: m.outletId,
    name: byId.get(m.outletId)?.name,
    stockedSkus: rows.filter(
      (r) => !r.gaps.some((/** @type {any} */ g) => g.outletId === m.outletId),
    ).length,
    unknownSkus: rows.filter((r) =>
      r.gaps.some(
        (/** @type {any} */ g) =>
          g.outletId === m.outletId &&
          ["unknown", "not_checked"].includes(g.state),
      ),
    ).length,
    boughtSkus: new Set(
      orders
        .filter((/** @type {any} */ o) => o.outlet_id === m.outletId)
        .map((/** @type {any} */ o) => o.product_id),
    ).size,
  }));
  return {
    universe: universe
      ? {
          id: universe.id,
          label: universe.label,
          date: dateOf(universe.service_date),
          sourceRef: universe.source_ref,
          sample: universe.sample,
          fresh,
          members: members.length,
        }
      : null,
    rows,
    depths,
    required,
    checked,
    present,
    osa: checked ? pct(present, required) : null,
    completeness: pct(checked, required),
    covered: covered.size,
    frequencyAchieved: pct(
      scheduled.filter((/** @type {any} */ f) => f.actual >= f.planned).length,
      scheduled.length,
    ),
    billed: null,
    // SEAM(SAP): authoritative billing must supply physical outlet invoice facts.
    // Local orders and van receipts are NOT relabelled as SAP-billed outlets.
    callMetrics: [
      ...completed.map((/** @type {any} */ v) => ({
        profileId: v.assignee_profile_id,
        territoryId: v.territory_id,
        orders: orderedCalls.has(v.id) ? 1 : 0,
        lines: linkedLines.filter((/** @type {any} */ l) => l.visit_id === v.id)
          .length,
      })),
      ...vanCalls.values(),
    ],
    billedStatus: "SAP billing feed unknown",
    calls: totalCalls,
    strike: pct(totalOrderedCalls, totalCalls),
    linesPerCall: totalCalls
      ? Math.round((totalOrderLines / totalCalls) * 10) / 10
      : null,
    nd:
      rows.length && rows.every((r) => r.ndPct != null)
        ? Math.round(
            (rows.reduce((n, r) => n + r.ndPct, 0) / rows.length) * 10,
          ) / 10
        : null,
    wd:
      rows.length && rows.every((r) => r.wdPct != null)
        ? Math.round(
            (rows.reduce((n, r) => n + r.wdPct, 0) / rows.length) * 10,
          ) / 10
        : null,
    trend: dates(p.from, p.to).map((day) => {
      const a = lastChecks.filter((c) => dateOf(c.service_date) === day);
      return {
        date: day,
        osa: pct(
          a.reduce((n, c) => n + c.present_count, 0),
          a.reduce((n, c) => n + c.required_count, 0),
        ),
        completeness: pct(
          a.reduce((n, c) => n + c.checked_count, 0),
          a.reduce((n, c) => n + c.required_count, 0),
        ),
      };
    }),
  };
}
/** F-220 extends the existing coverage response, never a second dashboard.
 * @param {any} ctx @param {any} p @param {any} s */
export async function coverageAvailability(ctx, p, s) {
  const now = await metrics(ctx.db, p, s),
    prior = await metrics(ctx.db, { ...p, ...p.compare }, s);
  const cards = [
    kpi(
      "validatedUniverse",
      "Validated universe",
      now.universe?.members ?? null,
      "count",
      null,
      prior.universe?.members ?? null,
      "Validated physical outlets in the single published universe, filtered by current ownership.",
    ),
    kpi(
      "coveredUniverse",
      "Covered universe",
      now.universe ? now.covered : null,
      "count",
      now.universe?.members ?? null,
      prior.universe ? prior.covered : null,
      "Distinct universe outlets with completed calls in the period.",
    ),
    kpi(
      "billedUniverse",
      "SAP-billed universe",
      null,
      "count",
      null,
      null,
      "Distinct universe outlets with SAP invoice evidence. Unknown until the billing seam is connected.",
    ),
    kpi(
      "frequencyAchieved",
      "Visit frequency achieved",
      now.frequencyAchieved,
      "pct",
      100,
      prior.frequencyAchieved,
      "Universe outlets meeting their approved-period planned visit frequency, divided by universe outlets with at least one planned visit. Actual field calls and non-void van checkouts count; adherence remains the existing plan-specific MCP measure. SEAM(COVERAGE).",
    ),
    kpi(
      "numericDistribution",
      "Numeric distribution",
      now.nd,
      "pct",
      null,
      prior.nd,
      "Mean SKU stocking-outlet share of the same validated universe. Unknown while stocking observations are missing or stale.",
    ),
    kpi(
      "weightedDistribution",
      "Weighted distribution",
      now.wd,
      "pct",
      null,
      prior.wd,
      "Mean SKU share of universe turnover weights at stocking outlets. Unknown with missing observations or weights.",
    ),
    kpi(
      "osa",
      "On-shelf availability",
      now.osa,
      "pct",
      100,
      prior.osa,
      "Present MSL lines divided by all required frozen MSL lines. Unchecked lines remain in the denominator.",
    ),
    kpi(
      "osaCompleteness",
      "MSL lines checked",
      now.completeness,
      "pct",
      100,
      prior.completeness,
      "Measured present or absent lines divided by every required MSL line.",
    ),
  ];
  return {
    cards,
    details: { ...now, prior: { nd: prior.nd, wd: prior.wd, osa: prior.osa } },
    orderStrike: kpi(
      "strikeRate",
      "Order strike rate",
      now.strike,
      "pct",
      null,
      prior.strike,
      "Completed physical calls producing a captured, non-void order divided by completed calls. Separate from governed productivity.",
    ),
    callLines: kpi(
      "linesPerCall",
      "Lines per call",
      now.linesPerCall,
      "count",
      null,
      prior.linesPerCall,
      "Captured order lines explicitly linked to completed calls divided by those same calls.",
    ),
  };
}
/** F-216: target cohort, first order/repeat milestones, and cumulative build vs dated plan.
 * @param {any} ctx @param {any} s @param {string} id @param {string} to */
export async function launchStatus(ctx, s, id, to) {
  const [launch] =
    await ctx.db`select * from availability_releases where id=${uuid(id)} and kind='launch' and status='published'`;
  if (!launch) throw invalid("Choose a published launch");
  const stores = await readStores(ctx.db, s, null),
    visible = new Map(stores.map((/** @type {any} */ o) => [o.id, o]));
  const targets = launch.payload.outletIds.filter((/** @type {string} */ id) =>
    visible.has(id),
  );
  const start = dateOf(launch.effective_from);
  const facts = (await orderFacts(ctx.db, targets, s, start, to)).filter(
    (/** @type {any} */ f) => launch.payload.productIds.includes(f.product_id),
  );
  const rows = targets.map((/** @type {string} */ outletId) => {
    const orders = [
      ...new Set(
        facts
          .filter((/** @type {any} */ f) => f.outlet_id === outletId)
          .map((/** @type {any} */ f) => f.order_id),
      ),
    ];
    const days = facts
      .filter((/** @type {any} */ f) => f.outlet_id === outletId)
      .map((/** @type {any} */ f) => dateOf(f.service_date))
      .sort();
    return {
      outletId,
      name: visible.get(outletId)?.name,
      firstOrderDate: days[0] ?? null,
      repeatPurchase: orders.length > 1,
      orders: orders.length,
    };
  });
  return {
    id: launch.id,
    label: launch.label,
    sample: launch.sample,
    targets: targets.length,
    rows,
    curve: launch.payload.buildTargets.map((/** @type {any} */ t) => ({
      date: t.date,
      plan: t.outlets,
      actual:
        t.date > to
          ? null
          : rows.filter(
              (/** @type {any} */ r) =>
                r.firstOrderDate && r.firstOrderDate <= t.date,
            ).length,
    })),
    scopeNarrowed: targets.length !== launch.payload.outletIds.length,
  };
}
