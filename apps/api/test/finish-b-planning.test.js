import { expect, test } from "bun:test";
import { campaignPlanning } from "../src/domains/availability/campaigns.js";
import { suggest } from "../src/domains/availability/rules.js";
import { validateScheme } from "../src/domains/tpm/engine.js";
const campaign = {
  id: "sample-scheme",
  campaign_version_id: "sample-version",
  name: "Sample display drive",
  rule: {
    kind: "percent_off",
    item: { productId: "sku", uom: "PC", quantity: 1 },
    percentOffBasisPoints: 500,
    demandUpliftPct: 20,
    planningObjective: "Discuss the Sample display drive",
  },
  eligibility: { classKey: { include: ["A"] } },
  campaign_scope: { distributorId: { include: ["sample-partner"] } },
  planning_sample: true,
};
test("F-218 F-219 only eligible governed campaigns change the server proposal, not discount percentages or foreign partner scope", () => {
  const eligible = campaignPlanning(
    [campaign],
    { classKey: "A", distributorId: "sample-partner" },
    "sku",
    true,
  );
  expect(eligible[0].objective).toContain("Sample display");
  expect(
    suggest(
      { historyDailyBase: 10, stockBase: 0, upliftPct: eligible[0].upliftPct },
      { coverDays: 2 },
    ).quantityBase,
  ).toBe(24);
  expect(
    campaignPlanning(
      [campaign],
      { classKey: "B", distributorId: "sample-partner" },
      "sku",
      true,
    ),
  ).toEqual([]);
  expect(
    campaignPlanning(
      [campaign],
      { classKey: "A", distributorId: "other" },
      "sku",
      true,
    ),
  ).toEqual([]);
  expect(
    campaignPlanning(
      [campaign],
      { classKey: "A", distributorId: "sample-partner" },
      "sku",
      false,
    ),
  ).toEqual([]);
  expect(() =>
    validateScheme({ ...campaign.rule, demandUpliftPct: 501 }),
  ).toThrow();
});
