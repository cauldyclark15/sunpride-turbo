import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductivePolicyList } from "./productive-policies";

const policy = {
  _id: "private-policy-id",
  label: "SAMPLE productive definition",
  version: 2,
  status: "published",
  orgUnitId: "private-unit",
  unitName: "Cebu",
  positionLabel: "Truck seller",
  preparedByName: "Sample planner",
  approvedByName: "Sample approver",
  sourceRef: "SAMPLE — not client agreed",
  effectiveFrom: Date.parse("2026-11-01T00:00:00+08:00"),
  contentHash: "abcdef0123456789abcdef",
  definition: {
    rule: "truck_seller",
    matchMode: "all",
    allowedCodes: ["collection", "merchandising"],
  },
};
describe("F-208 published productive-call policy registry", () => {
  it("shows version, approval, applicability, dates and agreement provenance without raw identifiers", () => {
    const html = renderToStaticMarkup(
      createElement(ProductivePolicyList, { policies: [policy] }),
    );
    for (const text of [
      "version 2",
      "Cebu",
      "Truck seller",
      "From Nov 1, 2026",
      "Every qualifying activity",
      "Sample approver",
      "not client agreed",
      "no-sales-due-to-inventory",
      "Earlier visits keep",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("private-policy-id");
    expect(html).not.toContain("private-unit");
    expect(html).not.toContain("Publish SAMPLE");
  });
  it("offers independent publication only for a draft and identifies the provisional legacy fallback", () => {
    const draft = renderToStaticMarkup(
      createElement(ProductivePolicyList, {
        policies: [{ ...policy, status: "draft", approvedByName: undefined }],
        canApprove: true,
      }),
    );
    expect(draft).toContain("waiting for a different approver");
    expect(draft).toContain("Publish SAMPLE productive definition version 2");
    const empty = renderToStaticMarkup(
      createElement(ProductivePolicyList, { policies: [] }),
    );
    expect(empty).toContain("provisional beta definition");
  });
});
