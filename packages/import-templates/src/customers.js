// SP-0170 customer upload template: the ONE source shared by the web app, the API and the
// client-ready template file. Layout = Sunpride's own "Customer Information template" (Loren
// Muñoz, MIS/IT, 2026-11-10): one row per customer, Customer Code (our key) + the client's 51
// fields in their order with their exact labels; the first ship-to sits inline in the row and
// the ADP Specific block is at the end, like their sheet. Rules come from
// @sunpride/customer-master (`complete` level), so the browser check, the server preview and the
// per-chunk re-check run the very same code. (Replaces the SP-0169 store template.)
import {
  ADP_CHANNEL,
  FIELDS,
  applicability,
  optionLabel,
  referenceIndex,
  validateCustomer,
} from "@sunpride/customer-master";

/** @typedef {import("@sunpride/customer-master").ReferenceRow} ReferenceRow */
/** @typedef {ReturnType<typeof referenceIndex>} ReferenceIndex */
/** @typedef {{id:string,key:string,label:string,section:string,required:boolean,when:null|'group1'|'group2'|'adp',kind:string,list?:string,shipTo:boolean,remark:string,hint:string}} TemplateColumn */
/** @typedef {{rowNumber:number,values:Record<string,string>}} UploadRow */
/** @typedef {{rowNumber:number,column?:string,label?:string,code:string,message:string,value?:string}} UploadError */
/** @typedef {{code:string,name:string}} GeoRegion */
/** @typedef {{code:string,name:string,regionCode:string}} GeoProvince */
/** @typedef {{code:string,name:string,provinceCode:string,regionCode:string}} GeoMunicipality */
/** @typedef {{code:string,name:string,municipalityCode:string}} GeoBarangay */
/** @typedef {{regions:GeoRegion[],provinces:GeoProvince[],municipalities:GeoMunicipality[],barangays:GeoBarangay[],postalCodes:Map<string,string[]>}} GeoData */

/** The client's Remarks column (workbook tab "source"), field by field in sheet order.
 * test/customers.test.js proves these equal the client's workbook extract. */
export const CLIENT_REMARKS = Object.freeze([
  "manual input",
  "manual input",
  "manual input",
  "manual input",
  "manual input",
  "manual input",
  "manual input",
  "manual input",
  "dropdown (refer to Tax Class tab)",
  "dropdown",
  "dropdown",
  "dropdown",
  "dropdown",
  "dropdown",
  "manual input",
  "manual input",
  "manual input",
  "manual input",
  "manual input",
  "dropdown",
  "System-suggested",
  "dropdown (Refer to Sales Organization tab) Pre-requisite Dist. Channel",
  "dropdown (Refer to Sales Office tab)",
  "dropdown (Refer to Distribution Channel) Pre-requisite Grp1",
  "dropdown (Refer to Cust. Grp 1 & 2 tab) Pre-requisite Grp2",
  "dropdown (Refer to Cust. Grp 1 & 2 tab)",
  "dropdown (Refer to Customer Group)",
  "dropdown (Refer to Type of Business tab)",
  "dropdown (List of Agents)",
  "dropdown (Refer to Payment Terms tab)",
  "manual input",
  "dropdown (Refer to Pricing Procedure)",
  "dropdown (Refer to Delivering Plant)",
  "manual input",
  "manual input",
  "manual input",
  "manual input",
  "manual input",
  "ERP-based, customer code)",
  "ERP-based, customer name)",
  "Distributor-specific)",
  "Dropdown, Universal)",
  "Distributor-specific)",
  "Distributor-specific)",
  "Drop-Down, Distributor-specific)",
  "Drop-Down, Distributor-specific)",
  "Drop-Down, Distributor-specific)",
  "Drop-Down, Distributor-specific)",
  "Warehouse of Distributor serving the account)",
  "Drop-Down, Universal but distributors have their own clustering independent of SFI in-house) This is what we term as route in distribution, We just use cluster to generalize.",
  "Drop-Down, Universal but distributors have their own clustering independent of SFI in-house) This is what we term as route in distribution, We just use cluster to generalize.",
]);

/** How to fill a cell, by kind (shown in header comments and the Instructions sheet). */
const HINTS = /** @type {Record<string,string>} */ ({
  list: 'Pick from the dropdown. "Description (Code)", the code alone or the description alone are all accepted.',
  geo: "PSGC name (e.g. Cebu, City of Cebu, Apas) or the 10-digit PSGC code. Capitals and accents do not matter.",
  coordinates:
    "Latitude, longitude in decimal degrees, e.g. 10.3312, 123.9056. Saved as a pending pin; the field team verifies it.",
  mobile: "Philippine mobile: 09XXXXXXXXX or +639XXXXXXXXX.",
  tin: "###-###-### or ###-###-###-### (digits only also accepted).",
  email: "e.g. owner@example.ph",
  money: "Amount in pesos, e.g. 15000.",
});
const POSTAL_HINT =
  "4-digit ZIP code of the Municipality (PHLPost), e.g. 6000.";

/** Column ids: the customer-master key; ship-to fields are prefixed so the two "Mobile No." and
 * "Email Address" columns stay distinct. @param {string} key */
