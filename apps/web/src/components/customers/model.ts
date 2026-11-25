/**
 * SP-0170 customer master (customer = store) — pure form model for the office web.
 * Field list, labels, sections and rules come from @sunpride/customer-master (the client's
 * "Customer Information template"); the server stays authoritative.
 */
import {
  CUSTOMER_NAME_FIELDS,
  formatCustomerName,
  validateEnrollment,
  type EnrollmentField,
  ADP_CHANNEL,
  CUSTOMER_FIELDS,
  FIELDS,
  SECTIONS,
  SHIP_TO_FIELDS,
  applicability,
  formatAddress,
  suggestPostalCode,
  optionLabel,
  referenceIndex,
  validateCustomer,
} from "@sunpride/customer-master";

export { ADP_CHANNEL, FIELDS, SECTIONS, SHIP_TO_FIELDS, optionLabel };
const EDITOR_FIELDS = FIELDS;

export type FieldSpec = (typeof FIELDS)[number];
export type Section = (typeof SECTIONS)[number];

export type RefOption = {
  list: string;
  salesOrgCode?: string | null;
  channelCode?: string | null;
  group1Code?: string | null;
  code: string;
  name: string;
  label?: string;
  active?: boolean;
};

export type GeoOption = {
  code: string;
  name: string;
  label?: string;
  area?: string | null;
};

export type ShipTo = {
  id?: string;
  sameAsCustomer: boolean;
  shipToParty: string;
  shipToAddress: string;
  contactPerson: string;
  mobileNo: string;
  email: string;
};

export type CustomerStatus = "prospect" | "active" | "inactive";

/** Server customer (contract §4); only the keys the web reads are typed strictly. */
export type Customer = Record<string, unknown> & {
  id: string;
  code: string;
  status: CustomerStatus;
  visitFrequency?: string;
  visitFrequencyDays?: number | null;
  visitFrequencyPerMonth?: number | null;
  completeness: "draft" | "complete";
  enrolmentStatus: string | null;
  canEdit?: boolean;
  missingFields?: FieldMissing[];
  history?: {
    id: string;
    at: number;
    actor: string;
    changes: {
      field: string;
      label: string;
      before: unknown;
      after: unknown;
    }[];
  }[];
  historyTruncated?: boolean;
  updatedAt?: number;
  customerName: string | null;
  customerAddress: string | null;
  addressCustom: boolean;
  latitude: number | null;
  longitude: number | null;
  pinStatus: string | null;
  shipTos: ShipTo[];
  custodianOrgUnitId: string | null;
  /** WEB-059: who proposed the pending field enrolment (null when none is pending). */
  proposedByProfileId?: string | null;
  /** SP-0188: a field app save the office must finish (null/absent when nothing is missing). */
  fieldMissing?: FieldMissing[] | null;
  /** SP-0188: what the agent typed on the phone, including values that were not kept. */
  fieldSubmitted?: Record<string, unknown> | null;
};

/** SP-0188: one field the phone left blank or that failed a check. */
export type FieldMissing = { field: string; label: string; message: string };

export type CustomerRow = {
  customFields?: Record<string, string>;
  id: string;
  code: string;
  customerName: string;
  registeredName: string | null;
  customerAddress: string | null;
  status: CustomerStatus;
  visitFrequency?: string;
  visitFrequencyDays?: number | null;
  visitFrequencyPerMonth?: number | null;
  enrolmentStatus: string | null;
  completeness: "draft" | "complete";
  salesOrgCode: string | null;
  salesOfficeCode: string | null;
  distributionChannelCode: string | null;
  distributionChannelName: string | null;
  customerGroup1Code: string | null;
  customerGroup1Name: string | null;
  customerGroup2Code: string | null;
  customerGroup2Name: string | null;
  customerGroupCode: string | null;
  customerGroupName: string | null;
  municipalityName: string | null;
  barangayName: string | null;
  territoryName: string | null;
  /** SP-0188: fields a field app save left for the office (older servers omit it). */
  fieldMissing?: FieldMissing[] | null;
  /** SP-0175 "who added what" (older servers omit these). */
  addedById?: string | null;
  addedByName?: string | null;
  addedAt?: number | null;
};

