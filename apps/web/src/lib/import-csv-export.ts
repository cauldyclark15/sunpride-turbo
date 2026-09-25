import type { CsvParseError } from "./csv";

export type ImportError = CsvParseError & { column?: string };

/** UI-only mirrors of the server headers; parity is asserted in tests. */
export const OPERATIONAL_HEADERS = {
  stock_adjustment:
    "source_reference,line_key,adjustment_type,reason_code,product_code,location_code,stock_status,lot_number,quantity_delta,unit_cost_minor,note",
  cycle_count:
    "count_reference,location_code,product_code,stock_status,lot_number,counted_quantity,finding,note",
} as const;

function cell(value: string | number) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function errorCsv(errors: ImportError[]) {
  return (
    [
      "row_number,column,code,message",
      ...errors.map((error) =>
        [error.rowNumber, error.column ?? "", error.code, error.message]
          .map(cell)
          .join(","),
      ),
    ].join("\r\n") + "\r\n"
  );
}

export function downloadCsv(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
