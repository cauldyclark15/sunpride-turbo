import { required } from "./model.js";

/** Transactional shared writer. Callers own authorization; never pass secrets, coordinates or raw evidence in details.
 * @param {import('@sunpride/db/client').Db} tx
 * @param {{subject?:string, actor?:{userId?:string,profileId?:string}, action:string, entityType:string, entityId:string, details?:unknown, at?:number}} entry
 * @returns {Promise<void>}
 */
export async function writeAudit(tx, entry) {
  const subject = required(
    entry.subject ?? entry.actor?.userId ?? entry.actor?.profileId,
    "Audit actor",
    500,
  );
  const details =
    entry.details == null
      ? null
      : typeof entry.details === "string"
        ? entry.details
        : JSON.stringify(entry.details);
  if (details && details.length > 10000)
    throw new Error("Audit details exceed limit");
  await tx`insert into audit_logs(subject,action,entity_type,entity_id,details,created_at) values
    (${subject},${required(entry.action, "Action", 100)},${required(entry.entityType, "Entity", 100)},${required(entry.entityId, "Entity reference", 200)},${details},${new Date(entry.at ?? Date.now())})`;
}
