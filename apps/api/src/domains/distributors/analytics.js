import {
  date,
  dayAdd,
  digest,
  fail,
  integer,
  master,
  policy,
  text,
  today,
  uuid,
} from "./model.js";

/** @param {any} v */
const day = (v) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
/** @param {any} c @param {string} id @param {string} from @param {string} to */
export async function feedCoverage(c, id, from, to) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const [secondary] =
    await c.db`select count(*)::integer as n from generate_series(${from}::date,${to}::date,interval '1 day') day where exists(select 1 from distributor_ingest_runs r where r.distributor_id=${id} and r.complete and day::date between r.period_from and r.period_to and not exists(select 1 from distributor_staging_lines s where s.run_id=r.id and s.status not in ('posted','duplicate')))`;
  const [primary] =
    await c.db`select count(*)::integer as n from generate_series(${from}::date,${to}::date,interval '1 day') day where exists(select 1 from distributor_primary_feed_receipts r where r.distributor_id=${id} and day::date between r.period_from and r.period_to)`;
  return {
    days,
    secondaryDays: secondary.n,
    primaryDays: primary.n,
    secondaryComplete: secondary.n === days,
    primaryComplete: primary.n === days,
  };
}
/** F-411: complete declared snapshots, net distributor offtake, no-sales ≠ zero DOI.
 * @param {any} c @param {any} d */
export async function stockHealth(c, d) {
  const p = await policy(c, d.id),
    end = today(c.now),
    window = integer(p.doiWindowDays, 1, 366),
    start = dayAdd(end, 1 - window),
    priorStart = dayAdd(start, -window);
  const [decl] =
    await c.db`select * from distributor_stock_declarations where distributor_id=${d.id} order by stock_date desc,revision desc limit 1`;
  const stocks = decl
    ? await c.db`select l.product_id,l.location_id,loc.name as location_name,l.batch,l.expiry,l.quantity_base,p.code,p.name from distributor_stock_lines l join products p on p.id=l.product_id join distributor_locations loc on loc.id=l.location_id where l.declaration_id=${decl.id} order by p.code,loc.code,l.batch`
    : [];
  const sales =
    await c.db`select product_id,sum(case when kind='sale' then quantity_base else -quantity_base end)::text as qty, sum(case when kind='sale' then amount_centavos else -amount_centavos end)::text as amount from distributor_secondary_current where distributor_id=${d.id} and sale_date between ${start}::date and ${end}::date group by product_id`;
  const prior =
    await c.db`select product_id,sum(case when kind='sale' then quantity_base else -quantity_base end)::text as qty from distributor_secondary_current where distributor_id=${d.id} and sale_date>=${priorStart}::date and sale_date<${start}::date group by product_id`;
  const feeds = await feedCoverage(c, d.id, start, end);
  const feedComplete = feeds.secondaryComplete;
  const freshness = decl
    ? Math.round(
        (Date.parse(end) - Date.parse(day(decl.stock_date))) / 86400000,
      )
    : null;
  const stale =
    freshness === null || freshness > integer(p.stockFreshDays, 0, 366);
  const m = await master(c, d.id);
  const ids = new Set([
    ...stocks.map((/** @type {any} */ s) => s.product_id),
    ...sales.map((/** @type {any} */ s) => s.product_id),
  ]);
  /** @type {any[]} */ const rows = [];
  for (const id of ids) {
    const bins = stocks.filter((/** @type {any} */ x) => x.product_id === id),
      s = sales.find((/** @type {any} */ x) => x.product_id === id),
      prev = prior.find((/** @type {any} */ x) => x.product_id === id),
      catalog = m.payload.products.find(
        (/** @type {any} */ x) => x.productId === id,
      );
    const [product] = await c.db`select code,name from products where id=${id}`;
    const onHand =
      decl && bins.length
        ? bins.reduce(
            (/** @type {number} */ n, /** @type {any} */ x) =>
              n + Number(x.quantity_base),
            0,
          )
        : null;
    const net = feedComplete ? Number(s?.qty ?? 0) : null;
    const doi =
      !stale && onHand !== null && net !== null && net > 0
        ? onHand / (net / window)
        : null;
    const near = bins
      .filter(
        (/** @type {any} */ x) =>
          x.expiry && day(x.expiry) <= dayAdd(end, p.nearExpiryDays),
      )
      .reduce(
        (/** @type {number} */ n, /** @type {any} */ x) =>
          n + Number(x.quantity_base),
        0,
      );
    const expired = bins
      .filter((/** @type {any} */ x) => x.expiry && day(x.expiry) < end)
      .reduce(
        (/** @type {number} */ n, /** @type {any} */ x) =>
          n + Number(x.quantity_base),
        0,
      );
    const pack = Number(catalog?.unitsPerUom ?? 1);
    const state = stale
      ? "stale"
      : net === null
        ? "unknown"
        : net <= 0
          ? "no_sales"
          : doi !== null && doi < p.understockDays
            ? "understock"
            : doi !== null && doi > p.overstockDays
              ? "overstock"
              : "healthy";
    rows.push({
      productId: id,
      code: product?.code,
      name: product?.name,
      onHandBase: onHand,
      onHand:
        onHand === null
          ? null
          : {
              cases: Math.floor(onHand / pack),
              pieces: onHand % pack,
              unitsPerCase: pack,
            },
      netSecondaryBase: net,
      priorSecondaryBase: prev ? Number(prev.qty) : null,
      daysOfInventory: doi,
      targetDays: { min: p.understockDays, max: p.overstockDays },
      nearExpiryBase: near,
      expiredBase: expired,
      status: state,
      locations: bins.map((/** @type {any} */ x) => ({
        locationId: x.location_id,
        locationName: x.location_name,
        batch: x.batch,
        expiry: x.expiry,
        quantityBase: Number(x.quantity_base),
      })),
      nextAction: stale
        ? "Submit a fresh complete stock declaration"
        : !feedComplete
          ? "Complete the secondary-sales feed period"
          : near > 0
            ? "Review dated batches first"
            : state === "understock"
              ? "Raise a primary order"
              : state === "overstock" || state === "no_sales"
                ? "Review retailer offtake"
                : "Keep declaring daily",
    });
  }
  const trend =
    await c.db`select sale_date as date,sum(case when kind='sale' then amount_centavos else -amount_centavos end)::text as secondary_centavos from distributor_secondary_current where distributor_id=${d.id} and sale_date between ${start}::date and ${end}::date group by sale_date order by sale_date`;
  return {
    period: { from: start, to: end, days: window },
    declaration: decl
      ? {
          id: decl.id,
          date: day(decl.stock_date),
          revision: decl.revision,
          submittedAt: decl.created_at,
        }
      : null,
    freshnessDays: freshness,
    offtakeComplete: feedComplete,
    completeOfftakeDays: feeds.secondaryDays,
    stale,
    source:
      "Distributor declarations and invoice-line offtake; not SAP valuation",
    rows,
    trend: trend.map((/** @type {any} */ x) => ({
      date: day(x.date),
      secondaryCentavos: Number(x.secondary_centavos),
    })),
  };
}
/** F-416 exact inventory bridge: end-of-day opening + net primary + transfers/adjustments - net secondary = closing.
 * Missing end points stay unknown, not an invented balanced zero.
 * @param {any} c @param {any} d @param {any} params */
