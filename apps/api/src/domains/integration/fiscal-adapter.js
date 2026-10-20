import { payloadHash } from "../../../../../packages/integration-contracts/sap/v1/index.js";
import { ApiError } from "../../core/errors.js";

/** SEAM(FISCAL): replace the local adapter with domains/fiscal requestOverride when merged.
 * The fallback records a request ONLY; it can never authorize credit locally.
 * Expected shape: requestOverride(ctx,{kind:'credit',customerCode,amountCentavos,currency:'PHP',reason,idempotencyKey,factsHash}).
 * @param {any} c @param {any} input
 */
export async function requestOverride(c, input) {
  const facts = {
    kind: "credit",
    customerCode: input.customerCode,
    amountCentavos: input.amountCentavos,
    currency: "PHP",
  };
  const hash = payloadHash({ ...facts, reason: input.reason.trim() });
  await c.db`select pg_advisory_xact_lock(hashtextextended(${`sap-override:${c.actor.profileId}:${input.idempotencyKey}`},0))`;
  const [prior] =
    await c.db`select * from sap_credit_override_requests where requester_profile_id=${c.actor.profileId} and request_key=${input.idempotencyKey}`;
  if (prior) {
    if (prior.request_hash !== hash)
      throw new ApiError(
        "idempotency_conflict",
        409,
        "Credit request key was reused for different facts",
      );
    return {
      id: prior.id,
      status: "pending_sap",
      duplicate: true,
      policy: "SAP approval required; this request does not authorize a sale",
    };
  }
  const [row] =
    await c.db`insert into sap_credit_override_requests(customer_code,amount_centavos,facts_hash,requester_profile_id,org_unit_id,reason,request_key,request_hash) values(${input.customerCode},${input.amountCentavos},${payloadHash(facts)},${c.actor.profileId},${c.actor.orgUnitId},${input.reason.trim()},${input.idempotencyKey},${hash}) returning id`;
  return {
    id: row.id,
    status: "pending_sap",
    duplicate: false,
    policy: "SAP approval required; this request does not authorize a sale",
  };
}
