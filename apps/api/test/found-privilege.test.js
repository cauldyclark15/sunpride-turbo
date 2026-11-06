import { describe, expect, it } from "bun:test";
import {
  PRIVILEGE_TYPES,
  PRIVILEGE_LABELS,
  computeLine,
  computeCart,
} from "../src/domains/fiscal/privilege.js";
import { invoiceTaxSnapshot } from "../src/domains/fiscal/taxes.js";

/** @param {any} o */
const line = (o) => ({
  qty: 1,
  vatRateBps: 1200,
  taxTreatment: "vatable",
  ...o,
});
/** bucket invariant: buckets before privilege discount = amount to pay + privilege discount */
/** @param {any} r */
const buckets = (r) =>
  r.vatableCentavos + r.vatCentavos + r.vatExemptCentavos + r.zeroRatedCentavos;

describe("privilege types", () => {
  it("lists the five types with labels", () => {
    expect(PRIVILEGE_TYPES).toEqual([
      "senior",
      "pwd",
      "solo_parent",
      "athlete",
      "uniformed",
    ]);
    expect(PRIVILEGE_LABELS.athlete).toBe("National athlete/coach");
    expect(PRIVILEGE_LABELS.senior).toBe("Senior citizen");
  });
});

describe("computeLine", () => {
  it("Itemcount observed case: P39.00 vatable 12% + Senior = P27.86", () => {
    const r = computeLine(
      line({ unitPriceCentavos: 3900, privilege: { type: "senior" } }),
    );
    expect(r.netCentavos).toBe(2786);
    expect(r.vatRemovedCentavos).toBe(418);
    expect(r.privilegeDiscountCentavos).toBe(696);
    expect(r.vatExemptCentavos).toBe(3482);
    expect(r.vatableCentavos).toBe(0);
    expect(r.vatCentavos).toBe(0);
    expect(buckets(r)).toBe(r.netCentavos + r.privilegeDiscountCentavos);
  });
  it("R1 worked example: P112 senior -> VAT 12, discount 20, pay 80", () => {
    const r = computeLine(
      line({ unitPriceCentavos: 11200, privilege: { type: "pwd" } }),
    );
    expect(r).toMatchObject({
      vatRemovedCentavos: 1200,
      privilegeDiscountCentavos: 2000,
      netCentavos: 8000,
      vatExemptCentavos: 10000,
    });
  });
  it("VAT-exempt item + senior: no VAT to remove, 20% of the price (P112 -> P89.60)", () => {
    const r = computeLine({
      unitPriceCentavos: 11200,
      qty: 1,
      taxTreatment: "exempt",
      privilege: { type: "senior" },
    });
    expect(r).toMatchObject({
      privilegeDiscountCentavos: 2240,
      netCentavos: 8960,
      vatExemptCentavos: 11200,
      vatRemovedCentavos: 0,
    });
  });
  it("zero-rated + senior goes to the zero-rated bucket", () => {
    const r = computeLine({
      unitPriceCentavos: 10000,
      qty: 1,
      taxTreatment: "zero_rated",
      privilege: { type: "senior" },
    });
    expect(r).toMatchObject({
      zeroRatedCentavos: 10000,
      privilegeDiscountCentavos: 2000,
      netCentavos: 8000,
      vatExemptCentavos: 0,
    });
  });
  it("solo parent and uniformed: VAT removed then 10%", () => {
    for (const type of ["solo_parent", "uniformed"]) {
      const r = computeLine(
        line({ unitPriceCentavos: 11200, privilege: { type } }),
      );
      expect(r).toMatchObject({
        vatRemovedCentavos: 1200,
        privilegeDiscountCentavos: 1000,
        netCentavos: 9000,
      });
    }
  });
  it("athlete keeps VAT: 20% of the VAT-exclusive amount, VAT stays in the vatable buckets", () => {
    const r = computeLine(
      line({ unitPriceCentavos: 11200, privilege: { type: "athlete" } }),
    );
    expect(r).toMatchObject({
      vatableCentavos: 10000,
      vatCentavos: 1200,
      vatExemptCentavos: 0,
      privilegeDiscountCentavos: 2000,
      netCentavos: 9200,
      vatRemovedCentavos: 0,
    });
    expect(buckets(r)).toBe(r.netCentavos + r.privilegeDiscountCentavos);
  });
  it("plain vatable line splits VAT half-up and matches invoiceTaxSnapshot", () => {
    for (const gross of [3900, 10, 1, 11199, 12345, 99999]) {
      const r = computeLine(line({ unitPriceCentavos: gross }));
      const snap = invoiceTaxSnapshot(
        [
          {
            totalMinor: String(gross),
            taxBasisPoints: 1200,
            taxCode: "VAT12",
            taxTreatment: "vatable",
            sourceTaxInclusive: true,
          },
        ],
        String(gross),
      );
      expect(String(r.vatableCentavos)).toBe(snap.vatableSalesMinor);
      expect(String(r.vatCentavos)).toBe(snap.vatMinor);
      expect(r.netCentavos).toBe(gross);
    }
  });
  it("promo versus privilege: the larger benefit wins, they never stack", () => {
    // P112 senior benefit = 12.00 + 20.00 = 32.00
    const privWins = computeLine(
      line({
        unitPriceCentavos: 11200,
        privilege: { type: "senior" },
        promoDiscountCentavos: 3000,
      }),
    );
    expect(privWins.privilegeDiscountCentavos).toBe(2000);
    expect(privWins.promoDiscountCentavos).toBe(0);
    expect(privWins.netCentavos).toBe(8000);
    const promoWins = computeLine(
      line({
        unitPriceCentavos: 11200,
        privilege: { type: "senior" },
        promoDiscountCentavos: 4000,
      }),
    );
    expect(promoWins.privilegeDiscountCentavos).toBe(0);
    expect(promoWins.promoDiscountCentavos).toBe(4000);
    expect(promoWins.netCentavos).toBe(7200);
    expect(promoWins.vatRemovedCentavos).toBe(0);
    expect(buckets(promoWins)).toBe(7200);
    expect(promoWins.vatableCentavos + promoWins.vatCentavos).toBe(7200);
  });
  it("a tie goes to the promo", () => {
    const r = computeLine(
      line({
        unitPriceCentavos: 11200,
        privilege: { type: "senior" },
        promoDiscountCentavos: 3200,
      }),
    );
    expect(r.promoDiscountCentavos).toBe(3200);
    expect(r.privilegeDiscountCentavos).toBe(0);
  });
  it("promo alone reduces the VAT base; a promo larger than the line is capped", () => {
    const r = computeLine(
      line({ unitPriceCentavos: 11200, promoDiscountCentavos: 1200 }),
    );
    expect(r).toMatchObject({
      netCentavos: 10000,
      vatableCentavos: 8929,
      vatCentavos: 1071,
      promoDiscountCentavos: 1200,
    });
    const capped = computeLine(
      line({ unitPriceCentavos: 500, promoDiscountCentavos: 9999 }),
    );
    expect(capped).toMatchObject({
      promoDiscountCentavos: 500,
      netCentavos: 0,
    });
  });
  it("rounds half-up at the line (quantity multiplies before the VAT split)", () => {
    // 3 x 0.50 = 1.50 -> net 1.34 (1.3392857), vat 0.16
    const a = computeLine(line({ unitPriceCentavos: 50, qty: 3 }));
    expect(a).toMatchObject({
      grossCentavos: 150,
      vatableCentavos: 134,
      vatCentavos: 16,
    });
    // 0.5 centavo boundary: gross 14 -> 14/1.12 = 12.5 exactly -> rounds up to 13
    const b = computeLine(line({ unitPriceCentavos: 14 }));
    expect(b).toMatchObject({ vatableCentavos: 13, vatCentavos: 1 });
    // senior discount boundary: net 125 * 20% = 25 ; gross 140 -> net 125
    const c = computeLine(
      line({ unitPriceCentavos: 140, privilege: { type: "senior" } }),
    );
    expect(c).toMatchObject({
      vatExemptCentavos: 125,
      privilegeDiscountCentavos: 25,
      netCentavos: 100,
    });
    // fractional weighed quantity rounds the gross half-up
    const d = computeLine(
      line({
        unitPriceCentavos: 1000,
        qty: 0.125,
        taxTreatment: "exempt",
        vatRateBps: 0,
      }),
    );
    expect(d.grossCentavos).toBe(125);
  });
  it("refuses zero, negative or bad quantity", () => {
    for (const qty of [0, -1, Number.NaN, Infinity])
      expect(() => computeLine(line({ unitPriceCentavos: 100, qty }))).toThrow(
        /more than zero/,
      );
  });
  it("refuses bad money and bad setup", () => {
    expect(() => computeLine(line({ unitPriceCentavos: 1.5 }))).toThrow(
      /whole centavos/,
    );
    expect(() => computeLine(line({ unitPriceCentavos: -5 }))).toThrow();
    expect(() =>
      computeLine(line({ unitPriceCentavos: 100, vatRateBps: 0 })),
    ).toThrow(/VAT rate/);
    expect(() =>
      computeLine(line({ unitPriceCentavos: 100, taxTreatment: "weird" })),
    ).toThrow(/tax treatment/);
    expect(() =>
      computeLine(line({ unitPriceCentavos: 100, privilege: { type: "vip" } })),
    ).toThrow(/Unknown discount/);
  });
  it("buckets always add up to pay + privilege discount", () => {
    for (const type of [null, ...PRIVILEGE_TYPES])
      for (const treatment of ["vatable", "exempt", "zero_rated"])
        for (const p of [1, 7, 99, 3900, 12345, 100000])
          for (const promo of [0, 10, 500]) {
            const r = computeLine({
              unitPriceCentavos: p,
              qty: 2,
              vatRateBps: 1200,
              taxTreatment: /** @type {any} */ (treatment),
              privilege: type ? { type } : undefined,
              promoDiscountCentavos: promo,
            });
            expect(buckets(r)).toBe(
              r.netCentavos + r.privilegeDiscountCentavos,
            );
            expect(r.netCentavos).toBeGreaterThanOrEqual(0);
          }
  });
});

