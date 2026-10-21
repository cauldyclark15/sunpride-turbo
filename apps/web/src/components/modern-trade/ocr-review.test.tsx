import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OcrReview } from "./ocr-review";
it("F-306 office shows real extracted source text and requires human confirmation", () => {
  const html = renderToStaticMarkup(
    <OcrReview
      extraction={{
        modelVersion: "apple-vision-text/v1",
        text: "PO-Number: SAMPLE-0580\nSAMPLE-SKU PC 2 25.50",
      }}
    />,
  );
  expect(html).toContain("SAMPLE-SKU PC 2 25.50");
  expect(html).toContain("review before confirming");
  expect(html).toContain("not a price or purchase-order approval");
  expect(renderToStaticMarkup(<OcrReview extraction={{}} />)).toBe("");
});
