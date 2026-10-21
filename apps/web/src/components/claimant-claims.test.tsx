import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ClaimantClaimList,
  claimAmount,
  claimBatch,
  type ClaimantData,
} from "./claimant-claims";
it("F-505 claimant screens show shared statuses and SAP-only finality, with exact peso and bounded batch intake", () => {
  const data: ClaimantData = {
    rows: [
      {
        id: "sample",
        reference: "SAMPLE-CLAIM",
        type: "Sample evidence claim",
        status: "needs_evidence",
        amountCentavos: 1005,
        periodFrom: "2026-10-21",
        periodTo: "2026-10-21",
      },
    ],
    types: [
      { id: "policy", code: "SAMPLE", required_evidence: ["attendance"] },
    ],
    notices: [
      {
        id: "notice",
        claim_id: "sample",
        message: "Your claim needs evidence.",
        read_at: null,
      },
    ],
    sources: [],
    sourcesTruncated: false,
  };
  const html = renderToStaticMarkup(<ClaimantClaimList data={data} />);
  expect(html).toContain("SAMPLE-CLAIM");
  expect(html).toContain("needs evidence");
  expect(html).toContain("after SAP acknowledgement");
  expect(html).toContain("Your claim needs evidence");
  expect(claimAmount("10.05")).toBe(1005);
  expect(() => claimAmount("1.001")).toThrow();
  const rows = claimBatch(
    '[{"reference":"SAMPLE-1","typeCode":"SAMPLE","amountPhp":"10.05","sources":[]}]',
    data.types,
  );
  expect(rows[0]?.typeId).toBe("policy");
  expect(rows[0]?.amountCentavos).toBe(1005);
  expect(() =>
    claimBatch(
      JSON.stringify(Array.from({ length: 26 }, () => ({}))),
      data.types,
    ),
  ).toThrow("1–25");
});
