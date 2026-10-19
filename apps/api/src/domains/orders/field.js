import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { outletContext, scoped } from "./access.js";
import { createOrder } from "./service.js";
import { date, fail, uuid } from "./validation.js";

/**
 * VISITS calls this inside its visit.activity transaction, AFTER inserting the activity,
 * BEFORE final change-log writes. No registration of a competing visit.activity handler.
 * Owns only commercial tables. CORE owns op receipts, VISITS owns activities/events.
 * @param {any} ctx OpCtx (db is the existing transaction)
 * @param {{activityId:string}} input
 */
export async function captureFieldOrder(ctx, { activityId }) {
  await requireCapability(ctx, "order.create");
  if (ctx.app !== "field-android" && ctx.app !== "field-ios")
    fail("Field app required");
  const [activity] =
    await ctx.db`select * from visit_activities where id = ${uuid(activityId)} and activity_kind = 'order_intent' and deleted_at is null`;
  if (!activity || activity.assignee_profile_id !== ctx.actor.profileId)
    throw new ApiError("out_of_scope", 403, "This field order is not yours");
  const [visit] =
    await ctx.db`select * from visit_executions where id = ${activity.visit_id} and deleted_at is null for update`;
  if (
    !visit ||
    visit.assignee_profile_id !== ctx.actor.profileId ||
    visit.org_unit_id !== activity.org_unit_id
  )
    fail("Visit not available");
  await scoped(ctx, "order.create", visit.org_unit_id);
  await outletContext(ctx, visit.outlet_id, "order.create");
  const a = activity.activity;
  const hash = sha256Hex(canonicalJson(a));
  const clientOrderId = uuid(a.clientOrderId, "Phone order");
  const [prior] =
    await ctx.db`select * from field_order_captures where visit_id = ${visit.id} and client_order_id = ${clientOrderId}`;
  if (prior) {
    if (prior.activity_id !== activityId || prior.payload_hash !== hash)
      fail("Phone order was already captured", "idempotency_conflict");
    return { entityId: prior.order_id };
  }
  const at = new Date(activity.device_time).getTime();
  if (!visit.checked_in_at || at < new Date(visit.checked_in_at).getTime())
    fail("Order time is before check-in", "wrong_date");
  if (at > ctx.now + 300_000) fail("Order time is in the future", "wrong_date");
  const day = date(new Date(visit.service_date).toISOString().slice(0, 10));
  const start = new Date(`${day}T00:00:00+08:00`),
    end = new Date(start.getTime() + 86400_000);
  const [account] =
    await ctx.db`select * from call_sheet_accounts where outlet_id = ${visit.outlet_id} and deleted_at is null`;
  if (!account) fail("The store's selling catalog needs setup");
  const allowed =
    await ctx.db`select l.product_id from call_sheet_account_lines l where l.call_sheet_account_id = ${account.id} and l.deleted_at is null and ${new Date(account.updated_at)}::timestamptz < ${end}::timestamptz
    union select rp.product_id from call_sheet_account_revision_products rp join call_sheet_account_revisions r on r.id = rp.call_sheet_account_revision_id
    where r.outlet_id = ${visit.outlet_id} and r.organization_id = ${visit.organization_id} and r.deleted_at is null and rp.deleted_at is null
      and r.effective_from < ${end} and r.superseded_at > ${start} and r.effective_from <= r.superseded_at and r.superseded_at <= ${account.updated_at} and r.revision < ${account.revision}`;
  if (
    !Array.isArray(a.lines) ||
    a.lines.some(
      (/** @type {any} */ l) =>
        !allowed.some((/** @type {any} */ p) => p.product_id === l.productId),
    )
  )
    fail("Product was not authorized on the visit day");
  const [customer] =
    await ctx.db`select c.* from customers c join outlet_customer_links l on l.customer_id = c.id
    where l.outlet_id = ${visit.outlet_id} and l.deleted_at is null and l.effective_from <= ${new Date(at)} and (l.effective_to is null or l.effective_to > ${new Date(at)})`;
  if (!customer)
    fail(
      "This store needs an accounting customer before a commercial order can be booked",
    );
  const row = await createOrder(ctx, {
    customerCode: customer.code,
    outletId: visit.outlet_id,
    lines: a.lines,
    at,
    serviceDate: day,
    clientRequestId: `field:${visit.id}:${clientOrderId}`,
    activityId,
    orderType: "field_order",
    status: "pending_approval",
  });
  const p = row.pricing_snapshot;
  const listId = p.lines[0]?.priceListId ?? null;
  const [pricing] =
    await ctx.db`insert into field_order_pricings(organization_id,org_unit_id,visit_id,activity_id,outlet_id,customer_id,client_order_id,price_list_id,price_list_source,currency,priced_at,total_minor,unpriced_lines,credit_status,credit_limit_minor,credit_open_orders_minor,server_time)
    values(${visit.organization_id},${visit.org_unit_id},${visit.id},${activity.id},${visit.outlet_id},${customer.id},${clientOrderId},${listId},${["sample", "office"].includes(p.lines[0]?.source) ? p.lines[0].source : null},'PHP',${new Date(at)},${p.totalCentavos ?? p.knownSubtotalCentavos},${p.lines.filter((/** @type {any} */ l) => l.unitPriceCentavos === null).length},${p.credit.status},${p.credit.limit},${p.credit.exposure},${new Date(ctx.now)}) returning id`;
  for (let i = 0; i < p.lines.length; i++) {
    const l = p.lines[i];
    await ctx.db`insert into field_order_pricing_lines(field_order_pricing_id,ordinal,product_id,uom,quantity,unit_price_minor,line_total_minor)
      values(${pricing.id},${i},${l.productId},${l.uom},${l.quantity},${l.unitPriceCentavos},${l.lineTotalCentavos})`;
  }
  await ctx.db`insert into field_order_captures(visit_id,client_order_id,activity_id,order_id,payload_hash) values(${visit.id},${clientOrderId},${activity.id},${row.id},${hash})`;
  // Durable post-commit work: CORE executes this job only after its enclosing op commits.
  await ctx.enqueue({
    kind: "orders.refresh",
    key: row.id,
    payload: { date: day, unitId: row.org_unit_id },
  });
  ctx.publish("orders");
  return { entityId: row.id };
}
