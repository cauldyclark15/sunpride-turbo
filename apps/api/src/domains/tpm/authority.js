import {
  authorityRule,
  enforceAuthority,
  currentFiscalActor,
} from "../fiscal/authority.js";
import { outletOwnerUnit } from "../org/scope.js";
import { invalid } from "../../core/errors.js";
import { authorize } from "../distributors/model.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { uuid } from "../orders/validation.js";

/** F-511: approved campaigns still obey the one fiscal role/channel/value-band authority.
 * Quote previews validate but never spend an approval. Order creation consumes it in its business transaction.
 * @param {any} c @param {any} q @returns {Promise<{status:string,reference?:string,request?:any,pendingId?:string}>} */
export async function authorizeCampaignQuote(c, q) {
  const actor = await currentFiscalActor(c.db, c.actor, q);
  const distributor =
    actor.role === "distributor"
      ? await authorize(c, q.distributorId, "order")
      : null;
  const orgUnitId = q.outletId
    ? await outletOwnerUnit(c.db, q.outletId, Date.now())
    : (distributor?.org_unit_id ?? actor.orgUnitId);
  if (!orgUnitId || q.subtotalCentavos == null || q.totalCentavos == null)
    throw invalid(
      "Complete the governed price before checking discount authority",
    );
  const { discountOverrideId: suppliedOverrideId, ...facts } = q;
  const amount = Math.max(
    q.subtotalCentavos - q.totalCentavos,
    q.promotions.reduce(
      (/** @type {number} */ n, /** @type {any} */ p) =>
        n +
        Number(p.discountCentavos ?? 0) +
        Number(p.earnedCentavos ?? 0) +
        Number(p.freeGoodsValueCentavos ?? 0),
      0,
    ),
  );
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw invalid("Discount amount exceeds authority range");
  const policy = {
    kind: "discount",
    orgUnitId,
    ...(distributor ? { distributorId: distributor.id } : {}),
    channel: q.channelKey,
    amountCentavos: String(amount),
    facts,
  };
  const rule = await authorityRule(c.db, actor, policy);
  if (BigInt(amount) <= BigInt(rule.self_limit_centavos))
    return { status: "authorized", reference: rule.id };
  const hash = sha256Hex(canonicalJson(facts));
  const [matching] =
    await c.db`select r.id,r.requires_second,exists(select 1 from fiscal_override_events e where e.request_id=r.id and e.kind='approved') as approved from fiscal_override_requests r where r.requester_id=${actor.profileId} and r.rule_id=${rule.id} and r.facts_hash=${hash} and r.expires_at>now() and (${suppliedOverrideId ? uuid(suppliedOverrideId) : null}::uuid is null or r.id=${suppliedOverrideId ?? null}::uuid) and not exists(select 1 from fiscal_override_events e where e.request_id=r.id and e.kind in ('consumed','rejected')) order by r.created_at desc limit 1`;
  const discountOverrideId = suppliedOverrideId ?? matching?.id;
  if (!discountOverrideId || (matching?.requires_second && !matching.approved))
    return {
      status: "approval_required",
      reference: rule.id,
      request: policy,
      ...(matching ? { pendingId: matching.id } : {}),
    };
  const result = await enforceAuthority(
    c.db,
    actor,
    {
      ...policy,
      overrideId: discountOverrideId,
      operationId: c.orderAuthorityOperationId ?? discountOverrideId,
    },
    c.env,
    { consume: Boolean(c.orderAuthorityOperationId) },
  );
  return { status: "authorized", reference: result.overrideId };
}
