import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
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
  it("F-601 F-607 preserves deep lineage tables, ISO dates, frozen cut metadata and long Unicode text without truncation", async () => {
    const long = "x".repeat(32766) + "😀" + "y".repeat(9000),
      date = new Date("2026-10-20T02:00:00Z"),
      contentHash = createHash("sha256").update("F-607 fixture").digest("hex");
    const buffer = Buffer.from(
      await xlsx({
        status: "accepted",
        contentHash,
        rows: [
          {
            label: "Sample outlet",
            nested: {
              lineage: [{ source: "SAMPLE", receivedAt: date, note: long }],
            },
          },
        ],
      }).arrayBuffer(),
    );
    const names = await readSheetNames(buffer);
    expect(names).toEqual(["1 Overview", "2 rows", "3 rows nested lineage"]);
    const overview = await readSheet(buffer, "1 Overview");
    expect(overview.find((r) => r[0] === "contentHash")?.[1]).toBe(contentHash);
    expect(overview.find((r) => r[0] === "status")?.[1]).toBe("accepted");
    const parents = await readSheet(buffer, "2 rows"),
      children = await readSheet(buffer, "3 rows nested lineage");
    const parentHeader = parents[0],
      parentRow = parents[1],
      childHeader = children[0],
      childRow = children[1];
    if (!parentHeader || !parentRow || !childHeader || !childRow)
      throw new Error("Missing exported lineage rows");
    expect(childRow[childHeader.indexOf("parentRow")]).toBe(
      parentRow[parentHeader.indexOf("rowRef")],
    );
    expect(childRow[childHeader.indexOf("receivedAt")]).toBe(
      date.toISOString(),
    );
    const text = childHeader
      .map((key, i) =>
        typeof key === "string" && key.startsWith("note part ")
          ? String(childRow[i])
          : "",
      )
      .join("");
    expect(text).toBe(long);
  });
  it("F-601 refuses oversized worksheets and invalid Excel headers instead of returning partial data", () => {
    expect(() =>
      xlsx({ rows: Array.from({ length: 100001 }, () => ({ value: 0 })) }),
    ).toThrow("100,000 rows");
    expect(() => xlsx({ rows: [{ ["x".repeat(32768)]: "value" }] })).toThrow(
      "Excel cell limit",
    );
    expect(() =>
      xlsx({
        rows: [
          Object.fromEntries(
            Array.from({ length: 16385 }, (_, i) => [`field${i}`, i]),
          ),
        ],
      }),
    ).toThrow("Narrow the period or columns");
  });
});
