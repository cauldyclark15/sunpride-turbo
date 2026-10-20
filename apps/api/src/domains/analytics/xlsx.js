import { ApiError } from "../../core/errors.js";

/** F-601: small dependency-free OOXML writer. Text is inlineStr, NEVER a formula.
 * ZIP uses stored entries and CRC32; no macro, formula, external link or executable XML.
 * @param {string} text */
const xml = (text) =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
/** @param {Buffer} bytes */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** @param {Record<string,string>} entries */
function zip(entries) {
  const files = [],
    central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const path = Buffer.from(name),
      data = Buffer.from(text),
      crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    files.push(local, path, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(path.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, path);
    offset += local.length + path.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}
/** @param {number} n */
function column(n) {
  let s = "";
  for (n++; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
/** @param {any} row @param {string} [prefix] @param {Record<string,any>} [out] */
function flatten(row, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(row)) {
    const key = prefix ? `${prefix} · ${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}
/** A sheet for every table, plus filters/lineage. Current authorization runs BEFORE this.
 * @param {any} body @param {string} [filename] */
export function xlsx(body, filename = "analytics") {
  /** @type {Record<string,any[]>} */ const tables = {};
  const metadata = flatten({
    period: body.period,
    compare: body.compare,
    scope: body.scope,
    freshness: body.freshness,
    demo: body.demo,
    definitionVersion: body.definitionVersion ?? "commercial/v1",
    moneyUnit: "PHP centavos (integer minor units)",
    quantityUnit:
      "Cases and pieces are separate; Base fields are scaled base units",
    next: body.next ?? null,
  });
  tables.Overview = Object.entries(metadata).map(([field, value]) => ({
    field,
    value,
  }));
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v))
      tables[k] = v.map((r) =>
        r && typeof r === "object" ? flatten(r) : { value: r },
      );
    else if (v && typeof v === "object")
      for (const [key, rows] of Object.entries(v))
        if (Array.isArray(rows))
          tables[`${k} ${key}`] = rows.map((r) =>
            r && typeof r === "object" ? flatten(r) : { value: r },
          );
  }
  const sheets = Object.entries(tables).map(([name, rows], i) => ({
    name: `${i + 1} ${name}`.replace(/[\\/?*\[\]:]/g, " ").slice(0, 31),
    rows,
  }));
  if (sheets.some((s) => s.rows.length > 100000))
    throw new ApiError(
      "export_too_large",
      422,
      "Narrow the period before exporting more than 100,000 rows.",
    );
  /** @type {Record<string,string>} */ const entries = {};
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  entries["[Content_Types].xml"] =
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`;
  entries["_rels/.rels"] =
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  entries["xl/workbook.xml"] =
    `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
  entries["xl/_rels/workbook.xml.rels"] =
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`;
  sheets.forEach((s, i) => {
    const keys = [...new Set(s.rows.flatMap((r) => Object.keys(r)))];
    const grid = [keys, ...s.rows.map((r) => keys.map((k) => r[k]))];
    entries[`xl/worksheets/sheet${i + 1}.xml`] =
      `<worksheet xmlns="${ns}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><sheetData>${grid
        .map(
          (row, r) =>
            `<row r="${r + 1}">${row
              .map((v, c) => {
                const ref = `${column(c)}${r + 1}`;
                if (v == null) return `<c r="${ref}"/>`;
                if (typeof v === "number" && Number.isFinite(v))
                  return `<c r="${ref}"><v>${v}</v></c>`;
                if (typeof v === "boolean")
                  return `<c r="${ref}" t="b"><v>${Number(v)}</v></c>`;
                return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(String(v).slice(0, 32767))}</t></is></c>`;
              })
              .join("")}</row>`,
        )
        .join(
          "",
        )}</sheetData>${keys.length ? `<autoFilter ref="A1:${column(keys.length - 1)}${grid.length}"/>` : ""}</worksheet>`;
  });
  return new Response(zip(entries), {
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9-]/g, "-")}.xlsx"`,
      "cache-control": "no-store",
    },
  });
}
