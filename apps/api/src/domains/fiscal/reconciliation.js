import { requireCapability } from "../../core/capabilities.js";
import { currentActor } from "../van/access.js";
import { uuid, text, choice, refuse } from "../van/model.js";

/** F-019: close a reconciled or lost tail; never advance/recycle original numbering.
 * Caller owns the transaction. @param {any} db @param {any} actor @param {any} p */
export async function retireAllocation(db, actor, p) {
  actor = await currentActor(db, actor);
  const [a] =
    await db`select a.*,r.org_unit_id,d.status as device_status from fiscal_allocations a join fiscal_series s on s.id=a.series_id join fiscal_registrations r on r.id=s.registration_id join registered_devices d on d.id=a.device_id where a.id=${uuid(p.allocationId)} for update of a`;
  if (!a) refuse("Choose a reserved document range");
  await requireCapability({ db, actor }, "admin.manage", a.org_unit_id);
  if (a.profile_id === actor.profileId)
    refuse("A different administrator must reconcile this range");
  if (a.device_status === "active")
    refuse("Suspend or retire the phone before reconciling its unused range");
  const reason = text(p.reason, 300, true),
    evidence = text(p.evidenceReference, 300, true),
    outcome = choice(p.outcome, ["unused_reconciled", "lost_unreconciled"]);
  const [prior] =
    await db`select * from fiscal_allocation_closures where allocation_id=${a.id}`;
  if (prior) {
    if (
      prior.outcome !== outcome ||
      prior.reason !== reason ||
      prior.evidence_reference !== evidence
    )
      refuse("This range already has a different reconciliation");
    return { id: prior.id, duplicate: true };
  }
  if (BigInt(a.next_issue) > BigInt(a.last_serial))
    refuse("Every number in this range is already accounted for");
  const [r] =
    await db`insert into fiscal_allocation_closures(allocation_id,first_unissued,last_serial,outcome,reason,evidence_reference,actor_profile_id) values(${a.id},${a.next_issue},${a.last_serial},${outcome},${reason},${evidence},${actor.profileId}) returning id`;
  await db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${actor.subject},'fiscal.range_retired','fiscal_allocation',${a.id},${{ outcome, reason, firstUnissued: String(a.next_issue), lastSerial: String(a.last_serial), evidenceReference: evidence }})`;
  return { id: r.id, duplicate: false };
}
