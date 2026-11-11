/**
 * SP-0170 customer master (customer = store) — pure form model for the office web.
 * Field list, labels, sections and rules come from @sunpride/customer-master (the client's
 * "Customer Information template"); the server stays authoritative.
 */
import {
  ADP_CHANNEL,
  CUSTOMER_FIELDS,
  FIELDS,
  SECTIONS,
  SHIP_TO_FIELDS,
  applicability,
  formatAddress,
  optionLabel,
  referenceIndex,
  validateCustomer,
} from "@sunpride/customer-master";

export { ADP_CHANNEL, FIELDS, SECTIONS, SHIP_TO_FIELDS, optionLabel };

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

export type GeoOption = { code: string; name: string; label?: string };

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
  completeness: "draft" | "complete";
  enrolmentStatus: string | null;
  customerName: string | null;
  customerAddress: string | null;
  addressCustom: boolean;
  latitude: number | null;
  longitude: number | null;
  pinStatus: string | null;
  shipTos: ShipTo[];
  custodianOrgUnitId: string | null;
};

export type CustomerRow = {
  id: string;
  code: string;
  customerName: string;
  registeredName: string | null;
  customerAddress: string | null;
  status: CustomerStatus;
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
};

/** The editable form state: every sheet key as text, names of chosen geography, ship-tos. */
export type Draft = {
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
};

export const ADP_KEYS = CUSTOMER_FIELDS.filter((f) => f.adp).map((f) => f.key);

const str = (v: unknown) =>
  v === null || v === undefined ? "" : typeof v === "string" ? v : String(v);

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
  for (const key of Object.keys(d.values)) d.values[key] = str(c[key]);
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
      roomStallNo: d.values.roomStallNo,
      floor: d.values.floor,
      houseNo: d.values.houseNo,
      street1: d.values.street1,
      street2: d.values.street2,
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
  const next = { ...d, values, names };
  if (ADDRESS_PARTS.has(key) && !d.addressCustom)
    next.values.customerAddress = generatedAddress(next);
  return next;
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
    shipToParty: d.values.customerName ?? "",
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
  for (const f of FIELDS) {
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
    customer[f.key] = blankToNull(d.values[f.key] ?? "");
  }
  // "" returns Customer Address to the generated line (contract §1).
  customer.customerAddress = d.addressCustom
    ? blankToNull(d.values.customerAddress ?? "")
    : "";
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
      shipToParty: blankToNull(r.shipToParty),
      shipToAddress: blankToNull(r.shipToAddress),
      contactPerson: blankToNull(r.contactPerson),
      mobileNo: blankToNull(r.mobileNo),
      email: blankToNull(r.email),
    };
  });
  return customer;
}

/** Instant browser check with the shared rules (geography membership is left to the server). */
export function checkDraft(
  index: ReferenceIndex,
  d: Draft,
  level: "draft" | "complete",
): FieldErrors {
  const input = toPayload(d, applies(index, d));
  // The generated address is what the server will store.
  input.customerAddress = d.values.customerAddress ?? "";
  const r = validateCustomer(input, { level, lists: index });
  return errorsToFields(r.errors);
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
        ? `${list.length} fields need attention before this can be saved.`
        : (e?.message ?? "The customer could not be saved."),
  };
}

/** Field keys in the client's order for one section. */
export function sectionFields(section: Section): FieldSpec[] {
  return FIELDS.filter((f) => f.section === section && !f.shipTo);
}

/** Status shown to people: a field-captured customer is a prospect until approved. */
export const STATUS_LABEL: Record<CustomerStatus, string> = {
  prospect: "Prospect",
  active: "Active",
  inactive: "Inactive",
};

export const LIST_FILTER_KEYS = [
  "salesOrgCode",
  "salesOfficeCode",
  "distributionChannelCode",
  "customerGroup1Code",
  "customerGroup2Code",
  "customerGroupCode",
  "completeness",
] as const;
