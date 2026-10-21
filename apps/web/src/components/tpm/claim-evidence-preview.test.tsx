import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, it, expect, vi } from "vitest";
import { ClaimEvidencePreview } from "./claim-evidence-preview";
import { ClaimReview } from "./tpm-workspace";
import type { Claim, Options } from "./model";
const state = vi.hoisted(() => ({
  denied: false,
  values: {} as Record<string, unknown>,
}));
vi.mock("../../lib/api", () => ({
  useApi: (key: unknown[]) => ({
    data: state.values[String(key[1])],
    error: state.denied ? new Error("Access removed") : null,
  }),
  useLive: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ can: () => true }),
}));
const claim: Claim = {
  id: "hidden-claim",
  reference: "Sample claim",
  partyType: "distributor",
  partyName: "Sample company",
  type: "Sample SKU",
  status: "needs_evidence",
  amountCentavos: 200,
  createdAt: 1792540800000,
  quantityUnits: 2,
  uom: "EA",
  periodFrom: "2026-10-21",
  periodTo: "2026-10-21",
};
const options: Options = {
  products: [],
  outlets: [],
  people: [],
  evidence: [],
};
beforeEach(() => {
  state.denied = false;
  state.values = {
    claim: {
      evidence: [
        {
          kind: "secondary_sale",
          source_id: "hidden-invoice",
          snapshot: {
            amountCentavos: 1000,
            quantityBase: "10",
            unitsPerUom: 1,
            uom: "EA",
          },
        },
      ],
      events: [],
      settlements: [],
      overrides: [],
      validation: {
        passed: false,
        reasons: ["Missing verified photo"],
        baseHash: "hidden-hash",
        exceptionEligible: true,
      },
    },
    "evidence-options": { rows: [], truncated: false },
  };
});
it("previews exact source money, quantity and protected original-image links without calling photographs monetary proof", () => {
  const html = renderToStaticMarkup(
    createElement(ClaimEvidencePreview, {
      claimId: claim.id,
      evidence: [
        {
          kind: "photo",
          source_id: "hidden-photo",
          snapshot: { occurredAt: 1792540800000 },
        },
        {
          kind: "secondary_sale",
          source_id: "hidden-invoice",
          snapshot: {
            amountCentavos: 1234,
            quantityBase: "10",
            unitsPerUom: 1,
            uom: "EA",
          },
        },
      ],
    }),
  );
  expect(html).toContain("Source value: ₱12.34");
  expect(html).toContain("10");
  expect(html).toContain("base units per EA");
  expect(html).toContain("does not certify a monetary value");
  expect(html).toContain(
    "/api/v1/tpm/claims/photo?id=hidden-claim&amp;sourceId=hidden-photo",
  );
  expect(html.replace(/<[^>]+>/g, "")).not.toContain("hidden-photo");
});
it("shows the governed execution exception and immutable correction controls in the real claim reviewer", () => {
  const html = renderToStaticMarkup(
    createElement(ClaimReview, {
      claim,
      options,
      canIntake: true,
      canApprove: true,
    }),
  );
  expect(html).toContain("Missing verified photo");
  expect(html).toContain("Independently approve execution exception");
  expect(html).toContain("Alternative evidence reference");
  expect(html).toContain("Save correction and require revalidation");
  expect(html).toContain("Refresh secondary sale source version");
  expect(html).toContain("Claimed source quantity:");
});
it("hides retained source facts and all actions after an explicit access denial", () => {
  state.denied = true;
  const html = renderToStaticMarkup(
    createElement(ClaimReview, {
      claim,
      options,
      canIntake: true,
      canApprove: true,
    }),
  );
  expect(html).toContain("Access removed");
  expect(html).not.toContain("Source value");
  expect(html).not.toContain("Independently approve");
  expect(html).not.toContain("Refresh secondary sale");
});