export async function reconciliation(c, d, params) {
  const from = date(params.from),
    to = date(params.to);
  if (
    from > to ||
    to > today(c.now) ||
    Date.parse(to) - Date.parse(from) > 366 * 86400000
  )
    fail("Choose a past period of at most 366 days");
  const p = await policy(c, d.id),
    openingDate = dayAdd(from, -1);
  const feeds = await feedCoverage(c, d.id, from, to),
    sourcesComplete = feeds.primaryComplete && feeds.secondaryComplete;
  const [open] =
    await c.db`select * from distributor_stock_declarations where distributor_id=${d.id} and stock_date=${openingDate} order by revision desc limit 1`;
  const [close] =
    await c.db`select * from distributor_stock_declarations where distributor_id=${d.id} and stock_date=${to} order by revision desc limit 1`;
  const stocks =
    await c.db`select declaration_id,product_id,sum(quantity_base)::text as qty from distributor_stock_lines where declaration_id in (${open?.id ?? null}::uuid,${close?.id ?? null}::uuid) group by declaration_id,product_id`;
  const primary =
    await c.db`select product_id,sum(quantity_base)::text as qty, count(*)::integer as lines from distributor_primary_movements where distributor_id=${d.id} and movement_date between ${from}::date and ${to}::date group by product_id`;
  const secondary =
    await c.db`select product_id,sum(case when kind='sale' then quantity_base else -quantity_base end)::text as qty,count(*)::integer as lines from distributor_secondary_current where distributor_id=${d.id} and sale_date between ${from}::date and ${to}::date group by product_id`;
  const ids = new Set(
    [...stocks, ...primary, ...secondary].map(
      (/** @type {any} */ x) => x.product_id,
    ),
  );
  const rows = [];
  for (const id of ids) {
    const [product] = await c.db`select code,name from products where id=${id}`;
    const opening = stocks.find(
        (/** @type {any} */ x) =>
          x.declaration_id === open?.id && x.product_id === id,
      ),
      closing = stocks.find(
        (/** @type {any} */ x) =>
          x.declaration_id === close?.id && x.product_id === id,
      );
    const a = primary.find((/** @type {any} */ x) => x.product_id === id),
      b = secondary.find((/** @type {any} */ x) => x.product_id === id);
    const openingBase = opening ? Number(opening.qty) : null,
      closingBase = closing ? Number(closing.qty) : null,
      primaryBase = Number(a?.qty ?? 0),
      secondaryBase = Number(b?.qty ?? 0);
    const expected =
      openingBase === null ? null : openingBase + primaryBase - secondaryBase;
    const variance =
      expected === null || closingBase === null ? null : closingBase - expected;
    const facts = {
      productId: id,
      openingId: open?.id ?? null,
      closingId: close?.id ?? null,
      openingBase,
      primaryBase,
      secondaryBase,
      closingBase,
      expectedBase: expected,
      varianceBase: variance,
      toleranceBase: p.reconciliationToleranceBase,
      sourceCounts: { primary: a?.lines ?? 0, secondary: b?.lines ?? 0 },
    };
    // Include exact immutable source identities/revisions, not only changed-and-restored totals.
    const primaryVersions =
      await c.db`select id,version from distributor_primary_movements where distributor_id=${d.id} and product_id=${id} and movement_date between ${from}::date and ${to}::date order by id`;
    const secondaryVersions =
      await c.db`select id,payload_hash from distributor_secondary_current where distributor_id=${d.id} and product_id=${id} and sale_date between ${from}::date and ${to}::date order by id`;
    const hash = digest({ facts, primaryVersions, secondaryVersions, feeds });
    const [review] =
      await c.db`select r.*,p.name as owner_name from distributor_reconciliation_reviews r join profiles p on p.id=r.assigned_to where r.distributor_id=${d.id} and r.period_from=${from} and r.period_to=${to} and r.product_id=${id} order by r.created_at desc,r.id desc limit 1`;
    rows.push({
      ...facts,
      code: product?.code,
      name: product?.name,
      contentHash: hash,
      status:
        variance === null || !sourcesComplete
          ? "incomplete"
          : Math.abs(variance) <= p.reconciliationToleranceBase
            ? "balanced"
            : "exception",
      review: review
        ? {
            status: review.status,
            explanation: review.explanation,
            ownerName: review.owner_name,
            stale: review.content_hash !== hash,
          }
        : null,
      nextAction: !sourcesComplete
        ? "Synchronize complete primary and secondary feeds"
        : variance === null
          ? "Submit exact opening and closing declarations"
          : Math.abs(variance) > p.reconciliationToleranceBase
            ? "Explain and assign the variance"
            : "Review source movements",
    });
  }
  return {
    period: { from, to },
    openingDate,
    feeds,
    openingPresent: !!open,
    closingPresent: !!close,
    toleranceBase: p.reconciliationToleranceBase,
    rows,
  };
}
/** @param {any} c @param {any} d @param {any} b */
export async function reviewReconciliation(c, d, b) {
  const result = await reconciliation(c, d, b),
    line = result.rows.find((x) => x.productId === uuid(b.productId));
  if (!line || line.contentHash !== b.contentHash)
    fail("Sources changed; refresh reconciliation", "stale_review", 409);
  if (
    !["explained", "accepted", "disputed"].includes(b.status) ||
    line.status === "incomplete"
  )
    fail("Resolve missing sources before review");
  const assignedTo = uuid(b.assignedTo);
  const [member] =
    await c.db`select id from distributor_users where distributor_id=${d.id} and profile_id=${assignedTo} and effective_from<=now() and (effective_to is null or effective_to>now())`;
  if (!member && assignedTo !== c.actor.profileId)
    fail("Assign to yourself or a current distributor operator");
  const [row] =
    await c.db`insert into distributor_reconciliation_reviews(distributor_id,period_from,period_to,product_id,content_hash,explanation,assigned_to,status,reviewed_by) values(${d.id},${b.from},${b.to},${b.productId},${line.contentHash},${text(b.explanation, "Explanation", 2000)},${assignedTo},${b.status},${c.actor.profileId}) returning id,status`;
  return row;
}
/** F-413 source-linked, completeness-sensitive composite, editable weights.
 * @param {any} c @param {any} d */
