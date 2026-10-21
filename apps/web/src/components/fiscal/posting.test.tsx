import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FiscalPosting } from "./posting";
it("F-119 distinguishes a queue, provider refusal, missing acknowledgement and explicitly SAMPLE success", () => {
  const render = (
    status: string,
    reference: string | null = null,
    source: string | null = null,
  ) =>
    renderToStaticMarkup(
      <FiscalPosting posting={{ status, reference, source }} />,
    );
  expect(render("pending")).toContain("Queued for SAP");
  expect(render("pending")).not.toContain("accepted");
  expect(render("dead_letter")).toContain("SAP refused");
  expect(render("completed", null, "sample")).toContain("needs review");
  expect(render("completed", "SAMPLE-123", "sample")).toContain(
    "SAMPLE SAP accepted",
  );
  expect(render("completed", "REAL-123", "sap")).toContain("SAP accepted");
  expect(renderToStaticMarkup(<FiscalPosting />)).toContain(
    "No linked business posting",
  );
});