/** The editable form state: every sheet key as text, names of chosen geography, ship-tos. */
export type Draft = {
  customFields?: Record<string, string>;
  enrollmentFields?: EnrollmentField[];
  code: string;
  values: Record<string, string>;
  /** Display names of the chosen geography (for the generated Customer Address). */
  names: Record<string, string>;
  addressCustom: boolean;
  latitude: string;
  longitude: string;
  shipTos: ShipTo[];
};

export type FieldErrors = Record<string, string>;

const GEO_NAME: Record<string, string> = {
  regionCode: "regionName",
  provinceCode: "provinceName",
  municipalityCode: "municipalityName",
  barangayCode: "barangayName",
};

/** Changing a parent clears every value chosen under it (SPEC rules 8/9). */
export const DEPENDENTS: Record<string, string[]> = {
  salesOrgCode: [
    "salesOfficeCode",
    "distributionChannelCode",
    "deliveringPlantCode",
    "customerGroup1Code",
    "customerGroup2Code",
  ],
  distributionChannelCode: ["customerGroup1Code", "customerGroup2Code"],
  customerGroup1Code: ["customerGroup2Code"],
  countryCode: [
    "regionCode",
    "provinceCode",
    "municipalityCode",
    "barangayCode",
    "postalCode",
  ],
  regionCode: [
    "provinceCode",
    "municipalityCode",
    "barangayCode",
    "postalCode",
  ],
  provinceCode: ["municipalityCode", "barangayCode", "postalCode"],
  municipalityCode: ["barangayCode", "postalCode"],
  barangayCode: ["postalCode"],
};

export const ADP_KEYS = CUSTOMER_FIELDS.filter((f) => f.adp).map((f) => f.key);

const str = (v: unknown) =>
  v === null || v === undefined ? "" : typeof v === "string" ? v : String(v);

// SP-0182: normalize free text, never reference keys or manually entered identifiers.
const TITLE_CASE_FIELDS = new Set(
  [...FIELDS, ...CUSTOMER_NAME_FIELDS]
    .filter(
      (f) =>
        f.kind === "text" && !f.key.endsWith("Code") && f.key !== "clusterNo",
    )
    .map((f) => f.key),
);

