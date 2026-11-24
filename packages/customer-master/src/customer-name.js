// SP-0240: enrollment captures the person's names separately. The combined name remains
// the display/search/accounting value; never guess parts from older names or import files.
/** @type {import('./fields.js').FieldSpec[]} */
export const CUSTOMER_NAME_FIELDS = [
  {
    key: "firstName",
    label: "First Name",
    section: "Customer General Information",
    required: true,
    kind: "text",
    max: 200,
  },
  {
    key: "middleName",
    label: "Middle Name",
    section: "Customer General Information",
    required: false,
    kind: "text",
    max: 200,
  },
  {
    key: "lastName",
    label: "Last Name",
    section: "Customer General Information",
    required: true,
    kind: "text",
    max: 200,
  },
];
/** @param {unknown} v */
const text = (v) => (typeof v === "string" ? v.trim() : "");
/** @param {Record<string, any>} input */
export const hasCustomerNameParts = (input) =>
  CUSTOMER_NAME_FIELDS.some((f) => text(input[f.key]) !== "");
/** @param {Record<string, any>} input */
export const formatCustomerName = (input) =>
  CUSTOMER_NAME_FIELDS.map((f) => text(input[f.key]))
    .filter(Boolean)
    .join(" ");
/** @param {Record<string, any>} input @param {boolean} [required] */
export function validateCustomerName(input, required = true) {
  /** @type {Record<string,string|null>} */ const value = {};
  /** @type {import('./validate.js').CustomerError[]} */ const errors = [];
  for (const f of CUSTOMER_NAME_FIELDS) {
    const raw = input[f.key];
    const s = text(raw);
    value[f.key] = s || null;
    const message =
      raw != null && typeof raw !== "string"
        ? `Enter ${f.label}.`
        : required && f.required && !s
          ? `${f.label} is required.`
          : s.length > 200
            ? `${f.label} must be 200 characters or fewer.`
            : "";
    if (message)
      errors.push({
        field: f.key,
        label: f.label,
        section: f.section,
        code: s.length > 200 ? "too_long" : "required",
        message,
      });
  }
  value.customerName = formatCustomerName(value) || null;
  if ((value.customerName?.length ?? 0) > 200)
    errors.push({
      field: "lastName",
      label: "Last Name",
      section: "Customer General Information",
      code: "too_long",
      message:
        "First Name, Middle Name and Last Name together must be 200 characters or fewer.",
    });
  return { value, errors };
}
