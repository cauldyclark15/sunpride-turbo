import { requireCapability } from "../../core/capabilities.js";
import { currentActor } from "../van/access.js";
import {
  PAYMENT_METHODS,
  text,
  choice,
  uuid,
  refuse,
  today,
} from "../van/model.js";
/** F-111. Never accept PAN/CVC as a card reference. No network method is automatically paid.
 * @param {any} p */
export function validateTender(p) {
  const method = PAYMENT_METHODS.find((m) => m.code === p.method);
  if (!method) refuse("Choose an authorized tender");
  if (method.referenceRequired) {
    const ref = text(p.reference, 100, true);
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]{1,99}$/.test(ref ?? ""))
      refuse("Enter the provider's confirmation reference");
    if (p.method === "card" && (ref ?? "").replace(/\D/g, "").length >= 12)
      refuse(
        "Enter only the terminal approval reference, never the card number",
      );
    if (p.status && p.status !== "awaiting_confirmation")
      refuse("Non-cash tender awaits independent office confirmation");
  }
  return method;
}
/** F-111. One effective row per method, including disabled rows; ambiguity fails closed.
 * @param {any} db @param {string} orgUnitId @param {number} [at] */
export async function tenderPolicy(db, orgUnitId, at = Date.now()) {
  const rows =
    await db`select * from fiscal_tender_rules where org_unit_id=${uuid(orgUnitId)} and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)}) order by method limit 101`;
  if (
    rows.length > 100 ||
    new Set(rows.map((/** @type {any} */ r) => r.method)).size !== rows.length
  )
    refuse("Tender policy overlaps; ask the office to correct it");
  return rows
    .filter((/** @type {any} */ r) => r.enabled)
    .map((/** @type {any} */ r) => {
      const base = PAYMENT_METHODS.find((m) => m.code === r.method);
      if (!base) refuse("Unsupported tender policy");
      return {
        ...base,
        label: r.label,
        referenceLabel: r.reference_label ?? base.referenceLabel,
      };
    });
}
/** F-111. Historical policy validates a signed offline operation at its capture time.
 * @param {any} db @param {string} orgUnitId @param {any} p @param {number} at */
export async function configuredTender(db, orgUnitId, p, at) {
  const policy = await tenderPolicy(db, orgUnitId, at);
  const method = policy.find((/** @type {any} */ m) => m.code === p.method);
  if (!method) refuse("This tender was not authorized at capture time");
  validateTender(p);
  return method;
}
/** F-111. Prospective replacement, never laundering an older offline payment.
 * @param {any} db @param {any} actor @param {any} p */
export async function saveTenderRule(db, actor, p) {
  actor = await currentActor(db, actor);
  await requireCapability({ db, actor }, "admin.manage", uuid(p.orgUnitId));
  const method = choice(
      p.method,
      PAYMENT_METHODS.map((m) => m.code),
    ),
    from = Date.parse(p.effectiveFrom);
  if (
    !Number.isFinite(from) ||
    from <= Date.now() ||
    from !== Date.parse(today(from) + "T00:00:00+08:00")
  )
    refuse("Schedule tender changes at a future Manila midnight");
  await db`select pg_advisory_xact_lock(hashtext(${p.orgUnitId + ":" + method}))`;
  const [future] =
    await db`select id from fiscal_tender_rules where org_unit_id=${p.orgUnitId} and method=${method} and effective_from>=${new Date(from)} limit 1`;
  if (future)
    refuse("A tender policy is already scheduled at or after this date");
  const [unit] =
    await db`select exists(select 1 from sample_data_rows where table_name='org_units' and row_id=${p.orgUnitId}) as sample`;
  await db`update fiscal_tender_rules set effective_to=${new Date(from)} where org_unit_id=${p.orgUnitId} and method=${method} and effective_from<${new Date(from)} and (effective_to is null or effective_to>${new Date(from)})`;
  const [row] =
    await db`insert into fiscal_tender_rules(org_unit_id,method,label,reference_label,enabled,effective_from,sample,entered_by) values(${p.orgUnitId},${method},${text(p.label, 40, true)},${text(p.referenceLabel, 40)},${p.enabled === true || p.enabled === "true"},${new Date(from)},${unit.sample},${actor.profileId}) returning id`;
  if (unit.sample)
    await db`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-fiscal-sample','fiscal_tender_rules',${row.id},${"fiscal_tender_rules:" + row.id}) on conflict(batch,key) do nothing`;
  return { id: row.id };
}
/** @param {any} db @param {any} actor @param {any} p */
export async function confirmTender(db, actor, p) {
  actor = await currentActor(db, actor);
  const [row] =
    await db`select v.*,t.org_unit_id,t.salesperson_profile_id from van_payments v join van_trips t on t.id=v.trip_id where v.id=${uuid(p.paymentId)} for update of v`;
  if (!row || row.method === "cash" || row.method === "credit")
    refuse("Choose a non-cash receipt");
  await requireCapability({ db, actor }, "van.cash.approve", row.org_unit_id);
  if (row.salesperson_profile_id === actor.profileId)
    refuse("Another person must confirm the tender");
  const [prior] =
    await db`select * from fiscal_tender_confirmations where payment_id=${row.id}`;
  const decision = choice(p.decision, ["confirmed", "rejected"]),
    reason = text(p.reason, 300, true);
  if (prior) {
    if (prior.decision !== decision || prior.reason !== reason)
      refuse("Tender is already decided");
    return { id: prior.id };
  }
  const [r] =
    await db`insert into fiscal_tender_confirmations(payment_id,decision,reason,actor_profile_id) values(${row.id},${decision},${reason},${actor.profileId}) returning id`;
  return { id: r.id };
}
