export type TemplateColumn = {
  column: string;
  required: boolean;
  help: string;
  example: string;
};
export type UploadRow = { rowNumber: number; values: Record<string, string> };
export type UploadError = {
  rowNumber: number;
  column?: string;
  code: string;
  message: string;
  value?: string;
};
export const CUSTOMER_TEMPLATE_SPEC: readonly TemplateColumn[];
export const CUSTOMER_HEADERS: readonly string[];
export const CUSTOMER_TEMPLATE_FILE_NAME: string;
export const CUSTOMER_CHUNK_SIZE: number;
export const CUSTOMER_MAX_ROWS: number;
export const CUSTOMER_ERROR_CODES: Readonly<Record<string, string>>;
export function customerTemplateCsv(): string;
export function cellOf(row: UploadRow, key: string): string;
export function normaliseCode(value: string): string;
export function phMobile(value: string): string | null;
export function headerMatches(header: string[]): boolean;
export function headerError(header: string[]): UploadError | null;
export function validateCustomerRowsSync(rows: UploadRow[]): UploadError[];
export function composeAddress(row: UploadRow): string;
