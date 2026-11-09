import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { resultFromTsv, MODEL_VERSION } from "../scripts/ocr-tesseract.js";
import { extractDocumentText, purchaseOrderFromText } from "../src/domains/mt/ocr.js";

const head =
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
/** @param {number} block @param {number} line @param {number} word @param {number} conf @param {string} text */
const w = (block, line, word, conf, text) =>
  `5\t1\t${block}\t1\t${line}\t${word}\t0\t0\t10\t10\t${conf}\t${text}`;
const page1 = [
  head,
  "1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t",
  w(1, 1, 1, 96, "PO"), w(1, 1, 2, 94, "NUMBER:"), w(1, 1, 3, 90, "SAMPLE-0580"),
  w(1, 2, 1, 92, "DELIVERY\u2014DATE:"), w(1, 2, 3, 88, "2026-10-24"),
  "4\t1\t2\t1\t1\t0\t0\t0\t10\t10\t-1\t",
  w(2, 1, 1, 91, "SAMPLE-SKU"), w(2, 1, 2, 95, "PC"), w(2, 1, 3, 97, "2"), w(2, 1, 4, 89, "25.50"),
].join("\n");
const page2 = [head, w(1, 1, 1, 80, "Thank"), w(1, 1, 2, 70, "you")].join("\n");

test("F-306 tesseract adapter emits the ocr.swift shape: modelVersion, row text, per-line page/text/confidence", () => {
  const r = resultFromTsv([page1, page2]);
  expect(Object.keys(r).sort()).toEqual(["modelVersion", "observations", "text"]);
  expect(r.modelVersion).toBe(MODEL_VERSION);
  expect(r.text).toBe(
    "PO NUMBER: SAMPLE-0580\nDELIVERY-DATE: 2026-10-24\nSAMPLE-SKU PC 2 25.50\nThank you",
  );
  expect(r.observations).toEqual([
    { page: 1, text: "PO NUMBER: SAMPLE-0580", confidence: 0.933 },
    { page: 1, text: "DELIVERY-DATE: 2026-10-24", confidence: 0.9 },
    { page: 1, text: "SAMPLE-SKU PC 2 25.50", confidence: 0.93 },
    { page: 2, text: "Thank you", confidence: 0.75 },
  ]);
  for (const o of r.observations) {
    expect(Object.keys(o).sort()).toEqual(["confidence", "page", "text"]);
    expect(o.confidence).toBeGreaterThanOrEqual(0);
    expect(o.confidence).toBeLessThanOrEqual(1);
  }
  const po = purchaseOrderFromText(r);
  expect(po.poNumber).toBe("SAMPLE-0580");
  expect(po.serviceDate).toBe("2026-10-24");
  expect(po.lines).toEqual([
    { productCode: "SAMPLE-SKU", uom: "PC", quantity: 2, requestedPriceCentavos: 2550 },
  ]);
});

test("F-306 empty recognition is an empty draft, not an error", () => {
  expect(resultFromTsv([head])).toEqual({ modelVersion: MODEL_VERSION, text: "", observations: [] });
});

test("F-306 adapter rejects unreadable bytes so the API reports an honest exception", async () => {
  const script = fileURLToPath(new URL("../scripts/ocr-tesseract.js", import.meta.url));
  await expect(
    extractDocumentText(new Uint8Array([1, 2, 3]), {
      SUNPRIDE_OCR_COMMAND: JSON.stringify([process.execPath, script]),
    }),
  ).rejects.toThrow("could not be read");
});
