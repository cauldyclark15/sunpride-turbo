import { requireCapability } from "../../core/capabilities.js";
import { fail, text, uuid } from "./model.js";
/** F-408 recommendation: start with explicit company-owned consignment, not an invented partner stock ledger.
 * Existing office load/settlement approvals and SAP ownership stay unchanged.
 * @param {any} c @param {any} d @param {any} b */
export async function saveVanArrangement(c, d, b) {
  if (b.stockOwner && b.stockOwner !== "sunpride")
    fail(
      "This arrangement uses Sunpride-owned consignment stock; partner-owned inventory is not silently posted to Sunpride",
    );
  const [vehicle] =
    await c.db`select * from vehicles where id=${uuid(b.vehicleId)} and status='active' and deleted_at is null for update`;
  if (!vehicle || vehicle.org_unit_id !== d.org_unit_id)
    fail("Choose a vehicle in the distributor's supervising area");
  await requireCapability(c, "van.manage", vehicle.org_unit_id);
  const from = b.effectiveFrom ? new Date(b.effectiveFrom) : new Date(c.now),
    to = b.effectiveTo ? new Date(b.effectiveTo) : null;
  if (
    !Number.isFinite(+from) ||
    +from < c.now ||
    (to && (!Number.isFinite(+to) || to <= from))
  )
    fail("Use a current or future arrangement window");
  if (b.replacesId) {
    const [old] =
      await c.db`select * from distributor_van_arrangements where id=${uuid(b.replacesId)} and distributor_id=${d.id} for update`;
    if (!old || new Date(old.effective_from) >= from)
      fail("Replace an earlier arrangement prospectively");
    await c.db`update distributor_van_arrangements set effective_to=${from},updated_at=now() where id=${old.id}`;
  }
  const [row] =
    await c.db`insert into distributor_van_arrangements(distributor_id,vehicle_id,stock_owner,reference,source,effective_from,effective_to,created_by) values(${d.id},${vehicle.id},'sunpride',${text(b.reference, "Arrangement reference", 300)},${d.source === "sample" ? "sample" : "office"},${from},${to},${c.actor.subject}) returning id`;
  await c.db`update profiles set scope_epoch=scope_epoch+1 where id in(select profile_id from distributor_users where distributor_id=${d.id} and 'van'=any(grants))`;
  return row;
}
