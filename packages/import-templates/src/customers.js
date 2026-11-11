// SP-0169 store ("customer") upload template: the ONE source shared by the web app and the API.
// Mirrors the template sent to the client (_handoffs/sunpride/templates/customers-template-spec.json);
// test/customers.test.js proves byte-for-byte parity with the client's CSV and JSON spec.

/** @typedef {{column:string,required:boolean,help:string,example:string}} TemplateColumn */
/** @typedef {{rowNumber:number,values:Record<string,string>}} UploadRow */
/** @typedef {{rowNumber:number,column?:string,code:string,message:string,value?:string}} UploadError */

/** @type {readonly TemplateColumn[]} */
export const CUSTOMER_TEMPLATE_SPEC = Object.freeze([
  {
    column: "customer_code",
    required: true,
    help: "Unique code per store. Letters, numbers, - or _ only, up to 40. Your SAP or old system code is fine.",
    example: "GT-000123",
  },
  {
    column: "customer_name",
    required: true,
    help: "Store name as it should appear in the app and on receipts.",
    example: "Aling Nena Sari-sari Store",
  },
  {
    column: "status",
    required: false,
    help: "active, inactive or prospect. Blank = active.",
    example: "active",
  },
  {
    column: "channel",
    required: true,
    help: "Trade channel, e.g. General Trade, Modern Trade, HORECA, Institutional, Food Service.",
    example: "General Trade",
  },
  {
    column: "sub_channel",
    required: false,
    help: "Must belong to the channel, e.g. Sari-sari, Grocery, Supermarket, Restaurant.",
    example: "Sari-sari",
  },
  {
    column: "classification",
    required: false,
    help: "Store class, e.g. A, B, C.",
    example: "B",
  },
  {
    column: "area",
    required: true,
    help: "Territory or branch the store belongs to (name or code).",
    example: "Cebu City North",
  },
  {
    column: "street_address",
    required: true,
    help: "House/building no., street.",
    example: "123 P. del Rosario St.",
  },
  { column: "barangay", required: false, help: "", example: "Kamputhaw" },
  {
    column: "city_municipality",
    required: true,
    help: "",
    example: "Cebu City",
  },
  { column: "province", required: true, help: "", example: "Cebu" },
  {
    column: "owner_name",
    required: false,
    help: "Store owner or main contact.",
    example: "Elena Cruz",
  },
  {
    column: "owner_phone",
    required: false,
    help: "Mobile number, e.g. 09171234567.",
    example: "09171234567",
  },
  {
    column: "billing_account_code",
    required: false,
    help: "SAP sold-to / billing account. Blank = same as customer_code. Several stores can share one.",
    example: "SAP-100045",
  },
  {
    column: "sap_id",
    required: false,
    help: "SAP customer number, if different from customer_code.",
    example: "100045",
  },
  {
    column: "latitude",
    required: false,
    help: "Decimal degrees. Optional; the field team confirms the pin on first visit.",
    example: "10.3157",
  },
  {
    column: "longitude",
    required: false,
    help: "Decimal degrees.",
    example: "123.8854",
  },
  {
    column: "visit_frequency_days",
    required: false,
    help: "How often the store is visited: 7 = weekly, 14 = every 2 weeks, 28 = monthly.",
    example: "7",
  },
]);

/** @type {readonly string[]} */
export const CUSTOMER_HEADERS = Object.freeze(
  CUSTOMER_TEMPLATE_SPEC.map((c) => c.column),
);
export const CUSTOMER_TEMPLATE_FILE_NAME = "sunpride-customers-template.csv";
/** Rows per server chunk and parallel chunk workers. */
export const CUSTOMER_CHUNK_SIZE = 100;
export const CUSTOMER_MAX_ROWS = 5000;

/** @param {string} value */
function csvCell(value) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
/** Exactly the CSV sent to the client: header + one example row, CRLF line endings. */
export function customerTemplateCsv() {
  return (
    [
      CUSTOMER_HEADERS.join(","),
      CUSTOMER_TEMPLATE_SPEC.map((c) => csvCell(c.example)).join(","),
    ].join("\r\n") + "\r\n"
  );
}