export const shipToId = (key) => `shipTo.${key}`;

/** @type {readonly TemplateColumn[]} */
export const CUSTOMER_COLUMNS = Object.freeze([
  {
    id: "code",
    key: "code",
    label: "Customer Code",
    section: "System",
    required: true,
    when: null,
    kind: "code",
    shipTo: false,
    remark:
      "Our key (SAP customer number when known). An existing code updates that customer; a new code adds one.",
    hint: "Letters, numbers, - or _ (up to 40). Unique per customer.",
  },
  ...FIELDS.map((f, i) => {
    /** @type {TemplateColumn['when']} */
    const when = f.adp
      ? "adp"
      : f.key === "customerGroup1Code"
        ? "group1"
        : f.key === "customerGroup2Code"
          ? "group2"
          : null;
    return {
      id: f.shipTo ? shipToId(f.key) : f.key,
      key: f.key,
      label: f.label,
      section: f.section,
      required: f.required,
      when,
      kind: f.kind,
      ...(f.list ? { list: f.list } : {}),
      shipTo: !!f.shipTo,
      remark: /** @type {string} */ (CLIENT_REMARKS[i]),
      hint:
        f.key === "postalCode"
          ? POSTAL_HINT
          : f.key === "countryCode"
            ? "Philippines (PH)."
            : (HINTS[f.kind] ?? ""),
    };
  }),
]);

/** The template header: the client's labels in the client's order. */
export const CUSTOMER_HEADERS = Object.freeze(
  CUSTOMER_COLUMNS.map((c) => c.label),
);
/** @param {string} id */
export const columnById = (id) => CUSTOMER_COLUMNS.find((c) => c.id === id);
export const CUSTOMER_TEMPLATE_BASENAME = "sunpride-customer-upload-template";
export const CUSTOMER_TEMPLATE_FILE_NAME = `${CUSTOMER_TEMPLATE_BASENAME}.xlsx`;
export const CUSTOMER_TEMPLATE_CSV_NAME = `${CUSTOMER_TEMPLATE_BASENAME}.csv`;
/** Rows per server chunk and the most rows one file may carry. */
export const CUSTOMER_CHUNK_SIZE = 100;
export const CUSTOMER_MAX_ROWS = 5000;
export const CUSTOMERS_SHEET = "Customers";

/** When a conditionally required column is required (plain words for comments/instructions).
 * @param {TemplateColumn} c */
export function requiredText(c) {
  if (!c.required) return "Optional.";
  if (c.when === "adp")
    return `Required when Distribution Channel is ${ADP_CHANNEL} (Distributive Trade); leave blank otherwise.`;
  if (c.when === "group1")
    return "Required when the Distribution Channel has Customer Grp 1 values (not 50 Services).";
  if (c.when === "group2")
    return "Required when the chosen Customer Grp 1 has Customer Grp 2 values (not Food Service, Services, Corporate).";
  return "Required.";
}

/** @param {string} value */
function csvCell(value) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
/** CSV template: UTF-8 BOM (so Excel keeps ñ) + the header line, CRLF. */
export function customerTemplateCsv() {
  return `\uFEFF${CUSTOMER_HEADERS.map(csvCell).join(",")}\r\n`;
}

/** Stable machine codes with their plain-English meaning (docs + UI legend). Row-level codes
 * of @sunpride/customer-master (required, invalid_option, not_for_sales_org…) come on top. */
export const CUSTOMER_ERROR_CODES = Object.freeze({
  header_mismatch: "The columns do not match the template.",
  empty_file: "The file has no customer rows.",
  too_many_rows: "The file has more rows than one upload allows.",
  unreadable_file: "The file could not be read.",
  invalid_code: "The Customer Code has characters that are not allowed.",
  duplicate_in_file: "The same Customer Code appears more than once.",
  ambiguous_option: "The description matches more than one option.",
  customer_out_of_scope:
    "The existing customer belongs to an area outside yours.",
  customer_inactive: "The existing customer is inactive.",
  forbidden: "The uploader no longer has permission.",
  conflict: "Another change touched this customer at the same time.",
  write_failed: "The customer could not be saved.",
  not_processed: "The import stopped before this row was processed.",
});

// ---------------------------------------------------------------------------------------------
// Header

