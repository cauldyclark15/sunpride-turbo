import { tx } from "@sunpride/db/client";
import { command, office, changed } from "./common.js";
import { feedCoverage } from "../distributors/analytics.js";
import { schemeUnits, eligibility } from "./engine.js";
import { eligibilityFacts } from "./campaigns.js";
import { dateOf, addDays } from "../analytics/measures.js";
import {
  uuid,
  text,
  integer,
  safe,
  fail,
  choice,
} from "../orders/validation.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { computeRoi } from "./evaluations.js";
import { enqueue } from "../../core/jobs.js";

/** F-508 one equal-length immediately-prior baseline, current revised secondary invoices,
 * versioned per-base-unit margins and the complete canonical campaign spend reservation net of returns.
 * @param {any} c @param {any} q @returns {Promise<any>} */
export async function readPromotionPerformance(c, q) {
  const [campaign] =
    await c.db`select * from campaign_versions where id=${uuid(q.campaignVersionId)}`;
  if (!campaign) fail("Campaign not found");
  if (+new Date(campaign.effective_to) > c.now)
    fail("Complete the campaign period before evaluating");
  const policies =
    await c.db`select distinct on(product_id) * from promotion_performance_policies where campaign_version_id=${campaign.id} and account_key=${text(q.accountKey, "Account", 160)} order by product_id,revision desc`;
  if (!policies.length || policies.length > 500)
    fail(
      "Configure the governed account/SKU margin and cost sources",
      "needs_setup",
    );
  const distributors = new Set(
    policies.map((/** @type {any} */ p) => p.distributor_id),
  );
  if (distributors.size !== 1)
    fail("An account evaluation must name one distributor source");
  const [distributor] =
    await c.db`select * from distributors where id=${policies[0].distributor_id} and status='accredited' and effective_from<=now() and (effective_to is null or effective_to>now())`;
  if (!distributor) fail("Distributor source access is no longer active");
  if (q.accountKey !== (distributor.sap_customer_code ?? distributor.code))
    fail("Account does not match the canonical distributor");
  const from = dateOf(campaign.effective_from),
    to = dateOf(new Date(+new Date(campaign.effective_to) - 1));
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (days < 1 || days > 180)
    fail("Evaluation supports campaigns of 1–180 days");
  const before = addDays(from, -days),
    priorTo = addDays(from, -1);
  const [baselineFeed, promotedFeed] = await Promise.all([
    feedCoverage(c, distributor.id, before, priorTo),
    feedCoverage(c, distributor.id, from, to),
  ]);
  if (!baselineFeed.secondaryComplete || !promotedFeed.secondaryComplete)
    fail(
      "Complete baseline and promoted secondary-sales feeds first",
      "needs_setup",
    );
  const sales =
    await c.db`select product_id,outlet_id,sale_date,kind,quantity_base,revision,payload_hash from distributor_secondary_current where distributor_id=${distributor.id} and sale_date between ${before}::date and ${to}::date order by product_id,sale_date,id limit 10001`;
  if (sales.length > 10000)
    fail("Narrow the campaign evaluation; source limit exceeded");
  const schemes =
    await c.db`select rule,eligibility from promotions where campaign_version_id=${campaign.id}`;
  const covered = new Set(policies.map((/** @type {any} */ p) => p.product_id));
  const required = new Set(
    schemes.flatMap((/** @type {any} */ s) =>
      schemeUnits(s.rule).map((u) => u.productId),
    ),
  );
  if (schemes.some((/** @type {any} */ s) => schemeUnits(s.rule).length === 0))
    for (const sale of sales) required.add(sale.product_id);
  if ([...required].some((id) => !covered.has(id)))
    fail("Every campaign SKU needs a governed margin source", "needs_setup");
  const cohort = new Map();
  for (const sale of sales)
    if (!cohort.has(sale.outlet_id)) {
      const facts = await eligibilityFacts(c, {
        outletId: sale.outlet_id,
        at: c.now,
      });
      cohort.set(sale.outlet_id, {
        facts,
        eligible: eligibility(campaign.scope ?? {}, facts).eligible,
      });
    }
  const eligibleSales = sales.filter((/** @type {any} */ sale) => {
    const cohortRow = cohort.get(sale.outlet_id);
    if (!cohortRow.eligible) return false;
    return (
      !schemes.length ||
      schemes.some((/** @type {any} */ scheme) => {
        const units = schemeUnits(scheme.rule);
        return (
          (!units.length ||
            units.some((u) => u.productId === sale.product_id)) &&
          eligibility(scheme.eligibility ?? {}, cohortRow.facts).eligible
        );
      })
    );
  });
  let baseline = 0n,
    promoted = 0n,
    margin = 0n,
    cost = 0n;
  for (const policy of policies) {
    let b = 0n,
      p = 0n;
    for (const sale of eligibleSales.filter(
      (/** @type {any} */ s) => s.product_id === policy.product_id,
    )) {
      const qty =
        BigInt(sale.quantity_base) * (sale.kind === "return" ? -1n : 1n);
      if (dateOf(sale.sale_date) < from) b += qty;
      else p += qty;
    }
    if (b < 0n || p < 0n)
      fail(
        "Net returns exceed sales; reconcile source periods before evaluating",
      );
    baseline += b;
    promoted += p;
    margin += (p - b) * BigInt(policy.unit_margin_centavos);
    cost += BigInt(policy.other_cost_centavos);
  }
  const spend =
    await c.db`select b.id,b.amount_centavos,b.source_key,coalesce(o.pricing_snapshot,vs.receipt) as snapshot,
    coalesce(o.status,case when vs.id is not null then 'approved' end) as status
    from campaign_commitment_balances b
    left join orders o on split_part(b.source_key,':',2)='order' and o.id::text=split_part(b.source_key,':',3)
    left join van_sales vs on split_part(b.source_key,':',2)='van_sale' and vs.id::text=split_part(b.source_key,':',3)
    left join outlets vso on vso.id=vs.outlet_id
    where b.campaign_version_id=${campaign.id} and (o.customer_code=${q.accountKey} or exists(select 1 from outlet_customer_links l join customers customer on customer.id=l.customer_id where l.outlet_id=vso.id and customer.code=${q.accountKey} and l.effective_from<=vs.created_at and (l.effective_to is null or l.effective_to>vs.created_at))) order by b.id limit 10001`;
  if (spend.length > 10000) fail("Narrow the campaign spend sources");
  for (const source of spend) {
    if (!["approved", "posted", "fulfilled", "voided"].includes(source.status))
      fail(
        "Wait for campaign orders to be accepted or voided before evaluating",
      );
    for (const promotion of source.snapshot?.promotionsApplied ?? [])
      if (
        promotion.campaignVersionId === campaign.id &&
        promotion.freeGoods?.length &&
        !Number.isSafeInteger(promotion.freeGoodsValueCentavos)
      )
        fail(
          "Retained free goods lack frozen value; reconcile before evaluating",
        );
  }
  const facts = {
    baselineVolumeBase: safe(baseline),
    promotedVolumeBase: safe(promoted),
    unitMarginCentavos: 0,
    incrementalMarginCentavos: safe(margin),
    otherCostCentavos: safe(cost),
    spendCentavos: safe(
      spend.reduce(
        (/** @type {bigint} */ n, /** @type {any} */ r) =>
          n + BigInt(r.amount_centavos),
        0n,
      ),
    ),
    spendCompleteness: "complete",
    spendSource:
      "canonical campaign benefit commitments net of returned/voided units",
    baselineMethod: `Equal-length preceding ${days}-day complete secondary-sales period`,
    marginSource: policies
      .map((/** @type {any} */ p) => p.margin_reference)
      .join("; "),
    definitionVersion: "promotion-performance/v1",
    sample:
      distributor.source === "sample" ||
      policies.some((/** @type {any} */ p) => p.source === "sample"),
    periods: { from, to, before, priorTo },
    policyIds: policies.map((/** @type {any} */ p) => p.id),
    sourceHash: sha256Hex(canonicalJson({ sales, spend, policies })),
  };
  return {
    ...facts,
    sourceKey:
      "performance:" +
      sha256Hex(
        canonicalJson({ campaign: campaign.id, account: q.accountKey, facts }),
      ),
  };
}
/** @param {any} c @param {any} q */
export async function evaluatePerformance(c, q) {
  const facts = await readPromotionPerformance(c, q),
    result = computeRoi(facts, facts.spendCentavos);
  const [campaign] =
    await c.db`select mechanic from campaign_versions where id=${q.campaignVersionId}`;
  const [row] =
    await c.db`insert into promotion_evaluations(campaign_version_id,account_key,mechanic,source_key,source_hash,facts,result,created_by) values(${q.campaignVersionId},${q.accountKey},${campaign.mechanic},${facts.sourceKey},${sha256Hex(canonicalJson({ facts, spend: String(facts.spendCentavos) }))},${facts},${{ ...result, sample: facts.sample }},${c.actor.subject}) on conflict(source_key) do nothing returning id`;
  return {
    id:
      row?.id ??
      (
        await c.db`select id from promotion_evaluations where source_key=${facts.sourceKey}`
      )[0].id,
    result,
  };
}
/** @param {any} router @param {any} ctx */
export function installPerformance(router, ctx) {
  router.get("/api/v1/tpm/roi/policies", async (/** @type {any} */ c) => {
    await office(c);
    const rows =
      await c.db`select distinct on(p.campaign_version_id,p.account_key,p.product_id) p.*,v.name as campaign_name,pr.name as product_name from promotion_performance_policies p join campaign_versions v on v.id=p.campaign_version_id join products pr on pr.id=p.product_id order by p.campaign_version_id,p.account_key,p.product_id,p.revision desc limit 501`;
    const distributors =
      await c.db`select id,name,coalesce(sap_customer_code,code) as account_key from distributors where status='accredited' and effective_from<=now() and (effective_to is null or effective_to>now()) order by name limit 501`;
    if (rows.length > 500 || distributors.length > 500)
      fail("Narrow the performance policy sources");
    return { rows, distributors };
  });
  router.post("/api/v1/tpm/roi/policy", (/** @type {any} */ c) =>
    command(
      c,
      "roi.policy",
      c.body,
      (cc) => office(cc, "masterdata.manage"),
      async (cc) => {
        const b = c.body,
          campaign = uuid(b.campaignVersionId),
          product = uuid(b.productId),
          distributor = uuid(b.distributorId);
        const [d] =
          await cc.db`select * from distributors where id=${distributor} and status='accredited'`;
        if (!d) fail("Choose an accredited distributor");
        const account = d.sap_customer_code ?? d.code;
        await cc.db`select id from campaigns where id=(select campaign_id from campaign_versions where id=${campaign}) for update`;
        const [prior] =
          await cc.db`select max(revision) as revision from promotion_performance_policies where campaign_version_id=${campaign} and account_key=${account} and product_id=${product}`;
        const [row] =
          await cc.db`insert into promotion_performance_policies(campaign_version_id,distributor_id,product_id,account_key,revision,unit_margin_centavos,other_cost_centavos,margin_reference,cost_reference,source,created_by) values(${campaign},${distributor},${product},${account},${Number(prior.revision ?? 0) + 1},${integer(b.unitMarginCentavos)},${integer(b.otherCostCentavos ?? 0)},${text(b.marginReference, "Margin source")},${text(b.costReference, "Cost source")},${choice(b.source ?? "sample", ["sample", "operational"], "Source")},${cc.actor.subject}) returning id`;
        await changed(cc, "roi.policy_saved", row.id);
        return { id: row.id, accountKey: account };
      },
    ),
  );
  ctx.registerJob("tpm.roi.evaluate", async (/** @type {any} */ job) => {
    await tx(job.db, (db) =>
      evaluatePerformance(
        { db, now: Date.now(), actor: { subject: "system:promotion-roi" } },
        job.payload,
      ),
    );
    await ctx.publish("tpm");
  });
  ctx.registerJob("tpm.roi.queue", async (/** @type {any} */ job) => {
    const day = job.payload.day,
      after = job.payload.after ?? "";
    const rows =
      await job.db`select distinct p.campaign_version_id,p.account_key,p.campaign_version_id::text||':'||p.account_key as cursor from promotion_performance_policies p join campaign_versions v on v.id=p.campaign_version_id where v.effective_to<=now()-interval '30 days' and p.campaign_version_id::text||':'||p.account_key>${after} order by cursor limit 100`;
    for (const row of rows)
      await enqueue(job.db, {
        kind: "tpm.roi.evaluate",
        key: day + ":" + row.cursor,
        payload: {
          campaignVersionId: row.campaign_version_id,
          accountKey: row.account_key,
        },
      });
    if (rows.length === 100)
      await enqueue(job.db, {
        kind: "tpm.roi.queue",
        key: day + ":" + rows.at(-1).cursor,
        payload: { day, after: rows.at(-1).cursor },
      });
  });
  ctx.scheduler.daily(
    "04:00",
    "Asia/Manila",
    "tpm.roi.closed",
    async (/** @type {any} */ job) => {
      const day = dateOf(Date.now());
      await enqueue(job.db, {
        kind: "tpm.roi.queue",
        key: day,
        payload: { day },
      });
    },
  );
}
