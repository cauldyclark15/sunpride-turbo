// SP-0170: one validation of the client's customer record for API, web and uploads.
// Pure JS (no I/O): the caller passes the reference rows and the resolved geography records.
import {
  ADP_CHANNEL,
  CUSTOMER_FIELDS,
  SHIP_TO_FIELDS,
  field,
} from "./fields.js";

/** @typedef {import("./fields.js").FieldSpec} FieldSpecRef */
/** @typedef {{list:string,salesOrgCode?:string,channelCode?:string,group1Code?:string,code:string,name:string,active?:boolean}} ReferenceRow */
/** @typedef {{code:string,name?:string}} GeoRegion */
/** @typedef {{code:string,name?:string,regionCode:string}} GeoProvince */
/** @typedef {{code:string,name?:string,provinceCode:string,regionCode:string}} GeoMunicipality */
/** @typedef {{code:string,name?:string,municipalityCode:string}} GeoBarangay */
/** @typedef {{region?:GeoRegion|null,province?:GeoProvince|null,municipality?:GeoMunicipality|null,barangay?:GeoBarangay|null,postalCodes?:string[]}} ResolvedGeography */
/** @typedef {{code:string,field:string,label:string,section:string,message:string,index?:number}} CustomerError */
/** @typedef {'draft'|'complete'} Level */

/** Stable error codes (documented in docs/architecture/CUSTOMER_MASTER_CONTRACT.md). */
export const ERROR_CODES = /** @type {const} */ ([
  "required",
  "too_long",
  "invalid_option",
  "not_for_sales_org",
  "not_for_channel",
  "not_for_group1",
  "not_applicable",
  "choose_parent_first",
  "invalid_tin",
  "invalid_mobile",
  "invalid_email",
  "invalid_coordinates",
  "invalid_credit_limit",
  "geography_mismatch",
  "postal_code_mismatch",
  "ship_to_required",
]);

/** "Description (Code)" — how every dropdown shows an option. @param {{code:string,name:string}} row */
export const optionLabel = (row) =>
  row.code === row.name ? row.name : `${row.name} (${row.code})`;

/** @param {any} v */
const blank = (v) => v == null || (typeof v === "string" && v.trim() === "");
/** @param {any} v @returns {string|null} */
const text = (v) =>
  blank(v) ? null : typeof v === "number" ? String(v) : String(v).trim();

/** TIN: ###-###-### or ###-###-###-### (branch code); digits-only accepted. Returns the dashed
 * form or null when invalid. @param {any} v */
export function normalizeTin(v) {
  const s = text(v);
  if (!s) return null;
  if (!/^[0-9-\s]+$/.test(s)) return null;
  const d = s.replace(/[-\s]/g, "");
  if (d.length !== 9 && d.length !== 12) return null;
  if (/-/.test(s) && !/^\d{3}-\d{3}-\d{3}(-\d{3})?$/.test(s.replace(/\s/g, "")))
    return null;
  return d.match(/.{3}/g)?.join("-") ?? null;
}

/** PH mobile: 09XXXXXXXXX or +639XXXXXXXXX (spaces/dashes ignored). Stored as 09XXXXXXXXX.
 * @param {any} v */
export function normalizePhMobile(v) {
  const s = text(v);
  if (!s) return null;
  const compact = s.replace(/[\s-]/g, "");
  if (/^09\d{9}$/.test(compact)) return compact;
  if (/^\+639\d{9}$/.test(compact)) return `0${compact.slice(3)}`;
  return null;
}

/** @param {any} v */
export function normalizeEmail(v) {
  const s = text(v);
  if (!s) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200
    ? s.toLowerCase()
    : null;
}

/** One-line Customer Address from the location parts. Same rule as SQL customer_address_line().
 * @param {{roomStallNo?:any,floor?:any,houseNo?:any,street1?:any,street2?:any,barangayName?:any,municipalityName?:any,provinceName?:any,postalCode?:any}} p */
export function formatAddress(p) {
  /** @param {any[]} parts @param {string} sep */
  const join = (parts, sep) =>
    parts
      .map(text)
      .filter((x) => x)
      .join(sep);
  return (
    join(
      [
        p.roomStallNo,
        p.floor,
        join([p.houseNo, p.street1], " "),
        p.street2,
        p.barangayName,
        p.municipalityName,
        join([p.provinceName, p.postalCode], " "),
      ],
      ", ",
    ) || null
  );
}

