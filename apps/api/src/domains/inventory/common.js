import { ApiError } from "../../core/errors.js";
import {
  requireCapability,
  CROSS_SCOPE_ROLES,
} from "../../core/capabilities.js";
import { hooks } from "../../core/hooks.js";
import { isUuid } from "../../core/util.js";
import { writeAudit } from "../org/audit.js";

export const ORGANIZATION = "sunpride";
export const STATUSES = [
  "available",
  "quality_hold",
  "quarantine",
  "damaged",
  "expired",
  "rejected",
  "wip",
  "in_transit",
];
export const STATUS_FIELDS = /** @type {Record<string,string>} */ ({
  available: "available_stock_base",
  quality_hold: "quality_hold_base",
  quarantine: "quarantine_base",
  damaged: "damaged_base",
  expired: "expired_base",
  rejected: "rejected_base",
  wip: "wip_base",
  in_transit: "in_transit_base",
});
/** @param {string} message @param {string} [code] @returns {never} */
export function invalid(message, code = "invalid_request") {
  throw new ApiError(code, 422, message);
}
/** @param {any} value @param {string} [name] */
export function id(value, name = "Identifier") {
  if (!isUuid(value)) invalid(`${name} must be a UUID`);
  return /** @type {string} */ (value);
}
/** @param {any} value @param {string} [name] @param {number} [min] */
export function integer(value, name = "Quantity", min = 0) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    invalid(`${name} must be a safe integer of at least ${min}`);
  return /** @type {number} */ (value);
}
/** @param {any} v @param {string} [name] @param {number} [max] */
export function text(v, name = "Value", max = 500) {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    invalid(`${name} is required (up to ${max} characters)`);
  return /** @type {string} */ (v.trim());
}
/** @param {any} v @param {string[]} allowed @param {string} [fallback] */
export function choice(v, allowed, fallback) {
  const value = v ?? fallback;
  if (!allowed.includes(value)) invalid("Choose a supported value");
  return /** @type {string} */ (value);
}
/** @param {any} v @returns {any[]} */
export function lines(v) {
  if (!Array.isArray(v) || !v.length || v.length > 100)
    invalid("Supply 1–100 lines");
  return v;
}
/** @param {number} [at] */
export const manilaDate = (at = Date.now()) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 10);
/** @param {any} t @param {string} org */
export const stockLock = async (t, org) => {
  await t`select pg_advisory_xact_lock(hashtext(${`inventory:${org}`}))`;
  // IP-INT2FIX: remember that THIS transaction excludes every posting of the org, so postings inside it need no row locks.
  try {
    t.__orgExclusive = org;
  } catch {
    /* a frozen handle just keeps taking row locks */
  }
};
/**
 * Posting locks (IP-VALUE). A posting takes (1) the org lock in SHARED mode, so whole-org
 * holders (`stockLock`, exclusive: commands, recalls, expiry) still exclude every posting, and
 * (2) one exclusive advisory lock per (product, location) it touches plus one for its
 * idempotency key. The per-row locks are taken in ONE statement over the sorted, de-duplicated
 * 64-bit lock keys, so two postings that touch the same pair of rows in opposite order cannot
 * deadlock, and two postings on different products never wait on each other.
 * Lock order everywhere: org(shared|exclusive) -> sorted row locks -> row locks -> change-log lock.
 * @param {any} t @param {string} org @param {string} idempotencyKey @param {any[]} movementLines
 */
export async function postingLocks(t, org, idempotencyKey, movementLines) {
  // The org lock is held exclusively by this very transaction (a command run through execute(), e.g. a 5,000 line count
  // approval): no other posting can run at all, so per-(product, location) locks would only pile up, one per row until
  // commit, and could exhaust the server's lock table. Nothing else is needed for safety.
  if (t.__orgExclusive === org) return [];
  const names = new Set([`idem:${org}:${idempotencyKey}`]);
  for (const l of movementLines)
    for (const loc of [l?.fromLocationId, l?.toLocationId])
      if (loc) names.add(`stock:${org}:${l.productId}:${loc}`);
  await t`select pg_advisory_xact_lock_shared(hashtext(${`inventory:${org}`}))`;
  await t`select pg_advisory_xact_lock(s.k) from (select distinct hashtextextended(n,0) as k from jsonb_array_elements_text(${JSON.stringify([...names])}::text::jsonb) as n order by 1 offset 0) s`;
  return [...names];
}
/** Read a consistent snapshot WITHOUT blocking postings: repeatable read, read only.
 * Falls back to the caller's transaction when one is already open.
 * @template T @param {any} db @param {(t:any)=>Promise<T>} fn @returns {Promise<T>} */
export async function snapshot(db, fn) {
  if (db.__inTx || typeof db.begin !== "function") return fn(db);
  return db.begin("isolation level repeatable read read only", fn);
}
/** Products and their policies for a whole movement in two queries. `get` throws exactly what
 * productPolicy throws; `peek` never throws.
 * @param {any} t @param {any[]} productIds @param {string} [org] */
