import { office } from "./common.js";
import { partnerContext, partnerStoreGrants } from "../partners/boundary.js";
import { authorize } from "../distributors/model.js";
import { authorize as authorizeAgency } from "../partners/model.js";
import { portalAccess } from "../mt/portal.js";

/** F-506 external claimants can inspect only their currently granted source stores.
 * Office review retains its national financial read boundary. @param {any} c @param {{outletId:string,occurredAt:number}} source */
export async function executionEvidenceAccess(c, source) {
  const member =
    c.actor?.role === "mt_customer"
      ? null
      : await partnerContext(c.db, c.actor);
  const external =
    Boolean(member) ||
    ["agency", "distributor", "mt_customer"].includes(c.actor?.role);
  if (!external) {
    await office(c);
    return {};
  }
  const hint = c.claimEvidenceScope;
  if (!hint) return null;
  if (c.actor.role === "mt_customer") {
    if (hint.partyType !== "modern_trade") return null;
    const { allowed } = await portalAccess(c);
    if (!allowed.some((/** @type {any} */ r) => r.id === hint.partyId))
      return null;
    const [binding] =
      await c.db`select id from mt_account_bindings where id::text=${hint.partyId} and outlet_id=${source.outletId} and effective_from<=now() and (effective_to is null or effective_to>now()) and effective_from<=${new Date(source.occurredAt)} and (effective_to is null or effective_to>${new Date(source.occurredAt)})`;
    if (!binding) return null;
    return { partyType: "modern_trade", partyId: binding.id };
  }
  if (
    !member ||
    member.distributor_id !== hint.partyId ||
    member.partner_kind !== hint.partyType
  )
    return null;
  if (member.partner_kind === "agency")
    await authorizeAgency(c, hint.partyId, "billing");
  else await authorize(c, hint.partyId, "claim");
  const grants = await partnerStoreGrants(c.db, member, source.occurredAt);
  return grants.some((/** @type {any} */ g) => g.outlet_id === source.outletId)
    ? { partyType: hint.partyType, partyId: hint.partyId }
    : null;
}