describe("computeCart", () => {
  it("mixed cart: vatable + exempt + zero-rated, no privilege", () => {
    const c = computeCart([
      line({ unitPriceCentavos: 11200 }),
      { unitPriceCentavos: 5000, qty: 2, taxTreatment: "exempt" },
      { unitPriceCentavos: 2500, qty: 1, taxTreatment: "zero_rated" },
    ]);
    expect(c).toMatchObject({
      vatable: 10000,
      vat: 1200,
      vatExempt: 10000,
      zeroRated: 2500,
      privilegeDiscount: 0,
      promoDiscount: 0,
      total: 23700,
    });
  });
  it("cart-level senior applies to every line; null opts a line out (mixed cart)", () => {
    const c = computeCart(
      [
        line({ unitPriceCentavos: 11200 }),
        line({ unitPriceCentavos: 11200, privilege: null }),
      ],
      { privilege: { type: "senior" } },
    );
    expect(c.privilegeDiscount).toBe(2000);
    expect(c.vatExempt).toBe(10000);
    expect(c.vatable).toBe(10000);
    expect(c.vat).toBe(1200);
    expect(c.total).toBe(8000 + 11200);
    expect(c.total + c.privilegeDiscount).toBe(
      c.vatable + c.vat + c.vatExempt + c.zeroRated,
    );
  });
  it("per-line privilege overrides the cart-level one", () => {
    const c = computeCart(
      [
        line({ unitPriceCentavos: 11200 }),
        line({ unitPriceCentavos: 11200, privilege: { type: "solo_parent" } }),
      ],
      { privilege: { type: "senior" } },
    );
    expect(c.privilegeDiscount).toBe(2000 + 1000);
    expect(c.total).toBe(8000 + 9000);
  });
  it("a cart total is the sum of line-rounded totals", () => {
    const c = computeCart(
      Array.from({ length: 3 }, () =>
        line({ unitPriceCentavos: 3900, privilege: { type: "senior" } }),
      ),
    );
    expect(c.total).toBe(3 * 2786);
  });
  it("refuses an empty cart or a zero-quantity line", () => {
    expect(() => computeCart([])).toThrow();
    expect(() =>
      computeCart([line({ unitPriceCentavos: 100, qty: 0 })]),
    ).toThrow(/more than zero/);
  });
});