export async function scorecard(c, d) {
  const h = await stockHealth(c, d),
    p = await policy(c, d.id),
    start = h.period.from,
    end = h.period.to,
    priorFrom = dayAdd(start, -h.period.days);
  const [sub] =
    await c.db`select count(distinct stock_date)::integer as n from distributor_stock_declarations where distributor_id=${d.id} and stock_date between ${start}::date and ${end}::date`;
  const [reach] =
    await c.db`select count(distinct f.outlet_id)::integer as n from distributor_secondary_current f where f.distributor_id=${d.id} and f.kind='sale' and f.sale_date between ${start}::date and ${end}::date`;
  const [universe] =
    await c.db`select count(distinct outlet_id)::integer as n from distributor_outlets where distributor_id=${d.id} and effective_from<=now() and (effective_to is null or effective_to>now())`;
  const [sales] =
    await c.db`select coalesce(sum(case when sale_date>=${start}::date then (case when kind='sale' then amount_centavos else -amount_centavos end) else 0 end),0)::text as current,coalesce(sum(case when sale_date<${start}::date then (case when kind='sale' then amount_centavos else -amount_centavos end) else 0 end),0)::text as prior from distributor_secondary_current where distributor_id=${d.id} and sale_date between ${priorFrom}::date and ${end}::date`;
  const [ar] =
    await c.db`select count(*)::integer as n,coalesce(sum(balance_centavos),0)::text as total,coalesce(sum(case when due_date<${end}::date then balance_centavos else 0 end),0)::text as overdue from distributor_ar_items where distributor_id=${d.id}`;
  const [audit] =
    await c.db`select * from distributor_capability_audits where distributor_id=${d.id} order by audit_date desc,created_at desc limit 1`;
  const growth =
    Number(sales.prior) > 0
      ? ((Number(sales.current) - Number(sales.prior)) / Number(sales.prior)) *
        100
      : null;
  const parts = {
    submission: Math.min(100, (sub.n / h.period.days) * 100),
    coverage: universe.n ? Math.min(100, (reach.n / universe.n) * 100) : null,
    growth: growth === null ? null : Math.max(0, Math.min(100, 100 + growth)),
    stock:
      h.stale || !h.rows.length
        ? null
        : (h.rows.filter((x) => x.status === "healthy").length /
            h.rows.length) *
          100,
    payment: ar.n
      ? Number(ar.total) === 0
        ? 100
        : Math.max(0, 100 - (Number(ar.overdue) / Number(ar.total)) * 100)
      : null,
    infrastructure: audit?.infrastructure_score ?? null,
    manpower: audit?.manpower_score ?? null,
  };
  const complete = Object.entries(parts).every(
    ([k, v]) => !p.scorecardWeights[k] || v !== null,
  );
  const total = complete
    ? Object.entries(parts).reduce(
        (n, [k, v]) => n + (Number(v ?? 0) * p.scorecardWeights[k]) / 100,
        0,
      )
    : null;
  return {
    period: h.period,
    score: total,
    complete,
    components: parts,
    weights: p.scorecardWeights,
    secondaryCentavos: Number(sales.current),
    priorCentavos: Number(sales.prior),
    growthPct: growth,
    targetCentavos: p.secondaryTargetCentavos ?? null,
    audit: audit
      ? { date: day(audit.audit_date), findings: audit.findings }
      : null,
    nextAction: !complete
      ? "Complete missing source data and capability audit"
      : h.stale
        ? "Submit current stock"
        : "Review the weakest scored component",
  };
}
/** @param {any} c @param {any} d @param {any} b */
export async function recordAudit(c, d, b) {
  const day = date(b.auditDate);
  if (day > today(c.now)) fail("Audit date cannot be in the future");
  const [row] =
    await c.db`insert into distributor_capability_audits(distributor_id,audit_date,infrastructure_score,manpower_score,findings,audited_by) values(${d.id},${day},${integer(b.infrastructureScore, 0, 100)},${integer(b.manpowerScore, 0, 100)},${text(b.findings, "Audit findings", 2000)},${c.actor.profileId}) returning id`;
  return row;
}
