import { dateOf } from "../fieldsync/model.js";
import { DSR_ACCESS } from "../distributors/dsr-context.js";
import { ORGANIZATION, product, reject } from "./shared.js";

/** Read-only validation of FIELDREPORTS' account setup; never writes another lane's projection.
 * @param {any} ctx @param {any} visit @param {any} activity
 */
export async function validateAccountCapture(ctx, visit, activity) {
  if (!["call_sheet", "order_intent"].includes(activity.kind)) return;
  if (ctx[DSR_ACCESS]) {
    for (const l of activity.lines ?? [])
      if (!ctx[DSR_ACCESS].allowed.has(l.productId)) reject("out_of_scope");
    return;
  }
  const [account] =
    await ctx.db`select * from call_sheet_accounts where outlet_id=${visit.outlet_id} and organization_id=${ORGANIZATION} and deleted_at is null`;
  if (!account && activity.kind === "call_sheet") reject();
  if (activity.kind === "call_sheet") return;
  const dayStart = new Date(
      `${new Date(visit.service_date).toISOString().slice(0, 10)}T00:00:00+08:00`,
    ),
    dayEnd = new Date(dayStart.getTime() + 86400000);
  const allowed = new Set();
  if (account && new Date(account.updated_at) < dayEnd) {
    const lines =
      await ctx.db`select product_id from call_sheet_account_lines where call_sheet_account_id=${account.id} and deleted_at is null`;
    for (const line of lines) allowed.add(line.product_id);
  }
  const revisions =
    await ctx.db`select * from call_sheet_account_revisions where outlet_id=${visit.outlet_id} and deleted_at is null
    and superseded_at>${dayStart} and effective_from<${dayEnd} order by superseded_at limit 51`;
  if (revisions.length > 50) reject();
  for (const revision of revisions) {
    if (
      revision.organization_id !== ORGANIZATION ||
      revision.revision >= (account?.revision ?? 0) ||
      new Date(revision.superseded_at) > new Date(account?.updated_at ?? 0) ||
      new Date(revision.effective_from) > new Date(revision.superseded_at)
    )
      continue;
    const lines =
      await ctx.db`select product_id from call_sheet_account_revision_products where call_sheet_account_revision_id=${revision.id} and deleted_at is null`;
    for (const line of lines) allowed.add(line.product_id);
  }
  const retail =
    await ctx.db`select body from availability_call_snapshots where profile_id=${visit.assignee_profile_id} and outlet_id=${visit.outlet_id} and service_date=${dateOf(visit.service_date)} and app=${ctx.app} and body->>'setupNeeded'='false' order by created_at desc limit 501`;
  if (retail.length > 500) reject();
  for (const snapshot of retail)
    for (const line of snapshot.body.lines ?? []) allowed.add(line.productId);
  for (const line of activity.lines) {
    if (!allowed.has(line.productId)) reject();
    const sku = await product(ctx.db, line.productId);
    if (line.uom === sku.uom) continue;
    const units =
      await ctx.db`select u.code from product_selling_uoms s join units_of_measure u on u.id=s.uom_id
      where s.product_id=${line.productId} and s.deleted_at is null and u.active and u.organization_id=${ORGANIZATION} and u.deleted_at is null`;
    if (!units.some((/** @type {any} */ u) => u.code === line.uom)) reject();
  }
}
