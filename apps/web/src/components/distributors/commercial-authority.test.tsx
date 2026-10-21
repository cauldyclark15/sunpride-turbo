import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PartnerDiscountApproval } from "./commercial";
it("F-410 F-511 partner quotes escalate through the existing Finance queue and show pending decisions without another request", () => {
  const props = { onRequest: async () => {}, onRefresh: async () => {} };
  const fresh = renderToStaticMarkup(
    <PartnerDiscountApproval
      {...props}
      authority={{ status: "approval_required" }}
    />,
  );
  expect(fresh).toContain("Request independent Finance approval");
  expect(fresh).toContain("Refresh this quotation");
  const pending = renderToStaticMarkup(
    <PartnerDiscountApproval
      {...props}
      authority={{ status: "approval_required", pendingId: "hidden-approval" }}
    />,
  );
  expect(pending).toContain("waiting for Finance");
  expect(pending).not.toContain("Request independent Finance approval");
  expect(pending).not.toContain("hidden-approval");
  expect(
    renderToStaticMarkup(
      <PartnerDiscountApproval
        {...props}
        authority={{ status: "authorized" }}
      />,
    ),
  ).toBe("");
});
