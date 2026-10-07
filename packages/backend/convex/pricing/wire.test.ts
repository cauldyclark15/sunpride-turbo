import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { MAX_LISTS_PER_CHANNEL } from "./model";
import { MAX_PROMOTIONS, promotionsAt } from "./promotions";
import { vanPricing } from "./wire";

type T = TestConvex<typeof schema>;
const NOW = Date.parse("2026-10-07T02:00:00Z");

async function setup() {
  const t: T = convexTest(schema, modules);
  const productId = await t.run((ctx) =>
    ctx.db.insert("products", {
      code: "P-1",
      name: "Pineapple Juice 240ml",
      category: "Beverages",
      uom: "PC",
      unitPrice: 0,
      active: true,
      organizationId: "sunpride",
      updatedAt: NOW,
    }),
  );
  return { t, productId };
}

async function list(t: T, code: string, channelKey: string | null) {
  return t.run((ctx) =>
    ctx.db.insert("priceLists", {
      organizationId: "sunpride",
      code,
      name: code,
      channelKey,
      currency: "PHP",
      status: "active",
      source: "office",
      effectiveFrom: 0,
      updatedAt: NOW,
    }),
  );
}

async function line(
  t: T,
  priceListId: Id<"priceLists">,
  productId: Id<"products">,
  unitPriceMinor: number,
) {
  await t.run((ctx) =>
    ctx.db.insert("priceListLines", {
      organizationId: "sunpride",
      priceListId,
      productId,
      uom: "PC",
      unitPriceMinor,
      effectiveFrom: 0,
      effectiveTo: NOW + 86_400_000,
      updatedAt: NOW,
    }),
  );
}

async function promotion(
  t: T,
  code: string,
  productId: Id<"products">,
  priceListId?: Id<"priceLists">,
) {
  await t.run((ctx) =>
    ctx.db.insert("promotions", {
      organizationId: "sunpride",
      code,
      name: code,
      ...(priceListId ? { priceListId } : {}),
      rule: {
        kind: "percent_off",
        item: { productId, uom: "CASE", quantity: 1 },
        percentOffBasisPoints: 500,
      },
      status: "active",
      source: "office",
      effectiveFrom: 0,
      updatedAt: NOW,
    }),
  );
}

describe("van pricing on the SP-0088 price lists (SP-0129)", () => {
  it("ships the Route Sales line in the truck unit with its effective window and list promotions", async () => {
    const { t, productId } = await setup();
    const rs = await list(t, "RS", "route sales");
    const other = await list(t, "KA", "key accounts");
    await line(t, rs, productId, 6850);
    await promotion(t, "ALL", productId);
    await promotion(t, "RS-ONLY", productId, rs);
    await promotion(t, "KA-ONLY", productId, other);
    const pricing = await t.run((ctx) =>
      vanPricing(ctx, [{ productId, uomCode: "PC" }], NOW),
    );
    expect(pricing.priceLines).toEqual([
      {
        priceListId: rs,
        priceListCode: "RS",
        productId,
        uomCode: "PC",
        unitPriceMinor: "6850",
        currency: "PHP",
        effectiveFrom: 0,
        effectiveTo: NOW + 86_400_000,
      },
    ]);
    expect(pricing.promotions.map((p) => p.code)).toEqual(["ALL", "RS-ONLY"]);
    expect(pricing.promotions[0]!.rule).toEqual({
      kind: "percent_off",
      item: { productId, uomCode: "CASE", quantity: 1 },
      percentOffBasisPoints: 500,
    });
  });

  it("prices nothing when the Route Sales channel is ambiguous, including past the read bound", async () => {
    const { t, productId } = await setup();
    const first = await list(t, "RS-1", "route sales");
    await line(t, first, productId, 6850);
    // One extra competing list beyond the bounded read: never silently picked as unique.
    for (let i = 2; i <= MAX_LISTS_PER_CHANNEL + 1; i++) {
      const id = await list(t, `RS-${i}`, "route sales");
      if (i === MAX_LISTS_PER_CHANNEL + 1) await line(t, id, productId, 9900);
      else await t.run((ctx) => ctx.db.patch(id, { status: "inactive" }));
    }
    const pricing = await t.run((ctx) =>
      vanPricing(ctx, [{ productId, uomCode: "PC" }], NOW),
    );
    expect(pricing).toEqual({ priceLines: [], promotions: [] });
  });

  it("withholds promotions on overflow and for products not on the truck", async () => {
    const { t, productId } = await setup();
    const rs = await list(t, "RS", "route sales");
    await line(t, rs, productId, 6850);
    const elsewhere = await t.run((ctx) =>
      ctx.db.insert("products", {
        code: "P-2",
        name: "Corned Beef",
        category: "Canned",
        uom: "PC",
        unitPrice: 0,
        active: true,
        organizationId: "sunpride",
        updatedAt: NOW,
      }),
    );
    await promotion(t, "OFF-TRUCK", elsewhere);
    expect(
      (
        await t.run((ctx) =>
          vanPricing(ctx, [{ productId, uomCode: "PC" }], NOW),
        )
      ).promotions,
    ).toEqual([]);
    for (let i = 0; i < MAX_PROMOTIONS; i++)
      await promotion(t, `P-${String(i).padStart(3, "0")}`, productId);
    const read = await t.run((ctx) => promotionsAt(ctx, rs, NOW));
    expect(read).toEqual({ overflow: true, promotions: [] });
    const pricing = await t.run((ctx) =>
      vanPricing(ctx, [{ productId, uomCode: "PC" }], NOW),
    );
    expect(pricing.priceLines).toHaveLength(1);
    expect(pricing.promotions).toEqual([]);
  });
});
