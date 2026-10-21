import { changed } from "./common.js";
import { posting } from "./finance.js";
import { fail, safe } from "../orders/validation.js";

/** Frozen allocation proration, cumulative so split returns cannot leak rounding cents.
 * Paid/free units of the same SKU are proportionately returned (our provisional policy).
 * @param {any} receipt @param {Map<string,bigint>} returned */
export function returnedBenefits(receipt, returned) {
  const lines = receipt.lines;
  const paid = lines.filter(
    (/** @type {any} */ l) => BigInt(l.paidBase ?? l.quantityBase) > 0n,
  );
  /** @param {number} amount @param {any} line */
  const portion = (amount, line) => {
    if (!line || !Number.isSafeInteger(amount) || amount < 0)
      fail("Frozen promotion allocation is missing");
    const original = BigInt(line.quantityBase),
      quantity = returned.get(line.productId) ?? 0n;
    if (original <= 0n || quantity < 0n || quantity > original)
      fail("Return quantity exceeds frozen sale");
    return (BigInt(amount) * quantity) / original;
  };
  return (receipt.promotionsApplied ?? []).map((/** @type {any} */ p) => {
    if (!p.campaignVersionId) return { id: p.id, earned: 0, spend: 0 };
    if (!Array.isArray(p.allocations) || p.allocations.length !== paid.length)
      fail("Frozen scheme allocations are incomplete");
    let allocated = 0n,
      reversed = 0n,
      gifts = 0n;
    for (const [index, amount] of p.allocations.entries()) {
      reversed += portion(amount, paid[index]);
      allocated += BigInt(amount);
    }
    if (
      allocated !==
      BigInt(p.earnedCentavos ?? 0) + BigInt(p.discountCentavos ?? 0)
    )
      fail("Frozen scheme amounts do not reconcile");
    for (const gift of p.freeGoods ?? []) {
      const line = lines.find(
        (/** @type {any} */ l) => l.productId === gift.productId,
      );
      gifts += portion(gift.referenceValueCentavos, line);
    }
    return {
      id: p.id,
      earned: p.benefitTiming === "claimable" ? safe(reversed) : 0,
      spend: safe(reversed + gifts),
    };
  });
}

/** Called inside the canonical return transaction after immutable return lines are inserted.
 * Original sale row is locked by the caller; money never comes from the device.
 * @param {any} c @param {any} sale @param {string} returnId */
export async function reverseReturnedVanBenefits(c, sale, returnId) {
  if (sale.receipt.schemeEngineVersion !== 1) return;
  const rows =
    await c.db`select l.product_id,sum(l.quantity_base)::text as quantity from van_return_lines l join van_returns r on r.id=l.return_id where r.sale_id=${sale.id} group by l.product_id`;
  const returned = new Map(
    rows.map((/** @type {any} */ r) => [r.product_id, BigInt(r.quantity)]),
  );
  return reverseVanBenefitTotals(c, sale, returnId, returned);
}
/** Internal cumulative allocation writer; the van adapter supplies canonical return quantities.
 * @param {any} c @param {any} sale @param {string} returnId @param {Map<string,bigint>} returned */
export async function reverseVanBenefitTotals(c, sale, returnId, returned) {
  for (const benefit of returnedBenefits(sale.receipt, returned)) {
    const key = `van_sale:${sale.id}:promotion:${benefit.id}`;
    const [e] =
      await c.db`select * from promotion_earnings where source_key=${key} for update`;
    if (e && BigInt(benefit.earned) > BigInt(e.reversed_centavos)) {
      const [claim] =
        await c.db`select 1 from claims where earning_id=${e.id} and status not in ('rejected','needs_evidence') limit 1`;
      if (claim)
        fail("Resolve the related claim before returning its earned goods");
      const amount = safe(BigInt(benefit.earned) - BigInt(e.reversed_centavos));
      if (BigInt(benefit.earned) > BigInt(e.amount_centavos))
        fail("Return benefit exceeds original earning");
      await posting(c, {
        sourceKey: `partial-return:${returnId}:${e.id}`,
        kind: "reversal",
        earningId: e.id,
        amountCentavos: amount,
        currency: "PHP",
      });
      await c.db`update promotion_earnings set reversed_centavos=${benefit.earned},updated_at=now() where id=${e.id}`;
      await changed(c, "earning.partial_return", e.id, {
        returnId,
        amountCentavos: amount,
      });
    }
    const [commitment] =
      await c.db`select * from campaign_commitments where source_key=${"earned:" + key}`;
    if (!commitment) continue;
    await c.db`select id from campaigns where id=${commitment.campaign_id} for update`;
    const [released] =
      await c.db`select coalesce(sum(amount_centavos),0) as amount from campaign_commitment_releases where commitment_id=${commitment.id}`;
    const delta = BigInt(benefit.spend) - BigInt(released.amount);
    if (delta > 0n) {
      if (BigInt(benefit.spend) > BigInt(commitment.amount_centavos))
        fail("Return exceeds original campaign spend");
      await c.db`insert into campaign_commitment_releases(commitment_id,source_key,amount_centavos,reason,actor_subject) values(${commitment.id},${`partial-return:${returnId}:${commitment.id}`},${safe(delta)},'Frozen proportional returned goods',${c.actor.subject})`;
      await changed(c, "budget.partial_return", commitment.id, {
        returnId,
        amountCentavos: safe(delta),
      });
    }
  }
}
