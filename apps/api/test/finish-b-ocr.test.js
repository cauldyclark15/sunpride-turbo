import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { parsePurchaseOrder } from "../src/domains/mt/parsers.js";
import { extractDocumentText } from "../src/domains/mt/ocr.js";

test.skipIf(process.platform !== "darwin")(
  "F-306 the real local OCR reads a generated sample scan and keeps every field reviewable",
  async () => {
    const child = Bun.spawn(
      [
        "/usr/bin/swift",
        fileURLToPath(new URL("./fixtures/ocr-po.swift", import.meta.url)),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const bytes = new Uint8Array(
      await new Response(child.stdout).arrayBuffer(),
    );
    expect(await child.exited).toBe(0);
    const result = await parsePurchaseOrder("ocr", bytes);
    expect(result.extraction.modelVersion).toBe("apple-vision-text/v1");
    expect(result.poNumber).toBe("SAMPLE-0580");
    expect(result.serviceDate).toBe("2026-10-24");
    expect(result.lines).toEqual([
      {
        productCode: "SAMPLE-SKU",
        uom: "PC",
        quantity: 2,
        requestedPriceCentavos: 2550,
      },
    ]);
    expect(result.exceptions).toContain(
      "OCR-assisted draft: review the source scan and confirm every extracted field.",
    );
  },
  60000,
);
test("F-306 unavailable OCR is an honest editable-source exception, not invented extraction", async () => {
  await expect(
    extractDocumentText(new Uint8Array([1, 2, 3]), {
      SUNPRIDE_OCR_COMMAND: '["/usr/bin/false"]',
    }),
  ).rejects.toThrow("could not be read");
});
