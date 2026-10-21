import { authorityRule, enforceAuthority } from "../fiscal/authority.js";
import { currentActor } from "../van/access.js";
import { outletOwnerUnit } from "../org/scope.js";
import { invalid } from "../../core/errors.js";

/** F-511: approved campaigns still obey the one fiscal role/channel/value-band authority.
 * Quote previews validate but never spend an approval. Order creation consumes it in its business transaction.
 * @param {any} c @param {any} q */
export async function authorizeCampaignQuote(c, q) {
  const actor = await currentActor(c.db, c.actor);
  const orgUnitId = q.outletId
    ? await outletOwnerUnit(c.db, q.outletId, Date.now())
    : actor.orgUnitId;
  if (!orgUnitId || q.subtotalCentavos == null || q.totalCentavos == null)
    throw invalid(
      "Complete the governed price before checking discount authority",
    );
  const { discountOverrideId, ...facts } = q;
  const amount = Math.max(
    q.subtotalCentavos - q.totalCentavos,
    q.promotions.reduce(
      (/** @type {number} */ n, /** @type {any} */ p) =>
        n + Number(p.discountCentavos ?? 0) + Number(p.earnedCentavos ?? 0),
      0,
    ),
  );
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw invalid("Discount amount exceeds authority range");
  const policy = {
    kind: "discount",
    orgUnitId,
    channel: q.channelKey,
    amountCentavos: String(amount),
    facts,
  };
  const rule = await authorityRule(c.db, actor, policy);
  if (BigInt(amount) <= BigInt(rule.self_limit_centavos))
    return { status: "authorized", reference: rule.id };
  if (!discountOverrideId)
    return { status: "approval_required", reference: rule.id };
  const result = await enforceAuthority(
    c.db,
    actor,
    {
      ...policy,
      overrideId: discountOverrideId,
      operationId: c.orderAuthorityOperationId ?? discountOverrideId,
    },
    { consume: Boolean(c.orderAuthorityOperationId) },
  );
  return { status: "authorized", reference: result.overrideId };
}
