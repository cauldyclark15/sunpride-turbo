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
/** @param {Record<string,any>} out @param {string} key @param {any} value */
function scalar(out, key, value) {
  if (value instanceof Date) value = value.toISOString();
  if (typeof value === "string" && value.length > 32767) {
    out[key] = "Long text continues in numbered part columns.";
    let start = 0,
      part = 1;
    while (start < value.length) {
      let end = Math.min(start + 32767, value.length);
      const last = value.charCodeAt(end - 1);
      if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
      out[`${key} part ${part++}`] = value.slice(start, end);
      start = end;
    }
  } else out[key] = value;
}
/** @param {any} row @param {string} [prefix] @param {Record<string,any>} [out] */
function flatten(row, prefix = "", out = Object.create(null)) {
  if (row instanceof Date) {
    scalar(out, prefix || "value", row);
    return out;
  }
  for (const [k, v] of Object.entries(row)) {
    const key = prefix ? `${prefix} · ${k}` : k;
    if (v instanceof Date) scalar(out, key, v);
    else if (v && typeof v === "object" && !Array.isArray(v))
      flatten(v, key, out);
    else
      scalar(
        out,
        key,
        Array.isArray(v)
          ? `${v.length} related records; see the matching table.`
          : v,
      );
  }
  return out;
}
/** @param {any} value @returns {boolean} */
function hasArrays(value) {
  if (Array.isArray(value)) return true;
  return (
    !!value &&
    typeof value === "object" &&
    !(value instanceof Date) &&
    Object.values(value).some(hasArrays)
  );
}
/** Preserve every nested table with stable parent references, not truncated JSON cells.
 * @param {any} value @param {Record<string,any[]>} tables @param {string} [path] @param {string|null} [parent] */
function collectTables(value, tables, path = "", parent = null) {
  if (Array.isArray(value)) {
    const name = path === "Overview" ? "Overview data" : path,
      rows = (tables[name] ??= []);
    for (const item of value) {
      const reference = `${name} #${rows.length + 1}`,
        nested = hasArrays(item);
      const row = flatten(
        item && typeof item === "object" ? item : { value: item },
      );
      if (parent) row.parentRow = parent;
      if (nested) row.rowRef = reference;
      if (rows.length >= 100000)
        throw new ApiError(
          "export_too_large",
          422,
          "Narrow the period before exporting more than 100,000 rows.",
        );
      rows.push(row);
      if (item && typeof item === "object" && !(item instanceof Date))
        for (const [key, child] of Object.entries(item))
          collectTables(child, tables, `${path} ${key}`, reference);
    }
  } else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, child] of Object.entries(value))
      collectTables(child, tables, path ? `${path} ${key}` : key, parent);
  }
}
/** A sheet for every table, plus filters/lineage. Current authorization runs BEFORE this.
 * @param {any} body @param {string} [filename] */
export function xlsx(body, filename = "analytics") {
  // Match exactly the JSON projection: dates become ISO strings and non-JSON internals
  // cannot accidentally be added to an export.
  body = JSON.parse(JSON.stringify(body));
  /** @type {Record<string,any[]>} */ const tables = Object.create(null);
  const metadata = flatten({
    ...body,
    definitionVersion: body.definitionVersion ?? "commercial/v1",
    moneyUnit: "PHP centavos (integer minor units)",
    quantityUnit:
      "Cases and pieces remain separate; refer to each table's field definitions for base-unit scaling.",
  });
  tables.Overview = Object.entries(metadata).map(([field, value]) => ({
    field,
    value,
  }));
  collectTables(body, tables);
  const sheets = Object.entries(tables).map(([name, rows], i) => ({
    name: `${i + 1} ${name}`.replace(/[\\/?*\[\]:]/g, " ").slice(0, 31),
    rows,
  }));
  for (const [i, path] of Object.keys(tables).entries())
    tables.Overview.push({ field: `Table ${path}`, value: sheets[i].name });
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
  let cells = 0;
  sheets.forEach((s, i) => {
    const keys = [...new Set(s.rows.flatMap((r) => Object.keys(r)))];
    cells += (s.rows.length + 1) * keys.length;
    if (keys.length > 16384 || cells > 2000000)
      throw new ApiError(
        "export_too_large",
        422,
        "Narrow the period or columns before exporting this workbook.",
      );
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
                if (String(v).length > 32767)
                  throw new ApiError(
                    "export_cell_too_large",
                    422,
                    "A workbook header exceeds the Excel cell limit.",
                  );
                return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
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
