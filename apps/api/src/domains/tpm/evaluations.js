import { canonicalJson, sha256Hex } from "../../core/util.js";
import { seams } from "./seams.js";
import { bounded, changed, command, office } from "./common.js";
import { currentActor } from "../van/access.js";
import { enforcePartnerSelf } from "../partners/boundary.js";
import {
  date,
  divide,
  fail,
  instant,
  integer,
  safe,
  text,
  uuid,
} from "../orders/validation.js";

const METRICS = [
  "targets",
  "coverage",
  "distribution",
  "availability",
  "collection",
  "settlementVariance",
];
/** F-510 weights are configurable; every result has immutable source and line explanations.
 * @param {any[]} rules @param {any} facts @param {number} base */
export function computeIncentive(rules, facts, base) {
  validateMetrics(rules);
  integer(base);
  const lines = rules.map((rule) => {
    const fact = facts[rule.metric];
    if (rule.weightBps === 0)
      return {
        metric: rule.metric,
        actual: fact?.actual ?? null,
        target: fact?.target ?? null,
        definitionVersion:
          fact?.definitionVersion ?? "excluded-by-effective-plan/v1",
        weightBps: 0,
        achievementBps: 0,
        amountCentavos: 0,
        excluded: true,
      };
    if (
      !fact ||
      !Number.isSafeInteger(fact.actual) ||
      fact.actual < 0 ||
      !Number.isSafeInteger(fact.target) ||
      fact.target <= 0 ||
      !fact.definitionVersion
    )
      fail(
        "Every incentive metric needs a governed actual, positive target and definition version",
      );
    const rawAchievement =
      rule.direction === "lower"
        ? fact.actual <= fact.target
          ? 10000
          : Math.max(
              0,
              20000 -
                safe((BigInt(fact.actual) * 10000n) / BigInt(fact.target)),
            )
        : Math.min(
            rule.capBps,
            safe((BigInt(fact.actual) * 10000n) / BigInt(fact.target)),
          );
    const achievement = Math.min(rule.capBps, rawAchievement);
    const amount = safe(
      divide(
        BigInt(base) * BigInt(rule.weightBps) * BigInt(achievement),
        10000n * 10000n,
      ),
    );
    return {
      metric: rule.metric,
      actual: fact.actual,
      target: fact.target,
      definitionVersion: fact.definitionVersion,
      weightBps: rule.weightBps,
      achievementBps: achievement,
      amountCentavos: amount,
      excluded: false,
    };
  });
  return {
    amountCentavos: safe(
      lines.reduce((n, l) => n + BigInt(l.amountCentavos), 0n),
    ),
    lines,
  };
}
/** @param {any} rules */
function validateMetrics(rules) {
  if (
    !Array.isArray(rules) ||
    rules.length !== METRICS.length ||
    new Set(rules.map((r) => r.metric)).size !== METRICS.length
  )
    fail("Configure each of the six incentive metrics once");
  for (const r of rules) {
    if (
      !METRICS.includes(r.metric) ||
      !["higher", "lower"].includes(r.direction)
    )
      fail("Invalid incentive metric");
    integer(r.weightBps, "Weight", 10000);
    integer(r.capBps, "Attainment cap", 20000);
    if (r.target != null && (!Number.isSafeInteger(r.target) || r.target <= 0))
      fail("Explicit metric targets must be positive whole canonical units");
  }
  if (
    rules.reduce(
      (/** @type {number} */ n, /** @type {any} */ r) => n + r.weightBps,
      0,
    ) !== 10000
  )
    fail("Incentive weights must total 100%");
}
/** F-508 directional ROI on explicit baseline and SAP margin provenance, never static uplift.
 * @param {any} facts @param {number} spend */