/** Stable machine codes with their plain-English meaning (docs + UI legend). */
export const CUSTOMER_ERROR_CODES = Object.freeze({
  header_mismatch: "The columns do not match the template.",
  empty_file: "The file has no store rows.",
  too_many_rows: "The file has more rows than one upload allows.",
  required: "A required value is missing.",
  invalid_code: "The code has characters that are not allowed.",
  too_long: "The value is too long.",
  invalid_status: "Status must be active, inactive or prospect.",
  invalid_phone: "The phone is not a Philippine mobile number.",
  owner_name_required: "A phone needs the owner's name.",
  invalid_coordinates: "Latitude or longitude is not valid.",
  coordinates_incomplete: "Latitude and longitude must be given together.",
  invalid_visit_frequency: "Visit frequency must be a whole number of days.",
  duplicate_in_file: "The same store code appears more than once.",
  unknown_channel: "The channel is not in the channel list.",
  unknown_sub_channel: "The sub-channel is not in the list.",
  sub_channel_mismatch: "The sub-channel belongs to a different channel.",
  unknown_area: "The area is not an active territory or branch.",
  ambiguous_area: "More than one area has this name.",
  area_out_of_scope: "The area is outside your assigned areas.",
  store_out_of_scope: "The existing store belongs to an area outside yours.",
  store_inactive: "The existing store is inactive.",
  area_change_not_supported: "Uploads do not move a store to another area.",
  forbidden: "The uploader no longer has permission.",
  billing_account_inactive: "The billing account is inactive.",
  conflict: "Another change touched this store at the same time.",
  write_failed: "The store could not be saved.",
  not_processed: "The import stopped before this row was processed.",
});

