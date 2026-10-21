import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CreditDecision, type CreditException } from "./credit-decision";
import wire from "../../../../van-sales-android/app/src/test/resources/sap-credit-exception-v1.json";

it("F-404 shows the actual sample provider acknowledgement without claiming a higher account limit", () => {
  const html = renderToStaticMarkup(
    <CreditDecision request={wire.approved as CreditException} />,
  );
  expect(html).toContain("SAMPLE");
  expect(html).toContain("SAP exception approved");
  expect(html).toContain("ordinary account limit is unchanged");
  expect(html).toContain(wire.approved.reference);
});
it("F-404 Finance approval and provider refusal never render as SAP permission", () => {
  const request = {
    ...wire.approved,
    status: "pending_sap",
    phase: "awaiting_sap",
    reference: null,
  } as CreditException;
  const pending = renderToStaticMarkup(<CreditDecision request={request} />);
  expect(pending).toContain("waiting for SAP");
  expect(pending).not.toContain("SAP exception approved");
  const rejected = renderToStaticMarkup(
    <CreditDecision
      request={{ ...request, phase: "rejected", status: "rejected" }}
    />,
  );
  expect(rejected).toContain("exception refused");
  expect(rejected).not.toContain("SAP exception approved");
});
