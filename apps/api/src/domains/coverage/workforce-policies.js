// F-209/F-222: one effective, editable form policy for non-call workforce capture.
import { tx } from "@sunpride/db/client";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { invalid, conflict } from "../../core/errors.js";
import { currentActor } from "../van/access.js";
import { employeeAt, localDate, manilaDate, DAY, uuid } from "./model.js";
import { required } from "../org/model.js";

/** @param {any} value */
export const workforceHash = (value) => sha256Hex(canonicalJson(value));
/** @param {any} v @param {number} min @param {number} max */
function integer(v, min, max) {
  if (!Number.isSafeInteger(v) || v < min || v > max)
    throw invalid("Form policy value is outside its supported range");
  return v;
}
/** @param {any} c */
export function formConfiguration(c) {
  if (
    !c ||
    !Array.isArray(c.fields) ||
    c.fields.length < 3 ||
    c.fields.length > 12
  )
    throw invalid("Configure three to twelve prospect fields");
  const seen = new Set();
  const fields = c.fields.map((/** @type {any} */ f) => {
    if (
      !f ||
      typeof f.key !== "string" ||
      !/^[a-z][A-Za-z0-9_]{0,31}$/.test(f.key) ||
      seen.has(f.key) ||
      !["text", "select"].includes(f.type) ||
      typeof f.required !== "boolean"
    )
      throw invalid("Invalid or duplicate KYC field");
    seen.add(f.key);
    const field = {
      key: f.key,
      label: required(f.label, "Field label", 100),
      type: f.type,
      required: f.required,
      maxLength: integer(f.maxLength, 1, 500),
      options: /** @type {string[]} */ ([]),
    };
    if (f.type === "select") {
      if (
        !Array.isArray(f.options) ||
        f.options.length < 1 ||
        f.options.length > 30 ||
        f.options.some(
          (/** @type {any} */ x) =>
            typeof x !== "string" || !x || x !== x.trim() || x.length > 100,
        ) ||
        new Set(f.options).size !== f.options.length
      )
        throw invalid("Select fields need distinct text choices");
      field.options = f.options;
    }
    return field;
  });
  for (const key of ["address", "channel", "contactName"])
    if (!fields.some((/** @type {any} */ f) => f.key === key && f.required))
      throw invalid(
        "Address, proposed channel and contact name must remain required for master-data review",
      );
  const dayStartMinutes = integer(c.dayStartMinutes, 0, 1439),
    dayEndMinutes = integer(c.dayEndMinutes, 1, 1440);
  if (dayStartMinutes >= dayEndMinutes)
    throw invalid("Field form day must end after it starts");
  return {
    fields,
    dayStartMinutes,
    dayEndMinutes,
    maxAccuracyMeters: integer(c.maxAccuracyMeters, 1, 5000),
    maxFixAgeSeconds: integer(c.maxFixAgeSeconds, 1, 900),
    maxShiftHours: integer(c.maxShiftHours, 1, 36),
    dedupeRadiusMeters: integer(c.dedupeRadiusMeters, 1, 500),
  };
}
/** Hash the immutable definition, not the prospective closure of its interval. @param {any} row */
export function formPolicyHash(row) {
  return workforceHash({
    orgUnitId: row.org_unit_id,
    version: row.version,
    label: row.label,
    sourceRef: row.source_ref,
    effectiveFrom: new Date(row.effective_from).toISOString(),
    configuration: row.configuration,
  });
}
/** @param {any} db @param {string} unit @param {number} at */
export async function formPolicyAt(db, unit, at) {
  const rows =
    await db`select * from workforce_form_policies where org_unit_id=${unit} and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)}) order by version limit 2`;
  if (rows.length > 1) throw conflict("Field form policy is ambiguous");
  const p = rows[0];
  if (p && formPolicyHash(p) !== p.content_hash)
    throw conflict("The published field form policy changed");
  return p ?? null;
}
/** @param {any} db @param {string} profileId @param {number} at */
export async function workforceContext(db, profileId, at) {
  const employee = await employeeAt(db, profileId, at),
    p = await formPolicyAt(db, employee.org_unit_id, at);
  if (!p) return null;
  const day = manilaDate(at),
    [session] =
      await db`select clock_in_request_id,clock_in_at,clock_out_at from attendance_sessions where profile_id=${profileId} and service_date=${day}::date`;
  return {
    policyId: p.id,
    version: p.version,
    label: p.label,
    sourceRef: p.source_ref,
    configuration: p.configuration,
    contentHash: p.content_hash,
    serviceDate: day,
    validFrom: Math.max(
      +new Date(p.created_at),
      localDate(day) + p.configuration.dayStartMinutes * 60000,
    ),
    expiresAt: Math.min(
      localDate(day) + p.configuration.dayEndMinutes * 60000,
      p.effective_to ? +new Date(p.effective_to) : Infinity,
    ),
    canProspect: roleHas(employee.role, "outlet.enrol.propose"),
    canClock: roleHas(employee.role, "workforce.record"),
    clockInRequestId: session?.clock_in_request_id ?? null,
    clockInAt: session ? +new Date(session.clock_in_at) : null,
    clockOutAt: session?.clock_out_at ? +new Date(session.clock_out_at) : null,
  };
}
/** @param {any} ctx @param {any} body */
export async function saveFormPolicy(ctx, body) {
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor),
      c = { ...ctx, db, actor };
    const unit = uuid(body.orgUnitId);
    await requireCapability(c, "workforce.configure", unit);
    const from = localDate(body.fromDate);
    if (from < localDate(manilaDate(ctx.now)))
      throw invalid("Form policies cannot be backdated");
    const configuration = formConfiguration(body.configuration),
      label = required(body.label, "Policy label", 160),
      sourceRef = required(body.sourceRef, "Source or assumption", 500);
    await db`select pg_advisory_xact_lock(hashtext(${`workforce-policy:${unit}`}))`;
    const rows =
      await db`select * from workforce_form_policies where org_unit_id=${unit} order by version desc for update`;
    if (rows.length > 1000)
      throw conflict(
        "Too many field form policy versions; archive with the office",
      );
    const same = rows.find(
      (/** @type {any} */ p) => +new Date(p.effective_from) === from,
    );
    if (same) {
      if (
        same.label !== label ||
        same.source_ref !== sourceRef ||
        workforceHash(same.configuration) !== workforceHash(configuration)
      )
        throw conflict(
          "An immutable policy already begins on that date; choose a later date",
        );
      return { id: same.id, version: same.version };
    }
    if (rows.some((/** @type {any} */ p) => +new Date(p.effective_from) > from))
      throw conflict("A future form policy already exists");
    if (rows.length && from <= ctx.now)
      throw invalid("A replacement must begin on a future Manila day");
    const version = (rows[0]?.version ?? 0) + 1,
      id = crypto.randomUUID(),
      row = {
        id,
        org_unit_id: unit,
        version,
        label,
        source_ref: sourceRef,
        configuration,
        effective_from: new Date(from),
      };
    if (rows[0])
      await db`update workforce_form_policies set effective_to=${new Date(from)},updated_at=now() where id=${rows[0].id}`;
    await db`insert into workforce_form_policies(id,org_unit_id,version,label,source_ref,configuration,content_hash,effective_from,created_by) values(${id},${unit},${version},${label},${sourceRef},${configuration},${formPolicyHash(row)},${new Date(from)},${actor.profileId})`;
    ctx.platform?.publish?.("coverage");
    return { id, version };
  });
}
/** @param {any} ctx */
export async function readFormPolicies(ctx) {
  await requireCapability(ctx, "workforce.read");
  const all =
    await ctx.db`select p.*,u.name as unit_name,a.name as author from workforce_form_policies p join org_units u on u.id=p.org_unit_id join profiles a on a.id=p.created_by order by u.name,p.version desc limit 1001`;
  if (all.length > 1000)
    throw conflict("Field form policy list exceeds the supported bound");
  const policies = [];
  for (const p of all) {
    try {
      await requireCapability(ctx, "workforce.read", p.org_unit_id);
      policies.push({
        id: p.id,
        orgUnitId: p.org_unit_id,
        unitName: p.unit_name,
        version: p.version,
        label: p.label,
        sourceRef: p.source_ref,
        configuration: p.configuration,
        from: +new Date(p.effective_from),
        to: p.effective_to ? +new Date(p.effective_to) : null,
        author: p.author,
      });
    } catch (e) {
      if (!(e && typeof e === "object" && "status" in e && e.status === 403))
        throw e;
    }
  }
  const units =
    await ctx.db`select id,name from org_units where deleted_at is null and status='active' order by name limit 1001`;
  if (units.length > 1000) throw conflict("Too many organizational units");
  const visible = [];
  for (const u of units) {
    try {
      await requireCapability(ctx, "workforce.configure", u.id);
      visible.push(u);
    } catch (e) {
      if (!(e && typeof e === "object" && "status" in e && e.status === 403))
        throw e;
    }
  }
  return {
    policies,
    units: visible,
    canConfigure: roleHas(ctx.actor.role, "workforce.configure"),
  };
}
