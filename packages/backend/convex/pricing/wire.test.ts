import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { MAX_LISTS_PER_CHANNEL } from "./model";
import { MAX_PROMOTIONS, promotionsAt } from "./promotions";
import { VAN_MAX_PRICE_LINES, vanCustomerPricing, vanPricing } from "./wire";

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

async function outlet(t: T, code: string, channel?: string) {
  return t.run(async (ctx) => {
    const unit = await ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      code: `U-${code}`,
      name: `Unit ${code}`,
      typeCode: "TERRITORY",
      status: "active",
      effectiveFrom: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    return ctx.db.insert("outlets", {
      organizationId: "sunpride",
      code,
      name: code,
      status: "active",
      custodianOrgUnitId: unit,
      createdBy: "test|seed",
      ...(channel ? { channel } : {}),
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
}

describe("customer price lists on the van (SP-0105)", () => {
  it("prices each customer by its outlet channel list, else the Route Sales list, with each list's promotions", async () => {
    const { t, productId } = await setup();
    const rs = await list(t, "RS", "route sales");
    const ka = await list(t, "KA", "key accounts");
    await line(t, rs, productId, 6850);
    await line(t, ka, productId, 6575);
    await promotion(t, "ALL", productId);
    await promotion(t, "KA-ONLY", productId, ka);
    await promotion(t, "PM-ONLY", productId, await list(t, "PM", "x"));
    const keyAccount = await outlet(t, "O-KA", "Key Accounts");
    const sariSari = await outlet(t, "O-RS");
    const unknown = await outlet(t, "O-NEW", "Brand New Channel");
    const pricing = await t.run((ctx) =>
      vanCustomerPricing(
        ctx,
        [{ productId, uomCode: "PC" }],
        [keyAccount, sariSari, unknown],
        NOW,
      ),
    );
    expect(
      pricing.priceLines.map((l) => [l.priceListCode, l.unitPriceMinor]),
    ).toEqual([
      ["RS", "6850"],
      ["KA", "6575"],
    ]);
    expect(pricing.customerPriceListIds[keyAccount]).toBe(ka);
    expect(pricing.customerPriceListIds[sariSari]).toBe(rs);
    // A channel with no list of its own falls back to the van list, as SP-0088 does.
    expect(pricing.customerPriceListIds[unknown]).toBe(rs);
    expect(pricing.promotions.map((p) => p.code)).toEqual(["ALL", "KA-ONLY"]);
  });

  it("gives a customer no list when its channel is ambiguous (never another list's price)", async () => {
    const { t, productId } = await setup();
    const rs = await list(t, "RS", "route sales");
    await line(t, rs, productId, 6850);
    await line(t, await list(t, "KA-1", "key accounts"), productId, 6500);
    await line(t, await list(t, "KA-2", "key accounts"), productId, 6400);
    const keyAccount = await outlet(t, "O-KA", "Key Accounts");
    const pricing = await t.run((ctx) =>
      vanCustomerPricing(
        ctx,
        [{ productId, uomCode: "PC" }],
        [keyAccount],
        NOW,
      ),
    );
    expect(pricing.customerPriceListIds[keyAccount]).toBeNull();
    expect(pricing.priceLines.map((l) => l.priceListCode)).toEqual(["RS"]);
  });

  it("does not ship a list whose lines exceed the bootstrap bound; its customers get none", async () => {
    const { t } = await setup();
    const rs = await list(t, "RS", "route sales");
    const ka = await list(t, "KA", "key accounts");
    const products: { productId: Id<"products">; uomCode: string }[] = [];
    for (let i = 0; i < VAN_MAX_PRICE_LINES / 2 + 1; i++) {
      const productId = await t.run((ctx) =>
        ctx.db.insert("products", {
          code: `P-${i}`,
          name: `Product ${i}`,
          category: "Canned",
          uom: "PC",
          unitPrice: 0,
          active: true,
          organizationId: "sunpride",
          updatedAt: NOW,
        }),
      );
      products.push({ productId, uomCode: "PC" });
      await line(t, rs, productId, 1000);
      await line(t, ka, productId, 900);
    }
    const keyAccount = await outlet(t, "O-KA", "Key Accounts");
    const pricing = await t.run((ctx) =>
      vanCustomerPricing(ctx, products, [keyAccount], NOW),
    );
    expect(pricing.priceLines).toHaveLength(VAN_MAX_PRICE_LINES / 2 + 1);
    expect(new Set(pricing.priceLines.map((l) => l.priceListId))).toEqual(
      new Set([rs]),
    );
    expect(pricing.customerPriceListIds[keyAccount]).toBeNull();
  });
});
