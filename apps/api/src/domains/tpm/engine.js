import {
  divide,
  fail,
  integer,
  quantityMilli,
  safe,
  text,
} from "../orders/validation.js";

export const ENGINE_VERSION = 1;
export const DIMENSIONS = [
  "outletId",
  "classKey",
  "channelKey",
  "territoryId",
  "geographyKey",
  "distributorId",
];
/** F-503: include dimensions AND together; an exclusion always wins. Missing facts fail closed.
 * @param {any} scope @param {any} facts */
export function eligibility(scope = {}, facts = {}) {
  const reasons = [];
  for (const dimension of DIMENSIONS) {
    const rule = scope[dimension];
    if (!rule) continue;
    if (rule.exclude?.includes(facts[dimension]))
      reasons.push(`${dimension}:excluded`);
    if (rule.include?.length && !rule.include.includes(facts[dimension]))
      reasons.push(`${dimension}:not_included`);
  }
  return { eligible: reasons.length === 0, reasons };
}
/** @param {any} scope */
export function validateScope(scope = {}) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope))
    fail("Eligibility scope must be an object");
  for (const [key, rule] of Object.entries(scope)) {
    if (
      !DIMENSIONS.includes(key) ||
      !rule ||
      typeof rule !== "object" ||
      Array.isArray(rule)
    )
      fail("Unknown eligibility dimension");
    for (const name of Object.keys(rule)) {
      const values = rule[name];
      if (
        !["include", "exclude"].includes(name) ||
        !Array.isArray(values) ||
        values.length > 1000 ||
        values.some((v) => typeof v !== "string" || !v || v.length > 160)
      )
        fail("Eligibility sets need bounded text values");
    }
  }
  return scope;
}
/** @param {any} u */
function unit(u) {
  if (!u) fail("Scheme product and selling unit are required");
  text(u.productId, "Product", 100);
  text(u.uom, "Selling unit", 32);
  if (!integer(u.quantity, "Quantity", 1_000_000))
    fail("Scheme quantity must be positive");
}
/** F-502: wire semantics v1; legacy mechanics are input aliases, not a second evaluator. @param {any} r */
export function validateScheme(r) {
  if (!r || typeof r !== "object" || Array.isArray(r))
    fail("Scheme rule is required");
  if (["buy_x_get_y", "bogo", "free_goods"].includes(r.kind)) {
    unit(r.buy);
    unit(r.free);
  } else if (["bundle", "combo"].includes(r.kind)) {
    if (
      !Array.isArray(r.components) ||
      !r.components.length ||
      r.components.length > 100
    )
      fail("Combo needs 1–100 components");
    r.components.forEach(unit);
    if (
      new Set(
        r.components.map((/** @type {any} */ u) => `${u.productId}|${u.uom}`),
      ).size !== r.components.length
    )
      fail("Combo components must be unique");
    integer(r.bundlePriceMinor, "Combo price");
  } else if (
    ["percent_off", "value_off", "quantity_off", "slab"].includes(r.kind)
  ) {
    unit(r.item);
    if (r.kind === "percent_off")
      integer(r.percentOffBasisPoints, "Discount basis points", 10000);
    if (r.kind === "value_off") integer(r.valueCentavos, "Value off");
    if (r.kind === "quantity_off")
      integer(r.quantityOff, "Quantity off", r.item.quantity);
    if (r.kind === "slab") {
      if (!Array.isArray(r.slabs) || !r.slabs.length || r.slabs.length > 50)
        fail("Add 1–50 slabs");
      let prior = 0;
      for (const slab of r.slabs) {
        integer(slab.minQuantity, "Slab threshold", 1_000_000);
        if (slab.minQuantity <= prior) fail("Slab thresholds must increase");
        integer(slab.percentOffBasisPoints, "Discount basis points", 10000);
        prior = slab.minQuantity;
      }
    }
  } else if (r.kind === "basket") {
    integer(r.minSubtotalCentavos, "Basket threshold");
    if (r.percentOffBasisPoints != null && r.valueCentavos != null)
      fail("Choose percent OR value for a basket benefit");
    if (r.percentOffBasisPoints == null && r.valueCentavos == null)
      fail("Basket benefit is required");
    if (r.percentOffBasisPoints != null)
      integer(r.percentOffBasisPoints, "Discount basis points", 10000);
    if (r.valueCentavos != null) integer(r.valueCentavos, "Value off");
  } else fail("Unsupported scheme mechanic");
  return r;
}
/** @param {any} r @returns {any[]} */
export const schemeUnits = (r) =>
  r.components ?? (r.buy ? [r.buy, r.free] : r.item ? [r.item] : []);
/** Exact proportional largest-remainder-centavo allocation, stable input order. @param {number} discount @param {number[]} balances @param {number[]} indexes */
function allocate(discount, balances, indexes) {
  const total = indexes.reduce((n, i) => n + BigInt(balances[i]), 0n);
  const out = balances.map(() => 0);
  if (!total) return out;
  for (const i of indexes)
    out[i] = safe((BigInt(discount) * BigInt(balances[i])) / total);
  let remaining = discount - out.reduce((a, b) => a + b, 0);
  for (const i of indexes)
    if (remaining && out[i] < balances[i]) {
      out[i]++;
      remaining--;
    }
  return out;
}
/** F-502 deterministic precedence (lower first, then code), residual-net stacking, exclusive groups.
 * @param {any[]} lines @param {any[]} promotions @param {any} [facts] */
