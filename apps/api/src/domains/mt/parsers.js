import { ApiError } from "../../core/errors.js";

/** Bounded RFC-4180 parser. Never use split(',') for retailer exports.
 * @param {string} input @returns {string[][]} */
export function csv(input) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (quoted) quoted = false;
      else if (!cell) quoted = true;
      else throw new ApiError("invalid_file", 422, "Unexpected quote in CSV");
    } else if (!quoted && (ch === "," || ch === "\n" || ch === "\r")) {
      row.push(cell);
      cell = "";
      if (ch !== ",") {
        if (ch === "\r" && input[i + 1] === "\n") i++;
        if (row.some((x) => x.trim())) rows.push(row);
        row = [];
      }
    } else cell += ch;
    if (rows.length > 101 || row.length > 20)
      throw new ApiError(
        "capacity",
        422,
        "A purchase order supports at most 100 lines and 20 columns",
      );
  }
  if (quoted) throw new ApiError("invalid_file", 422, "Unclosed CSV quote");
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}
/** OCR stays pluggable, with an explicit manual-review stub, never invented OCR facts. */
export const ocrStub = {
  /** @param {Uint8Array} _bytes */
  async extract(_bytes) {
    return {
      poNumber: "",
      serviceDate: "",
      lines: [],
      exceptions: [
        "OCR adapter is not connected. Enter the purchase order facts for review.",
      ],
    };
  },
};
/** @param {string} format @param {Uint8Array} bytes @param {Record<string,string>} [mapping] @param {{extract:(bytes:Uint8Array)=>Promise<any>}} [ocr] */
export async function parsePurchaseOrder(
  format,
  bytes,
  mapping = {},
  ocr = ocrStub,
) {
  if (format === "ocr") return ocr.extract(bytes);
  const input = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .replace(/^\uFEFF/, "");
  let data;
  if (format === "edi") {
    // Explicit sample EDI-like envelope, NOT a claim of X12/EDIFACT certification.
    const segments = input
      .split(/~|\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split("|"));
    const head = segments.find((s) => s[0] === "PO");
    if (
      !head ||
      segments.some((s) => !["PO", "LINE"].includes(s[0])) ||
      segments.filter((s) => s[0] === "PO").length !== 1
    )
      throw new ApiError(
        "invalid_file",
        422,
        "Use PO|number|date and LINE|SKU|unit|quantity|price-in-centavos",
      );
    data = {
      poNumber: head[1] ?? "",
      serviceDate: head[2] ?? "",
      lines: segments
        .filter((s) => s[0] === "LINE")
        .map((s) => ({
          productCode: s[1] ?? "",
          uom: s[2] ?? "",
          quantity: Number(s[3]),
          requestedPriceCentavos: s[4] ? Number(s[4]) : null,
        })),
      exceptions: [],
    };
  } else {
    let body = input,
      po = "",
      day = "";
    if (format === "email") {
      po = /^PO-Number:\s*([^\r\n]+)$/im.exec(input)?.[1]?.trim() ?? "";
      day = /^Delivery-Date:\s*([^\r\n]+)$/im.exec(input)?.[1]?.trim() ?? "";
      const marker = /^Lines:\s*\r?\n/im.exec(input);
      if (!marker)
        throw new ApiError(
          "invalid_file",
          422,
          "Structured email needs PO-Number, Delivery-Date and a Lines: CSV block",
        );
      body = input.slice(marker.index + marker[0].length);
    } else if (format !== "csv")
      throw new ApiError(
        "invalid_file",
        422,
        "Choose CSV, EDI-like, structured email or OCR",
      );
    const rows = csv(body),
      headers = rows.shift() ?? [];
    if (new Set(headers).size !== headers.length)
      throw new ApiError(
        "invalid_file",
        422,
        "CSV column names must be unique",
      );
    const read = (/** @type {string[]} */ row, /** @type {string} */ name) =>
      row[headers.indexOf(mapping[name] ?? name)] ?? "";
    const lines = rows.map((r) => ({
      productCode: read(r, "sku").trim(),
      uom: read(r, "uom").trim(),
      quantity: Number(read(r, "quantity")),
      requestedPriceCentavos: read(r, "price_centavos")
        ? Number(read(r, "price_centavos"))
        : null,
    }));
    const first = rows[0] ?? [];
    if (format === "csv") {
      po = read(first, "po_number");
      day = read(first, "delivery_date");
    }
    const mixed =
      format === "csv" &&
      rows.some(
        (r) => read(r, "po_number") !== po || read(r, "delivery_date") !== day,
      );
    data = {
      poNumber: po,
      serviceDate: day,
      lines,
      exceptions: mixed
        ? ["One file must contain exactly one PO number and delivery date"]
        : [],
    };
  }
  if (data.lines.length > 100)
    throw new ApiError(
      "capacity",
      422,
      "A purchase order supports at most 100 lines",
    );
  return data;
}
