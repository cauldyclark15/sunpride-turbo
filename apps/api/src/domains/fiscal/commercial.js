import { ApiError } from "../../core/errors.js";
import { requireCapability } from "../../core/capabilities.js";
import { actorFor } from "../../core/context.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { accessibleOrder } from "../orders/access.js";
import { resolvePrice } from "../orders/pricing.js";
import { safe, divide, quantityMilli } from "../orders/validation.js";
import { currentFinancialActor } from "./actors.js";
import { authorityRule, requestOverride, decideOverride } from "./authority.js";
import { enforceFinancialOverride } from "./discounts.js";

/** F-511: derive exact published price/discount facts; no caller amount/channel/role is trusted.
 * @param {any} c @param {any} row */
export async function companyDiscount(c, row) {
  const [profile] =
    await c.db`select user_id from profiles where user_id=${row.created_by_subject} or auth_subject=${row.created_by_subject} limit 1`;
  const actor = await currentFinancialActor(
    c.db,
    profile ? await actorFor(c.db, profile.user_id) : null,
  );
  await accessibleOrder({ ...c, actor }, row.id);
  const snapshot = row.pricing_snapshot;
  if (!row.amount_known || !snapshot?.lines?.length)
    throw new ApiError(
      "authority_unknown",
      409,
      "Reprice the complete source order before financial approval",
    );
  const lines = [];
  let gifts = 0;
  for (const line of snapshot.lines) {
    let value = 0;
    if (line.source === "promotion" && line.quantity > 0) {
      const quote = await resolvePrice(c.db, {
        organizationId: row.organization_id,
        productId: line.productId,
        uom: line.uom,
        channelKey: row.channel_key,
        customerCode: row.customer_code,
        outletId: row.outlet_id,
        at: +new Date(row.offline_created_at ?? row.created_at),
      });
      if (quote.unitPriceCentavos === null)
        throw new ApiError(
          "authority_unknown",
          409,
          "The gift needs a governed historical valuation",
        );
      value = safe(
        divide(
          BigInt(quote.unitPriceCentavos) * quantityMilli(line.quantity),
          1000n,
        ),
      );
      gifts += value;
    }
    lines.push({
      productId: line.productId,
      productName: line.description,
      uom: line.uom,
      quantity: line.quantity,
      unitPriceCentavos: line.unitPriceCentavos,
      grossCentavos: line.grossLineTotalCentavos ?? line.lineTotalCentavos,
      totalCentavos: line.lineTotalCentavos,
      giftValueCentavos: value,
    });
  }
  const amount =
    Number(row.subtotal_centavos) - Number(row.total_centavos) + gifts;
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new ApiError("authority_unknown", 409, "Discount value is unknown");
  return {
    actor,
    input: {
      kind: "discount",
      orgUnitId: row.org_unit_id,
      channel: row.channel_key,
      amountCentavos: String(amount),
      operationId: row.id,
      reason: "Published discounts for " + row.order_number,
      facts: {
        version: 5,
        kind: "commercial_discount",
        sourceType: "order",
        sourceId: row.id,
        sourceNumber: row.order_number,
        customerCode: row.customer_code,
        subtotalCentavos: Number(row.subtotal_centavos),
        totalCentavos: Number(row.total_centavos),
        giftValueCentavos: gifts,
        lines,
      },
    },
  };
}
/** F-511: partner primary orders use the same matrix, never employee capabilities.
 * @param {any} c @param {any} d @param {any} q @param {string} po */
