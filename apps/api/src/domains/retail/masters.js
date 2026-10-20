import { requireNationalScope } from "../../core/capabilities.js";
import { product } from "../visits/shared.js";
import {
  accessOutlet,
  changed,
  choice,
  integer,
  invalid,
  office,
  text,
  uuid,
  bounded,
} from "./common.js";
export const COMPONENTS = [
  "availability",
  "planogram",
  "posm",
  "price",
  "freezer",
  "promotion",
];
export const MASTER_KINDS = [
  "planogram",
  "posm",
  "equipment",
  "cold_policy",
  "scorecard",
  "expiry_policy",
  "incident_category",
];
/** F-311 F-314 F-315 F-316 F-320: validate actual domain policy, not arbitrary executable JSON.
 * @param {any} c @param {string} kind @param {any} d */
export async function validateMaster(c, kind, d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) throw invalid();
  if (kind === "planogram") {
    if (
      !Array.isArray(d.lines) ||
      !d.lines.length ||
      d.lines.length > 200 ||
      new Set(d.lines.map((/** @type {any} */ l) => l.productId)).size !==
        d.lines.length
    )
      throw invalid("Define distinct product targets");
    for (const l of d.lines) {
      await product(c.db, l.productId);
      integer(l.facings, 10000, 1);
      text(l.position, 100);
    }
    integer(d.targetSharePercent, 100);
  } else if (kind === "equipment") {
    for (const k of [
      "serial",
      "model",
      "sapFixedAssetId",
      "custodian",
      "agreement",
      "location",
    ])
      text(d[k], 200);
    choice(d.type, ["freezer", "chiller"]);
    uuid(d.outletId);
    await accessOutlet(c, d.outletId, "outlet.manage");
    if (!Number.isSafeInteger(d.deployedAt) || d.deployedAt > c.now)
      throw invalid("Check the deployment date");
    const policy = await masterById(
      c.db,
      uuid(d.policyVersionId),
      "cold_policy",
    );
    if (!policy || policy.data.type !== d.type)
      throw invalid("Choose the equipment temperature policy");
  } else if (kind === "cold_policy") {
    choice(d.type, ["freezer", "chiller"]);
    integer(d.minTemperatureDeciC, 600, -600);
    integer(d.maxTemperatureDeciC, 600, -600);
    if (d.minTemperatureDeciC > d.maxTemperatureDeciC) throw invalid();
    integer(d.minOwnSharePercent, 100);
    integer(d.followupHours, 720, 1);
  } else if (kind === "scorecard") {
    if (
      !Array.isArray(d.components) ||
      d.components.length !== COMPONENTS.length ||
      new Set(d.components.map((/** @type {any} */ l) => l.key)).size !==
        COMPONENTS.length
    )
      throw invalid("Include all six components");
    let total = 0;
    for (const l of d.components) {
      choice(l.key, COMPONENTS);
      total += integer(l.weight, 100, 1);
      if (typeof l.allowNotApplicable !== "boolean") throw invalid();
    }
    if (total !== 100) throw invalid("Weights must total 100");
    integer(d.targetPercent, 100, 1);
  } else if (kind === "expiry_policy") {
    await product(c.db, d.productId);
    integer(d.nearExpiryDays, 3650, 1);
    choice(d.action, ["pullout", "markdown"]);
  } else if (kind === "posm") {
    text(d.material, 200);
    integer(d.auditEveryDays, 365, 1);
  } else if (kind === "incident_category") {
    integer(d.slaHours, 720, 1);
    choice(d.severity, ["low", "medium", "high", "critical"]);
  }
  return d;
}
/** @param {any} db @param {string} id @param {string} kind */
export async function masterById(db, id, kind) {
  const [r] =
    await db`select * from retail_master_versions where id=${id} and kind=${kind} and organization_id='sunpride'`;
  return r ?? null;
}
/** @param {any} db @param {string} kind @param {number} at */
export async function currentMasters(db, kind, at) {
  return bounded(
    await db`select * from retail_master_versions where organization_id='sunpride' and kind=${kind} and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)}) order by code limit 501`,
  );
}
/** F-311: resolve most specific outlet class; ambiguity refuses rather than using an arbitrary layout.
 * @param {any} db @param {string} kind @param {any} outlet @param {number} at */
export async function policyAt(db, kind, outlet, at) {
  const rows = await currentMasters(db, kind, at),
    exact = rows.filter(
      (/** @type {any} */ r) => r.outlet_class === outlet.classification,
    ),
    matching = exact.length
      ? exact
      : rows.filter((/** @type {any} */ r) => r.outlet_class === "*");
  if (matching.length > 1)
    throw invalid(
      "Overlapping retail policies; ask the office to correct setup",
    );
  return matching[0] ?? null;
}
/** @param {any} c */
export async function saveMaster(c) {
  await office(c);
  await requireNationalScope(c, ["super_admin", "admin", "operations"]);
  const b = c.body,
    kind = choice(b.kind, MASTER_KINDS),
    code = text(b.code, 80),
    label = text(b.label, 160),
    klass = text(b.outletClass ?? "*", 80);
  const from = integer(b.effectiveFrom, Number.MAX_SAFE_INTEGER, 1);
  if (from < c.now) throw invalid("Publish prospectively");
  const data = await validateMaster(c, kind, b.data);
  await c.db`select pg_advisory_xact_lock(hashtextextended(${`retail:${kind}:${code}`},0))`;
  const [last] =
    await c.db`select * from retail_master_versions where kind=${kind} and code=${code} order by version desc limit 1`;
  if (last && from <= +new Date(last.effective_from))
    throw invalid("A later version is already scheduled");
  if (kind === "equipment") {
    const others = await currentMasters(c.db, "equipment", from);
    if (
      others.some(
        (/** @type {any} */ r) =>
          r.code !== code &&
          (r.data.serial === data.serial ||
            r.data.sapFixedAssetId === data.sapFixedAssetId),
      )
    )
      throw invalid("Serial or SAP fixed asset already registered");
  }
  if (last)
    await c.db`update retail_master_versions set effective_to=${new Date(from)} where id=${last.id}`;
  const [row] =
    await c.db`insert into retail_master_versions(kind,code,version,label,outlet_class,effective_from,data,source,actor_subject) values(${kind},${code},${(last?.version ?? 0) + 1},${label},${klass},${new Date(from)},${data},'office',${c.actor.subject}) returning *`;
  await changed(c, "master.published", row.id);
  return row;
}
/** F-314: service and reconciliation are append-only references, never a valuation ledger.
 * @param {any} c */
export async function service(c) {
  const b = c.body,
    m = await masterById(c.db, uuid(b.equipmentVersionId), "equipment");
  if (!m) throw invalid();
  await accessOutlet(c, m.data.outletId, "outlet.manage");
  const [r] =
    await c.db`insert into equipment_service_events(equipment_version_id,kind,reference,note,actor_subject,occurred_at) values(${m.id},${choice(b.kind, ["service", "repair", "reconcile"])},${text(b.reference)},${text(b.note, 1000)},${c.actor.subject},${new Date(c.now)}) returning id`;
  await changed(c, "equipment.service", r.id);
  return { id: r.id };
}
