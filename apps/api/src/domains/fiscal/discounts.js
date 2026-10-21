import {
  authorityRule,
  requestOverride,
  enforceAuthority,
} from "./authority.js";
import { text, uuid, integer, choice, extend } from "../van/model.js";
import { OVERRIDE_KINDS } from "./authority.js";
/** F-110 exact financial facts, excluding lots/UI-only metadata which can change independently.
 * All values come from the canonical writer's checked quote, not a caller's claimed amount.
 * @param {string} saleId @param {string} customerId @param {any[]} lines @param {string} totalMinor */
export function saleDiscountFacts(saleId, customerId, lines, totalMinor) {
  return {
    version: 2,
    saleId,
    customerId,
    lines: lines.map((l) => ({
      productId: l.productId,
      productCode: l.code,
      productName: l.name,
      uomCode: l.uomCode,
      quantityScale: String(l.quantityScale),
      quantityBase: String(l.quantityBase),
      unitPriceMinor: String(l.unitPriceMinor),
      grossMinor: String(l.grossMinor),
      discountMinor: String(l.discountMinor),
      totalMinor: String(l.totalMinor),
    })),
    totalMinor: String(totalMinor),
  };
}
/** @param {string} kind @param {string} saleId @param {string} customerId @param {any[]} lines @param {string} totalMinor */
export function saleOverrideFacts(kind, saleId, customerId, lines, totalMinor) {
  const f = {
    ...saleDiscountFacts(saleId, customerId, lines, totalMinor),
    version: 3,
    kind,
  };
  if (kind === "price")
    f.lines = f.lines.map((l, i) => ({
      ...l,
      originalUnitPriceMinor: String(lines[i].originalUnitPriceMinor),
    }));
  return f;
}
/** @param {any[]} lines */
export function priceOverrideAmount(lines) {
  return lines.reduce((n, l) => {
    const before = extend(
        integer(l.originalUnitPriceMinor),
        integer(l.paidBase ?? l.quantityBase),
        integer(l.quantityScale, true),
      ),
      after = integer(l.grossMinor);
    return n + (after > before ? after - before : before - after);
  }, 0n);
}
/** F-511: reason/audit within own limit, the SAME second-approval authority above it.
 * @param {any} db @param {any} actor @param {any} input @param {Record<string,string|undefined>} env */
export async function enforceDiscount(db, actor, input, env) {
  return enforceFinancialOverride(
    db,
    actor,
    { ...input, kind: "discount" },
    env,
  );
}
/** F-124: all override kinds use the existing effective matrix and append-only request/events.
 * @param {any} db @param {any} actor @param {any} input @param {Record<string,string|undefined>} env */
export async function enforceFinancialOverride(db, actor, input, env) {
  const kind = choice(input.kind, OVERRIDE_KINDS);
  const reason = text(input.reason, 300, true),
    id = uuid(input.overrideId);
  const rule = await authorityRule(db, actor, { ...input, kind });
  if (integer(input.amountCentavos) <= BigInt(rule.self_limit_centavos)) {
    const [old] =
      await db`select id from fiscal_override_requests where id=${id}`;
    if (!old)
      await requestOverride(db, actor, {
        ...input,
        id,
        reason,
        kind,
      });
  }
  return enforceAuthority(db, actor, { ...input, kind, overrideId: id }, env);
}
