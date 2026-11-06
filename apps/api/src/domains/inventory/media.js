import { roleHas } from "../../core/capabilities.js";

export const INVENTORY_MEDIA_PURPOSES = ["count-finding", "disposition-photo"];

/**
 * Media claim authorisation for the inventory purposes (called from the shared canClaimMedia hook; never replaces it).
 * - count-finding: ownerId is the count; only the person counting it (or the one it is assigned to) while it is open.
 * - disposition-photo: anyone who may ask for a bad-order decision; ownerId may be empty (photo taken before the request).
 * @param {any} db @param {any} actor @param {{purpose:string,ownerId:string|null,deviceId:string}} claim
 */
export async function canClaimInventoryMedia(db, actor, claim) {
  if (claim.purpose === "disposition-photo")
    return roleHas(actor.role, "inventory.adjustment.request");
  if (claim.purpose !== "count-finding" || !claim.ownerId) return false;
  const [session] =
    await db`select created_by,assigned_to,status from stock_count_sessions where id=${claim.ownerId}`;
  return Boolean(
    session &&
      ["planned", "counting"].includes(session.status) &&
      (session.created_by === actor.userId ||
        session.assigned_to === actor.userId),
  );
}
