import { Dataset, at, persist, plusDays, rowId } from "./store.js";
/** F-501–F-510 explicitly fictional, idempotent sample campaign and claim lineage.
 * @param {import('./store.js').Dataset} d */
export function tpm(d) {
  const from = plusDays(d.anchorDate, -14),
    to = plusDays(d.anchorDate, 30),
    profile = rowId("profiles", "approver"),
    creator = "system:sample";
  // jsonb_populate_recordset sees the union of columns for the table. Fill new
  // non-null defaults on pre-existing sample promotions too, not only our rows.
  for (const p of d.rows("promotions")) {
    p.benefit_timing ??= "on_invoice";
    p.engine_version ??= 1;
    p.eligibility ??= {};
    p.precedence ??= 100;
    p.stacking ??= "exclusive";
    p.excludes ??= [];
  }
  const type = d.add("claim_types", "tpm-promotion-v1", {
    code: "Sample promotion claim",
    effective_from: "2020-01-01T00:00:00Z",
    effective_to: "2100-01-01T00:00:00Z",
    required_evidence: ["checklist", "photo"],
    source: "sample",
  });
  d.add("claim_approval_rules", "tpm-finance-v1", {
    name: "Sample Finance band — provisional",
    party_type: "all",
    min_centavos: 0,
    max_centavos: 5_000_000,
    approver_roles: ["super_admin", "approver"],
    effective_from: "2020-01-01T00:00:00Z",
    effective_to: "2100-01-01T00:00:00Z",
    source: "sample",
  });
  const metrics = [
    "targets",
    "coverage",
    "distribution",
    "availability",
    "collection",
    "settlementVariance",
  ].map((metric, i) => ({
    metric,
    weightBps: i === 0 ? 5000 : 1000,
    capBps: 10000,
    direction: metric === "settlementVariance" ? "lower" : "higher",
  }));
  const plan = d.add("incentive_plans", "tpm-sample-incentive-v1", {
    code: "SAMPLE-INCENTIVE",
    name: "Sample balanced field incentive — provisional",
    effective_from: "2020-01-01T00:00:00Z",
    effective_to: "2100-01-01T00:00:00Z",
    base_centavos: 250000,
    metrics,
    source: "sample",
    created_by: creator,
  });
  const lines = metrics.map((r) => ({
    metric: r.metric,
    actual: 100,
    target: 100,
    definitionVersion: "sample-v1",
    weightBps: r.weightBps,
    achievementBps: 10000,
    amountCentavos: (250000 * r.weightBps) / 10000,
  }));
  d.add("incentive_statements", `tpm-incentive-${d.anchorDate.slice(0, 7)}`, {
    plan_id: plan.id,
    profile_id: rowId("profiles", "agent"),
    period_from: d.anchorDate.slice(0, 7) + "-01",
    period_to: d.anchorDate,
    source_key: "sample-metrics-" + d.anchorDate.slice(0, 7),
    source_hash: "sample-fictional-not-payroll",
    facts: {
      source: "sample",
      metrics: Object.fromEntries(
        metrics.map((r) => [
          r.metric,
          { actual: 100, target: 100, definitionVersion: "sample-v1" },
        ]),
      ),
    },
    result: { amountCentavos: 250000, lines },
    amount_centavos: 250000,
    status: "calculated",
    created_by: creator,
  });
  for (const [i, partyType] of [
    "distributor",
    "modern_trade",
    "agency",
  ].entries()) {
    const key = `tpm-${d.anchorDate.slice(0, 7)}-${i}`;
    const campaign = d.add("campaigns", key, {
      organization_id: "sunpride",
      code: `SAMPLE-${d.anchorDate.slice(0, 7)}-${i + 1}`,
    });
    const version = d.add("campaign_versions", key, {
      campaign_id: campaign.id,
      version: 1,
      name: [
        "Sample Cebu display launch",
        "Sample grocery volume week",
        "Sample agency execution",
      ][i],
      mechanic: ["Display and volume", "Basket value off", "Execution reward"][
        i
      ],
      status: "active",
      effective_from: new Date(at(from)).toISOString(),
      effective_to: new Date(at(to)).toISOString(),
      scope: { channelKey: { include: ["gt", "modern_trade", "mt"] } },
      checklist: [
        "Display present",
        "Price correct",
        "POSM up",
        "Stock sufficient",
      ],
      budget_centavos: 1_000_000 + i * 500_000,
      expected_volume_base: 10000 + i * 5000,
      expected_roi_bps: 2000,
      source: "sample",
      created_by: creator,
    });
    // Draft/inactive: do not unexpectedly discount the shared demo company's live orders.
    const scheme = d.add("promotions", key, {
      organization_id: "sunpride",
      code: campaign.code + "-BASKET",
      name: "Sample basket reward",
      rule_kind: "basket",
      rule: {
        kind: "basket",
        minSubtotalCentavos: 100000,
        valueCentavos: 5000,
      },
      status: "inactive",
      source: "sample",
      effective_from: new Date(at(from)).toISOString(),
      effective_to: new Date(at(to)).toISOString(),
      campaign_version_id: version.id,
      engine_version: 1,
      benefit_timing: "claimable",
      eligibility: {},
      precedence: 100,
      stacking: "stack",
      excludes: [],
    });
    const amount = [250000, 120000, 85000][i];
    d.add("campaign_commitments", key, {
      campaign_id: campaign.id,
      campaign_version_id: version.id,
      source_key: "sample-plan:" + key,
      amount_centavos: amount,
      created_by: creator,
    });
    const earning = d.add("promotion_earnings", key, {
      campaign_version_id: version.id,
      promotion_id: scheme.id,
      source_key: "sample:" + key,
      source_hash: "sample-fictional-not-a-SAP-ledger",
      account_key: "SAMPLE-ACCOUNT-" + (i + 1),
      earned_at: new Date(at(plusDays(d.anchorDate, -3))).toISOString(),
      amount_centavos: amount,
      reversed_centavos: 0,
    });
    const claim = d.add("claims", key, {
      reference: "SAMPLE-CLAIM-" + key,
      claimant_party_type: partyType,
      claimant_party_id: earning.account_key,
      claimant_name: [
        "Sample Cebu Distributor",
        "Sample Island Grocers",
        "Sample Display Agency",
      ][i],
      type_id: type.id,
      campaign_version_id: version.id,
      earning_id: earning.id,
      period_from: from,
      period_to: d.anchorDate,
      amount_centavos: amount,
      currency: "PHP",
      status: "needs_evidence",
      created_by: creator,
    });
    d.add("claim_events", key, {
      claim_id: claim.id,
      action: "needs_evidence",
      actor_subject: creator,
      details: {
        source: "sample",
        reason:
          "Illustrative claim; link captured execution evidence before approval.",
      },
    });
    d.add("deductions", key, {
      source_key: "sample-deduction:" + key,
      account_key: earning.account_key,
      classification: ["promotion", "short_delivery", "agency_billing"][i],
      invoice_reference: "Sample invoice " + (i + 1),
      remittance_reference: "Sample remittance " + (i + 1),
      claim_id: claim.id,
      amount_centavos: amount,
      recovered_centavos: 0,
      owner_profile_id: profile,
      status: i === 1 ? "disputed" : "open",
      opened_on: plusDays(d.anchorDate, -10 - i * 7),
      due_on: plusDays(d.anchorDate, 2 - i * 7),
      created_by: creator,
    });
    d.add("promotion_evaluations", key, {
      campaign_version_id: version.id,
      account_key: earning.account_key,
      mechanic: version.mechanic,
      source_key: "sample-evaluation:" + key,
      source_hash: "sample-directional-fixture",
      facts: {
        source: "sample",
        baselineMethod: "Fictional matched prior period",
        marginSource: "Fictional mock SAP margin",
      },
      result: {
        baselineVolumeBase: 8000,
        promotedVolumeBase: 10000,
        incrementalVolumeBase: 2000,
        upliftBps: 2500,
        incrementalMarginCentavos: 400000,
        spendCentavos: amount,
        grossRoiBps: Math.trunc((400000 * 10000) / amount),
        netRoiBps: Math.trunc(((400000 - amount) * 10000) / amount),
        directional: true,
        baselineMethod: "Fictional matched prior period",
        marginSource: "Fictional mock SAP margin",
      },
      created_by: creator,
    });
  }
}
/** Add the current month's sample TPM rows to an existing company, never reset it.
 * @param {import('../src/client.js').Db} db @param {string} date */
export async function seedTpm(db, date) {
  const [exists] =
    await db`select 1 from campaigns where id=${rowId("campaigns", `tpm-${date.slice(0, 7)}-0`)}`;
  if (exists) return;
  const data = new Dataset(date, 1);
  tpm(data);
  for (const table of [
    "claim_types",
    "claim_approval_rules",
    "incentive_plans",
  ]) {
    const id = data.rows(table)[0].id;
    const exists = await db.unsafe(`select 1 from ${table} where id=$1`, [id]);
    if (exists.length) {
      data.tables.delete(table);
      data.markers = data.markers.filter((m) => m.table_name !== table);
    }
  }
  await persist(db, data);
}
