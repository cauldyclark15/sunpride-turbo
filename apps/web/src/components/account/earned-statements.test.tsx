import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EarnedStatementList } from "./earned-statements";
import { signedCentavos } from "../tpm/model";
it("F-510 self statements label sample policy and excluded metrics; exact negative corrections remain centavos", () => {
  const html = renderToStaticMarkup(
    <EarnedStatementList
      rows={[
        {
          id: "sample",
          plan_name: "Sample field award",
          plan_source: "sample",
          status: "calculated",
          period_from: "2026-10-01",
          period_to: "2026-10-31",
          amountCentavos: 500,
          result: {
            lines: [
              {
                metric: "targets",
                actual: 5000,
                target: 10000,
                amountCentavos: 500,
              },
              {
                metric: "settlementVariance",
                actual: null,
                target: null,
                excluded: true,
                amountCentavos: 0,
              },
            ],
          },
        },
      ]}
    />,
  );
  expect(html).toContain("Sample policy");
  expect(html).toContain("5000 / 10000");
  expect(html).toContain("Excluded by this effective plan");
  expect(html).not.toContain("Unknown / Unknown");
  expect(signedCentavos("-10.05")).toBe(-1005);
  expect(() => signedCentavos("-1.001")).toThrow();
});
