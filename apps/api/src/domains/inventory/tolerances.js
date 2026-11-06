import { requireCapability } from "../../core/capabilities.js";
import { writeAudit } from "../org/audit.js";
import { ORGANIZATION, choice, invalid } from "./common.js";

/** SPEC 3.5 events that have a numeric tolerance. */
export const TOLERANCE_EVENTS = Object.freeze([
  "load_out_difference",
  "transfer_receive_variance",
  "load_in_difference",
  "count_variance",
  "truck_damage",
  "cash_variance",
]);

/** @typedef {{maxCentavos:number|null,maxQtyBase:number|null,maxCases:number|null,isDefault:boolean}} Tolerance */

/** @param {any} r @returns {Tolerance} */
const present = (r) => ({
  maxCentavos: r.max_centavos == null ? null : Number(r.max_centavos),
  maxQtyBase: r.max_qty_base == null ? null : Number(r.max_qty_base),
  maxCases: r.max_cases == null ? null : Number(r.max_cases),
  isDefault: r.is_default,
});

/**
 * The tolerance in force for an event at an instant: the latest row whose effective_from is not later than `at`.
 * @param {any} db @param {string} org @param {string} event @param {number|Date} [at]
 * @returns {Promise<Tolerance>}
 */
export async function toleranceFor(db, org, event, at = Date.now()) {
  if (!TOLERANCE_EVENTS.includes(event))
    throw new Error(`Unknown tolerance event: ${event}`);
  const when = new Date(at instanceof Date ? at.getTime() : at);
  const [row] =
    await db`select * from approval_tolerances where organization_id=${org} and event=${event} and effective_from<=${when} order by effective_from desc limit 1`;
  if (!row) throw new Error(`No tolerance set for ${event}`);
  return present(row);
}

/**
 * True when every measure given is inside the limit that is set. Compares sizes, so a short (-3) and an over (+3)
 * count the same. A null limit, or a measure not given, is not checked.
 * @param {Tolerance} tol
 * @param {{centavos?:number|null, qtyBase?:number|null, cases?:number|null}} measured
 */
export function withinTolerance(tol, { centavos, qtyBase, cases } = {}) {
  /** @param {number|null|undefined} limit @param {number|null|undefined} v */
  const ok = (limit, v) =>
    limit == null || v == null || Math.abs(Number(v)) <= limit;
  return (
    ok(tol.maxCentavos, centavos) &&
    ok(tol.maxQtyBase, qtyBase) &&
    ok(tol.maxCases, cases)
  );
}

/** @param {any} ctx */
async function listRoute(ctx) {
  await requireCapability(ctx, "inventory.read");
  const out = [];
  for (const event of TOLERANCE_EVENTS) {
    const [row] =
      await ctx.db`select * from approval_tolerances where organization_id=${ORGANIZATION} and event=${event} and effective_from<=${new Date(ctx.now)} order by effective_from desc limit 1`;
    if (row)
      out.push({
        event,
        ...present(row),
        effectiveFrom: new Date(row.effective_from).getTime(),
        updatedBy: row.updated_by,
      });
  }
  return out;
}

/** @param {any} v @param {string} name */
function limit(v, name) {
  if (v == null) return null;
  if (!Number.isSafeInteger(v) || v < 0)
    return invalid(`${name} must be zero or more.`);
  return v;
}

/** Save a new tolerance for an event, effective now (or a later date). Admin only. History is kept.
 * @param {any} ctx */
async function saveRoute(ctx) {
  const actor = await requireCapability(ctx, "admin.manage");
  const b = ctx.body;
  if (!b || typeof b !== "object" || Array.isArray(b))
    return invalid("Supply a tolerance object");
  const event = choice(b.event, [...TOLERANCE_EVENTS]);
  const maxCentavos = limit(b.maxCentavos, "Peso limit"),
    maxQtyBase = limit(b.maxQtyBase, "Piece limit"),
    maxCases = limit(b.maxCases, "Case limit");
  if (maxCentavos === null && maxQtyBase === null && maxCases === null)
    return invalid("Set at least one limit.");
  let from = ctx.now;
  if (b.effectiveFrom != null) {
    if (!Number.isFinite(b.effectiveFrom) || b.effectiveFrom < ctx.now - 60000)
      return invalid("A new limit starts now or later.");
    from = b.effectiveFrom;
  }
  const [r] =
    await ctx.db`insert into approval_tolerances (organization_id,event,effective_from,max_centavos,max_qty_base,max_cases,is_default,updated_by) values (${ORGANIZATION},${event},${new Date(from)},${maxCentavos},${maxQtyBase},${maxCases},false,${actor.userId}) on conflict (organization_id,event,effective_from) do update set max_centavos=excluded.max_centavos,max_qty_base=excluded.max_qty_base,max_cases=excluded.max_cases,is_default=false,updated_by=excluded.updated_by,updated_at=now() returning *`;
  await writeAudit(ctx.db, {
    actor,
    action: "inventory.tolerance.save",
    entityType: "approval_tolerances",
    entityId: event,
    details: { event, maxCentavos, maxQtyBase, maxCases, effectiveFrom: from },
  });
  return {
    event,
    ...present(r),
    effectiveFrom: new Date(r.effective_from).getTime(),
    updatedBy: r.updated_by,
  };
}

/** @param {import('../../core/router.js').Router} router */
export function installToleranceRoutes(router) {
  router.get("/api/v1/inventory/tolerances", listRoute);
  router.post("/api/v1/inventory/tolerances", saveRoute);
}
