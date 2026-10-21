import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CollectionEvidenceView,
  type CollectionEvidenceItem,
} from "./collection-evidence";
const wire = JSON.parse(
  readFileSync(
    new URL("./fixtures/collector-native-v2.json", import.meta.url),
    "utf8",
  ),
) as { evidence: { items: CollectionEvidenceItem[] } };
it("F-613 actual acknowledged collector evidence renders named bank notice and its scoped JPEG, not financial clearance", () => {
  const html = renderToStaticMarkup(
    createElement(CollectionEvidenceView, { items: wire.evidence.items }),
  );
  expect(html).toContain("SAMPLE bank returned insufficient-funds notice");
  expect(html).toContain("SAMPLE collector");
  expect(html).toContain("data:image/jpeg;base64,");
  expect(html).not.toContain("cleared");
});
it("F-613 absence of acknowledged evidence leaves phone-only work explicitly possible", () => {
  const html = renderToStaticMarkup(
    createElement(CollectionEvidenceView, { items: [] }),
  );
  expect(html).toContain("phone-only queued capture may still exist");
});
