import {
  requireCapability,
  requireNationalScope,
} from "../../core/capabilities.js";
import { invalid, conflict, forbidden } from "../../core/errors.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { writeAudit } from "../org/audit.js";
import { personAt } from "../org/scope.js";
import { resolvePrice } from "../orders/pricing.js";
import { callAvailability } from "../availability/sources.js";
import { requestRetailAction } from "./sap.js";
import { readEligibilityFacts } from "../integration/spec-adapters.js";
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
/** Match canonical visit reads: historical source person, stored scope and current outlet owner all gate evidence.
 * @param {any} c @param {any[]} rows */
export async function scopedVisits(c, rows) {
  const { accessVisit } = await import("../visits/shared.js");
  const result = [];
  for (const row of rows) {
    const [visit] =
      await c.db`select * from visit_executions where id=${row.visit_id}`;
    try {
      await accessVisit(c, visit);
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
  availability: async (/** @type {any} */ c, /** @type {any} */ visit) =>
    callAvailability(c.db, visit),
  // SEAM(SAP): expected price comes from the canonical effective replica resolver, never a supplied compliant flag.
  priceCompliance: async (
    /** @type {any} */ c,
    /** @type {any} */ visit,
    /** @type {any} */ appliedOutlet,
  ) => {
    const rows = bounded(
      await c.db`select a.*,p.uom,p.updated_at as product_updated_at from visit_activities a join products p on p.id::text=a.activity->>'productId' where a.visit_id=${visit.id} and a.activity_kind='price_check' and a.deleted_at is null order by a.device_time desc,a.id desc limit 501`,
    );
    const latest = new Map();
    for (const row of rows)
      if (!latest.has(row.activity.productId))
        latest.set(row.activity.productId, row);
    const { outlet } = await accessOutlet(c, visit.outlet_id, "visit.read");
    const [customer] = visit.customer_id
      ? await c.db`select code from customers where id=${visit.customer_id}`
      : [];
    const facts = [];
    for (const row of latest.values()) {
      // Without a frozen UOM on legacy price observations, a later master edit makes the comparison unknown.
      if (+new Date(row.product_updated_at) > +new Date(row.device_time))
        return null;
      const price = await resolvePrice(c.db, {
        organizationId: "sunpride",
        productId: row.activity.productId,
        uom: row.uom,
        channelKey: appliedOutlet ? appliedOutlet.channel : outlet.channel,
        customerCode: customer?.code ?? null,
        at: +new Date(row.device_time),
      });
      if (price.unitPriceCentavos === null || row.activity.currency !== "PHP")
        return null;
      facts.push({
        sourceId: row.id,
        priceListId: price.priceListId,
        source: price.source,
        uom: row.uom,
        expectedCentavos: price.unitPriceCentavos,
        observedCentavos: row.activity.observedPriceMinor,
        passed: price.unitPriceCentavos === row.activity.observedPriceMinor,
      });
    }
    return facts.length
      ? {
          score: (100 * facts.filter((f) => f.passed).length) / facts.length,
          facts,
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
    /** @type {Record<string,any>} */ const facts = {
      outletId: outlet.id,
      channelKey: outlet.channel,
      classKey: outlet.classification,
      territoryId: assignment?.territory_id,
      ...(await readEligibilityFacts(c, { outletId: outlet.id, at })),
    };
    // Missing geography/distributor facts are unknown, not a proof that no campaign applies.
    for (const campaign of rows)
      for (const [key, rule] of Object.entries(campaign.scope ?? {})) {
        if (
          facts[key] == null &&
          rule &&
          typeof rule === "object" &&
          Object.values(rule).some(
            (values) => Array.isArray(values) && values.length,
          )
        )
          return null;
      }
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
        if (values.length && facts[key] == null) return false;
        if (name === "exclude" && values.includes(facts[key])) return false;
        if (name === "include" && values.length && !values.includes(facts[key]))
          return false;
      }
    }
    return true;
  },
  requestSapAction: requestRetailAction,
};
/** F-313 F-321: assignment targets use current effective people scope, never a stale profile projection.
 * @param {any} c @param {string} id @param {boolean} [allowInactive] */
export async function officePerson(c, id, allowInactive = false) {
  const [stored] =
    await c.db`select * from profiles where id=${uuid(id)} and (${allowInactive} or status='active' and deleted_at is null)`;
  if (!stored) throw invalid("Choose an active custodian");
  const person = await personAt(c.db, stored, c.now);
  if (!person.org_unit_id) {
    if (allowInactive)
      await requireNationalScope(c, ["super_admin", "admin", "operations"]);
    else
      throw forbidden("Custodian has no current organization", "out_of_scope");
  } else await requireCapability(c, "outlet.manage", person.org_unit_id);
  return person;
}
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