export function evaluateSchemes(lines, promotions, facts = {}) {
  if (lines.length > 100 || promotions.length > 500)
    fail("Scheme evaluation exceeds supported bounds");
  const known = lines.every((l) => l.lineTotalCentavos !== null);
  const balances = lines.map((l) => integer(l.lineTotalCentavos ?? 0));
  const subtotal = safe(balances.reduce((n, v) => n + BigInt(v), 0n));
  const lineDiscounts = lines.map(() => 0);
  /** @type {any[]} */ const applied = [],
    explanations = [];
  const groups = new Set(),
    blocked = new Set();
  let exclusive = false;
  const ordered = [...promotions].sort(
    (a, b) =>
      (a.precedence ?? 100) - (b.precedence ?? 100) ||
      a.code.localeCompare(b.code),
  );
  for (const p of ordered) {
    if ((p.engine_version ?? 1) !== ENGINE_VERSION)
      fail("Unsupported scheme engine version");
    const r = validateScheme(p.rule);
    const a = eligibility(p.eligibility ?? {}, facts),
      b = eligibility(p.campaign_scope ?? {}, facts);
    const decision = {
      eligible: a.eligible && b.eligible,
      reasons: [...a.reasons, ...b.reasons],
    };
    if (!decision.eligible) {
      explanations.push({ id: p.id, ...decision });
      continue;
    }
    if (
      exclusive ||
      blocked.has(p.code) ||
      (p.exclusion_group && groups.has(p.exclusion_group)) ||
      (p.excludes ?? []).some((/** @type {string} */ code) =>
        applied.some((a) => a.code === code),
      ) ||
      ((p.stacking ?? "exclusive") === "exclusive" && applied.length)
    )
      continue;
    const units = r.components ?? (r.buy ? [r.buy] : r.item ? [r.item] : []);
    /** @type {number[]} */
    const indexes = units.length
      ? units.map((/** @type {any} */ u) =>
          lines.findIndex(
            (l) =>
              l.productId === u.productId &&
              l.uom === u.uom &&
              (p.price_list_id == null || p.price_list_id === l.priceListId),
          ),
        )
      : lines.map((_, i) => i);
    if (indexes.some((i) => i < 0 || lines[i].unitPriceCentavos === null))
      continue;
    const multiples = units.length
      ? Math.min(
          ...units.map((/** @type {any} */ u, /** @type {number} */ i) =>
            Number(
              quantityMilli(lines[indexes[i]].quantity) /
                (BigInt(u.quantity) * 1000n),
            ),
          ),
        )
      : 1;
    if (multiples < 1 || (!known && r.kind === "basket")) continue;
    const available = safe(
      indexes.reduce((n, i) => n + BigInt(balances[i]), 0n),
    );
    let discount = 0;
    /** @type {any[]} */ let freeGoods = [];
    if (r.kind === "percent_off")
      discount = safe(
        divide(BigInt(available) * BigInt(r.percentOffBasisPoints), 10000n),
      );
    if (["buy_x_get_y", "bogo", "free_goods"].includes(r.kind))
      freeGoods = [
        {
          ...r.free,
          quantity: safe(BigInt(r.free.quantity) * BigInt(multiples)),
        },
      ];
    if (r.kind === "value_off")
      discount = safe(BigInt(r.valueCentavos) * BigInt(multiples));
    if (r.kind === "quantity_off")
      discount = safe(
        BigInt(lines[indexes[0]].unitPriceCentavos) *
          BigInt(r.quantityOff) *
          BigInt(multiples),
      );
    if (["bundle", "combo"].includes(r.kind)) {
      const gross = units.reduce(
        (
          /** @type {bigint} */ n,
          /** @type {any} */ u,
          /** @type {number} */ i,
        ) =>
          n + BigInt(lines[indexes[i]].unitPriceCentavos) * BigInt(u.quantity),
        0n,
      );
      discount = Math.max(
        0,
        safe((gross - BigInt(r.bundlePriceMinor)) * BigInt(multiples)),
      );
    }
    if (r.kind === "slab") {
      const slab = [...r.slabs]
        .reverse()
        .find(
          (s) =>
            quantityMilli(lines[indexes[0]].quantity) >=
            BigInt(s.minQuantity) * 1000n,
        );
      if (slab)
        discount = safe(
          divide(
            BigInt(available) * BigInt(slab.percentOffBasisPoints),
            10000n,
          ),
        );
    }
    if (r.kind === "basket" && subtotal >= r.minSubtotalCentavos)
      discount =
        r.valueCentavos ??
        safe(
          divide(BigInt(available) * BigInt(r.percentOffBasisPoints), 10000n),
        );
    discount = Math.min(discount, available);
    if (!discount && !freeGoods.length) continue;
    const allocations = allocate(discount, balances, indexes);
    allocations.forEach((d, i) => {
      balances[i] -= d;
      lineDiscounts[i] += d;
    });
    applied.push({
      id: p.id,
      code: p.code,
      name: p.name,
      kind: r.kind,
      engineVersion: ENGINE_VERSION,
      campaignVersionId: p.campaign_version_id ?? null,
      discountCentavos: discount,
      freeGoods,
      lineIndexes: indexes,
      allocations,
    });
    if (p.exclusion_group) groups.add(p.exclusion_group);
    for (const code of p.excludes ?? []) blocked.add(code);
    exclusive = (p.stacking ?? "exclusive") === "exclusive";
  }
  return {
    engineVersion: ENGINE_VERSION,
    subtotalCentavos: known ? subtotal : null,
    knownSubtotalCentavos: subtotal,
    totalCentavos: known ? balances.reduce((a, b) => a + b, 0) : null,
    promotionsApplied: applied,
    lineDiscounts,
    eligibility: explanations,
  };
}
