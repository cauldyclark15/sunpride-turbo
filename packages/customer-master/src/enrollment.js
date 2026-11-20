// SP-0229: additive enrollment fields. Stable keys survive label/order changes.
/** @typedef {{key:string,label:string,kind:string,choices:string[],requiredChannels:string[],requiredTypes:string[]}} EnrollmentField */
export const ENROLLMENT_KINDS = [
  "text",
  "number",
  "date",
  "choice",
  "boolean",
  "photo",
];
export const ENROLLMENT_PHOTO_MAX = 100 * 1024;
/** @param {EnrollmentField} f @param {Record<string,any>} customer */
export function enrollmentRequired(f, customer) {
  return (
    f.requiredChannels.includes(customer.distributionChannelCode) ||
    f.requiredTypes.includes(customer.typeOfBusiness)
  );
}
/** @param {unknown} raw @returns {EnrollmentField[]} */
export function enrollmentFields(raw) {
  if (!Array.isArray(raw) || raw.length > 30)
    throw new Error("Use at most 30 extra fields.");
  if (raw.filter((f) => f?.kind === "photo").length > 4)
    throw new Error("Use at most four photo fields.");
  const seen = new Set();
  return raw.map((f) => {
    if (!f || !/^cf_[a-f0-9]{32}$/.test(f.key) || seen.has(f.key))
      throw new Error("Each field needs its own unchanged key.");
    seen.add(f.key);
    if (
      typeof f.label !== "string" ||
      !f.label.trim() ||
      f.label.trim().length > 100 ||
      !ENROLLMENT_KINDS.includes(f.kind)
    )
      throw new Error("Enter a field name and choose its type.");
    const list = (/** @type {any} */ v, /** @type {number} */ max) => {
      if (
        !Array.isArray(v) ||
        v.length > max ||
        v.some((x) => typeof x !== "string" || !x.trim() || x.length > 100) ||
        new Set(v.map((x) => x.trim())).size !== v.length
      )
        throw new Error("Use distinct, non-empty choices.");
      return v.map((x) => x.trim());
    };
    const choices = list(f.choices, 100);
    if (f.kind === "choice" ? !choices.length : choices.length)
      throw new Error("Choice lists need choices; other field types do not.");
    return {
      key: f.key,
      label: f.label.trim(),
      kind: f.kind,
      choices,
      requiredChannels: list(f.requiredChannels, 100),
      requiredTypes: list(f.requiredTypes, 100),
    };
  });
}
/** Validate canonical base64 and JPEG start/end markers before displaying or retaining a photo.
 * @param {string} s */
export function enrollmentPhotoValid(s) {
  if (
    !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(s) ||
    s.length > Math.ceil(ENROLLMENT_PHOTO_MAX / 3) * 4 + 23
  )
    return false;
  try {
    const encoded = s.slice(23),
      bytes = atob(encoded);
    return (
      btoa(bytes) === encoded &&
      bytes.length >= 4 &&
      bytes.length <= ENROLLMENT_PHOTO_MAX &&
      bytes.charCodeAt(bytes.length - 2) === 255 &&
      bytes.charCodeAt(bytes.length - 1) === 217
    );
  } catch {
    return false;
  }
}
/** Values use text on every wire, including explicit true/false (blank is not No).
 * Photos are bounded JPEG data URLs, never arbitrary remote links or executable content.
 * @param {EnrollmentField[]} fields @param {unknown} raw @param {Record<string,any>} customer
 */
export function validateEnrollment(fields, raw, customer) {
  /** @type {{field:string,label:string,section:string,code:string,message:string}[]} */ const errors =
    [];
  /** @type {Record<string,string>} */ const value = {};
  const input = raw == null ? {} : raw;
  if (typeof input !== "object" || Array.isArray(input))
    return {
      value,
      errors: [
        {
          field: "customFields",
          label: "Additional information",
          section: "Enrollment",
          code: "invalid",
          message: "Check the additional information.",
        },
      ],
    };
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(input))
    if (!known.has(key))
      errors.push({
        field: `customFields.${key}`,
        label: "Additional information",
        section: "Enrollment",
        code: "unknown",
        message: "The enrollment form changed. Download the form again.",
      });
  for (const f of fields) {
    const rawValue = /** @type {Record<string,any>} */ (input)[f.key];
    const s =
      typeof rawValue === "string"
        ? rawValue.trim()
        : rawValue == null
          ? ""
          : String(rawValue);
    const fail = (/** @type {string} */ message) =>
      errors.push({
        field: `customFields.${f.key}`,
        label: f.label,
        section: "Enrollment",
        code: "invalid",
        message: `${f.label}: ${message}`,
      });
    if (!s) {
      if (enrollmentRequired(f, customer))
        fail("is required for this customer.");
      continue;
    }
    if (!["string", "number", "boolean"].includes(typeof rawValue)) {
      fail("enter a value.");
      continue;
    }
    if (f.kind === "text" && s.length > 500)
      fail("use 500 characters or fewer.");
    if (
      f.kind === "number" &&
      (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s) ||
        !Number.isFinite(Number(s)) ||
        Math.abs(Number(s)) > 1e12)
    )
      fail("enter a number.");
    if (
      f.kind === "date" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(s) ||
        !Number.isFinite(Date.parse(s)) ||
        new Date(s).toISOString().slice(0, 10) !== s)
    )
      fail("enter a real date as YYYY-MM-DD.");
    if (f.kind === "choice" && !f.choices.includes(s))
      fail("choose from the list.");
    if (f.kind === "boolean" && !["true", "false"].includes(s))
      fail("choose Yes or No.");
    if (f.kind === "photo" && !enrollmentPhotoValid(s))
      fail("choose a JPEG photo no larger than 100 KB.");
    value[f.key] = s;
  }
  return { value, errors };
}
