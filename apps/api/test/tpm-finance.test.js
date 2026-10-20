import { afterAll, beforeAll, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import { install } from "../src/domains/tpm/index.js";
import {
  accrueOrder,
  applySapAcknowledgement,
  reverseOrder,
} from "../src/domains/tpm/finance.js";
import {
  computeIncentive,
  computeRoi,
} from "../src/domains/tpm/evaluations.js";
import { setTpmSeams } from "../src/domains/tpm/seams.js";
import { createUser, profileStore, startHarness } from "./harness.js";
import { sha256Hex } from "../src/core/util.js";
/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let profiles;
/** @type {any} */ let admin;
/** @type {any} */ let approver;
let version = "",
  promotion = "",
  earning = "",
  typeId = "",
  claimId = "";
const sourceId = crypto.randomUUID(),
  day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const rules = [
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
/** @param {string} role */
async function person(role) {
  const user = await createUser(
    h,
    crypto.randomUUID() + "@test.invalid",
    "long test password",
  );
  const p = profiles.set(user, { role, orgUnitId: null });
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status) values(${p.id},${user},${user},'Finance Test',${user + "@test.invalid"},${role},'active')`;
  const token = "sps_" + crypto.randomUUID().replaceAll("-", "");
  await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${user},${sha256Hex(token)},'web',now()+interval '1 day')`;
  return { ...p, cookie: "sp_session=" + token };
}
/** @param {any} who @param {string} path @param {any} [body] */
async function api(who, path, body) {
  const r = await h.fetch("/api/v1/tpm/" + path, {
    method: body ? "POST" : "GET",
    headers: { cookie: who.cookie, "content-type": "application/json" },
    ...(body
      ? {
          body: JSON.stringify({
            idempotencyKey: crypto.randomUUID(),
            ...body,
          }),
        }
      : {}),
  });
  return { status: r.status, body: await r.json() };
}
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  profiles = profileStore(h);
  admin = await person("super_admin");
  approver = await person("super_admin");
  const made = await api(admin, "campaigns/save", {
    code: "FINANCE",
    name: "Sample volume",
    mechanic: "Value off",
    status: "active",
    effectiveFrom: Date.now() - 86400_000,
    effectiveTo: Date.now() + 86400_000,
    budgetCentavos: 50000,
  });
  version = made.body.versionId;
  const [p] =
    await h.db`insert into promotions(organization_id,code,name,rule_kind,rule,status,source,effective_from,campaign_version_id) values('sunpride','EARN','Earned rebate','basket',${{ kind: "basket", minSubtotalCentavos: 0, valueCentavos: 1000 }},'active','sample',now()-interval '1 day',${version}) returning id`;
  promotion = p.id;
  const [t] =
    await h.db`insert into claim_types(code,effective_from,effective_to,required_evidence,source) values('REBATE',now()-interval '1 day',now()+interval '1 day',${["source_document"]},'sample') returning id`;
  typeId = t.id;
  await h.db`insert into claim_approval_rules(name,party_type,min_centavos,max_centavos,approver_roles,effective_from,effective_to,source) values('Sample independent Finance','all',0,10000,${["super_admin"]},now()-interval '1 day',now()+interval '1 day','sample')`;
  setTpmSeams({
    readEvidence: async (_c, kind, id) =>
      id === sourceId
        ? {
            kind,
            sourceId: id,
            fingerprint: "document:" + id,
            partyId: "ACCOUNT",
            partyType: "distributor",
            campaignVersionId: version,
            occurredAt: Date.parse(day + "T12:00:00+08:00"),
            verified: true,
            amountCentavos: 1000,
          }
        : null,
  });
});
afterAll(async () => {
  await h?.close();
});
test("F-504 earned accrual is atomic, idempotent, and staged pending the SAP seam", async () => {
  const order = {
    id: crypto.randomUUID(),
    status: "approved",
    created_at: new Date(),
    customer_code: "ACCOUNT",
    outlet_id: null,
    pricing_snapshot: {
      promotionsApplied: [
        {
          id: promotion,
          campaignVersionId: version,
          discountCentavos: 0,
          earnedCentavos: 1000,
          benefitTiming: "claimable",
        },
      ],
    },
  };
  await tx(h.db, (db) =>
    accrueOrder(
      { db, actor: { subject: admin.userId }, now: Date.now() },
      order,
    ),
  );
  await tx(h.db, (db) =>
    accrueOrder(
      { db, actor: { subject: admin.userId }, now: Date.now() },
      order,
    ),
  );
  const earned = await h.db`select * from promotion_earnings`;
  expect(earned).toHaveLength(1);
  earning = earned[0].id;
  const rows = await h.db`select * from tpm_posting_instructions`;
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("awaiting_seam");
  expect(rows[0].payload.sourceMode).toBe("sample");
  expect((await api(admin, "liabilities")).body.rows[0].campaignVersionId).toBe(
    version,
  );
  expect(
    (await api(admin, "liabilities")).body.rows[0].openCentavos,
  ).toBeNull();
  await applySapAcknowledgement(h.db, {
    instructionId: rows[0].id,
    status: "acknowledged",
    sapDocument: "MOCK-ACCRUAL-1",
    sourceEventId: "test-sap-accrual",
  });
  expect((await api(admin, "liabilities")).body.rows[0].openCentavos).toBe(
    1000,
  );
});
test("F-505 one intake accepts distributor MT agency with type period value and immutable history", async () => {
  for (const partyType of ["distributor", "modern_trade", "agency"]) {
    const r = await api(admin, "claims/submit", {
      reference: partyType + "-CLAIM",
      partyType,
      partyId: "ACCOUNT",
      partyName: "Sample claimant",
      typeId,
      periodFrom: day,
      periodTo: day,
      amountCentavos: 1000,
      campaignVersionId: version,
      earningId: earning,
    });
    expect(r.status).toBe(200);
    if (partyType === "distributor") claimId = r.body.id;
    const validation = await api(admin, "claims/validate", { id: r.body.id });
    expect(validation.body.passed).toBe(false);
    expect(validation.body.reasons).toContain(
      "Missing verified source_document",
    );
  }
  const r = await api(admin, "claims");
  expect(r.body.rows).toHaveLength(3);
});
test("F-506 authoritative evidence validates, duplicate proof is denied, and history is append-only", async () => {
  expect(
    (
      await api(admin, "claims/evidence", {
        id: claimId,
        kind: "source_document",
        sourceId,
      })
    ).status,
  ).toBe(200);
  const result = await api(admin, "claims/validate", { id: claimId });
  expect(result.status).toBe(200);
  expect(result.body.passed).toBe(true);
  const other = (await api(admin, "claims")).body.rows.find(
    (/** @type {any} */ r) => r.id !== claimId,
  );
  expect(
    (
      await api(admin, "claims/evidence", {
        id: other.id,
        kind: "source_document",
        sourceId,
      })
    ).status,
  ).toBe(422);
  expect(
    (await api(admin, "claims/validate", { id: other.id })).body.passed,
  ).toBe(false);
  await expect(
    (async () =>
      await h.db`update claim_evidence set kind='photo' where claim_id=${claimId}`)(),
  ).rejects.toThrow("append-only");
});
test("F-507 no self approval; SAP acknowledgment settles partially then fully; release needs its own SAP ack", async () => {
  expect((await api(admin, "claims/approve", { id: claimId })).status).toBe(
    422,
  );
  const approved = await api(approver, "claims/approve", { id: claimId });
  expect(approved.status).toBe(200);
  const requests = await Promise.all([
    api(approver, "claims/settle", {
      id: claimId,
      amountCentavos: 600,
      method: "credit_memo",
    }),
    api(approver, "claims/settle", {
      id: claimId,
      amountCentavos: 600,
      method: "payment",
    }),
  ]);
  expect(requests.map((r) => r.status).sort()).toEqual([200, 422]);
  const first = requests.find((r) => r.status === 200);
  const [instruction] =
    await h.db`select * from tpm_posting_instructions where settlement_id=${first?.body.id}`;
  const ack = {
    instructionId: instruction.id,
    status: /** @type {'acknowledged'} */ ("acknowledged"),
    sapDocument: "MOCK-CREDIT-1",
    sourceEventId: "test-credit-1",
  };
  expect(await applySapAcknowledgement(h.db, ack)).toEqual({
    duplicate: false,
  });
  expect(await applySapAcknowledgement(h.db, ack)).toEqual({ duplicate: true });
  expect((await api(admin, "claims/detail?id=" + claimId)).body.status).toBe(
    "part_settled",
  );
  expect((await api(admin, "liabilities")).body.rows[0].openCentavos).toBe(
    1000,
  );
  const [release] =
    await h.db`select * from tpm_posting_instructions where settlement_id=${first?.body.id} and kind='release'`;
  await applySapAcknowledgement(h.db, {
    instructionId: release.id,
    status: "acknowledged",
    sapDocument: "MOCK-RELEASE-1",
    sourceEventId: "test-release-1",
  });
  expect((await api(admin, "liabilities")).body.rows[0].openCentavos).toBe(400);
  const final = await api(approver, "claims/settle", {
    id: claimId,
    amountCentavos: 400,
    method: "payment",
  });
  expect(final.status).toBe(200);
  const [last] =
    await h.db`select * from tpm_posting_instructions where settlement_id=${final.body.id}`;
  await applySapAcknowledgement(h.db, {
    instructionId: last.id,
    status: "acknowledged",
    sapDocument: "MOCK-PAY-2",
    sourceEventId: "test-pay-2",
  });
  expect((await api(admin, "claims/detail?id=" + claimId)).body.status).toBe(
    "settled",
  );
  expect(
    (await h.db`select * from claim_notifications where claim_id=${claimId}`)
      .length,
  ).toBeGreaterThan(4);
  const [e] = await h.db`select * from promotion_earnings where id=${earning}`;
  await expect(
    tx(h.db, (db) => reverseOrder({ db }, String(e.source_key).split(":")[1])),
  ).rejects.toThrow("Resolve");
});
test("F-508 directional ROI is measured from a baseline and margin provenance; zero spend is unknown", () => {
  const facts = {
    baselineVolumeBase: 100,
    promotedVolumeBase: 150,
    unitMarginCentavos: 100,
    sourceKey: "sample",
    marginSource: "mock-sap",
    baselineMethod: "matched prior",
    definitionVersion: "v1",
  };
  expect(computeRoi(facts, 1000)).toMatchObject({
    incrementalVolumeBase: 50,
    grossRoiBps: 50000,
    netRoiBps: 40000,
    directional: true,
  });
  expect(computeRoi(facts, 0).netRoiBps).toBeNull();
  expect(computeRoi({ ...facts, promotedVolumeBase: 50 }, 1000).netRoiBps).toBe(
    -60000,
  );
});
test("F-509 all deductions have named owners, age, dispute and bounded recovery", async () => {
  const made = await api(admin, "deductions/capture", {
    sourceKey: "MT-DED-1",
    accountKey: "ACCOUNT",
    classification: "short_delivery",
    invoiceReference: "INV-1",
    remittanceReference: "REM-1",
    claimId,
    amountCentavos: 500,
    ownerProfileId: approver.id,
    openedOn: day,
    dueOn: day,
  });
  expect(made.status).toBe(200);
  expect(
    (
      await api(approver, "deductions/decide", {
        id: made.body.id,
        action: "dispute",
        reason: "Proof requested",
      })
    ).status,
  ).toBe(200);
  expect((await api(admin, "deductions")).body.rows[0]).toMatchObject({
    ageDays: 0,
    status: "disputed",
    ownerName: "Finance Test",
  });
  expect(
    (
      await api(approver, "deductions/decide", {
        id: made.body.id,
        action: "recover",
        amountCentavos: 600,
        reason: "Too much",
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await api(approver, "deductions/decide", {
        id: made.body.id,
        action: "recover",
        amountCentavos: 500,
        reason: "SAP matched credit",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api(approver, "deductions/decide", {
        id: made.body.id,
        action: "resolve",
        reason: "Reconciled",
      })
    ).status,
  ).toBe(200);
});
test("F-510 persisted incentive source replay, independent approval, dispute and adjustments", async () => {
  const plan = await api(admin, "incentives/plan", {
    code: "TEST-INCENTIVE",
    name: "Sample balanced incentive",
    effectiveFrom: Date.now() - 86400_000,
    effectiveTo: Date.now() + 86400_000,
    baseCentavos: 10000,
    metrics: rules,
  });
  expect(plan.status).toBe(200);
  const body = {
    planId: plan.body.id,
    profileId: admin.id,
    periodFrom: day,
    periodTo: day,
  };
  expect((await api(admin, "incentives/calculate", body)).status).toBe(422);
  const facts = {
    sourceKey: "test-snapshot-v1",
    metrics: Object.fromEntries(
      rules.map((r) => [
        r.metric,
        { actual: 100, target: 100, definitionVersion: "test-v1" },
      ]),
    ),
  };
  setTpmSeams({ readIncentiveMetrics: async () => facts });
  const calculated = await api(admin, "incentives/calculate", body);
  expect(calculated.status).toBe(200);
  expect((await api(admin, "incentives/calculate", body)).body).toEqual(
    calculated.body,
  );
  expect(
    (
      await api(admin, "incentives/decide", {
        id: calculated.body.id,
        action: "approve",
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await api(approver, "incentives/decide", {
        id: calculated.body.id,
        action: "approve",
      })
    ).status,
  ).toBe(200);
  const adjustment = await api(admin, "incentives/adjust", {
    id: calculated.body.id,
    amountCentavos: -1000,
    reason: "Sample variance correction",
  });
  expect(adjustment.status).toBe(200);
  expect(
    (
      await api(admin, "incentives/approve-adjustment", {
        id: adjustment.body.id,
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await api(approver, "incentives/approve-adjustment", {
        id: adjustment.body.id,
      })
    ).status,
  ).toBe(200);
  expect(
    (await api(admin, "incentives")).body.statements[0].amountCentavos,
  ).toBe(9000);
  facts.metrics.targets.actual = 50;
  expect((await api(admin, "incentives/calculate", body)).status).toBe(422);
});
test("F-508 ROI source feeds require complete SAP spend, not an earnings-only partial total, and freeze results", async () => {
  const body = { campaignVersionId: version, accountKey: "ACCOUNT" };
  expect((await api(admin, "roi/evaluate", body)).status).toBe(422);
  const facts = {
    sourceKey: "test-account-roi-v1",
    baselineVolumeBase: 100,
    promotedVolumeBase: 150,
    unitMarginCentavos: 100,
    baselineMethod: "matched prior",
    marginSource: "mock-sap",
    definitionVersion: "test-v1",
  };
  setTpmSeams({ readPromotionPerformance: async () => facts });
  expect((await api(admin, "roi/evaluate", body)).status).toBe(422);
  setTpmSeams({
    readPromotionPerformance: async () => ({
      ...facts,
      spendCentavos: 1250,
      spendSource: "mock-sap-invoice-rebate-and-valued-goods",
      spendCompleteness: "complete",
    }),
  });
  const result = await api(admin, "roi/evaluate", body);
  expect(result.status).toBe(200);
  expect(result.body.result.spendCentavos).toBe(1250);
  expect(result.body.result.netRoiBps).toBe(30000);
  expect((await api(admin, "roi/evaluate", body)).body).toEqual(result.body);
  expect((await api(admin, "roi")).body.rows[0].accountKey).toBe("ACCOUNT");
});
test("F-506 canonical photo and checklist readers reject absent proof rather than claimant assertions", async () => {
  const options = await api(admin, "claims/evidence-options?id=" + claimId);
  expect(options.status).toBe(200);
  expect(Array.isArray(options.body.rows)).toBe(true);
  const { readEvidence } = await import("../src/domains/tpm/claims.js");
  expect(
    await readEvidence({ db: h.db }, "photo", crypto.randomUUID()),
  ).toBeNull();
  expect(
    await readEvidence({ db: h.db }, "checklist", crypto.randomUUID()),
  ).toBeNull();
});
test("F-510 all six governed metrics explain weighted incentive and variance penalty", () => {
  const facts = Object.fromEntries(
    rules.map((r) => [
      r.metric,
      { actual: 100, target: 100, definitionVersion: "test-v1" },
    ]),
  );
  expect(computeIncentive(rules, facts, 10000).amountCentavos).toBe(10000);
  expect(
    computeIncentive(
      rules.map((r) =>
        r.metric === "settlementVariance" ? { ...r, capBps: 5000 } : r,
      ),
      facts,
      10000,
    ).amountCentavos,
  ).toBe(9500);
  facts.settlementVariance.actual = 200;
  expect(computeIncentive(rules, facts, 10000).amountCentavos).toBe(9000);
  expect(() => computeIncentive(rules, {}, 10000)).toThrow("governed");
});
