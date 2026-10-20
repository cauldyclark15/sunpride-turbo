import { describe, it, expect } from "vitest";
import readXlsxFile, { readSheet } from "read-excel-file/node";
import { xlsx } from "../../../api/src/domains/analytics/xlsx.js";

const readSheetNames = async (input: Buffer) =>
  (await readXlsxFile(input)).map((sheet) => sheet.sheet);

describe("F-601 real Excel workbooks", () => {
  it("round-trips ZIP/OOXML with typed amounts, Unicode, nulls and literal formula-looking text", async () => {
    const response = xlsx({
      period: { from: "2026-10-01", to: "2026-10-20" },
      rows: [
        {
          name: '=HYPERLINK("https://bad.invalid")',
          amountCentavos: 12345,
          empty: null,
          unicode: "Cebu ₱ & <meat>",
          enabled: true,
        },
        {
          name: " +SUM(A1:A2)",
          amountCentavos: 0,
          empty: null,
          unicode: "Sample",
          enabled: false,
        },
      ],
      locations: [{ label: "Depot", cases: 5.5 }],
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(response.headers.get("content-disposition")).toContain(".xlsx");
    const sheets = await readSheetNames(buffer);
    expect(sheets).toEqual(["1 Overview", "2 rows", "3 locations"]);
    const rows = await readSheet(buffer, "2 rows");
    expect(rows[0]).toEqual([
      "name",
      "amountCentavos",
      "empty",
      "unicode",
      "enabled",
    ]);
    expect(rows[1]).toEqual([
      '=HYPERLINK("https://bad.invalid")',
      12345,
      null,
      "Cebu ₱ & <meat>",
      true,
    ]);
    expect(rows[2]).toEqual(["+SUM(A1:A2)", 0, null, "Sample", false]);
    expect(buffer.toString()).not.toContain("<f>");
    expect(await readSheet(buffer, "3 locations")).toEqual([
      ["label", "cases"],
      ["Depot", 5.5],
    ]);
  });
  it("exports nested cockpit tables and an empty table as separate worksheets", async () => {
    const buffer = Buffer.from(
      await xlsx({
        rows: [],
        field: { people: [{ name: "Rep", sales: 100 }] },
        assortment: [{ product: { name: "Meat" }, onShelf: null }],
      }).arrayBuffer(),
    );
    expect(await readSheetNames(buffer)).toEqual([
      "1 Overview",
      "2 rows",
      "3 field people",
      "4 assortment",
    ]);
    expect(await readSheet(buffer, "3 field people")).toEqual([
      ["name", "sales"],
      ["Rep", 100],
    ]);
    expect(await readSheet(buffer, "4 assortment")).toEqual([
      ["product · name", "onShelf"],
      ["Meat", null],
    ]);
  });
});
