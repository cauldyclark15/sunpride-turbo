import { activePromotions } from "./active.js";
import { eligibilityFacts } from "./campaigns.js";
import { eligibility, schemeUnits, ENGINE_VERSION } from "./engine.js";
import { fail } from "../orders/validation.js";
import { outletOwnerUnit } from "../org/scope.js";

/** F-502/F-503: export only already-authorized outlet/SKU facts. Do not disclose the
 * campaign's other customer/class/geography include/exclude lists to a handset.
 * The financial transaction must independently resolve these same facts again.
 * @param {any[]} promotions @param {any} facts @param {{productId:string,uom:string}[]} products */
export function nativePromotions(promotions, facts, products) {
  const units = new Set(products.map((p) => `${p.productId}|${p.uom}`));
  return promotions
    .filter(
      (p) =>
        (!p.channel_key || p.channel_key === facts.channelKey) &&
        eligibility(p.eligibility ?? {}, facts).eligible &&
        eligibility(p.campaign_scope ?? {}, facts).eligible &&
        schemeUnits(p.rule).every((u) => units.has(`${u.productId}|${u.uom}`)),
    )
    .map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      rule: p.rule,
      engine_version: p.engine_version ?? ENGINE_VERSION,
      price_list_id: p.price_list_id ?? null,
      campaign_version_id: p.campaign_version_id ?? null,
      benefit_timing: p.benefit_timing ?? "on_invoice",
      precedence: p.precedence ?? 100,
      stacking: p.stacking ?? "exclusive",
      exclusion_group: p.exclusion_group ?? null,
      excludes: p.excludes ?? [],
      eligibility: {},
      campaign_scope: {},
      effectiveFrom: +new Date(p.effective_from),
      effectiveTo: p.effective_to ? +new Date(p.effective_to) : null,
      sample: Boolean(p.planning_sample),
    }));
}

/** The caller already owns the outlet boundary. A rebate needs one unambiguous active ERP account.
 * @param {any} db @param {string} outletId @param {number} at */
export async function schemeAccountKey(db, outletId, at) {
  const date = new Date(at);
  const links =
    await db`select c.code from outlet_customer_links l join customers c on c.id=l.customer_id where l.outlet_id=${outletId} and l.deleted_at is null and c.deleted_at is null and c.active and l.effective_from<=${date} and (l.effective_to is null or l.effective_to>${date}) order by l.id limit 2`;
  return links.length === 1 ? links[0].code : null;
}

/** Native cached context is opt-in; frozen v1 clients keep their unchanged DTO.
 * It carries no approval tokens and grants no new outlet, product or financial access.
 * @param {any} c @param {{outletId:string,channelKey:string|null,orgUnitId?:string,products:any[],prices:any[],at?:number}} q */
export async function nativeSchemeContext(c, q) {
  const at = q.at ?? c.now,
    date = new Date(at);
  const facts = await eligibilityFacts(c, {
    outletId: q.outletId,
    channelKey: q.channelKey,
    at,
  });
  const offers = nativePromotions(
    await activePromotions(c.db, "sunpride", at),
    facts,
    q.products,
  );
  const accountKey = await schemeAccountKey(c.db, q.outletId, at);
  const orgUnitId =
    q.orgUnitId ?? (await outletOwnerUnit(c.db, q.outletId, at));
  const rules =
    await c.db`select * from fiscal_authority_rules where org_unit_id=${orgUnitId}
    and kind='discount' and role=${c.actor.role} and channel in (${facts.channelKey},'*')
    and effective_from<${new Date(at + 86400000)} and (effective_to is null or effective_to>${date}) order by effective_from,id limit 501`;
  if (rules.length > 500)
    fail("Narrow the effective discount authority configuration");
  const validUntil = Math.min(
    at + 86400000,
    ...rules.flatMap((/** @type {any} */ r) => [
      ...(+new Date(r.effective_from) > at
        ? [+new Date(r.effective_from)]
        : []),
      ...(r.effective_to ? [+new Date(r.effective_to)] : []),
    ]),
  );
  return {
    engineVersion: ENGINE_VERSION,
    outletId: q.outletId,
    accountLinked: Boolean(accountKey),
    quotedAt: at,
    validUntil,
    channelKey: facts.channelKey,
    products: q.products.map((p) => ({
      productId: p.productId,
      uom: p.uom,
      name: p.name ?? null,
      code: p.code ?? null,
    })),
    prices: q.prices.map((p) => ({
      productId: p.productId,
      uom: p.uom,
      priceListId: p.priceListId ?? null,
      unitPriceCentavos: p.unitPriceCentavos,
    })),
    promotions: offers,
    authority: rules
      .filter((/** @type {any} */ r) => +new Date(r.effective_from) <= at)
      .map((/** @type {any} */ r) => ({
        channel: r.channel,
        minCentavos: String(r.min_centavos),
        maxCentavos: String(r.max_centavos),
        selfLimitCentavos: String(r.self_limit_centavos),
      })),
  };
}
