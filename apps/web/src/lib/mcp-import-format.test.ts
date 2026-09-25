import { describe, expect, it } from "vitest";
import { MCP_HEADERS as SERVER } from "../../../../packages/backend/convex/imports/mcp";
import { MCP_HEADERS, parseMcpFile, sheetToMcpRows } from "./mcp-import-format";

const columns = MCP_HEADERS.mcp_visits.split(",");
describe("MCP spreadsheet format", () => {
  it("mirrors canonical server headers and parses quoted CSV objectives/codes", async () => {
    expect(MCP_HEADERS).toEqual(SERVER);
    const text = `${columns.join(",")}\r\n0007,T,R,0009,,2026-10-15,weekly,1,30,"Visit, then ""sell"""\r\n`;
    const file = { name: "visits.csv", text: async () => text } as File;
    const parsed = await parseMcpFile(file, "mcp_visits");
    expect(parsed.rows[0]?.values.outlet_code).toBe("0009");
    expect(parsed.rows[0]?.values.objectives).toBe('Visit, then "sell"');
    expect(parsed.fileHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("retains first-sheet row numbers, text leading zeroes and date-only Excel cells", () => {
    const sheet = [
      columns,
      [
        "0007",
        "T",
        "R",
        "0009",
        "",
        new Date("2026-10-15T00:00:00Z"),
        "weekly",
        1,
        30,
        "Visit",
      ],
      Array(columns.length).fill(null),
      ["0007", "T", "R", "0010", "", 46940, "weekly", 2, 30, "Visit"],
    ];
    const result = sheetToMcpRows(sheet, "mcp_visits");
    expect(result.rows.map((row) => row.rowNumber)).toEqual([2, 4]);
    expect(result.rows[0]?.values.service_date).toBe("2026-10-15");
    expect(result.rows[0]?.values.outlet_code).toBe("0009");
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rowNumber: 4, code: "text_required" }),
      ]),
    );
  });
  it("rejects numeric code and date with time instead of losing leading zeroes or guessing timezone", () => {
    const result = sheetToMcpRows(
      [
        columns,
        [
          7,
          "T",
          "R",
          9,
          "",
          new Date("2026-10-15T12:00:00Z"),
          "weekly",
          1,
          30,
          "Visit",
        ],
      ],
      "mcp_visits",
    );
    expect(result.errors.map((error) => error.code)).toEqual([
      "text_required",
      "text_required",
      "ambiguous_date",
    ]);
  });
  it("parses a real first-sheet XLSX with a styled date and text leading zeroes", async () => {
    const bytes = Uint8Array.from(
      Buffer.from(
        "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",
        "base64",
      ),
    );
    const file = Object.assign(
      new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      { name: "visits.xlsx" },
    ) as File;
    const parsed = await parseMcpFile(file, "mcp_visits");
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]?.values).toMatchObject({
      employee_code: "0007",
      outlet_code: "0009",
      service_date: "2026-10-15",
      sequence: "1",
    });
    expect(parsed.interpretation).toContain("first sheet");
  });
});
