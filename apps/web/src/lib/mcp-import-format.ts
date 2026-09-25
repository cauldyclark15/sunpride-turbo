import { parseCsv, type ParsedCsv } from "./csv";

async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Pure browser mirror; the server remains authoritative. */
export const MCP_HEADERS = {
  mcp_visits:
    "employee_code,territory_code,route_code,outlet_code,customer_code,service_date,frequency,sequence,duration_minutes,objectives",
  route_sheet:
    "employee_code,territory_code,route_code,outlet_code,customer_code,frequency,sequence,duration_minutes,objectives",
} as const;
export type McpFormat = keyof typeof MCP_HEADERS;
export type McpParsed = ParsedCsv & {
  fileHash: string;
  interpretation: string;
};

type ExcelCell = string | number | boolean | Date | null;
export function sheetToMcpRows(
  cells: ExcelCell[][],
  format: McpFormat,
): ParsedCsv {
  const expected = MCP_HEADERS[format].split(",");
  const header = (cells[0] ?? []).map((value) =>
    typeof value === "string" ? value.trim() : String(value ?? ""),
  );
  const errors: ParsedCsv["errors"] = [];
  if (header.join(",") !== MCP_HEADERS[format])
    errors.push({
      rowNumber: 1,
      code: "invalid_format",
      message: `Header must match exactly: ${MCP_HEADERS[format]}`,
    });
  const rows: ParsedCsv["rows"] = [];
  for (let index = 1; index < cells.length; index++) {
    const source = cells[index]!;
    if (source.every((value) => value === null || value === "")) continue;
    const values: Record<string, string> = {};
    expected.forEach((name, column) => {
      const value = source[column];
      if (value instanceof Date) {
        const iso = Number.isNaN(value.getTime()) ? "" : value.toISOString();
        if (name !== "service_date" || iso.slice(11, 23) !== "00:00:00.000")
          errors.push({
            rowNumber: index + 1,
            code: "ambiguous_date",
            message: `${name} must be text, or a date-only Excel cell`,
          });
        values[name] = iso.slice(0, 10);
      } else if (typeof value === "number" || typeof value === "boolean") {
        if (name.endsWith("_code") || name === "service_date")
          errors.push({
            rowNumber: index + 1,
            code: "text_required",
            message: `${name} must be stored as text to preserve leading zeroes and avoid ambiguous Excel dates`,
          });
        values[name] = String(value);
      } else values[name] = value ?? "";
    });
    if (
      source.length > expected.length &&
      source
        .slice(expected.length)
        .some((value) => value !== null && value !== "")
    )
      errors.push({
        rowNumber: index + 1,
        code: "column_count",
        message: "Extra cells outside template columns",
      });
    rows.push({ rowNumber: index + 1, values });
  }
  return {
    header,
    rows,
    errors,
    missingColumns: expected.filter((x) => !header.includes(x)),
    unknownColumns: header.filter((x) => !expected.includes(x)),
  };
}

export async function parseMcpFile(
  file: File,
  format: McpFormat,
): Promise<McpParsed> {
  const header = MCP_HEADERS[format].split(",");
  if (/\.csv$/i.test(file.name)) {
    const text = await file.text();
    return {
      ...parseCsv(text, header),
      fileHash: await contentHash(new TextEncoder().encode(text)),
      interpretation:
        "CSV: dates read as literal YYYY-MM-DD Manila text; codes remain text.",
    };
  }
  if (!/\.xlsx$/i.test(file.name))
    throw new Error("Upload a .csv or .xlsx file");
  // Dynamic browser-only import keeps the XLSX parser out of the server bundle.
  const { readSheet } = await import("read-excel-file/browser");
  const cells = await readSheet(file, 1);
  const parsed = sheetToMcpRows(cells as unknown as ExcelCell[][], format);
  const buffer = new Uint8Array(await file.arrayBuffer());
  // SHA-256 over workbook bytes: same workbook, regardless of filename, shares a run key.
  return {
    ...parsed,
    fileHash: await contentHash(buffer),
    interpretation:
      "XLSX first sheet: date-only Excel cells become YYYY-MM-DD (Manila calendar date); text codes keep leading zeroes. Numeric code/date cells are rejected; store codes as text.",
  };
}
