import { afterAll, beforeAll, expect, test } from "bun:test";
import vectors from "../../../packages/domain-contracts/fixtures/tpm/engine-v1.json";
import {
  evaluateSchemes,
  eligibility,
  validateScheme,
} from "../src/domains/tpm/engine.js";
import { install } from "../src/domains/tpm/index.js";
import { createUser, profileStore, startHarness } from "./harness.js";
import { sha256Hex } from "../src/core/util.js";

for (const vector of vectors.vectors)
  test(vector.name, () => {
    const result = evaluateSchemes(
      vector.lines,
      vector.promotions,
      vector.facts,
    );
    expect(result.totalCentavos).toBe(vector.expected.totalCentavos);
    expect(
      result.promotionsApplied.reduce((n, p) => n + p.earnedCentavos, 0),
    ).toBe(
      "earnedCentavos" in vector.expected ? vector.expected.earnedCentavos : 0,
    );
    expect(
      result.promotionsApplied
        .flatMap((p) => p.freeGoods)
        .reduce((n, g) => n + g.quantity, 0),
    ).toBe(vector.expected.freeQuantity);
    expect(result.lineDiscounts.reduce((a, b) => a + b, 0)).toBe(
      result.knownSubtotalCentavos - (result.totalCentavos ?? 0),
    );
    expect(
      evaluateSchemes(
        vector.lines,
        [...vector.promotions].reverse(),
        vector.facts,
      ),
    ).toEqual(result);
  });
test("F-502 unknown basket value and unknown versions fail closed", () => {
  const l = [
    {
      productId: "A",
      uom: "PC",
      quantity: 1,
      unitPriceCentavos: null,
      lineTotalCentavos: null,
    },
  ];
  const p = {
    id: "A",
    code: "A",
    rule: { kind: "basket", minSubtotalCentavos: 0, valueCentavos: 50 },
  };
  expect(evaluateSchemes(l, [p]).totalCentavos).toBeNull();
  expect(evaluateSchemes(l, [p]).promotionsApplied).toEqual([]);
  expect(() => evaluateSchemes(l, [{ ...p, engine_version: 2 }])).toThrow(
    "version",
  );
  expect(() =>
    validateScheme({
      kind: "slab",
      item: { productId: "A", uom: "PC", quantity: 1 },
      slabs: [{ minQuantity: 0, percentOffBasisPoints: 10 }],
    }),
  ).toThrow();
});
test("F-503 all dimensions AND together and exclusions override inclusions", () => {
  for (const key of [
    "outletId",
    "classKey",
    "channelKey",
    "territoryId",
    "geographyKey",
    "distributorId",
  ]) {
    expect(eligibility({ [key]: { include: ["yes"] } }, {}).eligible).toBe(
      false,
    );
    expect(
      eligibility({ [key]: { include: ["yes"] } }, { [key]: "yes" }).eligible,
    ).toBe(true);
    expect(
      eligibility(
        { [key]: { include: ["yes"], exclude: ["yes"] } },
        { [key]: "yes" },
      ).eligible,
    ).toBe(false);
  }
});
/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let profiles;
/** @type {any} */ let admin;
/** @type {any} */ let viewer;
/** @type {any} */ let regional;
let campaignVersionId = "";
/** @param {string} role @param {string|null} [unit] */
async function person(role, unit = null) {
  const user = await createUser(
    h,
    crypto.randomUUID() + "@test.invalid",
    "test password long enough",
  );
  const p = profiles.set(user, { role, orgUnitId: unit });
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user},${user},'TPM Test',${user + "@test.invalid"},${role},'active',${unit})`;
  const token = "sps_" + crypto.randomUUID().replaceAll("-", "");
  await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${user},${sha256Hex(token)},'web',now()+interval '1 day')`;
  return { ...p, cookie: "sp_session=" + token };
}
/** @param {any} who @param {string} path @param {any} [body] */
async function api(who, path, body) {
  const r = await h.fetch("/api/v1/tpm/" + path, {
    method: body ? "POST" : "GET",
    headers: { cookie: who.cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
}
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  profiles = profileStore(h);
  const [unit] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','ROOT','National','region','active','2020-01-01') returning id`;
  h.setHooks({ rootUnitId: async () => unit.id });
  admin = await person("super_admin");
  viewer = await person("viewer", unit.id);
  regional = await person("manager");
});
afterAll(async () => {
  await h?.close();
});
test("F-501 W3 thin campaign, replay, stable version and W5 budget are live HTTP commands", async () => {
  const b = {
    code: "TEST-CAMPAIGN",
    name: "Sample launch",
    mechanic: "Display + volume",
    status: "active",
    effectiveFrom: Date.now() - 1000,
    effectiveTo: Date.now() + 86400_000,
    budgetCentavos: 10000,
    expectedVolumeBase: 500,
    expectedRoiBps: 1500,
    checklist: ["Display present"],
    scope: { channelKey: { include: ["gt"] } },
    idempotencyKey: crypto.randomUUID(),
  };
  const r = await api(admin, "campaigns/save", b);
  expect(r.status).toBe(200);
  campaignVersionId = r.body.versionId;
  expect((await api(admin, "campaigns/save", b)).body).toEqual(r.body);
  expect(
    (await api(admin, "campaigns/save", { ...b, name: "Changed" })).status,
  ).toBe(409);
  const listed = await api(viewer, "campaigns");
  expect(listed.body.rows[0].checklist).toEqual(["Display present"]);
  expect(
    (
      await api(viewer, "campaigns/save", {
        ...b,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(403);
  expect((await api(regional, "campaigns")).status).toBe(403);
  const commit = {
    campaignVersionId,
    amountCentavos: 6000,
    sourceKey: "PROMO-LAUNCH",
    idempotencyKey: crypto.randomUUID(),
  };
  const other = {
    ...commit,
    sourceKey: "OTHER",
    idempotencyKey: crypto.randomUUID(),
  };
  const requests = [commit, other];
  const successes = await Promise.all(
    requests.map((b) => api(admin, "budget/commit", b)),
  );
  expect(successes.map((r) => r.status).sort()).toEqual([200, 422]);
  const winner = successes.findIndex((r) => r.status === 200);
  expect((await api(admin, "budget/commit", requests[winner])).status).toBe(
    200,
  );
  expect((await api(admin, "budget/commit", requests[1 - winner])).status).toBe(
    422,
  );
  expect((await api(admin, "campaigns")).body.rows[0].committedCentavos).toBe(
    6000,
  );
});
test("F-503 basic W4 eligibility respects campaign period and exclusions", async () => {
  const [p] =
    await h.db`insert into promotions(organization_id,code,name,rule_kind,rule,status,source,effective_from,effective_to,campaign_version_id,eligibility) values('sunpride','W4','W4 basic','basket',${{ kind: "basket", minSubtotalCentavos: 0, valueCentavos: 50 }},'active','sample',now()-interval '1 minute',now()+interval '1 hour',${campaignVersionId},${{ outletId: { include: ["not-known"] } }}) returning id`;
  const r = await api(admin, "eligibility", { channelKey: "gt" });
  expect(r.status).toBe(200);
  expect(r.body.rows[0].eligible).toBe(false);
  await h.db`update promotions set effective_to=now()-interval '1 second' where id=${p.id}`;
  expect((await api(admin, "eligibility", {})).body.rows).toEqual([]);
});
