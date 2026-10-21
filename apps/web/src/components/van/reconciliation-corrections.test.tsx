import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../../lib/api", () => ({ apiFetch: vi.fn(), useApi: vi.fn() }));
vi.mock("../../lib/auth", () => ({ usePermissions: vi.fn() }));
vi.mock("./use-command", () => ({ useVanCommand: vi.fn() }));
import { CorrectionFacts } from "./reconciliation-corrections";
describe("F-116 F-117 retained correction evidence", () => {
  it("shows independently reviewed cash and shortage evidence, never internal identifiers", () => {
    const html = renderToStaticMarkup(
      <CorrectionFacts
        change={{
          id: "private-change",
          kind: "cash_recount",
          reason: "SAMPLE recount evidence",
          requestedBy: "SAMPLE supervisor",
          decidedBy: "SAMPLE reviewer",
          decision: "approved",
          facts: {
            newDeclaredMinor: "120",
            newReceivedMinor: "120",
            reference: "SAMPLE handover receipt",
            movementNumber: "MV-SAMPLE",
            lines: [
              {
                quantityBase: "2",
                product: {
                  name: "SAMPLE item",
                  quantityScale: "1",
                  caseBase: "0",
                  uomCode: "EA",
                },
              },
            ],
          },
        }}
      />,
    );
    for (const label of [
      "Recounted cash",
      "corrected handover",
      "SAMPLE handover receipt",
      "SAMPLE supervisor",
      "SAMPLE reviewer",
      "SAMPLE item",
      "MV-SAMPLE",
    ])
      expect(html).toContain(label);
    expect(html).not.toContain("private-change");
  });
});