/** Index reference rows by list for fast dependent lookups. @param {ReferenceRow[]} rows */
export function referenceIndex(rows) {
  /** @type {Map<string, ReferenceRow[]>} */ const byList = new Map();
  for (const r of rows) {
    if (r.active === false) continue;
    const list = byList.get(r.list) ?? [];
    list.push(r);
    byList.set(r.list, list);
  }
  /** @param {string} list @param {{salesOrgCode?:string|null,channelCode?:string|null,group1Code?:string|null}} [parent] */
  const options = (list, parent = {}) =>
    (byList.get(list) ?? []).filter(
      (r) =>
        (parent.salesOrgCode == null ||
          (r.salesOrgCode ?? "") === "" ||
          r.salesOrgCode === parent.salesOrgCode) &&
        (parent.channelCode == null ||
          (r.channelCode ?? "") === "" ||
          r.channelCode === parent.channelCode) &&
        (parent.group1Code == null ||
          (r.group1Code ?? "") === "" ||
          r.group1Code === parent.group1Code),
    );
  return {
    options,
    all: (/** @type {string} */ list) => byList.get(list) ?? [],
  };
}
/** @typedef {ReturnType<typeof referenceIndex>} ReferenceIndex */

/** Which dependent fields apply for a chosen assignment (SPEC rules 5/6).
 * @param {ReferenceIndex} index @param {{salesOrgCode?:any,distributionChannelCode?:any,customerGroup1Code?:any}} c */
export function applicability(index, c) {
  const salesOrgCode = text(c.salesOrgCode),
    channelCode = text(c.distributionChannelCode),
    group1Code = text(c.customerGroup1Code);
  // A channel outside the chosen sales org decides nothing about its groups.
  const channelValid =
    !!salesOrgCode &&
    !!channelCode &&
    index
      .options("distribution_channel", { salesOrgCode })
      .some((r) => r.code === channelCode);
  const group1Options =
    channelValid && salesOrgCode && channelCode
      ? index.options("customer_group_1", { salesOrgCode, channelCode })
      : null;
  // Without a Grp 1 yet, Grp 2 applies when any Grp 1 of the channel has Grp 2 values.
  const group2Options =
    channelValid && salesOrgCode && channelCode
      ? index.options("customer_group_2", {
          salesOrgCode,
          channelCode,
          group1Code,
        })
      : null;
  return {
    group1: group1Options === null ? null : group1Options.length > 0,
    group2: group2Options === null ? null : group2Options.length > 0,
    adp: channelCode === ADP_CHANNEL,
  };
}

/**
 * Validate a customer at `draft` (field capture: formats, list membership and dependencies of
 * whatever is filled; only Customer Name required) or `complete` (every required field of the
 * sheet with the conditional rules; needed for approval/activation and uploads).
 * @param {Record<string, any>} input
 * @param {{level?:Level, lists:ReferenceRow[]|ReferenceIndex, geography?:ResolvedGeography|null}} ctx
 * @returns {{ok:boolean, level:Level, errors:CustomerError[], value:Record<string, any>}}
 */
