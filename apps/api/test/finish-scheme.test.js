import { test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { verifySchemeLines, nativeScheme } from "../src/domains/van/schemes.js";
test("F-110 no active scheme preserves ordinary selling quantities without entering programme-only bounds", () => {
  const lines = [
    {
      productId: "SAMPLE",
      paidBase: "1000001",
      freeBase: "0",
      quantityBase: "1000001",
      quantityScale: "1",
      unitPriceMinor: "1",
      grossMinor: "1000001",
      discountMinor: "0",
      totalMinor: "1000001",
    },
  ];
  expect(verifySchemeLines(lines, structuredClone(lines), [], {})).toEqual([]);
  expect(lines[0].totalMinor).toBe("1000001");
});
const a = "00000000-0000-4000-8000-000000000101",
  b = "00000000-0000-4000-8000-000000000102",
  outlet = "00000000-0000-4000-8000-000000000201";
/** @param {string} productId @param {number} [quantity] */
const unit = (productId, quantity = 1) => ({ productId, uom: "EA", quantity });
/** @param {string} code @param {any} rule @param {number} [precedence] @param {string} [stacking] */
const programme = (code, rule, precedence = 100, stacking = "exclusive") => ({
  id: crypto.randomUUID(),
  code,
  name: `SAMPLE ${code}`,
  rule,
  precedence,
  stacking,
  engine_version: 1,
  effective_from: "2026-01-01T00:00:00Z",
  effective_to: null,
});
/** @param {any} p */
const meta = (p) => ({
  promotionId: p.id,
  code: p.code,
  name: p.name,
  kind: p.rule.kind,
});
/** @param {string} productId @param {number} price @param {number} paid @param {number} free @param {number} discount @param {any} [promotion] */
const row = (productId, price, paid, free, discount, promotion = null) => ({
  productId,
  uomCode: "EA",
  quantityScale: "1",
  quantityBase: String(paid + free),
  paidBase: String(paid),
  freeBase: String(free),
  unitPriceMinor: String(price),
  grossMinor: String(price * paid),
  discountMinor: String(discount),
  totalMinor: String(price * paid - discount),
  priceListId: "SAMPLE-BOOK",
  promotion,
});
test("F-110 canonical simple schemes validate stacking, half-up, allocated bundles and governed gifts; native wire keeps exact semantics", async () => {
  const p1 = programme(
    "SAMPLE-P1",
    { kind: "percent_off", item: unit(a), percentOffBasisPoints: 5000 },
    10,
    "stackable",
  );
  const p2 = programme(
    "SAMPLE-P2",
    { kind: "percent_off", item: unit(a), percentOffBasisPoints: 1000 },
    20,
    "stackable",
  );
  const skipped = programme(
    "SAMPLE-EXCLUSIVE",
    { kind: "percent_off", item: unit(a), percentOffBasisPoints: 9000 },
    30,
  );
  const bundle = programme("SAMPLE-BUNDLE", {
    kind: "bundle",
    components: [unit(a), unit(b)],
    bundlePriceMinor: 200,
  });
  const gift = programme("SAMPLE-GIFT", {
    kind: "buy_x_get_y",
    buy: unit(a, 2),
    free: unit(b),
  });
  const cases = [
    {
      name: "residual stacking and manual basket",
      promotions: [skipped, p2, p1],
      basketMinor: 3,
      cart: [{ productId: a, quantityBase: "1" }],
      lines: [row(a, 101, 1, 0, 59, meta(p2))],
    },
    {
      name: "bundle and manual basket",
      promotions: [bundle],
      basketMinor: 5,
      cart: [
        { productId: a, quantityBase: "1" },
        { productId: b, quantityBase: "1" },
      ],
      lines: [
        row(a, 101, 1, 0, 37, meta(bundle)),
        row(b, 202, 1, 0, 71, meta(bundle)),
      ],
    },
    {
      name: "free stock item",
      promotions: [gift],
      basketMinor: 0,
      cart: [{ productId: a, quantityBase: "4" }],
      lines: [row(a, 101, 4, 0, 0), row(b, 202, 0, 2, 0, meta(gift))],
    },
  ];
  const facts = { outletId: outlet, channelKey: "general" };
  for (const c of cases) {
    const applied = verifySchemeLines(
      c.lines,
      structuredClone(c.lines),
      c.promotions,
      facts,
    );
    expect(applied.length).toBe(c === cases[0] ? 2 : 1);
    const tampered = structuredClone(c.lines);
    const index = tampered.findIndex((l) => l.promotion);
    tampered[index].promotion = {
      ...tampered[index].promotion,
      code: "UNAPPROVED",
    };
    expect(() =>
      verifySchemeLines(
        structuredClone(c.lines),
        tampered,
        c.promotions,
        facts,
      ),
    ).toThrow("no longer matches");
  }
  const forged = structuredClone(cases[2].lines);
  forged[1].freeBase = "3";
  expect(() => verifySchemeLines(forged, forged, [gift], facts)).toThrow(
    "approved scheme changed",
  );
  if (process.env.SP_NATIVE_SCHEME_WIRE)
    await writeFile(
      process.env.SP_NATIVE_SCHEME_WIRE,
      JSON.stringify({
        at: Date.UTC(2026, 9, 21),
        outletId: outlet,
        priceListId: "SAMPLE-BOOK",
        products: [
          {
            productId: a,
            code: "SAMPLE-A",
            name: "SAMPLE A",
            unitPriceMinor: "101",
          },
          {
            productId: b,
            code: "SAMPLE-B",
            name: "SAMPLE B",
            unitPriceMinor: "202",
          },
        ],
        cases: cases.map((c) => ({
          ...c,
          promotions: c.promotions.map((p) => nativeScheme(p, [outlet])),
          expected: c.lines.map((l) =>
            Object.fromEntries(
              Object.entries(l).filter(([k]) =>
                [
                  "productId",
                  "quantityBase",
                  "paidBase",
                  "freeBase",
                  "unitPriceMinor",
                  "grossMinor",
                  "discountMinor",
                  "totalMinor",
                  "promotion",
                ].includes(k),
              ),
            ),
          ),
        })),
      }),
      { mode: 0o600 },
    );
});