export function computeRoi(facts, spend) {
  const baseline = integer(facts.baselineVolumeBase),
    promoted = integer(facts.promotedVolumeBase),
    margin = integer(facts.unitMarginCentavos),
    other = integer(facts.otherCostCentavos ?? 0);
  if (
    !facts.sourceKey ||
    !facts.baselineMethod ||
    !facts.marginSource ||
    !facts.definitionVersion
  )
    fail("Baseline, margin and metric provenance are required");
  const incremental = promoted - baseline,
    incrementalMargin = safe(BigInt(incremental) * BigInt(margin));
  const cost = safe(BigInt(integer(spend)) + BigInt(other));
  return {
    baselineVolumeBase: baseline,
    promotedVolumeBase: promoted,
    incrementalVolumeBase: incremental,
    upliftBps: baseline
      ? safe((BigInt(incremental) * 10000n) / BigInt(baseline))
      : null,
    incrementalMarginCentavos: incrementalMargin,
    spendCentavos: cost,
    grossRoiBps: cost
      ? safe((BigInt(incrementalMargin) * 10000n) / BigInt(cost))
      : null,
    netRoiBps: cost
      ? safe(
          ((BigInt(incrementalMargin) - BigInt(cost)) * 10000n) / BigInt(cost),
        )
      : null,
    directional: true,
    baselineMethod: facts.baselineMethod,
    marginSource: facts.marginSource,
  };
}
/** @param {any} router */
export function installEvaluations(router) {
  for (const path of [
    "/api/v1/account/incentives",
    "/api/v1/partners/incentives/mine",
  ])
    router.get(path, async (/** @type {any} */ c) => {
      const actor = await currentActor(c.db, c.actor);
      await enforcePartnerSelf(c.db, actor);
      const rows = bounded(
        await c.db`select s.id,s.status,s.period_from,s.period_to,s.result,s.amount_centavos,i.name as plan_name,i.source as plan_source from incentive_statements s join incentive_plans i on i.id=s.plan_id where s.profile_id=${actor.profileId} order by s.period_to desc limit 501`,
      );
      return {
        rows: rows.map((/** @type {any} */ r) => ({
          ...r,
          amountCentavos: Number(r.amount_centavos),
        })),
      };
    });
  router.get("/api/v1/tpm/roi", async (/** @type {any} */ c) => {
    await office(c);
    const rows = bounded(
      await c.db`select e.*,v.name as campaign_name from promotion_evaluations e join campaign_versions v on v.id=e.campaign_version_id order by e.created_at desc limit 501`,
    );
    return {
      rows: rows.map((e) => ({
        id: e.id,
        campaignName: e.campaign_name,
        accountKey: e.account_key,
        mechanic: e.mechanic,
        ...e.result,
        sourceKey: e.source_key,
        createdAt: new Date(e.created_at).getTime(),
      })),
    };
  });
  router.post("/api/v1/tpm/roi/evaluate", (/** @type {any} */ c) =>
    command(
      c,
      "roi.evaluate",
      c.body,
      (cc) => office(cc, "masterdata.manage"),
      async (cc) => {
        const b = c.body,
          [v] =
            await cc.db`select * from campaign_versions where id=${uuid(b.campaignVersionId)}`;
        if (!v) fail("Campaign not found");
        const account = text(b.accountKey, "Account", 160);
        const facts = await seams.readPromotionPerformance(cc, {
          campaignVersionId: v.id,
          accountKey: account,
        });
        // F-508 earnings omit invoice discounts and valued free goods; never call them total spend.
        if (facts?.spendCompleteness !== "complete" || !facts?.spendSource)
          fail(
            "Connect complete governed SAP promotion spend, including invoice discounts and valued goods.",
          );
        const spend = integer(facts.spendCentavos);
        const result = computeRoi(facts, spend),
          hash = sha256Hex(canonicalJson({ facts, spend: String(spend) }));
        const key = text(facts.sourceKey, "Performance source", 160);
        const [old] =
          await cc.db`select * from promotion_evaluations where source_key=${key}`;
        if (old) {
          if (old.source_hash !== hash)
            fail("Performance source version conflicts");
          return { id: old.id, result: old.result };
        }
        const [e] =
          await cc.db`insert into promotion_evaluations(campaign_version_id,account_key,mechanic,source_key,source_hash,facts,result,created_by) values(${v.id},${account},${v.mechanic},${key},${hash},${facts},${result},${cc.actor.subject}) returning id`;
        await changed(cc, "roi.evaluated", e.id);
        return { id: e.id, result };
      },
    ),
  );
  router.get("/api/v1/tpm/incentives", async (/** @type {any} */ c) => {
    await office(c);
    return {
      adjustments: bounded(
        await c.db`select id,statement_id,amount_centavos,reason,status from incentive_adjustments order by created_at desc limit 501`,
      ),
      plans: bounded(
        await c.db`select * from incentive_plans order by effective_from desc limit 501`,
      ),
      statements: bounded(
        await c.db`select s.*,p.name as person_name,i.name as plan_name from incentive_statements s join profiles p on p.id=s.profile_id join incentive_plans i on i.id=s.plan_id order by s.period_to desc limit 501`,
      ).map((s) => ({
        id: s.id,
        personName: s.person_name,
        planName: s.plan_name,
        status: s.status,
        amountCentavos: Number(s.amount_centavos),
        result: s.result,
        periodFrom: String(
          s.period_from instanceof Date
            ? s.period_from.toISOString()
            : s.period_from,
        ).slice(0, 10),
        periodTo: String(
          s.period_to instanceof Date ? s.period_to.toISOString() : s.period_to,
        ).slice(0, 10),
      })),
    };
  });
  router.post("/api/v1/tpm/incentives/plan", (/** @type {any} */ c) =>
    command(
      c,
      "incentive.plan",
      c.body,
      (cc) => office(cc, "masterdata.manage"),
      async (cc) => {
        const b = c.body,
          from = instant(b.effectiveFrom),
          to = instant(b.effectiveTo);
        if (to <= from) fail("Plan end must follow start");
        validateMetrics(b.metrics);
        if (!["sample", "office"].includes(b.source ?? "office"))
          fail("Choose a sample or office incentive policy source");
        const [r] =
          await cc.db`insert into incentive_plans(code,name,effective_from,effective_to,base_centavos,metrics,source,created_by) values(${text(b.code, "Plan code", 80)},${text(b.name, "Plan name", 160)},${from},${to},${integer(b.baseCentavos)},${b.metrics},${b.source ?? "office"},${cc.actor.subject}) returning id`;
        await changed(cc, "incentive.plan_saved", r.id);
        return { id: r.id };
      },
    ),
  );
  router.post("/api/v1/tpm/incentives/calculate", (/** @type {any} */ c) =>
    command(
      c,
      "incentive.calculate",
      c.body,
      (cc) => office(cc, "order.encode"),
      async (cc) => {
        const b = c.body,
          from = date(b.periodFrom),
          to = date(b.periodTo),
          profile = uuid(b.profileId);
        const [plan] =
          await cc.db`select * from incentive_plans where id=${uuid(b.planId)} and effective_from<=${new Date(from + "T00:00:00+08:00")} and effective_to>=${new Date(to + "T23:59:59.999+08:00")}`;
        if (
          !plan ||
          to < from ||
          Date.parse(to) - Date.parse(from) > 366 * 86400_000
        )
          fail("Choose a period fully covered by the incentive plan");
        const [person] =
          await cc.db`select id from profiles where id=${profile} and status='active' and deleted_at is null`;
        if (!person) fail("Choose an active employee or distributor rep");
        const facts = await seams.readIncentiveMetrics(cc, {
          profileId: profile,
          periodFrom: from,
          periodTo: to,
          rules: plan.metrics,
        });
        const result = computeIncentive(
          plan.metrics,
          facts.metrics,
          Number(plan.base_centavos),
        );
        const hash = sha256Hex(
          canonicalJson({ plan: plan.id, metrics: plan.metrics, facts }),
        );
        const [old] =
          await cc.db`select * from incentive_statements where plan_id=${plan.id} and profile_id=${profile} and period_from=${from} and period_to=${to}`;
        if (old) {
          if (old.source_hash !== hash)
            fail(
              "Statement facts changed; use an independently approved adjustment",
            );
          return { id: old.id, result: old.result };
        }
        const [r] =
          await cc.db`insert into incentive_statements(plan_id,profile_id,period_from,period_to,source_key,source_hash,facts,result,amount_centavos,created_by) values(${plan.id},${profile},${from},${to},${text(facts.sourceKey, "Metric snapshot source", 160)},${hash},${facts},${result},${result.amountCentavos},${cc.actor.subject}) returning id`;
        await changed(cc, "incentive.calculated", r.id);
        return { id: r.id, result };
      },
    ),
  );
  router.post("/api/v1/tpm/incentives/adjust", (/** @type {any} */ c) =>
    command(
      c,
      "incentive.adjust",
      c.body,
      (cc) => office(cc, "order.encode"),
      async (cc) => {
        const b = c.body,
          [r] =
            await cc.db`select * from incentive_statements where id=${uuid(b.id)} for update`;
        if (!r) fail("Statement not found");
        if (!Number.isSafeInteger(b.amountCentavos) || !b.amountCentavos)
          fail("Adjustment needs nonzero whole centavos");
        const [a] =
          await cc.db`insert into incentive_adjustments(statement_id,amount_centavos,reason,created_by) values(${r.id},${b.amountCentavos},${text(b.reason, "Adjustment reason")},${cc.actor.subject}) returning id`;
        await changed(cc, "incentive.adjustment_requested", a.id);
        return { id: a.id };
      },
    ),
  );
  router.post(
    "/api/v1/tpm/incentives/approve-adjustment",
    (/** @type {any} */ c) =>
      command(
        c,
        "incentive.adjustment_approve",
        c.body,
        (cc) => office(cc, "order.approve"),
        async (cc) => {
          const [a] =
            await cc.db`select * from incentive_adjustments where id=${uuid(c.body.id)} for update`;
          if (!a || a.status !== "pending") fail("Choose a pending adjustment");
          const [r] =
            await cc.db`select * from incentive_statements where id=${a.statement_id} for update`;
          if (
            a.created_by === cc.actor.subject ||
            r.profile_id === cc.actor.profileId
          )
            fail("You cannot approve your own adjustment", "self_approval");
          const total = BigInt(r.amount_centavos) + BigInt(a.amount_centavos);
          if (total < 0n) fail("Adjustment would make incentive negative");
          await cc.db`update incentive_adjustments set status='approved',approved_by=${cc.actor.subject},updated_at=now() where id=${a.id}`;
          await cc.db`update incentive_statements set amount_centavos=${safe(total)},updated_at=now() where id=${r.id}`;
          await changed(cc, "incentive.adjustment_approved", a.id);
          return { id: a.id };
        },
      ),
  );
  router.post("/api/v1/tpm/incentives/decide", (/** @type {any} */ c) =>
    command(
      c,
      "incentive.decide",
      c.body,
      (cc) => office(cc, "order.approve"),
      async (cc) => {
        const b = c.body,
          [r] =
            await cc.db`select * from incentive_statements where id=${uuid(b.id)} for update`;
        if (!r) fail("Statement not found");
        if (b.action === "dispute") {
          await cc.db`update incentive_statements set status='disputed',updated_at=now() where id=${r.id}`;
          await changed(cc, "incentive.disputed", r.id, {
            reason: text(b.reason, "Dispute reason"),
          });
          return { id: r.id };
        }
        if (
          b.action !== "approve" ||
          !["calculated", "disputed"].includes(r.status)
        )
          fail("Choose a calculated statement for approval");
        if (
          r.created_by === cc.actor.subject ||
          r.profile_id === cc.actor.profileId
        )
          fail(
            "You cannot approve your own incentive statement",
            "self_approval",
          );
        await cc.db`update incentive_statements set status='approved',approved_by=${cc.actor.subject},updated_at=now() where id=${r.id}`;
        await changed(cc, "incentive.approved", r.id);
        return { id: r.id };
      },
    ),
  );
}
