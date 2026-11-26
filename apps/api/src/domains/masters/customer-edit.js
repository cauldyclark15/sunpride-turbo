// SP-0250: one permission and edit projection for web, Android and iOS.
import {
  FIELDS,
  referenceIndex,
  optionLabel,
  validateCustomer,
  validateEnrollment,
  enrollmentRequired,
} from "@sunpride/customer-master";
import { roleHas, requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { access } from "../org/readers.js";
import {
  readCustomer,
  referenceRows,
  resolveGeography,
  derive,
} from "./customers.js";
import { readEnrollmentForm } from "./enrollment-form.js";
import { ORG_LOCK } from "../org/identity.js";
import { currentActor } from "../van/access.js";
import { isPlainObject } from "../../core/util.js";

/** @param {any} c */
export const awaitingApproval = (c) =>
  c.status === "prospect" ||
  (c.status === "active" && c.enrolmentStatus === "provisional");

/** Always resolve current scope and persisted approval state, including on retries.
 * @param {any} c @param {string} id @param {boolean} [enforce] */
export async function customerEditAccess(c, id, enforce = false) {
  if (enforce) {
    // Same order as legacy approval and territory writers: organization, then row.
    await c.db`select pg_advisory_xact_lock(${ORG_LOCK})`;
    c.actor = await currentActor(c.db, c.actor);
    await c.db`select id from outlets where id=${id} for update`;
  }
  await requireCapability(c, "outlet.read");
  const [o] =
    await c.db`select status,enrolment_status,created_by from outlets where id=${id} and deleted_at is null`;
  if (!o) throw new ApiError("not_found", 404, "Customer not found.");
  const [pending] =
    await c.db`select proposed_by,proposed_by_profile_id from outlet_enrolments where outlet_id=${id} and status='pending' and deleted_at is null order by created_at desc limit 1`;
  const waiting = awaitingApproval({
    status: o.status,
    enrolmentStatus: o.enrolment_status,
  });
  const own = pending
    ? pending.proposed_by_profile_id === c.actor.profileId ||
      pending.proposed_by === c.actor.subject
    : [c.actor.subject, c.actor.userId].includes(o.created_by);
  // The original submitter can complete their waiting profile even when its
  // territory has another salesperson. Keep the ordinary current-unit scope gate.
  await access(
    c,
    "outlets",
    id,
    own && waiting && c.actor.role === "sales"
      ? "outlet.enrol.propose"
      : "outlet.read",
  );
  const canEdit =
    o.status !== "inactive" &&
    (roleHas(c.actor.role, "admin.manage") ||
      (waiting &&
        (roleHas(c.actor.role, "outlet.manage") ||
          roleHas(c.actor.role, "outlet.enrol.approve") ||
          (own && c.actor.role === "sales"))));
  if (enforce && !canEdit)
    throw new ApiError(
      "forbidden",
      403,
      waiting
        ? "Only the salesman who submitted this customer, a CDM or an admin can edit it."
        : "This customer is approved. Only admins can edit it.",
    );
  return canEdit;
}

/** Comparable sheet facts, not row IDs or derived bookkeeping. @param {any} c */
function facts(c) {
  /** @type {Record<string,any>} */ const out = {};
  for (const f of FIELDS) {
    if (f.shipTo) {
      for (const [i, s] of (c.shipTos ?? []).entries())
        out[`shipTos[${i}].${f.key}`] = s[f.key] ?? null;
    } else if (f.kind === "coordinates") {
      out.latitude = c.latitude ?? null;
      out.longitude = c.longitude ?? null;
    } else out[f.key] = c[f.key] ?? null;
  }
  for (const [i, s] of (c.shipTos ?? []).entries())
    out[`shipTos[${i}].sameAsCustomer`] = s.sameAsCustomer;
  for (const [k, v] of Object.entries(c.customFields ?? {}))
    out[`customFields.${k}`] = v;
  return out;
}
/** @param {any} before @param {any} after */
export function customerChanges(before, after) {
  const a = facts(before),
    b = facts(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(
      (key) =>
        JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null),
    )
    .map((field) => ({
      field,
      label:
        FIELDS.find((f) => f.key === field.split(".").pop())?.label ?? field,
      before: a[field] ?? null,
      after: b[field] ?? null,
    }));
}

/** Flattened native edits only accept known sheet keys; never permissions, code or status.
 * @param {any} existing @param {any} edits */
export function applyCustomerEdits(existing, edits) {
  if (!isPlainObject(edits) || Object.keys(edits).length > 200)
    throw new ApiError("invalid_request", 400, "Check the customer details.");
  /** @type {Record<string,any>} */ const input = {};
  for (const [key, raw] of Object.entries(edits)) {
    const ship = /^shipTos\[(\d+)\]\.(\w+)$/.exec(key);
    const custom = /^customFields\.(cf_[a-f0-9]{32})$/.exec(key);
    if (
      ship &&
      Number(ship[1]) < Math.max(1, existing.shipTos.length) &&
      FIELDS.some((f) => f.shipTo && f.key === ship[2])
    ) {
      input.shipTos ??= structuredClone(
        existing.shipTos.length ? existing.shipTos : [{ sameAsCustomer: true }],
      );
      input.shipTos[Number(ship[1])][ship[2]] = raw;
    } else if (custom) {
      input.customFields ??= { ...existing.customFields };
      input.customFields[custom[1]] = raw;
    } else if (
      ["latitude", "longitude"].includes(key) ||
      FIELDS.some(
        (f) =>
          !f.shipTo && !f.hidden && f.kind !== "coordinates" && f.key === key,
      )
    ) {
      input[key] =
        ["latitude", "longitude", "creditLimit"].includes(key) &&
        raw !== null &&
        raw !== ""
          ? Number(raw)
          : raw;
    } else
      throw new ApiError(
        "invalid_request",
        400,
        "Download the customer form again.",
      );
  }
  return input;
}

/** Missing fields and change history shown identically across apps. @param {any} c @param {string} id */
export async function customerView(c, id) {
  const canEdit = await customerEditAccess(c, id);
  const customer = await readCustomer(c.db, id);
  const enrollment = await readEnrollmentForm(c.db);
  const result = validateCustomer(customer, {
    level: "complete",
    requireNameParts: false,
    lists: await referenceRows(c.db),
    geography: await resolveGeography(c.db, customer),
  });
  const custom = validateEnrollment(
    enrollment.fields,
    customer.customFields,
    customer,
  );
  const rows =
    await c.db`select a.id,a.created_at,a.details,coalesce(p.name,'Former user') actor_name from audit_logs a left join lateral(select name from profiles where user_id::text=a.subject or auth_subject=a.subject order by id limit 1) p on true where a.entity_type='outlets' and a.entity_id=${id} and a.action='customer.update' order by a.created_at desc,a.id desc limit 51`;
  const labels = new Map(
    enrollment.fields.map((f) => [`customFields.${f.key}`, f.label]),
  );
  return {
    ...customer,
    canEdit,
    missingFields: [...result.errors, ...custom.errors],
    history: rows.slice(0, 50).map((/** @type {any} */ r) => ({
      id: r.id,
      at: new Date(r.created_at).getTime(),
      actor: r.actor_name,
      changes:
        (typeof r.details === "string"
          ? JSON.parse(r.details)
          : r.details
        )?.changes?.map((/** @type {any} */ v) => ({
          ...v,
          label: labels.get(v.field) ?? v.label,
          before:
            typeof v.before === "string" && v.before.startsWith("data:image/")
              ? "Photo"
              : v.before,
          after:
            typeof v.after === "string" && v.after.startsWith("data:image/")
              ? "Photo"
              : v.after,
        })) ?? [],
    })),
    historyTruncated: rows.length > 50,
  };
}

/** Stateless native form preview: changing a parent refreshes dependent dropdowns, never saves.
 * @param {any} c @param {string} id @param {any} [edits] */
export async function customerEditor(c, id, edits = {}) {
  const customer = await customerView(c, id);
  const input = applyCustomerEdits(customer, edits);
  /** @type {Record<string,any>} */ const v = { ...customer, ...input };
  const geo = await derive(c.db, v, input, customer);
  const refs = await referenceRows(c.db),
    index = referenceIndex(refs);
  const enrollment = await readEnrollmentForm(c.db);
  const errors = [
    ...validateCustomer(v, {
      level: "complete",
      requireNameParts: false,
      lists: refs,
      geography: geo,
    }).errors,
    ...validateEnrollment(enrollment.fields, v.customFields, v).errors,
  ];
  /** @type {Record<string,any[]>} */ const places = {
    regionCode: await c.db`select code,name from ph_regions order by name`,
    provinceCode: v.regionCode
      ? await c.db`select code,name from ph_provinces where region_code=${v.regionCode} order by name`
      : [],
    municipalityCode: v.provinceCode
      ? await c.db`select code,name from ph_municipalities where province_code=${v.provinceCode} order by name`
      : [],
    barangayCode: v.municipalityCode
      ? await c.db`select code,name from ph_barangays where municipality_code=${v.municipalityCode} order by name`
      : [],
    postalCode: geo.postalCodes.map((/** @type {string} */ code) => ({
      code,
      name: code,
    })),
  };
  /** @type {Record<string,string[]>} */ const dependents = {
    regionCode: [
      "provinceCode",
      "municipalityCode",
      "barangayCode",
      "postalCode",
    ],
    provinceCode: ["municipalityCode", "barangayCode", "postalCode"],
    municipalityCode: ["barangayCode", "postalCode"],
    salesOrgCode: [
      "salesOfficeCode",
      "distributionChannelCode",
      "customerGroup1Code",
      "customerGroup2Code",
      "deliveringPlantCode",
    ],
    distributionChannelCode: ["customerGroup1Code", "customerGroup2Code"],
    customerGroup1Code: ["customerGroup2Code"],
  };
  const adpKeys = FIELDS.filter((f) => f.adp).map((f) => f.key);
  dependents.salesOrgCode.push(...adpKeys);
  dependents.distributionChannelCode.push(...adpKeys);
  /** @type {any[]} */ const fields = [];
  /** @param {any} f @param {string} key @param {any} value @param {any[]} [options] */
  const add = (f, key, value, options = []) =>
    fields.push({
      key,
      label: f.label,
      section: f.section,
      kind: f.kind,
      value: value == null ? "" : String(value),
      options: options.map((r) => ({ code: r.code, name: optionLabel(r) })),
      clears: dependents[key] ?? [],
      error:
        errors.find(
          (e) =>
            e.field === key ||
            (["latitude", "longitude"].includes(key) &&
              e.field === "coordinates"),
        )?.message ?? null,
    });
  for (const f of FIELDS) {
    if (f.hidden || (f.adp && v.distributionChannelCode !== "40")) continue;
    if (f.shipTo) {
      for (const [i, s] of (v.shipTos.length
        ? v.shipTos
        : [{ sameAsCustomer: true }]
      ).entries()) {
        if (s.sameAsCustomer && f.key !== "contactPerson") continue;
        add(
          { ...f, label: `Ship-to ${i + 1}: ${f.label}` },
          `shipTos[${i}].${f.key}`,
          s[f.key],
        );
      }
    } else if (f.kind === "coordinates") {
      add({ ...f, label: "Latitude", kind: "number" }, "latitude", v.latitude);
      add(
        { ...f, label: "Longitude", kind: "number" },
        "longitude",
        v.longitude,
      );
    } else {
      const options = f.list
        ? index.options(f.list, {
            salesOrgCode: v.salesOrgCode,
            channelCode: v.distributionChannelCode,
            group1Code: v.customerGroup1Code,
          })
        : (places[f.key] ?? []);
      add(f, f.key, v[f.key], options);
    }
  }
  for (const f of enrollment.fields)
    add(
      {
        ...f,
        section: "Additional information",
        required: enrollmentRequired(f, v),
      },
      `customFields.${f.key}`,
      v.customFields?.[f.key],
      (f.kind === "boolean" ? ["true", "false"] : f.choices).map((code) => ({
        code,
        name: code === "true" ? "Yes" : code === "false" ? "No" : code,
      })),
    );
  return { customer, fields, missingFields: errors };
}
