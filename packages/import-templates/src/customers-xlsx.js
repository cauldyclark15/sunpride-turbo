// SP-0170 customer upload template as an Excel workbook (exceljs), and the .xlsx reader.
// Same code builds the browser download and the client-ready file
// (scripts/build-customer-template.js). Loaded lazily: only template downloads and .xlsx
// uploads pay for exceljs.
import ExcelJS from "exceljs";
import {
  CUSTOMERS_SHEET,
  CUSTOMER_COLUMNS,
  CUSTOMER_MAX_ROWS,
  LIST_FIRST_ROW,
  dropdownSources,
  instructionLines,
  listSheets,
  requiredText,
} from "./customers.js";

/** @typedef {import("@sunpride/customer-master").ReferenceRow} ReferenceRow */

const REQUIRED_FILL = /** @type {const} */ ({
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFFF2CC" },
});
const HEADER_FILL = /** @type {const} */ ({
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFF2F2F2" },
});

/** Spreadsheet column letters for a 1-based index. @param {number} n */
export function columnLetter(n) {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26))
    s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/**
 * Build the template workbook: Instructions, Customers (headers = the client's labels, required
 * headings marked and commented with the rule + the client's Remarks, every cell text-formatted,
 * dropdowns on list columns), then one sheet per client list from the DB reference rows.
 * @param {ReferenceRow[]} reference active customer_reference_values rows
 */
export function buildCustomerTemplateWorkbook(reference) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Sunpride";
  wb.title = "Sunpride customer upload template";
  const lastRow = CUSTOMER_MAX_ROWS + 1;

  const info = wb.addWorksheet("Instructions");
  info.getColumn(1).width = 140;
  for (const [i, line] of instructionLines().entries()) {
    const cell = info.getCell(i + 1, 1);
    cell.value = line;
    cell.alignment = { wrapText: true, vertical: "top" };
    if (i === 0) cell.font = { bold: true, size: 14 };
  }

  const ws = wb.addWorksheet(CUSTOMERS_SHEET, {
    views: [{ state: "frozen", xSplit: 1, ySplit: 1 }],
  });
  CUSTOMER_COLUMNS.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(40, Math.max(14, c.label.length + 4));
    col.numFmt = "@"; // keep codes like 0002 / 0700000000 and mobiles exactly as typed
    const cell = ws.getCell(1, i + 1);
    cell.value = c.label;
    cell.font = { bold: c.required };
    cell.fill = c.required ? REQUIRED_FILL : HEADER_FILL;
    cell.alignment = { wrapText: true, vertical: "top" };
    cell.note = [
      `${c.section}${c.section === "System" ? "" : " (Sunpride template)"}`,
      requiredText(c),
      c.hint,
      c.remark ? `Sunpride remark: ${c.remark}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  ws.getRow(1).height = 30;

  const sheets = listSheets(reference);
  for (const s of sheets) {
    const sheet = wb.addWorksheet(s.name);
    sheet.getCell(1, 1).value = s.title;
    sheet.getCell(1, 1).font = { bold: true };
    s.columns.forEach((h, i) => {
      const cell = sheet.getCell(2, i + 1);
      cell.value = h;
      cell.font = { bold: true };
      sheet.getColumn(i + 1).width = Math.max(12, h.length + 4);
      sheet.getColumn(i + 1).numFmt = "@";
    });
    s.rows.forEach((r, j) =>
      r.forEach((v, i) => {
        if (v !== "") sheet.getCell(LIST_FIRST_ROW + j, i + 1).value = v;
      }),
    );
  }

  const sources = dropdownSources(sheets);
  CUSTOMER_COLUMNS.forEach((c, i) => {
    const range = `${columnLetter(i + 1)}2:${columnLetter(i + 1)}${lastRow}`;
    /** @type {string[]|null} */ let formulae = null;
    if (c.list === "country") formulae = ['"Philippines (PH)"'];
    else if (c.kind === "list") {
      const src = sources[c.id];
      if (src && src.count > 0) {
        const L = columnLetter(src.column);
        formulae = [
          `'${src.sheet}'!$${L}$${LIST_FIRST_ROW}:$${L}$${LIST_FIRST_ROW + src.count - 1}`,
        ];
      }
    }
    if (!formulae) return;
    // Dependent lists are plain lists in Excel; the upload enforces the chain. Typed codes or
    // descriptions are allowed (warning style), so the error style is "information".
    /** @type {any} */ (ws).dataValidations.add(range, {
      type: "list",
      allowBlank: true,
      formulae,
      showErrorMessage: true,
      errorStyle: "information",
      errorTitle: c.label,
      error:
        'Not a dropdown value. A code or description is also accepted; the upload checks it.',
      showInputMessage: true,
      promptTitle: c.label,
      prompt: requiredText(c).slice(0, 250),
    });
  });
  return wb;
}

/** The template as .xlsx bytes. @param {ReferenceRow[]} reference */
export async function customerTemplateXlsx(reference) {
  const buffer = await buildCustomerTemplateWorkbook(
    reference,
  ).xlsx.writeBuffer();
  return new Uint8Array(/** @type {ArrayBuffer} */ (buffer));
}

/** A cell's value as the text the user sees/typed. @param {any} v @returns {string} */
export function cellText(v) {
  if (v == null) return "";
  if (v instanceof Date)
    return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : "";
  if (typeof v === "object") {
    if (Array.isArray(v.richText))
      return v.richText.map((/** @type {any} */ r) => r.text ?? "").join("");
    if ("result" in v) return cellText(v.result);
    if ("text" in v) return cellText(v.text);
    if ("error" in v) return "";
    return "";
  }
  if (typeof v === "number")
    return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(15)));
  return String(v);
}

/**
 * Read the "Customers" sheet (else the first sheet whose first row has "Customer Code", else the
 * first sheet) into a grid with spreadsheet row numbers.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<{rowNumber:number,cells:string[]}[]>}
 */
export async function readCustomerXlsx(bytes) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(/** @type {any} */ (bytes));
  const hasCode = (/** @type {any} */ s) => {
    const values = /** @type {any[]} */ (s.getRow(1).values ?? []);
    return values.some(
      (v) => cellText(v).trim().toLowerCase() === "customer code",
    );
  };
  const ws =
    wb.getWorksheet(CUSTOMERS_SHEET) ??
    wb.worksheets.find(hasCode) ??
    wb.worksheets[0];
  if (!ws) return [];
  /** @type {{rowNumber:number,cells:string[]}[]} */ const grid = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values = /** @type {any[]} */ (row.values ?? []);
    /** @type {string[]} */ const cells = [];
    for (let i = 1; i < values.length; i++) cells.push(cellText(values[i]));
    grid.push({ rowNumber, cells });
  });
  return grid;
}
