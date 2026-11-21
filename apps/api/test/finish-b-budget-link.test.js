import { expect, test } from "bun:test";
import { requireCampaignLink } from "../src/domains/tpm/budget-link.js";
test("F-501 loosened: promotions may be activated with or without a campaign budget", () => {
  const from = new Date("2026-10-21T00:00:00Z"),
    to = new Date("2026-10-22T00:00:00Z");
  expect(() => requireCampaignLink("active", null, null, from, to)).not.toThrow();
  expect(() =>
    requireCampaignLink("active", "sample-campaign", null, from, to),
  ).not.toThrow();
  const old = { status: "inactive", campaign_version_id: null, effective_from: from, effective_to: to };
  expect(() => requireCampaignLink("active", null, old, from, null)).not.toThrow();
});