export function validateCustomer(input, ctx) {
  const level = ctx.level ?? "complete";
  const index = Array.isArray(ctx.lists)
    ? referenceIndex(ctx.lists)
    : ctx.lists;
  /** @type {CustomerError[]} */ const errors = [];
  /** @type {Record<string, any>} */ const value = {};
  /** @param {string} code @param {FieldSpecRef} f @param {string} message @param {number} [i] */
  const fail = (code, f, message, i) =>
    errors.push({
      code,
      field: i === undefined ? f.key : `shipTos[${i}].${f.key}`,
      label: f.label,
      section: f.section,
      message,
      ...(i === undefined ? {} : { index: i }),
    });
  const app = applicability(index, input);
  /** @param {FieldSpecRef} f */
  const isRequired = (f) => {
    if (level === "draft") return f.key === "customerName";
    if (!f.required) return false;
    if (f.adp) return app.adp;
    if (f.key === "customerGroup1Code") return app.group1 !== false;
    if (f.key === "customerGroup2Code")
      return app.group1 !== false && app.group2 !== false;
    return true;
  };

  /** Scalar fields: required + format. @param {FieldSpecRef} f @param {any} raw @param {number} [i] */
  const scalar = (f, raw, i) => {
    if (f.kind === "coordinates") return undefined;
    if (blank(raw)) {
      if (isRequired(f)) fail("required", f, `${f.label} is required.`, i);
      return null;
    }
    if (f.kind === "money") {
      const n =
        typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(n) || n < 0 || n > 999999999999.99) {
        fail(
          "invalid_credit_limit",
          f,
          `${f.label} must be a number of 0 or more.`,
          i,
        );
        return null;
      }
      return Math.round(n * 100) / 100;
    }
    if (f.kind === "tin") {
      const v = normalizeTin(raw);
      if (!v)
        fail(
          "invalid_tin",
          f,
          `${f.label} must be ###-###-### or ###-###-###-### (digits only also accepted).`,
          i,
        );
      return v;
    }
    if (f.kind === "mobile") {
      const v = normalizePhMobile(raw);
      if (!v)
        fail(
          "invalid_mobile",
          f,
          `${f.label} must be a Philippine mobile number: 09XXXXXXXXX or +639XXXXXXXXX.`,
          i,
        );
      return v;
    }
    if (f.kind === "email") {
      const v = normalizeEmail(raw);
      if (!v)
        fail("invalid_email", f, `${f.label} is not a valid email address.`, i);
      return v;
    }
    const v = /** @type {string} */ (text(raw));
    if (f.max && v.length > f.max) {
      fail(
        "too_long",
        f,
        `${f.label} must be ${f.max} characters or fewer.`,
        i,
      );
      return v.slice(0, f.max);
    }
    return v;
  };

  for (const f of CUSTOMER_FIELDS) {
    if (f.kind === "list" || f.kind === "geo") {
      const v = text(input[f.key]);
      if (!v && isRequired(f)) fail("required", f, `${f.label} is required.`);
      value[f.key] = v;
      continue;
    }
    if (f.kind === "coordinates") continue;
    value[f.key] = scalar(f, input[f.key]);
  }
  if (blank(input.countryCode) && level === "draft") value.countryCode = null;

  // Dropdown membership, dependent on the chosen Sales Organization / channel / group (rule 8).
  /** @param {string} key @param {{salesOrgCode?:string|null,channelCode?:string|null,group1Code?:string|null}} [parent] @param {string} [parentCode] @param {FieldSpecRef} [parentField] */
  const member = (key, parent, parentCode, parentField) => {
    const f = field(key);
    const v = value[key];
    if (!v) return;
    if (parentField && parent && Object.values(parent).some((x) => !x)) {
      fail(
        "choose_parent_first",
        f,
        `Choose ${parentField.label} before ${f.label}.`,
      );
      return;
    }
    const all = index.all(/** @type {string} */ (f.list));
    if (!all.some((r) => r.code === v)) {
      fail("invalid_option", f, `${f.label} "${v}" is not in the list.`);
      return;
    }
    if (
      parent &&
      !index
        .options(/** @type {string} */ (f.list), parent)
        .some((r) => r.code === v)
    )
      fail(
        parentCode ?? "not_for_sales_org",
        f,
        parentCode === "not_for_channel"
          ? `${f.label} "${v}" is not under Distribution Channel ${parent.channelCode}.`
          : parentCode === "not_for_group1"
            ? `${f.label} "${v}" is not under Customer Grp 1 ${parent.group1Code}.`
            : `${f.label} "${v}" is not available for Sales Organization ${parent.salesOrgCode}.`,
      );
  };
  const salesOrgCode = value.salesOrgCode,
    channelCode = value.distributionChannelCode,
    group1Code = value.customerGroup1Code;
  for (const key of [
    "taxClassificationCode",
    "countryCode",
    "salesOrgCode",
    "customerGroupCode",
    "typeOfBusiness",
    "salesPartnerCode",
    "paymentTermsCode",
    "pricingProcedureCode",
  ])
    member(key);
  const org = field("salesOrgCode");
  for (const key of [
    "salesOfficeCode",
    "distributionChannelCode",
    "deliveringPlantCode",
  ])
    member(key, { salesOrgCode }, "not_for_sales_org", org);
  if (group1Code && app.group1 === false)
    fail(
      "not_applicable",
      field("customerGroup1Code"),
      `Customer Grp 1 does not apply to Distribution Channel ${channelCode}.`,
    );
  else
    member(
      "customerGroup1Code",
      { salesOrgCode, channelCode },
      "not_for_channel",
      field("distributionChannelCode"),
    );
  const group1Valid =
    !!group1Code &&
    index
      .options("customer_group_1", { salesOrgCode, channelCode })
      .some((r) => r.code === group1Code);
  if (
    value.customerGroup2Code &&
    (app.group1 === false || (group1Valid && app.group2 === false))
  )
    fail(
      "not_applicable",
      field("customerGroup2Code"),
      `Customer Grp 2 does not apply to Customer Grp 1 ${group1Code ?? ""}.`.replace(
        " .",
        ".",
      ),
    );
  else
    member(
      "customerGroup2Code",
      { salesOrgCode, channelCode, group1Code },
      "not_for_group1",
      field("customerGroup1Code"),
    );

  // Geography (rule 9): every level must belong to its parent; postal code to the municipality.
  const geo = ctx.geography ?? null;
  const gf = {
    region: field("regionCode"),
    province: field("provinceCode"),
    municipality: field("municipalityCode"),
    barangay: field("barangayCode"),
    postal: field("postalCode"),
  };
  if (geo) {
    if (value.regionCode && !geo.region)
      fail(
        "invalid_option",
        gf.region,
        `Region "${value.regionCode}" is not in the list.`,
      );
    if (value.provinceCode) {
      if (!geo.province)
        fail(
          "invalid_option",
          gf.province,
          `Province "${value.provinceCode}" is not in the list.`,
        );
      else if (!value.regionCode)
        fail(
          "choose_parent_first",
          gf.province,
          "Choose Region before Province.",
        );
      else if (geo.province.regionCode !== value.regionCode)
        fail(
          "geography_mismatch",
          gf.province,
          "Province is not in the chosen Region.",
        );
    }
    if (value.municipalityCode) {
      if (!geo.municipality)
        fail(
          "invalid_option",
          gf.municipality,
          `Municipality "${value.municipalityCode}" is not in the list.`,
        );
      else if (!value.provinceCode)
        fail(
          "choose_parent_first",
          gf.municipality,
          "Choose Province before Municipality.",
        );
      else if (geo.municipality.provinceCode !== value.provinceCode)
        fail(
          "geography_mismatch",
          gf.municipality,
          "Municipality is not in the chosen Province.",
        );
    }
    if (value.barangayCode) {
      if (!geo.barangay)
        fail(
          "invalid_option",
          gf.barangay,
          `Barangay "${value.barangayCode}" is not in the list.`,
        );
      else if (!value.municipalityCode)
        fail(
          "choose_parent_first",
          gf.barangay,
          "Choose Municipality before Barangay.",
        );
      else if (geo.barangay.municipalityCode !== value.municipalityCode)
        fail(
          "geography_mismatch",
          gf.barangay,
          "Barangay is not in the chosen Municipality.",
        );
    }
    if (value.postalCode) {
      if (!/^\d{4}$/.test(value.postalCode))
        fail(
          "invalid_option",
          gf.postal,
          `Postal Code "${value.postalCode}" is not in the list.`,
        );
      else if (!value.municipalityCode)
        fail(
          "choose_parent_first",
          gf.postal,
          "Choose Municipality before Postal Code.",
        );
      else if (!(geo.postalCodes ?? []).includes(value.postalCode))
        fail(
          "postal_code_mismatch",
          gf.postal,
          `Postal Code ${value.postalCode} does not belong to the chosen Municipality.`,
        );
    }
  } else if (value.postalCode && !/^\d{4}$/.test(value.postalCode))
    fail(
      "invalid_option",
      gf.postal,
      `Postal Code "${value.postalCode}" is not in the list.`,
    );

  // Geographical Coordinates (system-suggested; required for complete).
  const cf = field("coordinates");
  const lat = input.latitude,
    lng = input.longitude;
  if (blank(lat) && blank(lng)) {
    if (level === "complete") fail("required", cf, `${cf.label} is required.`);
    value.latitude = null;
    value.longitude = null;
  } else {
    const la = Number(lat),
      lo = Number(lng);
    if (
      blank(lat) ||
      blank(lng) ||
      !Number.isFinite(la) ||
      !Number.isFinite(lo) ||
      la < -90 ||
      la > 90 ||
      lo < -180 ||
      lo > 180 ||
      (la === 0 && lo === 0)
    ) {
      fail(
        "invalid_coordinates",
        cf,
        `${cf.label} must be a latitude from -90 to 90 and a longitude from -180 to 180.`,
      );
      value.latitude = null;
      value.longitude = null;
    } else {
      value.latitude = la;
      value.longitude = lo;
    }
  }

  // Delivery Arrangement: one or more ship-to entries.
  const shipTos = Array.isArray(input.shipTos) ? input.shipTos : [];
  value.shipTos = shipTos.map(
    (/** @type {any} */ s, /** @type {number} */ i) => {
      /** @type {Record<string, any>} */ const out = {
        sameAsCustomer: s?.sameAsCustomer === true,
      };
      for (const f of SHIP_TO_FIELDS) out[f.key] = scalar(f, s?.[f.key], i);
      return out;
    },
  );
  if (level === "complete" && value.shipTos.length === 0) {
    const f = /** @type {FieldSpecRef} */ (SHIP_TO_FIELDS[0]);
    fail(
      "ship_to_required",
      f,
      "Add at least one ship-to (Ship-to Party, Ship-to Address, Contact Person, Mobile No.).",
    );
  }
  return { ok: errors.length === 0, level, errors, value };
}

/** First ship-to built from the customer's own data ("same as customer"). Contact Person is
 * not a customer field in the sheet: it comes from the caller (e.g. the store owner's name).
 * @param {Record<string, any>} c @param {string|null} [contactPerson] */
export function shipToFromCustomer(c, contactPerson = null) {
  return {
    sameAsCustomer: true,
    shipToParty: text(c.customerName),
    shipToAddress: text(c.customerAddress),
    contactPerson: text(contactPerson),
    mobileNo: text(c.mobileNo),
    email: text(c.email),
  };
}
