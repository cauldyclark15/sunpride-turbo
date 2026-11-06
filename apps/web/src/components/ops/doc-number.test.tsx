import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocNumber, looksLikeDocNumber } from "./doc-number";

describe("DocNumber", () => {
  it("shows the number in monospace", () => {
    const html = renderToStaticMarkup(
      createElement(DocNumber, { value: "TRF-CEB-261106-0012" }),
    );
    expect(html).toContain("TRF-CEB-261106-0012");
    expect(html).toContain("font-mono");
  });
  it("never shows a UUID or an empty value", () => {
    for (const v of [
      "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
      "",
      "  ",
      null,
      undefined,
    ]) {
      const html = renderToStaticMarkup(createElement(DocNumber, { value: v }));
      expect(html).toContain("No number yet");
      expect(html).not.toContain("3f1c2d4e");
    }
  });
  it("recognises the TYPE-LOC-YYMMDD-NNNN pattern", () => {
    for (const ok of [
      "TRF-CEB-261106-0012",
      "SHF-REG01-261106-0001",
      "Z-REG01-261106-0003",
      "LOAD-CEB-261106-12345",
    ])
      expect(looksLikeDocNumber(ok)).toBe(true);
    for (const bad of ["trf-ceb-1", "TRF-CEB-261106", "12345"])
      expect(looksLikeDocNumber(bad)).toBe(false);
  });
});