/** Compare labels: case, extra spaces and a trailing required-star do not matter. @param {any} s */
const headerKey = (s) =>
  String(s ?? "")
    .replace(/\uFEFF/g, "")
    .replace(/\s*\*\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Map a file's header to column ids. Repeated client labels ("Mobile No.", "Email Address")
 * map by occurrence: the first is the customer's, the second the ship-to's. Column order may
 * differ from the template; names must match.
 * @param {string[]} header
 * @returns {{ids:(string|null)[], missing:string[], unknown:string[]}}
 */
export function mapHeader(header) {
  /** @type {Map<string, number>} */ const seen = new Map();
  /** @type {Set<string>} */ const used = new Set();
  /** @type {string[]} */ const unknown = [];
  const ids = (header ?? []).map((h) => {
    const k = headerKey(h);
    if (!k) return null;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    const col = CUSTOMER_COLUMNS.filter((c) => headerKey(c.label) === k)[n];
    if (!col) {
      unknown.push(String(h).trim());
      return null;
    }
    used.add(col.id);
    return col.id;
  });
  const missing = CUSTOMER_COLUMNS.filter((c) => !used.has(c.id)).map((c) =>
    c.shipTo && CUSTOMER_COLUMNS.some((o) => !o.shipTo && o.label === c.label)
      ? `${c.label} (Delivery Arrangement)`
      : c.label,
  );
  return { ids, missing, unknown };
}

/** File-level error for a header that does not match the template, or null.
 * @param {string[]} header @returns {UploadError|null} */
export function headerError(header) {
  const { missing, unknown } = mapHeader(header);
  if (!missing.length && !unknown.length) return null;
  const parts = [];
  if (missing.length) parts.push(`missing columns: ${missing.join(", ")}`);
  if (unknown.length) parts.push(`unknown columns: ${unknown.join(", ")}`);
  return {
    rowNumber: 1,
    code: "header_mismatch",
    message: `The columns do not match the customer template (${parts.join("; ")}). Download the template and copy your rows into it.`,
    value: (header ?? []).map((h) => String(h).trim()).join(", "),
  };
}

// ---------------------------------------------------------------------------------------------
// Files

/** RFC 4180 subset: quoted fields, escaped quotes, CRLF/LF. @param {string} text */
export function splitCsv(text) {
  /** @type {string[][]} */ const rows = [];
  /** @type {string[]} */ let cells = [];
  let field = "",
    quoted = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      cells.push(field);
      rows.push(cells);
      cells = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || cells.length) {
    cells.push(field);
    rows.push(cells);
  }
  return rows;
}

/**
 * Turn a grid (first non-blank row = header; each entry carries its spreadsheet row number)
 * into upload rows keyed by column id. Blank rows are skipped.
 * @param {{rowNumber:number,cells:string[]}[]} grid
 * @returns {{header:string[], rows:UploadRow[], fileErrors:UploadError[]}}
 */
export function rowsFromGrid(grid) {
  const first = grid.find((r) => r.cells.some((c) => String(c ?? "").trim()));
  if (!first)
    return {
      header: [],
      rows: [],
      fileErrors: [
        { rowNumber: 1, code: "empty_file", message: "The file is empty." },
      ],
    };
  const header = first.cells.map((c) => String(c ?? "").trim());
  while (header.length && !header[header.length - 1]) header.pop();
  /** @type {UploadError[]} */ const fileErrors = [];
  const bad = headerError(header);
  if (bad) fileErrors.push(bad);
  const { ids } = mapHeader(header);
  /** @type {UploadRow[]} */ const rows = [];
  for (const line of grid) {
    if (line.rowNumber <= first.rowNumber) continue;
    if (!line.cells.some((c) => String(c ?? "").trim())) continue;
    /** @type {Record<string,string>} */ const values = {};
    ids.forEach((id, i) => {
      if (id) values[id] = String(line.cells[i] ?? "").trim();
    });
    rows.push({ rowNumber: line.rowNumber, values });
  }
  if (!bad && !rows.length)
    fileErrors.push({
      rowNumber: 1,
      code: "empty_file",
      message: "The file has no customer rows under the header.",
    });
  if (rows.length > CUSTOMER_MAX_ROWS)
    fileErrors.push({
      rowNumber: 1,
      code: "too_many_rows",
      message: `The file has ${rows.length} rows. Upload at most ${CUSTOMER_MAX_ROWS} customers per file; split it and upload each part.`,
    });
  return { header, rows, fileErrors };
}

/** @param {string} text */
export function parseCustomerCsv(text) {
  return rowsFromGrid(
    splitCsv(text).map((cells, i) => ({ rowNumber: i + 1, cells })),
  );
}

/**
 * Read an uploaded .xlsx or .csv. The .xlsx reader (exceljs) is loaded only when needed.
 * @param {string} fileName @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<{header:string[], rows:UploadRow[], fileErrors:UploadError[]}>}
 */
