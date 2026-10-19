/**
 * Dependency-free CSV reader for the import workspace.
 *
 * Supports the RFC 4180 subset the import templates use: quoted fields, escaped quotes,
 * commas inside quotes, CRLF or LF, and a leading byte-order mark. The browser only turns
 * text into rows — every value is re-validated on the server (see
 * docs/runbooks/MASTER_DATA_IMPORTS.md).
 */

export type CsvParseError = {
  rowNumber: number;
  code: string;
  message: string;
};

export type ParsedCsv = {
  header: string[];
  rows: { rowNumber: number; values: Record<string, string> }[];
  errors: CsvParseError[];
  missingColumns: string[];
  unknownColumns: string[];
};

/** Splits raw CSV text into cells, honouring quotes. Exported for tests. */
export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  for (; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"' && field === "") {
      quoted = true;
      continue;
    }
    if (character === ",") {
      cells.push(field);
      field = "";
      continue;
    }
    if (character === "\r") continue;
    if (character === "\n") {
      cells.push(field);
      rows.push(cells);
      cells = [];
      field = "";
      continue;
    }
    field += character;
  }
  if (field !== "" || cells.length > 0) {
    cells.push(field);
    rows.push(cells);
  }
  return rows;
}

export function parseCsv(text: string, expectedHeader: string[]): ParsedCsv {
  const errors: CsvParseError[] = [];
  const emptyFile: ParsedCsv = {
    header: [],
    rows: [],
    errors: [
      {
        rowNumber: 1,
        code: "empty_file",
        message: "The file is empty.",
      },
    ],
    missingColumns: [...expectedHeader],
    unknownColumns: [],
  };

  if (text.replace(/\uFEFF/g, "").trim() === "") return emptyFile;

  const lines = splitCsv(text).map((cells, position) => ({
    rowNumber: position + 1,
    cells,
  }));
  const populated = lines.filter(
    (line, position) =>
      position === 0 || line.cells.some((cell) => cell.trim() !== ""),
  );

  if (populated.length === 0) return emptyFile;

  const header = populated[0]!.cells.map((cell) => cell.trim());
  const named = header.filter((column) => column !== "");
  if (named.length === 0) return emptyFile;
  const missingColumns = expectedHeader.filter(
    (column) => !named.includes(column),
  );
  const unknownColumns = [
    ...new Set(named.filter((column) => !expectedHeader.includes(column))),
  ];
  const duplicateColumns = named.filter(
    (column, position) => named.indexOf(column) !== position,
  );

  if (missingColumns.length > 0)
    errors.push({
      rowNumber: 1,
      code: "missing_column",
      message: `Missing column(s): ${missingColumns.join(", ")}. Download the current template.`,
    });
  if (unknownColumns.length > 0)
    errors.push({
      rowNumber: 1,
      code: "unknown_column",
      message: `Unexpected column(s): ${unknownColumns.join(", ")}. Remove them or use the current template.`,
    });
  if (duplicateColumns.length > 0)
    errors.push({
      rowNumber: 1,
      code: "duplicate_column",
      message: `Repeated column(s): ${[...new Set(duplicateColumns)].join(", ")}.`,
    });

  const rows: ParsedCsv["rows"] = [];
  for (const line of populated.slice(1)) {
    if (line.cells.length > header.length)
      errors.push({
        rowNumber: line.rowNumber,
        code: "column_count",
        message: `Expected ${header.length} columns but found ${line.cells.length}.`,
      });
    const values: Record<string, string> = {};
    header.forEach((column, position) => {
      if (column === "") return;
      values[column] = (line.cells[position] ?? "").trim();
    });
    rows.push({ rowNumber: line.rowNumber, values });
  }

  return { header, rows, errors, missingColumns, unknownColumns };
}

/**
 * Stable content hash used as the import file's identity. The server treats this as an
 * opaque token: the same file re-uploaded under the same run produces the same value and is
 * reported as a duplicate, while a different file is rejected for that key.
 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Upload identity is SHA-256; hashText remains for legacy pure callers. */
export async function parseImportFile(
  file: File,
  expectedHeader: string[],
): Promise<ParsedCsv & { fileHash: string }> {
  if (!/\.(csv|xlsx)$/i.test(file.name))
    throw new Error("Choose a CSV or XLSX file.");
  let parsed: ParsedCsv;
  let bytes: Uint8Array;
  if (/\.csv$/i.test(file.name)) {
    const text = await file.text();
    bytes = new TextEncoder().encode(text);
    parsed = parseCsv(text, expectedHeader);
  } else {
    const { readSheet } = await import("read-excel-file/browser");
    const cells = await readSheet(file, 1);
    bytes = new Uint8Array(await file.arrayBuffer());
    const errors: CsvParseError[] = [];
    const text = cells
      .map((row, index) =>
        row
          .map((value, column) => {
            const key = expectedHeader[column] ?? "";
            if (
              index > 0 &&
              (typeof value === "number" || typeof value === "boolean") &&
              /code|reference|barcode|^key$|_at$|date/.test(key)
            )
              errors.push({
                rowNumber: index + 1,
                code: "text_required",
                message: `Store ${key.replaceAll("_", " ")} as text to keep its exact value.`,
              });
            let text = String(value ?? "");
            if (value instanceof Date) {
              const iso = Number.isFinite(value.getTime())
                ? value.toISOString()
                : "";
              if (
                !/(date|_at)$/.test(key) ||
                iso.slice(11, 23) !== "00:00:00.000"
              )
                errors.push({
                  rowNumber: index + 1,
                  code: "ambiguous_date",
                  message: "Use text or a date-only Excel cell.",
                });
              text = iso.slice(0, 10);
            }
            return `"${text.replaceAll('"', '""')}"`;
          })
          .join(","),
      )
      .join("\n");
    parsed = parseCsv(text, expectedHeader);
    parsed.errors.push(...errors);
  }
  if (
    parsed.header.join(",") !== expectedHeader.join(",") ||
    parsed.header.length !== expectedHeader.length
  )
    parsed.errors.unshift({
      rowNumber: 1,
      code: "invalid_format",
      message:
        "Columns must exactly match the downloaded template, in the same order.",
    });
  if (!parsed.rows.length || parsed.rows.length > 5000)
    parsed.errors.push({
      rowNumber: 1,
      code: "too_many_rows",
      message: "Choose a file with 1–5,000 rows.",
    });
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const fileHash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return { ...parsed, fileHash };
}