export function normalizeCustomerText(key: string, value: string): string {
  if (!TITLE_CASE_FIELDS.has(key)) return value;
  return value
    .toLowerCase()
    .replace(/\p{L}[\p{L}\p{M}]*(?:['’][\p{L}\p{M}]+)*/gu, (word) =>
      word
        .split(/(['’])/u)
        .map((part, i) =>
          // Keep possessive 's, but capitalize names such as O'Neil and D’Angelo.
          i % 2 || (i > 0 && part === "s")
            ? part
            : part.charAt(0).toUpperCase() + part.slice(1),
        )
        .join(""),
    );
}

export function emptyShipTo(sameAsCustomer = false): ShipTo {
  return {
    sameAsCustomer,
    shipToParty: "",
    shipToAddress: "",
    contactPerson: "",
    mobileNo: "",
    email: "",
  };
}

export function emptyDraft(): Draft {
  const values: Record<string, string> = {};
  for (const f of CUSTOMER_FIELDS)
    if (f.kind !== "coordinates") values[f.key] = "";
  for (const f of CUSTOMER_NAME_FIELDS) values[f.key] = "";
  values.countryCode = "PH";
  return {
    code: "",
    values,
    names: {},
    addressCustom: false,
    latitude: "",
    longitude: "",
    shipTos: [emptyShipTo(true)],
  };
}

export function draftFromCustomer(c: Customer): Draft {
  const d = emptyDraft();
  d.code = c.code ?? "";
  d.customFields = (c.customFields as Record<string, string>) ?? {};
  for (const key of Object.keys(d.values)) d.values[key] = str(c[key]);
  if (!d.values.customerName)
    d.values.customerName = formatCustomerName(d.values);
  if (!d.values.countryCode) d.values.countryCode = "PH";
  for (const [codeKey, nameKey] of Object.entries(GEO_NAME))
    d.names[codeKey] = str(c[nameKey]);
  d.addressCustom = c.addressCustom === true;
  d.latitude = str(c.latitude);
  d.longitude = str(c.longitude);
  d.shipTos = (c.shipTos ?? []).map((s) => ({
    id: s.id,
    sameAsCustomer: s.sameAsCustomer === true,
    shipToParty: str(s.shipToParty),
    shipToAddress: str(s.shipToAddress),
    contactPerson: str(s.contactPerson),
    mobileNo: str(s.mobileNo),
    email: str(s.email),
  }));
  if (!d.shipTos.length) d.shipTos = [emptyShipTo(true)];
  return d;
}

/** The one-line Customer Address built from the location parts (package rule). */
export function generatedAddress(d: Draft): string {
  return (
    formatAddress({
      roomStallNo: normalizeCustomerText(
        "roomStallNo",
        d.values.roomStallNo ?? "",
      ),
      floor: normalizeCustomerText("floor", d.values.floor ?? ""),
      houseNo: normalizeCustomerText("houseNo", d.values.houseNo ?? ""),
      street1: normalizeCustomerText("street1", d.values.street1 ?? ""),
      street2: normalizeCustomerText("street2", d.values.street2 ?? ""),
      barangayName: d.names.barangayCode,
      municipalityName: d.names.municipalityCode,
      provinceName: d.names.provinceCode,
      postalCode: d.values.postalCode,
    }) ?? ""
  );
}

const ADDRESS_PARTS = new Set([
  "roomStallNo",
  "floor",
  "houseNo",
  "street1",
  "street2",
  "regionCode",
  "provinceCode",
  "municipalityCode",
  "barangayCode",
  "postalCode",
  "countryCode",
]);

/**
 * Set one field. Clears its dependents, keeps the generated Customer Address in step with the
 * location (until the user types their own), and clears the ADP block when the channel leaves 40.
 */
export function setField(
  d: Draft,
  key: string,
  value: string,
  name?: string,
): Draft {
  if (key === "customerAddress") {
    const generated = generatedAddress(d);
    const custom = value.trim() !== "" && value !== generated;
    return {
      ...d,
      addressCustom: custom,
      values: { ...d.values, customerAddress: custom ? value : generated },
    };
  }
  if (d.values[key] === value && name === undefined) return d;
  const values = { ...d.values, [key]: value };
  const names = { ...d.names };
  if (key in GEO_NAME) names[key] = value ? (name ?? "") : "";
  if (d.values[key] !== value)
    for (const dep of DEPENDENTS[key] ?? []) {
      values[dep] = "";
      if (dep in GEO_NAME) names[dep] = "";
    }
  if (key === "distributionChannelCode" && value !== ADP_CHANNEL)
    for (const k of ADP_KEYS) values[k] = "";
  if (CUSTOMER_NAME_FIELDS.some((f) => f.key === key))
    values.customerName = formatCustomerName(values);
  const next = { ...d, values, names };
  // SP-0220: Street 1 and the location are the address; changing them replaces an older
  // custom line (the server does the same).
  if (ADDRESS_PARTS.has(key)) {
    next.addressCustom = false;
    next.values.customerAddress = generatedAddress(next);
  }
  return next;
}

/** Apply only after a new barangay selection (never on reopen or after manual edits/clearing). */
export function withSuggestedPostal(d: Draft, options: GeoOption[]): Draft {
  if (!d.values.barangayCode) return d;
  return setField(
    d,
    "postalCode",
    suggestPostalCode(options, d.names.barangayCode) ?? "",
  );
}

/** Ship-to list operations. The list always keeps at least one entry. */
export function addShipTo(d: Draft): Draft {
  return { ...d, shipTos: [...d.shipTos, emptyShipTo(false)] };
}

export function removeShipTo(d: Draft, index: number): Draft {
  if (d.shipTos.length <= 1) return d;
  return { ...d, shipTos: d.shipTos.filter((_, i) => i !== index) };
}

export function setShipTo(
  d: Draft,
  index: number,
  key: keyof ShipTo,
  value: string | boolean,
): Draft {
  return {
    ...d,
    shipTos: d.shipTos.map((s, i) =>
      i === index ? { ...s, [key]: value } : s,
    ),
  };
}

/** A "same as customer" ship-to shows (and sends) the customer's own name/address/mobile/email. */
export function resolvedShipTo(d: Draft, s: ShipTo): ShipTo {
  if (!s.sameAsCustomer) return s;
  return {
    ...s,
    shipToParty: d.values.customerName || "",
    shipToAddress: d.values.customerAddress ?? "",
    mobileNo: d.values.mobileNo ?? "",
    email: d.values.email ?? "",
  };
}

export type ReferenceIndex = ReturnType<typeof referenceIndex>;
export const indexReference = (rows: RefOption[]): ReferenceIndex =>
  referenceIndex(rows as never);

/** Dropdown options of a list under the draft's chosen parents. */
export function optionsFor(
  index: ReferenceIndex,
  list: string,
  d: Draft,
): RefOption[] {
  const v = d.values;
  const parent: Record<string, string | null> = {};
  if (
    [
      "sales_office",
      "distribution_channel",
      "delivering_plant",
      "customer_group_1",
      "customer_group_2",
    ].includes(list)
  ) {
    if (!v.salesOrgCode) return [];
    parent.salesOrgCode = v.salesOrgCode;
  }
  if (list === "customer_group_1" || list === "customer_group_2") {
    if (!v.distributionChannelCode) return [];
    parent.channelCode = v.distributionChannelCode;
  }
  if (list === "customer_group_2") {
    if (!v.customerGroup1Code) return [];
    parent.group1Code = v.customerGroup1Code;
  }
  return index.options(list, parent) as RefOption[];
}

/** Which conditional parts apply (SPEC rules 5/6): `false` = the chain has none. */
export function applies(index: ReferenceIndex, d: Draft) {
  const a = applicability(index, d.values);
  return {
    group1: a.group1 as boolean | null,
    group2: a.group2 as boolean | null,
    adp: d.values.distributionChannelCode === ADP_CHANNEL,
  };
}

/** Required marker per field key for the `complete` level (sheet asterisk + rules 5/6). */
export function requiredMarks(
  index: ReferenceIndex,
  d: Draft,
): Record<string, boolean> {
  const a = applies(index, d);
  const out: Record<string, boolean> = {};
  for (const f of EDITOR_FIELDS) {
    let r = f.required;
    if (f.adp) r = r && a.adp;
    if (f.key === "customerGroup1Code") r = a.group1 !== false;
    if (f.key === "customerGroup2Code")
      r = a.group1 !== false && a.group2 !== false;
    out[f.key] = r;
  }
  return out;
}

const blankToNull = (v: string) => (v.trim() === "" ? null : v.trim());

/** The API body `customer` (contract §1): only sheet keys, coordinates as lat/long. */
export function toPayload(d: Draft, a?: { adp: boolean }) {
  const customer: Record<string, unknown> = {};
  for (const f of CUSTOMER_FIELDS) {
    if (f.kind === "coordinates") continue;
    if (f.adp && a && !a.adp) continue;
    customer[f.key] = blankToNull(
      normalizeCustomerText(f.key, d.values[f.key] ?? ""),
    );
  }
  // SP-0240 rollback: submit the editable full name, not hidden historical parts.
  // SP-0220: Customer Address is no longer typed; the server builds it from Street 1 and the
  // location fields (an older custom address is kept until those change).
  delete customer.customerAddress;
  // SP-0252: Sales Partner is set by the server (the person who added the customer).
  delete customer.salesPartnerCode;
  if (customer.creditLimit !== null && customer.creditLimit !== undefined)
    customer.creditLimit = Number(
      String(customer.creditLimit).replace(/,/g, ""),
    );
  customer.latitude = d.latitude.trim() === "" ? null : Number(d.latitude);
  customer.longitude = d.longitude.trim() === "" ? null : Number(d.longitude);
  customer.shipTos = d.shipTos.map((s) => {
    const r = resolvedShipTo(d, s);
    return {
      sameAsCustomer: s.sameAsCustomer,
      shipToParty: blankToNull(
        normalizeCustomerText("shipToParty", r.shipToParty),
      ),
      shipToAddress: blankToNull(
        s.sameAsCustomer && !d.addressCustom
          ? generatedAddress(d)
          : normalizeCustomerText("shipToAddress", r.shipToAddress),
      ),
      contactPerson: blankToNull(
        normalizeCustomerText("contactPerson", r.contactPerson),
      ),
      mobileNo: blankToNull(r.mobileNo),
      email: blankToNull(r.email),
    };
  });
  customer.customFields = d.customFields ?? {};
  return customer;
}

/** Instant browser check with the shared rules (geography membership is left to the server). */
export function checkDraft(
  index: ReferenceIndex,
  d: Draft,
  level: "draft" | "complete" | "pending",
): FieldErrors {
  const input = toPayload(d, applies(index, d));
  // The generated address is what the server will store.
  input.customerAddress = d.values.customerAddress ?? "";
  const r = validateCustomer(input, {
    level: level === "pending" ? "draft" : level,
    lists: index,
  });
  // A "same as customer" ship-to repeats the customer's own fields: report those once, there.
  const copied = new Set(["shipToParty", "shipToAddress", "mobileNo", "email"]);
  const errors = r.errors.filter((e: { field: string; index?: number }) => {
    if (e.index === undefined) return true;
    const key = e.field.split(".").pop() ?? "";
    return !(d.shipTos[e.index]?.sameAsCustomer && copied.has(key));
  });
  const custom = validateEnrollment(
    d.enrollmentFields ?? [],
    d.customFields,
    input,
  );
  const customErrors =
    level === "pending"
      ? custom.errors.filter((e) =>
          (d.customFields?.[e.field.split(".")[1] ?? ""] ?? "").trim(),
        )
      : custom.errors;
  return errorsToFields([...errors, ...customErrors]);
}

type ServerError = { field?: string; message?: string; label?: string };

export function errorsToFields(errors: readonly ServerError[]): FieldErrors {
  const out: FieldErrors = {};
  for (const e of errors) {
    if (!e.field || out[e.field]) continue;
    out[e.field] = e.message ?? `${e.label ?? e.field} is not valid.`;
  }
  return out;
}

/** Field errors from an API failure: `422 validation_failed` → `details.errors[]` by field. */
export function fieldErrorsFrom(error: unknown): {
  fields: FieldErrors;
  message: string;
} {
  const e = error as { message?: string; details?: unknown } | null;
  const details = e?.details as { errors?: ServerError[] } | undefined;
  const list = Array.isArray(details?.errors) ? details.errors : [];
  return {
    fields: errorsToFields(list),
    message:
      list.length > 1
        ? `${list.length} fields need attention. Each one is marked below.`
        : (e?.message ?? "The customer could not be saved."),
  };
}

/** Field keys in the client's order for one section. */
export function sectionFields(section: Section): FieldSpec[] {
  // SP-0220: hidden fields (the stored one-line Customer Address) are not shown or edited.
  return EDITOR_FIELDS.filter(
    (f) =>
      f.section === section && !f.shipTo && !(f as { hidden?: boolean }).hidden,
  );
}

/** Status shown to people: a field-captured customer is a prospect until approved. */
/** Waits for an approver: an office/upload prospect, or a field "Add customer" store that is
 * already visitable (active) under a provisional code until its enrolment is approved. */
export function awaitsApproval(c: {
  status: string;
  enrolmentStatus: string | null;
}): boolean {
  return (
    c.status === "prospect" ||
    (c.status === "active" && c.enrolmentStatus === "provisional")
  );
}

export const STATUS_LABEL: Record<CustomerStatus, string> = {
  prospect: "Prospect",
  active: "Active",
  inactive: "Inactive",
};

/** SP-0176: the badge people see. A store waiting for approval (prospect, or a field store visitable under a
 * provisional code) never shows the green "Active" badge. */
export function statusLabel(c: {
  status: CustomerStatus;
  enrolmentStatus: string | null;
}): string {
  return awaitsApproval(c)
    ? "Waiting for approval"
    : (STATUS_LABEL[c.status] ?? c.status);
}
export function statusTone(c: {
  status: CustomerStatus;
  enrolmentStatus: string | null;
}): "good" | "wait" | "off" {
  return awaitsApproval(c) ? "wait" : c.status === "active" ? "good" : "off";
}

export const LIST_FILTER_KEYS = [
  "salesOrgCode",
  "salesOfficeCode",
  "distributionChannelCode",
  "customerGroup1Code",
  "customerGroup2Code",
  "customerGroupCode",
  "completeness",
  "addedBy",
  "addedOn",
] as const;
