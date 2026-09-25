import { v } from "convex/values";
import { hashPayload } from "../inventory/posting";

/** Shared CSV import primitives. See docs/runbooks/MASTER_DATA_IMPORTS.md. */

export const MAX_IMPORT_ROWS = 5_000;
export const IMPORT_CHUNK_ROWS = 100;
export const MAX_IMPORT_ERRORS = 500;

export const importRowValidator = v.object({
  rowNumber: v.number(),
  values: v.record(v.string(), v.string()),
});

export const rowErrorValidator = v.object({
  rowNumber: v.number(),
  column: v.optional(v.string()),
  code: v.string(),
  message: v.string(),
});

export type ImportType = "products" | "opening_stock";

export type ImportRow = {
  rowNumber: number;
  values: Record<string, string>;
};

export type RowError = {
  rowNumber: number;
  column?: string;
  code: string;
  message: string;
};

export const ERROR_CODES = {
  requiredMissing: "required_missing",
  invalidFormat: "invalid_format",
  unknownReference: "unknown_reference",
  duplicateInFile: "duplicate_in_file",
  barcodeConflict: "barcode_conflict",
  policyMissing: "policy_missing",
  notPositive: "not_positive",
  tooManyRows: "too_many_rows",
  scopeDenied: "scope_denied",
  duplicateStock: "duplicate_stock",
} as const;

export function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeLotNumber(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeBarcode(value: string): string {
  return value.replace(/\D/g, "");
}

/** Empty means "use the default"; anything else must be a recognized boolean. */
export function parseCsvBoolean(
  value: string,
  fallback: boolean,
): boolean | null {
  const normalized = value.trim().toUpperCase();
  if (normalized === "") return fallback;
  if (["Y", "YES", "TRUE", "1"].includes(normalized)) return true;
  if (["N", "NO", "FALSE", "0"].includes(normalized)) return false;
  return null;
}

/** `YYYY-MM-DD` only, interpreted as UTC midnight. */
export function parseCsvDate(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const parsed = Date.parse(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

export function parseCsvInteger(value: string): number | null {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function chunk<T>(rows: T[], size = IMPORT_CHUNK_ROWS): T[][] {
  if (size <= 0) throw new Error("Chunk size must be positive");
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size)
    chunks.push(rows.slice(index, index + size));
  return chunks;
}

/**
 * One idempotency key per chunk. Replaying a chunk returns its stored result and writes
 * nothing; reusing a key with a different payload is rejected.
 */
export function chunkKey(
  importType: ImportType,
  runKey: string,
  chunkIndex: number,
): string {
  return `${importType}:${runKey}:${chunkIndex}`;
}

export function fileHashOf(rowCount: number, rows: ImportRow[]): string {
  return hashPayload({ rowCount, rows });
}

/** Server-owned digest of the exact chunk and its posting provenance. */
export function chunkHashOf(
  chunkIndex: number,
  rows: ImportRow[],
  sourceReference?: string,
): string {
  return hashPayload({
    chunkIndex,
    rows,
    sourceReference: sourceReference ?? null,
  });
}

export function rowError(
  rowNumber: number,
  code: string,
  message: string,
  column?: string,
): RowError {
  return { rowNumber, code, message, ...(column ? { column } : {}) };
}

export function cell(row: ImportRow, column: string): string {
  return (row.values[column] ?? "").trim();
}

export function requiredCell(
  row: ImportRow,
  column: string,
  errors: RowError[],
): string | null {
  const value = cell(row, column);
  if (value === "") {
    errors.push(
      rowError(
        row.rowNumber,
        ERROR_CODES.requiredMissing,
        `${column} is required`,
        column,
      ),
    );
    return null;
  }
  return value;
}