const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const LIMITS = /** @type {Record<string, number>} */ ({
  customer_name: 200,
  classification: 40,
  street_address: 300,
  barangay: 100,
  city_municipality: 100,
  province: 100,
  owner_name: 100,
  sap_id: 120,
  channel: 100,
  sub_channel: 100,
  area: 160,
});
/** @param {UploadRow} row @param {string} key */
export const cellOf = (row, key) => (row.values[key] ?? "").trim();
/** Normalised (upper-case) store or account code. @param {string} value */
export const normaliseCode = (value) => value.trim().toUpperCase();
/** PH mobile: 09XXXXXXXXX or +63/63 9XXXXXXXXX, spaces and dashes allowed. Returns 09… form or null. @param {string} value */
export function phMobile(value) {
  const digits = value.replace(/[\s()-]/g, "").replace(/^\+/, "");
  if (/^09\d{9}$/.test(digits)) return digits;
  if (/^639\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
  return null;
}
/** @param {string} text */
function decimal(text) {
  return /^[+-]?\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
}
/** @param {string[]} header */
export function headerMatches(header) {
  return (
    Array.isArray(header) &&
    header.length === CUSTOMER_HEADERS.length &&
    header.every((h, i) => String(h).trim() === CUSTOMER_HEADERS[i])
  );
}
/** File-level error for a header that differs from the template. @param {string[]} header @returns {UploadError|null} */
export function headerError(header) {
  if (headerMatches(header)) return null;
  const got = (header ?? []).map((h) => String(h).trim());
  const missing = CUSTOMER_HEADERS.filter((c) => !got.includes(c));
  const extra = got.filter((c) => c && !CUSTOMER_HEADERS.includes(c));
  const parts = [];
  if (missing.length) parts.push(`missing ${missing.join(", ")}`);
  if (extra.length) parts.push(`unexpected ${extra.join(", ")}`);
  if (!parts.length) parts.push("the columns are in a different order");
  return {
    rowNumber: 1,
    code: "header_mismatch",
    message: `Use the template's columns in the same order (${parts.join("; ")}). Download the template and copy your rows into it.`,
    value: got.join(","),
  };
}

/**
 * Synchronous row rules (no database). Run in the browser on file pick AND again on the
 * server for preview and commit — the server is authoritative.
 * @param {UploadRow[]} rows
 * @returns {UploadError[]}
 */
export function validateCustomerRowsSync(rows) {
  /** @type {UploadError[]} */ const errors = [];
  /** @type {Map<string, number>} */ const seen = new Map();
  for (const row of rows) {
    /** @param {string} column @param {string} code @param {string} message */
    const fail = (column, code, message) =>
      errors.push({
        rowNumber: row.rowNumber,
        column,
        code,
        message,
        value: cellOf(row, column),
      });
    for (const spec of CUSTOMER_TEMPLATE_SPEC)
      if (spec.required && !cellOf(row, spec.column))
        fail(
          spec.column,
          "required",
          `${spec.column.replaceAll("_", " ")} is required.`,
        );
    for (const [column, max] of Object.entries(LIMITS))
      if (cellOf(row, column).length > max)
        fail(column, "too_long", `Keep this to ${max} characters or fewer.`);
    const code = cellOf(row, "customer_code");
    if (code && !CODE.test(code))
      fail(
        "customer_code",
        "invalid_code",
        "Use up to 40 letters, numbers, - or _, starting with a letter or number.",
      );
    if (code && CODE.test(code)) {
      const key = normaliseCode(code);
      const first = seen.get(key);
      if (first !== undefined)
        fail(
          "customer_code",
          "duplicate_in_file",
          `This store code is already used on row ${first}. Each store needs its own code.`,
        );
      else seen.set(key, row.rowNumber);
    }
    const billing = cellOf(row, "billing_account_code");
    if (billing && !CODE.test(billing))
      fail(
        "billing_account_code",
        "invalid_code",
        "Use up to 40 letters, numbers, - or _, starting with a letter or number.",
      );
    const status = cellOf(row, "status").toLowerCase();
    if (status && !["active", "inactive", "prospect"].includes(status))
      fail(
        "status",
        "invalid_status",
        "Use active, inactive or prospect, or leave it blank for active.",
      );
    const phone = cellOf(row, "owner_phone");
    if (phone && !phMobile(phone))
      fail(
        "owner_phone",
        "invalid_phone",
        "Enter an 11-digit mobile number starting with 09, e.g. 09171234567.",
      );
    if (phone && !cellOf(row, "owner_name"))
      fail(
        "owner_name",
        "owner_name_required",
        "Add the owner's name for this phone number.",
      );
    const latText = cellOf(row, "latitude"),
      lngText = cellOf(row, "longitude");
    if (Boolean(latText) !== Boolean(lngText))
      fail(
        latText ? "longitude" : "latitude",
        "coordinates_incomplete",
        "Fill in both latitude and longitude, or leave both blank.",
      );
    if (latText) {
      const lat = decimal(latText);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90)
        fail(
          "latitude",
          "invalid_coordinates",
          "Latitude must be a decimal number from -90 to 90, e.g. 10.3157.",
        );
    }
    if (lngText) {
      const lng = decimal(lngText);
      if (!Number.isFinite(lng) || lng < -180 || lng > 180)
        fail(
          "longitude",
          "invalid_coordinates",
          "Longitude must be a decimal number from -180 to 180, e.g. 123.8854.",
        );
    }
    const freq = cellOf(row, "visit_frequency_days");
    if (freq && (!/^\d+$/.test(freq) || Number(freq) < 1 || Number(freq) > 366))
      fail(
        "visit_frequency_days",
        "invalid_visit_frequency",
        "Use a whole number of days from 1 to 366, e.g. 7 for weekly.",
      );
  }
  return errors;
}

/** The single address line saved on the store. @param {UploadRow} row */
export function composeAddress(row) {
  const barangay = cellOf(row, "barangay");
  return [
    cellOf(row, "street_address"),
    barangay
      ? /^(brgy|barangay)\b/i.test(barangay)
        ? barangay
        : `Brgy. ${barangay}`
      : "",
    cellOf(row, "city_municipality"),
    cellOf(row, "province"),
  ]
    .filter(Boolean)
    .join(", ");
}