export async function parseCustomerFile(fileName, bytes) {
  if (/\.csv$/i.test(fileName))
    return parseCustomerCsv(new TextDecoder("utf-8").decode(bytes));
  if (/\.xlsx$/i.test(fileName)) {
    try {
      const { readCustomerXlsx } = await import("./customers-xlsx.js");
      return rowsFromGrid(await readCustomerXlsx(bytes));
    } catch {
      return {
        header: [],
        rows: [],
        fileErrors: [
          {
            rowNumber: 1,
            code: "unreadable_file",
            message:
              "This Excel file could not be read. Save it as .xlsx (Excel Workbook) or .csv and try again.",
          },
        ],
      };
    }
  }
  return {
    header: [],
    rows: [],
    fileErrors: [
      {
        rowNumber: 1,
        code: "unreadable_file",
        message: "Choose an Excel (.xlsx) or CSV (.csv) file.",
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Values

/** Case/accent/space-insensitive comparison key. @param {any} s */
export const norm = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;
/** Normalised (upper-case) Customer Code. @param {string} value */
export const normaliseCode = (value) =>
  String(value ?? "")
    .trim()
    .toUpperCase();
/** @param {UploadRow} row @param {string} id */
export const cellOf = (row, id) => String(row.values[id] ?? "").trim();

/**
 * Resolve a dropdown cell: "Description (Code)", the code alone or the description alone
 * (case/accents ignored; numbers that lost leading zeros in Excel still match). Candidates are
 * the options under the chosen parent first, then the whole list (so a value from the wrong
 * parent is reported as such by the rules, not as unknown). Unknown text is returned as-is for
 * the rules to report as "not in the list".
 * @param {string} text @param {{code:string,name:string}[]} candidates @param {{code:string,name:string}[]} all
 * @returns {{code:string|null, ambiguous?:boolean}}
 */
export function resolveOption(text, candidates, all) {
  const t = String(text ?? "").trim();
  if (!t) return { code: null };
  const m = /^(.*\S)\s*\(([^()]+)\)\s*$/.exec(t);
  const nt = norm(t);
  const digits = (/** @type {string} */ s) =>
    /^\d+$/.test(s) ? String(Number(s)) : null;
  /** @type {((o:{code:string,name:string})=>boolean)[]} */
  const tests = [
    ...(m
      ? [(/** @type {{code:string}} */ o) => norm(o.code) === norm(m[2])]
      : []),
    (o) => norm(o.code) === nt,
    (o) => norm(o.name) === nt,
    ...(m
      ? [(/** @type {{name:string}} */ o) => norm(o.name) === norm(m[1])]
      : []),
    (o) =>
      digits(String(o.code)) !== null &&
      digits(String(o.code)) === digits(t.replace(/\.0+$/, "")),
  ];
  for (const pool of [candidates, all])
    for (const test of tests) {
      const codes = [...new Set(pool.filter(test).map((o) => o.code))];
      if (codes.length === 1) return { code: /** @type {string} */ (codes[0]) };
      if (codes.length > 1) return { code: null, ambiguous: true };
    }
  return { code: t };
}

/** Comparison keys for a PSGC name: full, without "(…)", the "(…)" part, "City of X" ⇄ "X City".
 * @param {string} name */
function geoKeys(name) {
  const n = norm(name);
  const out = new Set([n]);
  const paren = /^(.*?)\s*\((.*)\)\s*$/.exec(n);
  if (paren) {
    out.add(/** @type {string} */ (paren[1]));
    out.add(/** @type {string} */ (paren[2]));
  }
  for (const k of [...out]) {
    const city = /^city of (.+)$/.exec(k);
    if (city) out.add(`${city[1]} city`);
  }
  return out;
}
/** @template {{code:string,name:string}} T @param {string} text @param {T[]} pool @returns {{record:T|null, ambiguous?:boolean}} */
function pickGeo(text, pool) {
  const t = String(text ?? "").trim();
  if (!t) return { record: null };
  const code = /^\d{9}$/.test(t) ? `0${t}` : t;
  const byCode = pool.find((r) => r.code === code);
  if (byCode) return { record: byCode };
  const key = norm(t);
  const hits = pool.filter((r) => geoKeys(r.name).has(key));
  if (hits.length === 1) return { record: /** @type {T} */ (hits[0]) };
  if (hits.length > 1) return { record: null, ambiguous: true };
  return { record: null };
}

/** PSGC lookup over loaded rows (the server loads the rows a file needs). @param {GeoData} data */
export function geoLookup(data) {
  /** @type {Map<string, GeoBarangay[]>} */ const barangaysOf = new Map();
  for (const b of data.barangays) {
    const list = barangaysOf.get(b.municipalityCode) ?? [];
    list.push(b);
    barangaysOf.set(b.municipalityCode, list);
  }
  return {
    data,
    /** @param {Record<string,string>} v raw Region/Province/Municipality/Barangay cells */
    resolve(v) {
      /** @type {string[]} */ const ambiguous = [];
      /** @template {{code:string,name:string}} T @param {string} id @param {T[]} scoped @param {T[]} all @returns {T|null} */
      const pick = (id, scoped, all) => {
        const first = pickGeo(v[id] ?? "", scoped);
        if (first.ambiguous) ambiguous.push(id);
        if (first.record || first.ambiguous || scoped === all)
          return first.record;
        const wide = pickGeo(v[id] ?? "", all);
        if (wide.ambiguous) ambiguous.push(id);
        return wide.record;
      };
      const region = pick("regionCode", data.regions, data.regions);
      const province = pick(
        "provinceCode",
        region
          ? data.provinces.filter((p) => p.regionCode === region.code)
          : data.provinces,
        data.provinces,
      );
      const municipality = pick(
        "municipalityCode",
        province
          ? data.municipalities.filter((m) => m.provinceCode === province.code)
          : data.municipalities,
        data.municipalities,
      );
      const barangay = pick(
        "barangayCode",
        municipality
          ? (barangaysOf.get(municipality.code) ?? [])
          : data.barangays,
        data.barangays,
      );
      return {
        region,
        province,
        municipality,
        barangay,
        postalCodes: municipality
          ? (data.postalCodes.get(municipality.code) ?? [])
          : [],
        ambiguous,
      };
    },
  };
}
/** @typedef {ReturnType<typeof geoLookup>} GeoLookup */

/** "lat, lng" → numbers; anything else is passed through for the rules to reject. @param {string} text */
export function parseCoordinates(text) {
  const t = String(text ?? "").trim();
  if (!t) return { latitude: null, longitude: null };
  const m =
    /^\(?\s*([+-]?\d+(?:\.\d+)?)\s*(?:,|;|\s)\s*([+-]?\d+(?:\.\d+)?)\s*\)?$/.exec(
      t,
    );
  if (!m) return { latitude: t, longitude: t };
  return { latitude: Number(m[1]), longitude: Number(m[2]) };
}

/** Phone numbers that lost their leading 0 in Excel (9171234567) are read as 09171234567. @param {string} t */
const phone = (t) => (/^9\d{9}$/.test(t) ? `0${t}` : t);

/**
 * Cells → the customer record the writer takes (codes resolved). Blank cells are null.
 * @param {UploadRow} row @param {ReferenceIndex} index @param {GeoLookup|null} [geo]
 */
export function rowToCustomer(row, index, geo = null) {
  /** @type {UploadError[]} */ const errors = [];
  /** @type {Record<string, any>} */ const customer = {};
  /** @type {Record<string, any>} */ const shipTo = { sameAsCustomer: false };
  const get = (/** @type {string} */ id) => cellOf(row, id);
  for (const c of CUSTOMER_COLUMNS) {
    if (c.id === "code" || c.kind === "list" || c.kind === "coordinates")
      continue;
    let v = get(c.id) || null;
    if (v && c.kind === "mobile") v = phone(v);
    if (c.shipTo) shipTo[c.key] = v;
    else customer[c.key] = v;
  }
  /** @param {string} key @param {{code:string,name:string}[]} candidates */
  const list = (key, candidates) => {
    const col = /** @type {TemplateColumn} */ (columnById(key));
    const r = resolveOption(
      get(key),
      candidates,
      index.all(/** @type {string} */ (col.list)),
    );
    if (r.ambiguous)
      errors.push({
        rowNumber: row.rowNumber,
        column: key,
        label: col.label,
        code: "ambiguous_option",
        message: `${col.label} "${get(key)}" matches more than one option. Use "Description (Code)" or the code.`,
        value: get(key),
      });
    customer[key] = r.code;
    return r.code;
  };
  for (const key of [
    "taxClassificationCode",
    "countryCode",
    "customerGroupCode",
    "typeOfBusiness",
    "salesPartnerCode",
    "paymentTermsCode",
    "pricingProcedureCode",
  ])
    list(key, index.all(/** @type {string} */ (columnById(key)?.list)));
  const salesOrgCode = list("salesOrgCode", index.all("sales_organization"));
  const parent = salesOrgCode ? { salesOrgCode } : {};
  list("salesOfficeCode", index.options("sales_office", parent));
  list("deliveringPlantCode", index.options("delivering_plant", parent));
  const channelCode = list(
    "distributionChannelCode",
    index.options("distribution_channel", parent),
  );
  const group1Code = list(
    "customerGroup1Code",
    index.options("customer_group_1", { ...parent, channelCode }),
  );
  list(
    "customerGroup2Code",
    index.options("customer_group_2", { ...parent, channelCode, group1Code }),
  );
  const coords = parseCoordinates(get("coordinates"));
  customer.latitude = coords.latitude;
  customer.longitude = coords.longitude;
  /** @type {any} */ let geography = null;
  if (geo) {
    const g = geo.resolve(row.values);
    for (const id of g.ambiguous) {
      const col = /** @type {TemplateColumn} */ (columnById(id));
      errors.push({
        rowNumber: row.rowNumber,
        column: id,
        label: col.label,
        code: "ambiguous_option",
        message: `${col.label} "${get(id)}" matches more than one place. Use its 10-digit PSGC code.`,
        value: get(id),
      });
    }
    // Resolved PSGC codes replace names; unresolved text stays for the rules to report.
    if (g.region) customer.regionCode = g.region.code;
    if (g.province) customer.provinceCode = g.province.code;
    if (g.municipality) customer.municipalityCode = g.municipality.code;
    if (g.barangay) customer.barangayCode = g.barangay.code;
    geography = g;
  }
  customer.shipTos = [shipTo];
  return {
    code: normaliseCode(get("code")),
    customer,
    geography,
    errors,
  };
}
/** @typedef {ReturnType<typeof rowToCustomer>} RowItem */

/** Rule error field ("shipTos[0].mobileNo", "coordinates", "regionCode") → column id. @param {string} field */
export function columnOfField(field) {
  const m = /^shipTos\[\d+\]\.(.+)$/.exec(field);
  return m ? shipToId(/** @type {string} */ (m[1])) : field;
}

/**
 * Validate rows at the `complete` level with the shared customer-master rules. Without `geo`
 * (the browser) the PSGC membership checks are left to the server.
 * @param {UploadRow[]} rows @param {ReferenceRow[]|ReferenceIndex} lists @param {GeoLookup|null} [geo]
 * @returns {{errors:UploadError[], items:Map<number, RowItem>}}
 */
export function validateCustomerRows(rows, lists, geo = null) {
  const index = Array.isArray(lists) ? referenceIndex(lists) : lists;
  /** @type {UploadError[]} */ const errors = [];
  /** @type {Map<number, RowItem>} */ const items = new Map();
  /** @type {Map<string, number>} */ const seen = new Map();
  for (const row of rows) {
    const item = rowToCustomer(row, index, geo);
    /** @type {UploadError[]} */ const mine = [...item.errors];
    /** @param {string} column @param {string} code @param {string} message */
    const fail = (column, code, message) =>
      mine.push({
        rowNumber: row.rowNumber,
        column,
        label: columnById(column)?.label ?? column,
        code,
        message,
        value: cellOf(row, column),
      });
    if (!item.code) fail("code", "required", "Customer Code is required.");
    else if (!CODE_RE.test(item.code))
      fail(
        "code",
        "invalid_code",
        "Customer Code: use up to 40 letters, numbers, - or _, starting with a letter or number.",
      );
    else {
      const first = seen.get(item.code);
      if (first !== undefined)
        fail(
          "code",
          "duplicate_in_file",
          `Customer Code ${item.code} is already on row ${first}. Each customer needs its own code.`,
        );
      else seen.set(item.code, row.rowNumber);
    }
    const taken = new Set(mine.map((e) => e.column));
    const result = validateCustomer(item.customer, {
      level: "complete",
      lists: index,
      geography: item.geography,
    });
    for (const e of result.errors) {
      const column = columnOfField(e.field);
      if (taken.has(column)) continue;
      mine.push({
        rowNumber: row.rowNumber,
        column,
        label: e.label,
        code: e.code,
        message: e.message,
        value: cellOf(row, column),
      });
    }
    errors.push(...mine);
    items.set(row.rowNumber, item);
  }
  return { errors: sortErrors(errors), items };
}

/** Row order, then template column order. @param {UploadError[]} errors */
export function sortErrors(errors) {
  const order = (/** @type {string|undefined} */ c) => {
    const i = c ? CUSTOMER_COLUMNS.findIndex((x) => x.id === c) : -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...errors].sort(
    (a, b) => a.rowNumber - b.rowNumber || order(a.column) - order(b.column),
  );
}

/**
 * The writer payload for one row. New customers send every value. Updates send only the
 * filled cells, so blank optional cells keep the customer's current values; Customer Grp 1/2
 * are cleared when the chosen chain has none (they would otherwise no longer apply). The first
 * ship-to is replaced by the row's (blank cells keep its current values); further ship-tos stay.
 * @param {RowItem} item @param {UploadRow} row @param {ReferenceIndex} index
 * @param {{shipTos?:any[]}|null} existing
 */
export function writerInput(item, row, index, existing) {
  const c = item.customer;
  if (!existing) return { ...c };
  /** @type {Record<string, any>} */ const out = {};
  for (const col of CUSTOMER_COLUMNS) {
    if (col.id === "code" || col.shipTo) continue;
    if (col.kind === "coordinates") {
      if (cellOf(row, col.id)) {
        out.latitude = c.latitude;
        out.longitude = c.longitude;
      }
      continue;
    }
    if (cellOf(row, col.id)) out[col.key] = c[col.key];
  }
  const app = applicability(index, c);
  if (app.group1 === false) out.customerGroup1Code = null;
  if (app.group1 === false || app.group2 === false)
    out.customerGroup2Code = null;
  const [first, ...rest] = existing.shipTos ?? [];
  /** @type {Record<string, any>} */ const ship = {
    ...(first
      ? {
          shipToParty: first.shipToParty,
          shipToAddress: first.shipToAddress,
          contactPerson: first.contactPerson,
          mobileNo: first.mobileNo,
          email: first.email,
        }
      : {}),
    sameAsCustomer: false,
  };
  for (const col of CUSTOMER_COLUMNS)
    if (col.shipTo && cellOf(row, col.id))
      ship[col.key] = c.shipTos[0][col.key];
  out.shipTos = [
    ship,
    ...rest.map((s) => ({
      shipToParty: s.shipToParty,
      shipToAddress: s.shipToAddress,
      contactPerson: s.contactPerson,
      mobileNo: s.mobileNo,
      email: s.email,
      sameAsCustomer: s.sameAsCustomer === true,
    })),
  ];
  return out;
}

// ---------------------------------------------------------------------------------------------
// Template list sheets (generated from the DB reference rows, in the client's tab order)

/** @typedef {{name:string,title:string,columns:string[],rows:string[][]}} ListSheet */

/** Sheet each list column's dropdown points at (the client's tab names). */
export const LIST_SHEET_OF = Object.freeze(
  /** @type {Record<string,string>} */ ({
    customer_group_1: "Cust. Grp. 1&2",
    customer_group_2: "Cust. Grp. 1&2",
    sales_organization: "Sales Organization",
    customer_group: "Customer Groups",
    distribution_channel: "Distribution Channel",
    type_of_business: "Type of Business",
    sales_office: "Sales Office",
    sales_partner: "List of Agents",
    delivering_plant: "Delivering Plant",
    payment_terms: "Payment Terms",
    tax_classification: "Tax Class",
    pricing_procedure: "Pricing Procedure",
  }),
);
/** First data row on a list sheet (row 1 = title, row 2 = headings, like the client's tabs). */
export const LIST_FIRST_ROW = 3;

/**
 * One sheet per client list, with the client's tab names and column headings, plus a
 * "Dropdown value" column ("Description (Code)") the Customers sheet's dropdowns point at.
 * @param {ReferenceRow[]} reference active rows of customer_reference_values
 * @returns {ListSheet[]}
 */
export function listSheets(reference) {
  const of = (/** @type {string} */ list) =>
    reference.filter((r) => r.list === list && r.active !== false);
  const orgName = new Map(
    of("sales_organization").map((r) => [r.code, r.name]),
  );
  const g1 = of("customer_group_1");
  const g2 = of("customer_group_2");
  const channels = of("distribution_channel");
  /** @type {string[][]} */ const chain = [];
  for (const a of g1) {
    const org = {
      code: a.salesOrgCode ?? "",
      name: orgName.get(a.salesOrgCode ?? "") ?? "",
    };
    const ch = channels.find(
      (c) => c.salesOrgCode === a.salesOrgCode && c.code === a.channelCode,
    ) ?? { code: a.channelCode ?? "", name: a.channelCode ?? "" };
    const kids = g2.filter(
      (b) =>
        b.salesOrgCode === a.salesOrgCode &&
        b.channelCode === a.channelCode &&
        b.group1Code === a.code,
    );
    for (const b of kids.length ? kids : [null])
      chain.push([
        optionLabel(org),
        optionLabel(ch),
        optionLabel(a),
        b ? optionLabel(b) : "",
      ]);
  }
  const uniq = (/** @type {string[]} */ xs) => [...new Set(xs)];
  const g1Pick = uniq(g1.map(optionLabel));
  const g2Pick = uniq(g2.map(optionLabel));
  const chainRows = Array.from(
    { length: Math.max(chain.length, g1Pick.length, g2Pick.length) },
    (_, i) => [
      ...(chain[i] ?? ["", "", "", ""]),
      "",
      g1Pick[i] ?? "",
      g2Pick[i] ?? "",
    ],
  );
  const withOrg = (/** @type {string} */ list) =>
    of(list).map((r) => [
      orgName.get(r.salesOrgCode ?? "") ?? "",
      r.salesOrgCode ?? "",
      r.code,
      r.name,
      optionLabel(r),
    ]);
  const plain = (/** @type {string} */ list) =>
    of(list).map((r) => [r.code, r.name, optionLabel(r)]);
  return [
    {
      name: "Cust. Grp. 1&2",
      title: "Cust. Grp. 1&2",
      columns: [
        "Company",
        "Distribution Channels",
        "Customer Grp 1",
        "Customer Grp 2",
        "",
        "Customer Grp 1 (dropdown value)",
        "Customer Grp 2 (dropdown value)",
      ],
      rows: chainRows,
    },
    {
      name: "Sales Organization",
      title: "Sales Organization",
      columns: ["Sales Org Code", "Sales Org", "Dropdown value"],
      rows: plain("sales_organization"),
    },
    {
      name: "Customer Groups",
      title: "Customer Groups",
      columns: ["Customer group", "Name", "Dropdown value"],
      rows: plain("customer_group"),
    },
    {
      name: "Distribution Channel",
      title: "Distribution Channel",
      columns: [
        "Sales Org",
        "Sales Org Code",
        "Dist. Channel Code",
        "Dist. Channel Description",
        "Dropdown value",
      ],
      rows: withOrg("distribution_channel"),
    },
    {
      name: "Type of Business",
      title: "Type of Business",
      columns: ["Type of Business"],
      rows: of("type_of_business").map((r) => [r.name]),
    },
    {
      name: "Sales Office",
      title: "Sales Office",
      columns: [
        "Sales Org",
        "Sales Org Code",
        "Code",
        "Description",
        "Dropdown value",
      ],
      rows: withOrg("sales_office"),
    },
    {
      name: "List of Agents",
      title: "List of Agents",
      columns: ["Code", "Name", "Dropdown value"],
      rows: plain("sales_partner"),
    },
    {
      name: "Delivering Plant",
      title: "Delivering Plant",
      columns: [
        "Sales Org",
        "Sales Org Code",
        "Code",
        "Description",
        "Dropdown value",
      ],
      rows: withOrg("delivering_plant"),
    },
    {
      name: "Payment Terms",
      title: "Payment Terms",
      columns: ["Code", "Description", "Dropdown value"],
      rows: plain("payment_terms"),
    },
    {
      name: "Tax Class",
      title: "Customer Tax Classification",
      columns: ["Code", "Description", "Dropdown value"],
      rows: plain("tax_classification"),
    },
    {
      name: "Pricing Procedure",
      title: "Customer Pricing Procedure",
      columns: ["Code", "Description", "Dropdown value"],
      rows: plain("pricing_procedure"),
    },
  ];
}

/** Where each dropdown column's values live (1-based column on the list sheet, value count).
 * @param {ListSheet[]} sheets */
export function dropdownSources(sheets) {
  /** @type {Record<string, {sheet:string,column:number,count:number}>} */
  const out = {};
  for (const c of CUSTOMER_COLUMNS) {
    if (c.kind !== "list" || !c.list || c.list === "country") continue;
    const s = /** @type {ListSheet} */ (
      sheets.find(
        (x) => x.name === LIST_SHEET_OF[/** @type {string} */ (c.list)],
      )
    );
    const column =
      c.list === "customer_group_1"
        ? 6
        : c.list === "customer_group_2"
          ? 7
          : s.columns.length;
    out[c.id] = {
      sheet: s.name,
      column,
      count: s.rows.filter((r) => r[column - 1]).length,
    };
  }
  return out;
}

/** A valid example row (shown on the Instructions sheet, never inside the Customers sheet). */
export const EXAMPLE = Object.freeze(
  /** @type {Record<string,string>} */ ({
    code: "SP000123",
    registeredName: "Tindahan ni Aling Rosa Inc.",
    tradeName: "Aling Rosa",
    customerName: "Aling Rosa Store",
    customerAddress: "12 Gorordo Ave, Apas, City of Cebu, Cebu 6000",
    email: "rosa@example.ph",
    mobileNo: "09171234567",
    tin: "123-456-789",
    taxClassificationCode: "Liable for Taxes (1)",
    countryCode: "Philippines (PH)",
    regionCode: "Region VII (Central Visayas)",
    provinceCode: "Cebu",
    municipalityCode: "City of Cebu",
    barangayCode: "Apas",
    houseNo: "12",
    street1: "Gorordo Ave",
    postalCode: "6000",
    coordinates: "10.3312, 123.9056",
    salesOrgCode: "SFI (1000)",
    salesOfficeCode: "SFI Cebu (100)",
    distributionChannelCode: "General Trade (30)",
    customerGroup1Code: "Key Accounts 3 (KAS3)",
    customerGroup2Code: "GT-Grocery Stores (GGS)",
    customerGroupCode: "NO GROUP (74)",
    typeOfBusiness: "Sole Proprietor",
    paymentTermsCode: "Due in 7 days (0003)",
    creditLimit: "15000",
    pricingProcedureCode: "Standard Inclusive Tax (2)",
    deliveringPlantCode: "Cebu Production (1000)",
    "shipTo.shipToParty": "Aling Rosa Store",
    "shipTo.shipToAddress": "12 Gorordo Ave, Apas, City of Cebu, Cebu 6000",
    "shipTo.contactPerson": "Rosa Dela Cruz",
    "shipTo.mobileNo": "09171234567",
  }),
);

/** Instructions sheet text, one line per row. */
export function instructionLines() {
  return [
    "Sunpride customer upload template",
    "",
    'Fill in the "Customers" sheet: one row per customer (= one store). Do not rename or remove the column headings.',
    "The columns follow Sunpride's Customer Information template: Customer General Information, Customer Location, Customer Assignment, Payment Arrangement, Delivery Arrangement (the first ship-to), ADP Specific.",
    "Customer Code: an existing code updates that customer; a new code adds a customer. Blank optional cells on an existing customer keep its current values.",
    "Yellow headings are required. Hover over a heading to read the rule and Sunpride's remark.",
    "Customer Grp 1 is required when the Distribution Channel has Grp 1 values (not 50 Services); Customer Grp 2 when the chosen Grp 1 has Grp 2 values.",
    `ADP Specific (the last 13 columns) is required only for Distribution Channel ${ADP_CHANNEL} (Distributive Trade).`,
    "Sales Office, Distribution Channel and Delivering Plant must belong to the Sales Organization; Customer Grp 1 to the Distribution Channel; Customer Grp 2 to Customer Grp 1. The dropdowns list every value; the upload checks the chain.",
    'Dropdown cells accept "Description (Code)" (e.g. "General Trade (30)"), the code alone ("30") or the description alone ("General Trade").',
    "Region, Province, Municipality and Barangay: the PSGC name (e.g. Cebu, City of Cebu, Apas) or the 10-digit PSGC code. Capitals and accents do not matter.",
    "Postal Code must be one of the Municipality's ZIP codes. Geographical Coordinates: latitude, longitude (e.g. 10.3312, 123.9056); saved as a pending pin for the field team to verify.",
    "Mobile No.: 09XXXXXXXXX or +639XXXXXXXXX. TIN number: ###-###-### or ###-###-###-###.",
    `Up to ${CUSTOMER_MAX_ROWS.toLocaleString("en-US")} customers per file. Save as .xlsx (or .csv with the same headings) and upload it from Customers → Upload customers.`,
    "",
    "Example row (a General Trade customer):",
    ...CUSTOMER_COLUMNS.map((c) => `${c.label}: ${EXAMPLE[c.id] ?? ""}`),
  ];
}