export async function productCatalog(t, productIds, org = ORGANIZATION) {
  const wanted = [...new Set(productIds.filter((v) => isUuid(v)))];
  /** @type {Map<string,any>} */ const products = new Map(),
    policies = new Map();
  if (wanted.length) {
    for (const r of await t`select * from products where id in ${t(wanted)} and organization_id=${org} and active and deleted_at is null`)
      products.set(r.id, r);
    for (const r of await t`select * from product_inventory_policies where organization_id=${org} and product_id in ${t(wanted)} and active and deleted_at is null`)
      if (!policies.has(r.product_id)) policies.set(r.product_id, r);
  }
  return {
    /** @param {any} productId */
    peek: (productId) => products.get(productId) ?? null,
    /** @param {any} productId */
    get(productId) {
      id(productId, "Product");
      const product = products.get(productId);
      if (!product)
        throw new ApiError("not_found", 404, "Active product not found");
      const policy = policies.get(productId);
      const scale = Number(policy?.quantity_scale ?? product.quantity_scale ?? 1);
      if (!Number.isSafeInteger(scale) || scale <= 0)
        invalid("The product quantity scale needs correction", "invalid_uom");
      return {
        product,
        policy,
        tracking: policy?.tracking_mode ?? product.tracking_mode ?? "none",
        scale,
      };
    },
  };
}
/** @param {any} ctx @param {string} capability @param {string} locationId @param {string} [org] */
export async function locationGate(
  ctx,
  capability,
  locationId,
  org = ORGANIZATION,
) {
  id(locationId, "Location");
  const [row] =
    await ctx.db`select * from inventory_locations where id=${locationId} and organization_id=${org} and deleted_at is null`;
  if (!row) throw new ApiError("not_found", 404, "Stock location not found");
  const actor = await requireCapability(ctx, capability);
  if (!row.org_unit_id && !CROSS_SCOPE_ROLES.includes(actor.role))
    throw new ApiError(
      "unmapped_location",
      403,
      "This location needs an organizational unit",
    );
  if (row.org_unit_id)
    await requireCapability(ctx, capability, row.org_unit_id);
  return row;
}
/** Stock facts are embargoed for the assigned blind counter until submission review
 * finishes. Count entry/list routes remain available; a separate inventory screen must
 * not turn the blind form into a cosmetic privacy control.
 * @param {any} ctx @param {string[]} locationIds
 */
export async function blindStockGate(ctx, locationIds) {
  if (!ctx.actor || !locationIds.length) return;
  const rows =
    await ctx.db`select id from stock_count_sessions where organization_id=${ORGANIZATION} and blind_count and status in ('counting','submitted') and location_id in ${ctx.db(locationIds)} and (created_by=${ctx.actor.userId} or exists (select 1 from stock_count_lines l where l.session_id=stock_count_sessions.id and l.counted_by=${ctx.actor.userId})) limit 1`;
  if (rows.length)
    throw new ApiError(
      "blind_count_active",
      403,
      "Stock quantities are hidden while your blind count is awaiting completion. Open Stock counts to continue.",
    );
}

/** @param {any} ctx @param {string} [org] @returns {Promise<any[]>} */
export async function visibleLocations(ctx, org = ORGANIZATION) {
  const actor = await requireCapability(ctx, "inventory.read");
  const all =
    await ctx.db`select * from inventory_locations where organization_id=${org} and deleted_at is null order by code`;
  if (CROSS_SCOPE_ROLES.includes(actor.role)) return all;
  const units = new Set(await hooks.scopeUnitIds(ctx.db, actor));
  return all.filter(
    (/** @type {any} */ r) => r.org_unit_id && units.has(r.org_unit_id),
  );
}
/** @param {any} t @param {string} productId @param {string} [org] */
export async function productPolicy(t, productId, org = ORGANIZATION) {
  id(productId, "Product");
  const [product] =
    await t`select * from products where id=${productId} and organization_id=${org} and active and deleted_at is null`;
  if (!product)
    throw new ApiError("not_found", 404, "Active product not found");
  const [policy] =
    await t`select * from product_inventory_policies where organization_id=${org} and product_id=${productId} and active and deleted_at is null`;
  const scale = Number(policy?.quantity_scale ?? product.quantity_scale ?? 1);
  if (!Number.isSafeInteger(scale) || scale <= 0)
    invalid("The product quantity scale needs correction", "invalid_uom");
  return {
    product,
    policy,
    tracking: policy?.tracking_mode ?? product.tracking_mode ?? "none",
    scale,
  };
}
/** @param {any} t @param {any} actor @param {string} action @param {string} entityId @param {any} [details] */
export async function audit(t, actor, action, entityId, details = null) {
  await writeAudit(t, {
    actor,
    subject: actor?.userId ?? "system:expiry",
    action: `inventory.${action}`,
    entityType: "inventory",
    entityId,
    details: details == null ? undefined : JSON.stringify(details),
  });
}
/** @param {any} actor @param {string|null} author */
export function notSelf(actor, author) {
  if (actor.userId === author || actor.profileId === author)
    throw new ApiError(
      "self_approval",
      403,
      "A different person must approve this work",
    );
}
/** @param {any} t @param {any} row @param {string} capability @param {any} actor */
export async function gateTransfer(t, row, capability, actor) {
  for (const key of [
    "source_location_id",
    "destination_location_id",
    "in_transit_location_id",
  ])
    await locationGate(
      { db: t, actor },
      capability,
      row[key],
      row.organization_id,
    );
}
/** @param {any} t @param {string} table @param {string} rowId */
export async function document(t, table, rowId) {
  id(rowId); // table is a code-owned literal, never request input.
  const [row] = await t.unsafe(
    `select * from ${table} where id=$1 and organization_id=$2 for update`,
    [rowId, ORGANIZATION],
  );
  if (!row) throw new ApiError("not_found", 404, "Stock document not found");
  return row;
}
/** @param {any} row @param {string[]} statuses */
export function state(row, statuses) {
  if (!statuses.includes(row.status))
    throw new ApiError(
      "invalid_state",
      409,
      "This document is not ready for that action",
    );
}
/** Safe numeric DB integer at the JSON boundary. @param {any} value */
export function number(value) {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n))
    invalid("Quantity exceeds the supported range", "quantity_overflow");
  return n;
}
