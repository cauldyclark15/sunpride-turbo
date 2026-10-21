import { expect, test } from "bun:test";
import { requireCampaignLink } from "../src/domains/tpm/budget-link.js";
test("F-501 new financial schemes cannot evade campaign budgets by omitting their campaign; legacy bonus schemes cannot be reactivated or extended", () => {
  const from = new Date("2026-10-21T00:00:00Z"),
    to = new Date("2026-10-22T00:00:00Z");
  expect(() => requireCampaignLink("active", null, null, from, to)).toThrow(
    "campaign budget",
  );
  expect(() =>
    requireCampaignLink("active", "sample-campaign", null, from, to),
  ).not.toThrow();
  const old = {
    status: "active",
    campaign_version_id: null,
    effective_from: from,
    effective_to: to,
  };
  expect(() =>
    requireCampaignLink("active", null, old, from, to),
  ).not.toThrow();
  expect(() => requireCampaignLink("active", null, old, from, null)).toThrow();
  expect(() =>
    requireCampaignLink(
      "active",
      null,
      { ...old, status: "inactive" },
      from,
      to,
    ),
  ).toThrow();
});
