/**
 * SP-0169 store ("customer") upload — browser-side helpers.
 *
 * The template and the synchronous row rules come from the shared
 * `@sunpride/import-templates/customers` module, so the browser check on file pick and the
 * server's authoritative re-check run the very same code.
 */
import {
  CUSTOMER_CHUNK_SIZE,
  CUSTOMER_HEADERS,
  CUSTOMER_MAX_ROWS,
  CUSTOMER_TEMPLATE_FILE_NAME,
  customerTemplateCsv,
  headerError,
  validateCustomerRowsSync,
  type UploadError,
  type UploadRow,
} from "@sunpride/import-templates/customers";
import type { ParsedCsv } from "./csv";
import { downloadCsv } from "./import-csv-export";

export type { UploadError, UploadRow };
export { CUSTOMER_HEADERS, CUSTOMER_CHUNK_SIZE, CUSTOMER_MAX_ROWS };
export const STORE_UPLOAD_API = "/api/v1/imports/store-upload";
/** Rows per async-validation request (progress granularity). */
export const PREVIEW_BATCH = 1000;

export type Step = 1 | 2 | 3 | 4 | 5;
export const STEPS: { step: Step; label: string }[] = [
  { step: 1, label: "Upload file" },
  { step: 2, label: "Validate" },
  { step: 3, label: "Preview" },
  { step: 4, label: "Import" },
  { step: 5, label: "Result" },
];

export type PreviewRow = {
  rowNumber: number;
  customerCode: string;
  action: "new" | "update";
  valid: boolean;
};
export type PreviewResult = {
  rowCount: number;
  validCount: number;
  errorRowCount: number;
  newCount: number;
  updateCount: number;
  errors: UploadError[];
  rows: PreviewRow[];
};
export type RunStatus =
  "queued" | "running" | "completed" | "completed_with_errors" | "interrupted";
export type RunSummary = {
  id: string;
  fileName: string;
  status: RunStatus;
  rowCount: number;
  succeeded: number;
  failed: number;
  pending: number;
  created: number;
  updated: number;
  actorName: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  interruptedAt: number | null;
  heartbeatAt: number | null;
  duplicate?: boolean;
  resumed?: boolean;
};
export type RunRow = {
  rowNumber: number;
  customerCode: string;
  values: Record<string, string>;
  action: "new" | "update" | null;
  status: "pending" | "succeeded" | "failed";
  errors: {
    column: string | null;
    code: string;
    message: string;
    value: string;
  }[];
};

export const isLive = (status: RunStatus) =>
  status === "queued" || status === "running";

export const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Waiting to start",
  running: "Importing",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  interrupted: "Interrupted",
};

/**
 * Instant (synchronous) checks on file pick: header, required cells, formats and duplicates.
 * Parse errors from the CSV/XLSX reader are kept, tied to their row.
 */
export function syncValidate(
  parsed: Pick<ParsedCsv, "header" | "rows" | "errors">,
): {
  fileErrors: UploadError[];
  rowErrors: UploadError[];
} {
  const fileErrors: UploadError[] = [];
  const header = headerError(parsed.header);
  if (header) fileErrors.push(header);
  if (!parsed.rows.length)
    fileErrors.push({
      rowNumber: 1,
      code: "empty_file",
      message: "The file has no store rows under the header.",
    });
  if (parsed.rows.length > CUSTOMER_MAX_ROWS)
    fileErrors.push({
      rowNumber: 1,
      code: "too_many_rows",
      message: `The file has ${parsed.rows.length} rows. Upload at most ${CUSTOMER_MAX_ROWS} stores per file.`,
    });
  const parseRowErrors: UploadError[] = parsed.errors
    .filter((e) => e.rowNumber > 1)
    .map((e) => ({ ...e }));
  // Header-level parse errors are already covered by headerError's exact message.
  if (fileErrors.length) return { fileErrors, rowErrors: parseRowErrors };
  return {
    fileErrors,
    rowErrors: sortErrors([
      ...parseRowErrors,
      ...validateCustomerRowsSync(parsed.rows),
    ]),
  };
}

export function sortErrors(errors: UploadError[]) {
  const order = (c?: string) =>
    c ? CUSTOMER_HEADERS.indexOf(c) : Number.MAX_SAFE_INTEGER;
  return [...errors].sort(
    (a, b) => a.rowNumber - b.rowNumber || order(a.column) - order(b.column),
  );
}

/** rowNumber → column ("" for whole-row) → errors, for cell highlighting. */
export function errorIndex(errors: UploadError[]) {
  const index = new Map<number, Map<string, UploadError[]>>();
  for (const e of errors) {
    const row = index.get(e.rowNumber) ?? new Map<string, UploadError[]>();
    const key = e.column ?? "";
    row.set(key, [...(row.get(key) ?? []), e]);
    index.set(e.rowNumber, row);
  }
  return index;
}

/** Combine the batched async-preview responses into one result. */
export function mergePreviews(parts: PreviewResult[]): PreviewResult {
  const rows = parts.flatMap((p) => p.rows);
  const errors = sortErrors(parts.flatMap((p) => p.errors));
  const bad = new Set(errors.map((e) => e.rowNumber));
  const fixed = rows.map((r) => ({ ...r, valid: !bad.has(r.rowNumber) }));
  return {
    rowCount: fixed.length,
    validCount: fixed.filter((r) => r.valid).length,
    errorRowCount: bad.size,
    newCount: fixed.filter((r) => r.valid && r.action === "new").length,
    updateCount: fixed.filter((r) => r.valid && r.action === "update").length,
    errors,
    rows: fixed,
  };
}

/** Spreadsheet-safe CSV cell (formula injection guarded). */
function cell(value: string | number | null | undefined) {
  const raw = String(value ?? "");
  const text =
    /^[\s]*[=+@-]/.test(raw) && !/^[+-]?\d/.test(raw.trim()) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
const line = (cells: (string | number | null | undefined)[]) =>
  cells.map(cell).join(",");

/** Every problem: row, column, offending value, code, message. */
export function errorsCsv(errors: UploadError[]) {
  return (
    [
      "row_number,column,value,code,message",
      ...errors.map((e) =>
        line([e.rowNumber, e.column ?? "", e.value ?? "", e.code, e.message]),
      ),
    ].join("\r\n") + "\r\n"
  );
}

/** Run report: the original columns + result + error, one line per uploaded row. */
export function reportCsv(rows: RunRow[]) {
  return (
    [
      [
        ...CUSTOMER_HEADERS,
        "result",
        "action",
        "error_column",
        "error_code",
        "error_message",
      ].join(","),
      ...rows.map((r) => {
        const result =
          r.status === "succeeded"
            ? "succeeded"
            : r.status === "failed"
              ? "failed"
              : "not processed";
        return line([
          ...CUSTOMER_HEADERS.map((h) => r.values[h] ?? ""),
          result,
          r.action ?? "",
          r.errors.map((e) => e.column ?? "").join("; "),
          r.errors.map((e) => e.code).join("; ") ||
            (r.status === "pending" ? "not_processed" : ""),
          r.errors.map((e) => e.message).join(" ") ||
            (r.status === "pending"
              ? "The import stopped before this row was processed. Resume the upload."
              : ""),
        ]);
      }),
    ].join("\r\n") + "\r\n"
  );
}

export function downloadTemplate() {
  downloadCsv(CUSTOMER_TEMPLATE_FILE_NAME, customerTemplateCsv());
}

/** 0–100 for a progress bar. */
export const percent = (done: number, total: number) =>
  total ? Math.min(100, Math.round((done / total) * 100)) : 0;
