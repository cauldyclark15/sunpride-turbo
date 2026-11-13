import { activePromotions, applyPromotions } from "../orders/pricing.js";
import { alignPromotionPriceLists } from "../tpm/active.js";
import { eligibilityFacts } from "../tpm/campaigns.js";
import { eligibility, schemeUnits } from "../tpm/engine.js";
import { canonicalJson } from "../../core/util.js";
import { integer, refuse } from "./model.js";
const simple = new Set(["buy_x_get_y", "percent_off", "bundle"]);
/** F-110: do not authorize an exclusion-only rule using a missing canonical dimension.
 * @param {any} scope @param {any} facts */
function eligible(scope, facts) {
  const result = eligibility(scope ?? {}, facts);
  if (!result.eligible) return false;
  return Object.keys(scope ?? {}).every(
    (key) => facts[key] !== null && facts[key] !== undefined,
  );
}
/** @param {any[]} all @param {any} facts */
const matching = (all, facts) =>
  all.filter(
    (p) =>
      (p.benefit_timing ?? "on_invoice") === "on_invoice" &&
      eligible(p.eligibility, facts) &&
      eligible(p.campaign_scope, facts),
  );
/** F-110: the existing TPM engine is the only canonical scheme calculator. Verify gifts and exact native metadata too.
 * @param {any[]} lines @param {any[]} incoming @param {any[]} promotions @param {any} facts */
export function verifySchemeLines(lines, incoming, promotions, facts) {
  const selected = matching(promotions, facts);
  if (!selected.length) {
    for (const [i, line] of lines.entries()) {
      if (integer(line.freeBase) !== 0n)
        refuse(
          "The approved scheme changed; refresh or ask the office to review this saved sale",
        );
      if (incoming[i]?.promotion)
        refuse("The approved scheme no longer matches this sale");
      line.promotion = null;
      line.schemeDiscountMinor = "0";
    }
    return [];
  }
  const paid = lines.filter((l) => integer(l.paidBase) > 0n);
  const quote = applyPromotions(
    paid.map((l) => ({
      productId: l.productId,
      uom: l.uomCode,
      quantity: Number(l.paidBase) / Number(l.quantityScale),
      unitPriceCentavos: Number(l.unitPriceMinor),
      lineTotalCentavos: Number(l.grossMinor),
      priceListId: l.priceListId,
    })),
    selected,
    facts,
  );
  /** @type {Map<string,bigint>} */ const free = new Map();
  /** @type {Map<string,any>} */ const metadata = new Map();
  /** @type {Map<string,bigint>} */ const discounts = new Map(
    paid.map((l, i) => [l.productId, BigInt(quote.lineDiscounts[i])]),
  );
  for (const p of quote.promotionsApplied) {
    const meta = {
      promotionId: p.id,
      code: p.code,
      name: p.name,
      kind: p.kind,
    };
    if (
      p.kind !== "buy_x_get_y" &&
      p.kind !== "bogo" &&
      p.kind !== "free_goods"
    )
      for (const index of p.lineIndexes)
        metadata.set(paid[index].productId, meta);
    for (const gift of p.freeGoods) {
      const row = lines.find(
        (l) => l.productId === gift.productId && l.uomCode === gift.uom,
      );
      if (!row)
        refuse("Download the governed free item before completing this scheme");
      free.set(
        row.productId,
        (free.get(row.productId) ?? 0n) +
          BigInt(gift.quantity) * integer(row.quantityScale, true),
      );
      metadata.set(row.productId, meta);
    }
  }
  for (const [i, line] of lines.entries()) {
    if (
      integer(line.freeBase) !== (free.get(line.productId) ?? 0n) ||
      integer(line.discountMinor) < (discounts.get(line.productId) ?? 0n)
    )
      refuse(
        "The approved scheme changed; refresh or ask the office to review this saved sale",
      );
    const meta = metadata.get(line.productId) ?? null;
    if (canonicalJson(incoming[i]?.promotion ?? null) !== canonicalJson(meta))
      refuse("The approved scheme no longer matches this sale");
    line.promotion = meta;
    line.schemeDiscountMinor = String(discounts.get(line.productId) ?? 0n);
  }
  return quote.promotionsApplied;
}
/** @param {any} db @param {any} actor @param {any} trip @param {any} customer @param {any[]} lines @param {any[]} incoming @param {number} at */
export async function validateSaleSchemes(
  db,
  actor,
  trip,
  customer,
  lines,
  incoming,
  at,
) {
  // FLD-116: verify against the same SAP-mirror list alignment the native quote used.
  const all = await alignPromotionPriceLists(
    db,
    await activePromotions(db, trip.organization_id, at),
    lines.map((/** @type {any} */ l) => l.priceListId),
  );
  const facts = all.length
    ? await eligibilityFacts(
        { db, actor, now: at },
        { outletId: customer.id, at },
      )
    : {};
  return verifySchemeLines(lines, incoming, all, facts);
}
/** F-110: exact wire adapter, shared by projection and the API-to-native fixture.
 * @param {any} p @param {string[]} [outletIds] */
