import { actorFor } from "../../core/context.js";
import { ApiError } from "../../core/errors.js";
import { currentActor } from "../van/access.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import {
  requestOverride,
  decideOverride,
  authorityRule,
} from "../fiscal/authority.js";
import { enforceFinancialOverride } from "../fiscal/discounts.js";
import {
  productPolicy,
  locationGate,
  STATUS_FIELDS,
  invalid,
} from "./common.js";
/** WEB-081: a branch with no stock band for the requester's role gets a setup path, not a generic policy error.
 * Ambiguous bands still fall through to the matrix's own refusal. @param {any} db @param {string} orgUnitId @param {string} role */
async function requireStockBand(db, orgUnitId, role) {
  const [band] =
    await db`select 1 from fiscal_authority_rules where org_unit_id=${orgUnitId} and kind='stock' and role=${role} and effective_from<=now() and (effective_to is null or effective_to>now()) limit 1`;
  if (band) return;
  const [unit] = await db`select name from org_units where id=${orgUnitId}`;
  throw new ApiError(
    "authority_missing",
    409,
    `No stock approval limit is set for ${unit?.name ?? "this branch"}. An administrator adds one in Admin → Fiscal & authority → Price and discount authority (Override: Stock).`,
  );
}
/** F-124: the existing independent stock approval is also the one fiscal matrix decision.
 * Values/roles/locations are re-derived, never accepted from an authority form.
 * @param {any} c @param {any} document @param {any[]} rows @param {string} [creatorCapability] @param {{tillCount?:boolean}} [options] */
/** Capability that posts a counted difference: the till path uses the approver's own band.
 * @param {string} counterRole */
export function postingCapability(counterRole, creatorCapability = "inventory.count.submit") {
  return roleHas(counterRole, creatorCapability)
    ? "inventory.approve"
    : "inventory.adjustment.approve";
}
export async function enforceInventoryAuthority(
  c,
  document,
  rows,
  creatorCapability = "inventory.adjustment.request",
  { tillCount = false } = {},
) {
  if (!rows.length) return;
  const userId = document.requested_by ?? document.created_by;
  const counter = await currentActor(c.db, await actorFor(c.db, userId));
  if (counter.profileId === c.actor.profileId)
    invalid("Another person must approve stock changes");
  // IP-INT2: a store cashier (or any role that may not request stock changes) can still count at the till. Their count
  // is approved on the approver's own authority: the approver needs the adjustment capability and a stock band that
  // covers the value; otherwise the count could never be approved.
  const onApprover = tillCount && !roleHas(counter.role, creatorCapability);
  const requester = onApprover ? await currentActor(c.db, c.actor) : counter;
  if (onApprover) creatorCapability = "inventory.adjustment.approve";
  /** @type {Map<string,any[]>} */ const groups = new Map();
  for (const l of rows) {
    const locationId = l.location_id ?? document.location_id;
    const loc = await locationGate(
      { ...c, actor: requester },
      creatorCapability,
      locationId,
    );
    if (!loc.org_unit_id)
      invalid("Map the stock location to its branch before approval");
    const pp = await productPolicy(c.db, l.product_id);
    const [balance] =
      await c.db`select * from inventory_balances where product_id=${l.product_id} and location_id=${locationId} and deleted_at is null for update`;
    const variance = BigInt(l.variance_base),
      expected = BigInt(balance?.[STATUS_FIELDS[l.stock_status]] ?? 0);
    if (expected + variance < 0n)
      invalid(
        "An override cannot invent owned stock or a negative physical count",
      );
    const originalCost =
        balance?.weighted_average_cost_minor == null
          ? null
          : BigInt(balance.weighted_average_cost_minor),
      statedCost = l.unit_cost_minor == null ? null : BigInt(l.unit_cost_minor);
    if (originalCost === null && statedCost === null)
      invalid("A verified stock valuation is needed before financial approval");
    const cost =
      originalCost === null
        ? statedCost
        : statedCost === null
          ? originalCost
          : originalCost > statedCost
            ? originalCost
            : statedCost;
    if (cost === null || cost < 0n)
      throw new ApiError(
        "valuation_required",
        409,
        "A verified stock valuation is required",
      );
    const scale = BigInt(pp.scale),
      quantity = variance < 0n ? -variance : variance;
    // Conservative centavo ceiling: a fraction must not fall into a smaller value band.
    const value = (quantity * cost + scale - 1n) / scale;
    const line = {
      productId: pp.product.id,
      productCode: pp.product.code,
      productName: pp.product.name,
      uomCode: pp.product.uom,
      quantityScale: String(scale),
      expectedBase: String(expected),
      countedBase: String(expected + variance),
      varianceBase: String(variance),
      unitCostMinor: String(cost),
      valueMinor: String(value),
      locationId,
      locationName: loc.name,
      stockStatus: l.stock_status,
      lotId: l.lot_id ?? null,
    };
    groups.set(loc.org_unit_id, [...(groups.get(loc.org_unit_id) ?? []), line]);
  }
  for (const [orgUnitId, lines] of [...groups].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    await requireCapability(
      c,
      onApprover ? "inventory.adjustment.approve" : "inventory.approve",
      orgUnitId,
    );
    const id = crypto.randomUUID(),
      amount = lines.reduce((n, l) => n + BigInt(l.valueMinor), 0n);
    const input = {
      id,
      orgUnitId,
      kind: "stock",
      channel: "inventory",
      amountCentavos: String(amount),
      reason: document.reason_code ?? "stock_count",
      facts: {
        version: 4,
        kind: "stock",
        sourceType: document.source_count_id
          ? "stock_count"
          : "inventory_adjustment",
        sourceId: document.id,
        sourceNumber: document.adjustment_number ?? "Stock count correction",
        valuation: "conservative_current_inventory_cost",
        lines,
        totalMinor: String(amount),
      },
    };
    await requireStockBand(c.db, orgUnitId, requester.role);
    if (onApprover) {
      const rule = await authorityRule(c.db, requester, input);
      if (amount > BigInt(rule.self_limit_centavos))
        throw new ApiError(
          "above_approval_limit",
          409,
          "This count is worth more than you may approve on your own. Ask a manager with a higher limit to approve it.",
        );
      await enforceFinancialOverride(
        c.db,
        requester,
        { ...input, overrideId: id, operationId: document.id },
        c.env ?? process.env,
      );
      continue;
    }
    await requestOverride(c.db, requester, input);
    await decideOverride(
      c.db,
      c.actor,
      { id, decision: "approved", reason: input.reason },
      c.env,
    );
    await enforceFinancialOverride(
      c.db,
      requester,
      { ...input, overrideId: id, operationId: document.id },
      c.env ?? process.env,
    );
  }
}
