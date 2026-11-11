/**
 * SP-0170 customer upload (machinery from SP-0169) — browser-side helpers.
 *
 * The template (the client's "Customer Information template" layout), the file reader and the
 * row rules come from the shared `@sunpride/import-templates/customers` module, which runs the
 * `@sunpride/customer-master` rules at the `complete` level. The browser check on file pick and
 * the server's authoritative re-check (which adds PSGC geography and existing customers) run the
 * very same code.
 */
import {
  CUSTOMER_CHUNK_SIZE,
  CUSTOMER_COLUMNS,
  CUSTOMER_HEADERS,
  CUSTOMER_MAX_ROWS,
  CUSTOMER_TEMPLATE_CSV_NAME,
  CUSTOMER_TEMPLATE_FILE_NAME,
  customerTemplateCsv,
  parseCustomerFile,
  sortErrors,
  validateCustomerRows,
  type UploadError,
  type UploadRow,
} from "@sunpride/import-templates/customers";
import type { ReferenceRow } from "@sunpride/customer-master";
import { downloadCsv } from "./import-csv-export";

export type { UploadError, UploadRow };
export { CUSTOMER_COLUMNS, CUSTOMER_HEADERS, CUSTOMER_CHUNK_SIZE, CUSTOMER_MAX_ROWS };
export const CUSTOMER_UPLOAD_API = "/api/v1/imports/customer-upload";
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
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors"
  | "interrupted";
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
    label?: string | null;
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

/** The client's label of a column id ("shipTo.mobileNo" → "Mobile No. (ship-to)"). */
export function columnLabel(id: string | null | undefined) {
  if (!id) return "";
  const c = CUSTOMER_COLUMNS.find((x) => x.id === id);
  if (!c) return id;
  return c.shipTo &&
    CUSTOMER_COLUMNS.some((o) => !o.shipTo && o.label === c.label)
    ? `${c.label} (ship-to)`
    : c.label;
}

/** Read an .xlsx or .csv file into template rows. */
export async function readCustomerFile(file: File) {
  return parseCustomerFile(file.name, new Uint8Array(await file.arrayBuffer()));
}

/**
 * Instant (synchronous) checks on file pick: the shared rules at the `complete` level with the
 * reference lists (geography is checked on the server).
 */
export function syncValidate(
  parsed: { rows: UploadRow[]; fileErrors: UploadError[] },
  reference: ReferenceRow[],
): { fileErrors: UploadError[]; rowErrors: UploadError[] } {
  if (parsed.fileErrors.length)
    return { fileErrors: parsed.fileErrors, rowErrors: [] };
  return {
    fileErrors: [],
    rowErrors: validateCustomerRows(parsed.rows, reference).errors,
  };
}

export { sortErrors };

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

/** Every problem: row, the client's column label, offending value, message, code. */
export function errorsCsv(errors: UploadError[]) {
  return (
    "\uFEFF" +
    [
      "Row,Column,Value,Problem,Code",
      ...errors.map((e) =>
        line([
          e.rowNumber,
          e.label ?? columnLabel(e.column),
          e.value ?? "",
          e.message,
          e.code,
        ]),
      ),
    ].join("\r\n") +
    "\r\n"
  );
}

/** Run report: the template's columns + result + problems, one line per uploaded row. */
export function reportCsv(rows: RunRow[]) {
  return (
    "\uFEFF" +
    [
      line([...CUSTOMER_HEADERS, "Result", "Action", "Problem column", "Problem"]),
      ...rows.map((r) => {
        const result =
          r.status === "succeeded"
            ? "succeeded"
            : r.status === "failed"
              ? "failed"
              : "not processed";
        return line([
          ...CUSTOMER_COLUMNS.map((c) => r.values[c.id] ?? ""),
          result,
          r.action ?? "",
          r.errors.map((e) => e.label ?? columnLabel(e.column)).join("; "),
          r.errors.map((e) => e.message).join(" ") ||
            (r.status === "pending"
              ? "The import stopped before this row was processed. Resume the upload."
              : ""),
        ]);
      }),
    ].join("\r\n") +
    "\r\n"
  );
}

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** The Excel template, built in the browser by the same code as the client file. */
export async function downloadTemplateXlsx(reference: ReferenceRow[]) {
  const { customerTemplateXlsx } = await import(
    "@sunpride/import-templates/customers-xlsx"
  );
  const bytes = await customerTemplateXlsx(reference);
  downloadBlob(
    CUSTOMER_TEMPLATE_FILE_NAME,
    new Blob([bytes as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
}

export function downloadTemplateCsv() {
  downloadCsv(CUSTOMER_TEMPLATE_CSV_NAME, customerTemplateCsv());
}

/** 0–100 for a progress bar. */
export const percent = (done: number, total: number) =>
  total ? Math.min(100, Math.round((done / total) * 100)) : 0;
