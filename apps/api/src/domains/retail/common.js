import { requireCapability } from "../../core/capabilities.js";
import { invalid, conflict, forbidden } from "../../core/errors.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { writeAudit } from "../org/audit.js";
import { accessOutlet, uuid, text, date } from "../visits/shared.js";
export { uuid, text, date, accessOutlet };
/** @param {any} value @param {number} [max] @param {number} [min] */
export function integer(value, max = 1_000_000_000, min = 0) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw invalid("Enter a whole number in range");
  return value;
}
/** @param {any} value @param {string[]} allowed */
export function choice(value, allowed) {
  if (!allowed.includes(value)) throw invalid("Choose a supported value");
  return value;
}
/** @param {any} rows @param {number} [max] */
export function bounded(rows, max = 500) {
  if (rows.length > max)
    throw invalid("Too many results; narrow the selection");
  return rows;
}
/** @param {any} c @param {string} action @param {string} id */
export async function changed(c, action, id) {
  await writeAudit(c.db, {
    subject: c.actor.subject,
    action: `retail.${action}`,
    entityType: "retail",
    entityId: id,
    details: null,
  });
  await c.change("retail", id, c.actor.orgUnitId ?? "national");
  c.publish("retail");
}
/** Serialize business-key retries even when the HTTP operation ID changes. Authorization precedes replay.
 * @param {any} c @param {string} action @param {any} body @param {()=>Promise<any>} handler */
export async function once(c, action, body, handler) {
  const key = uuid(body.requestKey),
    hash = sha256Hex(canonicalJson({ action, body }));
  await c.db`select pg_advisory_xact_lock(hashtextextended(${c.actor.subject + key},0))`;
  const [old] =
    await c.db`select * from retail_commands where actor_subject=${c.actor.subject} and request_key=${key}`;
  if (old) {
    if (old.payload_hash !== hash)
      throw conflict("This request was already used with different details");
    return old.response;
  }
  const response = await handler();
  await c.db`insert into retail_commands(actor_subject,request_key,payload_hash,response) values(${c.actor.subject},${key},${hash},${response})`;
  return response;
}
/** @param {any} c @param {any} visit @param {any} ids @param {boolean} [required] */
export async function photos(c, visit, ids, required = false) {
  if (
    !Array.isArray(ids) ||
    ids.length > 20 ||
    (required && !ids.length) ||
    new Set(ids).size !== ids.length
  )
    throw invalid("Attach the captured photos");
  for (const id of ids) {
    const [photo] =
      await c.db`select e.* from field_evidence_files e join files f on f.id=e.storage_id
      where e.id=${uuid(id)} and e.visit_id=${visit.id} and e.outlet_id=${visit.outlet_id} and e.owner_profile_id=${c.actor.profileId}
      and e.deleted_at is null and e.status<>'rejected' and f.status='stored' and f.stored_at is not null and f.sha256=e.checksum`;
    if (!photo)
      throw invalid("Photo is not uploaded or belongs to another call");
    await seams.validatePhoto(c, photo);
  }
  return ids;
}
/** @param {any} c @param {string} id */
export async function readAccess(c, id) {
  return accessOutlet(c, id, "visit.read");
}
/** Scope filters may skip only explicit authorization refusals; broken reads must surface.
 * @param {any} c @param {any[]} rows @param {(r:any)=>string} outlet */
export async function scoped(c, rows, outlet) {
  const result = [];
  for (const row of rows) {
    try {
      await readAccess(c, outlet(row));
      result.push(row);
    } catch (e) {
      if (!(e && typeof e === "object" && "status" in e && e.status === 403))
        throw e;
    }
  }
  return result;
}
/** SEAM(INTEGRITY): actual watermark validation belongs to INTEGRITY. Never claim these bytes are watermarked without it.
 * SEAM(AVAILABILITY): use the canonical availability observations, never another MSL/OSA authority.
 * SEAM(TPM): campaign version identity and eligibility are supplied by TPM, no duplicate master.
 * SEAM(SAP): operational requests wait for an acknowledged stock/markdown effect.
 */
export const seams = {
  validatePhoto: async (/** @type {any} */ _c, /** @type {any} */ _photo) => {},
  availability: async (/** @type {any} */ c, /** @type {any} */ visit) => {
    const [a] =
      await c.db`select a.*, (select count(*)::int from merchandising_audit_missing_products m where m.merchandising_audit_id=a.id) as missing from merchandising_audits a where a.visit_id=${visit.id}`;
    return a && a.required_count > 0 && a.missing === 0
      ? {
          score: (100 * a.required_available_count) / a.required_count,
          sourceId: a.id,
        }
      : null;
  },
  campaigns: async (
    /** @type {any} */ c,
    /** @type {any} */ outlet,
    /** @type {number} */ at,
  ) => {
    const [exists] =
      await c.db`select to_regclass('public.campaign_versions') as relation`;
    if (!exists.relation) return null;
    // Read the exact TPM thin-master schema from v2/spec-tpm. Unsupported restricted facts deny eligibility.
    const rows = bounded(
      await c.db`select v.*,m.code from campaign_versions v join campaigns m on m.id=v.campaign_id where m.organization_id='sunpride' and v.status='active' and v.effective_from<=${new Date(at)} and v.effective_to>${new Date(at)} limit 501`,
    );
    const [assignment] =
      await c.db`select territory_id from outlet_assignments where outlet_id=${outlet.id} and deleted_at is null and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`;
    const facts = {
      outletId: outlet.id,
      channelKey: outlet.channel,
      classKey: outlet.classification,
      territoryId: assignment?.territory_id,
    };
    return rows.filter((/** @type {any} */ r) =>
      seams.campaignEligible(r.scope, facts),
    );
  },
  campaignEligible: (/** @type {any} */ scope, /** @type {any} */ facts) => {
    const dimensions = [
      "outletId",
      "classKey",
      "channelKey",
      "territoryId",
      "geographyKey",
      "distributorId",
    ];
    for (const [key, rule] of Object.entries(scope ?? {})) {
      if (
        !dimensions.includes(key) ||
        !rule ||
        typeof rule !== "object" ||
        Array.isArray(rule)
      )
        return false;
      for (const [name, values] of Object.entries(rule)) {
        if (!["include", "exclude"].includes(name) || !Array.isArray(values))
          return false;
        if (name === "exclude" && values.includes(facts[key])) return false;
        if (name === "include" && values.length && !values.includes(facts[key]))
          return false;
      }
    }
    return true;
  },
  requestSapAction: async (
    /** @type {any} */ _c,
    /** @type {any} */ _input,
  ) => ({ status: "awaiting_seam" }),
};
/** @param {any} c @param {string} capability */
export async function office(c, capability = "masterdata.manage") {
  await requireCapability(c, capability);
}
export {
  invalid,
  conflict,
  forbidden,
  canonicalJson,
  sha256Hex,
  requireCapability,
};