export function nativeScheme(p, outletIds = []) {
  if (!simple.has(p.rule.kind) || (p.engine_version ?? 1) !== 1)
    refuse("This programme needs a newer scheme engine");
  const unit = (/** @type {any} */ u) => ({
    productId: u.productId,
    uomCode: u.uom,
    quantity: u.quantity,
  });
  const r = p.rule;
  const rule = r.buy
    ? { kind: r.kind, buy: unit(r.buy), free: unit(r.free) }
    : r.item
      ? {
          kind: r.kind,
          item: unit(r.item),
          percentOffBasisPoints: r.percentOffBasisPoints,
        }
      : {
          kind: r.kind,
          components: r.components.map(unit),
          bundlePriceMinor: String(r.bundlePriceMinor),
        };
  return {
    promotionId: p.id,
    code: p.code,
    name: p.name,
    priceListId: null,
    effectiveFrom: new Date(p.effective_from).getTime(),
    effectiveTo: p.effective_to ? new Date(p.effective_to).getTime() : null,
    rule,
    engineVersion: 1,
    precedence: p.precedence ?? 100,
    stacking: p.stacking ?? "exclusive",
    exclusionGroup: p.exclusion_group ?? null,
    excludes: p.excludes ?? [],
    outletIds,
  };
}
/** F-110: bounded per-outlet eligibility for the existing three simple native mechanics.
 * Unsupported on-invoice programmes are explicit checkout holds, never silently dropped benefits.
 * @param {any} db @param {any} actor @param {any[]} customers @param {any[]} products @param {Map<string,Map<string,string|null>>} sourceLists @param {number} at */
export async function schemeFeed(
  db,
  actor,
  customers,
  products,
  sourceLists,
  at,
) {
  const all = await activePromotions(db, "sunpride", at);
  /** @type {Map<string,any>} */ const feed = new Map();
  /** @type {any[]} */ const holds = [];
  const byId = new Map(products.map((p) => [p.productId, p]));
  for (const customer of all.length ? customers : []) {
    const facts = await eligibilityFacts(
      { db, actor, now: at },
      { outletId: customer.outletId, at },
    );
    for (const p of matching(all, facts)) {
      const units = schemeUnits(p.rule);
      if (units.length && !units.some((u) => byId.has(u.productId))) continue;
      if (p.rule.kind === "percent_off" && p.rule.percentOffBasisPoints === 0)
        continue;
      const source = sourceLists.get(customer.outletId);
      if (
        p.price_list_id &&
        (p.rule.buy ? [p.rule.buy] : units).some(
          (u) => source?.get(u.productId) !== p.price_list_id,
        )
      )
        continue;
      if (
        !simple.has(p.rule.kind) ||
        (p.engine_version ?? 1) !== 1 ||
        units.some(
          (u) =>
            !byId.has(u.productId) || byId.get(u.productId).uomCode !== u.uom,
        ) ||
        (p.rule.kind === "bundle" && units.length < 2)
      ) {
        holds.push({
          outletId: customer.outletId,
          productIds: units
            .filter((u) => byId.has(u.productId))
            .map((u) => u.productId),
          code: p.code,
        });
        continue;
      }
      let row = feed.get(p.id);
      if (!row) {
        row = nativeScheme(p);
        feed.set(p.id, row);
      }
      row.outletIds.push(customer.outletId);
    }
  }
  if (feed.size > 50 || holds.length > 1000)
    refuse(
      "Scheme download exceeds supported bounds; narrow the active programme scope",
    );
  return { promotions: [...feed.values()], holds };
}