export async function partnerDiscount(c, d, q, po) {
  const actor = await currentFinancialActor(c.db, c.actor),
    gifts = q.freeGoods.reduce(
      (/** @type {number} */ n, /** @type {any} */ l) =>
        n + l.authorityValueCentavos,
      0,
    );
  const amount = Number(q.subtotalCentavos) - Number(q.totalCentavos) + gifts;
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new ApiError(
      "authority_unknown",
      409,
      "Discount and gift value must be known",
    );
  return {
    actor,
    input: {
      kind: "discount",
      orgUnitId: d.org_unit_id,
      channel: "distributor",
      amountCentavos: String(amount),
      reason: "Published distributor discounts for " + po,
      facts: {
        version: 5,
        kind: "commercial_discount",
        sourceType: "distributor_order",
        sourceId: po,
        distributorId: d.id,
        sourceNumber: po,
        customerCode: d.sap_customer_code,
        subtotalCentavos: q.subtotalCentavos,
        totalCentavos: q.totalCentavos,
        giftValueCentavos: gifts,
        lines: [...q.lines, ...q.freeGoods].map((/** @type {any} */ l) => ({
          productId: l.productId,
          productName: l.description,
          uom: l.uom,
          quantity: l.quantity,
          unitPriceCentavos: l.unitPriceCentavos,
          totalCentavos: l.lineTotalCentavos,
          giftValueCentavos: l.authorityValueCentavos ?? 0,
        })),
      },
    },
  };
}
/** @param {any} c @param {any} value */
export async function requestCommercial(c, value) {
  const { actor, input } = value;
  if (input.amountCentavos === "0") return { id: null, requiresSecond: false };
  const rule = await authorityRule(c.db, actor, input),
    hash = sha256Hex(canonicalJson(input.facts));
  await c.db`select pg_advisory_xact_lock(hashtext(${actor.profileId + ":commercial:" + hash}))`;
  const [old] =
    await c.db`select id,requires_second from fiscal_override_requests where requester_id=${actor.profileId} and rule_id=${rule.id} and facts_hash=${hash} and expires_at>now() order by created_at desc,id desc limit 1`;
  if (old) return { id: old.id, requiresSecond: old.requires_second };
  return requestOverride(c.db, actor, { ...input, id: crypto.randomUUID() });
}
/** Same independent office approval may approve its exact financial facts if its role is in the band.
 * Otherwise the dedicated source-derived request reaches the existing Fiscal desk.
 * @param {any} c @param {any} row @param {string|null} reason */
export async function enforceCompanyDiscount(c, row, reason) {
  if (
    Number(row.subtotal_centavos) === Number(row.total_centavos) &&
    !(row.pricing_snapshot?.lines ?? []).some(
      (/** @type {any} */ l) => l.source === "promotion",
    )
  )
    return;
  const value = await companyDiscount(c, row),
    request = await requestCommercial(c, value);
  if (!request.id) return;
  const rule = await authorityRule(c.db, value.actor, value.input);
  if (
    request.requiresSecond &&
    rule.approver_roles.includes(c.actor.role) &&
    c.actor.profileId !== value.actor.profileId
  ) {
    const [decided] =
      await c.db`select id from fiscal_override_events where request_id=${request.id} and kind in ('approved','rejected')`;
    if (!decided)
      await decideOverride(
        c.db,
        c.actor,
        {
          id: request.id,
          decision: "approved",
          reason: reason ?? "Independent order and financial review",
        },
        c.env,
      );
  }
  await enforceFinancialOverride(
    c.db,
    value.actor,
    { ...value.input, overrideId: request.id },
    c.env ?? {},
  );
}
/** @param {any} router */
export function installCommercial(router) {
  router.post(
    "/api/v1/fiscal/commercial/request",
    async (/** @type {any} */ c) => {
      const { tx } = await import("@sunpride/db/client");
      const result = await tx(c.db, async (db) => {
        const cc = {
          ...c,
          db,
          actor: await currentFinancialActor(db, c.actor),
        };
        const row = await accessibleOrder(cc, c.body.orderId);
        await requireCapability(
          cc,
          row.created_by_subject === cc.actor.subject
            ? "order.create"
            : "order.approve",
          row.org_unit_id,
        );
        return requestCommercial(cc, await companyDiscount(cc, row));
      });
      await c.publish("fiscal");
      return result;
    },
  );
}
