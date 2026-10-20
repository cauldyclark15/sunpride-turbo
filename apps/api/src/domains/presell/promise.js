import { invalid } from "../../core/errors.js";
import { date, manilaDate } from "../orders/validation.js";

/** F-301: one promise policy frozen at order capture, using Manila cut-off (not upload time).
 * @param {any} policy @param {string} requested @param {number} at */
export function validateRequestedDay(policy, requested, at) {
  date(requested);
  const local = new Date(at + 8 * 3600000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const base = Date.parse(manilaDate(at));
  const days = (Date.parse(requested) - base) / 86400000;
  const minimum = policy.lead_days + Number(minute >= policy.cutoff_minute);
  if (days < minimum || days > policy.horizon_days)
    throw invalid(
      `Choose delivery ${minimum}–${policy.horizon_days} days after the order day`,
    );
  return requested;
}
/** @param {any} db @param {number} at */
export async function policyAt(db, at) {
  const rows =
    await db`select * from presell_policies where channel_profile='pre_sell' and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`;
  if (rows.length !== 1)
    throw invalid("Publish a pre-sell delivery policy first");
  return rows[0];
}
/** Called by the existing visit writer, before accepting its immutable activity. No competing visit handler.
 * @param {any} ctx @param {any} visit @param {any} activity */
export async function validatePresellIntent(ctx, visit, activity) {
  if (activity.kind !== "order_intent") return null;
  const [call] =
    await ctx.db`select definition_snapshot from call_executions where visit_id=${visit.id}`;
  const configured = call?.definition_snapshot.channelProfile === "pre_sell";
  if (!configured && activity.requestedDeliveryDate == null) return null;
  const at = ctx.payload.deviceTime;
  const policy = await policyAt(ctx.db, at);
  validateRequestedDay(policy, activity.requestedDeliveryDate, at);
  return policy;
}
/** Existing commercial order writer remains sole owner of order/line/pricing facts.
 * @param {any} ctx @param {any} row @param {any} activity @param {number} at */
export async function capturePromise(ctx, row, activity, at) {
  const [call] =
    await ctx.db`select definition_snapshot from call_executions where visit_id=(select visit_id from visit_activities where id=${row.source_activity_id})`;
  if (
    activity.requestedDeliveryDate == null &&
    call?.definition_snapshot.channelProfile !== "pre_sell"
  )
    return;
  const policy = await policyAt(ctx.db, at);
  validateRequestedDay(policy, activity.requestedDeliveryDate, at);
  await ctx.db`insert into presell_order_promises(order_id,requested_delivery_date,policy_id,policy_snapshot,captured_at)
    values(${row.id},${activity.requestedDeliveryDate},${policy.id},${policy},${new Date(at)})`;
}
