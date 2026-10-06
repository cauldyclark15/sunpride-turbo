import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  applyPromotions,
  channelKey,
  effectiveLines,
  priceLineAt,
  priceListForChannel,
} from "./model";

type T = TestConvex<typeof schema>;
const P1 = "p1" as Id<"products">;
const P2 = "p2" as Id<"products">;
const PC = "pc" as Id<"unitsOfMeasure">;
const CS = "cs" as Id<"unitsOfMeasure">;

describe("channel keys (SP-0129)", () => {
  it("maps the field's channel names onto the three price-list channels", () => {
    expect(channelKey("Key Accounts")).toBe("KEY_ACCOUNTS");
    expect(channelKey("kas")).toBe("KEY_ACCOUNTS");
    expect(channelKey(" Route Sales ")).toBe("ROUTE_SALES");
    expect(channelKey("PMOT Extruck")).toBe("ROUTE_SALES");
    expect(channelKey("RDS")).toBe("ROUTE_SALES");
    expect(channelKey("Public Market")).toBe("PUBLIC_MARKET");
    expect(channelKey("PM Stalls")).toBe("PUBLIC_MARKET");
    expect(channelKey(undefined)).toBe("");
  });
});

describe("promotion evaluation (ADR-008)", () => {
  const line = (
    productId: Id<"products">,
    uomId: Id<"unitsOfMeasure">,
    quantity: number,
    unitPriceMinor: bigint | null,
  ) => ({ productId, uomId, quantity, unitPriceMinor });

  it("buy X get Y gives free goods per full multiple", () => {
    const result = applyPromotions(
      [line(P1, PC, 25, 2650n)],
      [
        {
          code: "B10G1",
          rule: {
            kind: "buy_x_get_y",
            buy: { productId: P1, uomId: PC, quantity: 10 },
            free: { productId: P1, uomId: PC, quantity: 1 },
          },
        },
      ],
    );
    expect(result.freeGoods).toEqual([
      { productId: P1, uomId: PC, quantity: 2, promotionCode: "B10G1" },
    ]);
    expect(result.lines[0]!.freeQuantity).toBe(2);
    expect(result.totalMinor).toBe(2650n * 25n);
    expect(result.applied).toEqual(["B10G1"]);
  });

  it("percent off applies only to the promoted unit at the threshold, rounded half up", () => {
    const rule = {
      kind: "percent_off" as const,
      item: { productId: P1, uomId: CS, quantity: 2 },
      percentOffBasisPoints: 500,
    };
    const below = applyPromotions(
      [line(P1, CS, 1, 212_025n)],
      [{ code: "CASE5", rule }],
    );
    expect(below.discountMinor).toBe(0n);
    const met = applyPromotions(
      [line(P1, CS, 3, 212_025n), line(P1, PC, 3, 4650n)],
      [{ code: "CASE5", rule }],
    );
    // 5% of 636075 = 31803.75 -> 31804
    expect(met.lines[0]!.discountMinor).toBe(31_804n);
    expect(met.lines[1]!.discountMinor).toBe(0n);
    expect(met.totalMinor).toBe(636_075n + 13_950n - 31_804n);
  });

  it("a bundle discounts complete sets and splits the saving across its components", () => {
    const result = applyPromotions(
      [line(P1, PC, 3, 7250n), line(P2, PC, 2, 9900n)],
      [
        {
          code: "MERIENDA",
          rule: {
            kind: "bundle",
            components: [
              { productId: P1, uomId: PC, quantity: 1 },
              { productId: P2, uomId: PC, quantity: 1 },
            ],
            bundlePriceMinor: 15_900n,
          },
        },
      ],
    );
    // 2 bundles x (17150 - 15900) = 2500
    expect(result.discountMinor).toBe(2_500n);
    expect(result.lines.reduce((sum, row) => sum + row.discountMinor, 0n)).toBe(
      2_500n,
    );
    expect(result.totalMinor).toBe(3n * 7250n + 2n * 9900n - 2_500n);
  });

  it("never stacks two promotions on a line and fails closed on unpriced or invalid rules", () => {
    const promos = [
      {
        code: "A-PCT",
        rule: {
          kind: "percent_off" as const,
          item: { productId: P1, uomId: PC, quantity: 1 },
          percentOffBasisPoints: 1000,
        },
      },
      {
        code: "B-PCT",
        rule: {
          kind: "percent_off" as const,
          item: { productId: P1, uomId: PC, quantity: 1 },
          percentOffBasisPoints: 9000,
        },
      },
      {
        code: "C-BUNDLE",
        rule: {
          kind: "bundle" as const,
          components: [
            { productId: P1, uomId: PC, quantity: 1 },
            { productId: P2, uomId: PC, quantity: 1 },
          ],
          bundlePriceMinor: 1n,
        },
      },
      {
        code: "D-BAD",
        rule: {
          kind: "percent_off" as const,
          item: { productId: P2, uomId: PC, quantity: 1 },
          percentOffBasisPoints: 20_000,
        },
      },
    ];
    const result = applyPromotions(
      [line(P1, PC, 1, 1000n), line(P2, PC, 1, null)],
      promos,
    );
    expect(result.applied).toEqual(["A-PCT"]);
    expect(result.lines[0]!.discountMinor).toBe(100n);
    expect(result.priced).toBe(false);
    expect(result.lines[1]!.grossMinor).toBeNull();
  });
});

describe("price resolution fails closed (ADR-008)", () => {
  async function lists(t: T) {
    return t.run(async (ctx) => {
      const now = Date.now();
      const list = (code: string, channel: string) =>
        ctx.db.insert("priceLists", {
          organizationId: "sunpride",
          code,
          name: code,
          channel,
          currency: "PHP",
          vatInclusive: true,
          status: "active",
          source: "office",
          createdAt: now,
          updatedAt: now,
        });
      const uom = await ctx.db.insert("unitsOfMeasure", {
        organizationId: "sunpride",
        code: "PC",
        name: "Piece",
        dimension: "count",
        decimalPlaces: 0,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      const product = await ctx.db.insert("products", {
        code: "X",
        name: "X",
        category: "C",
        uom: "PC",
        unitPrice: 0,
        active: true,
        updatedAt: now,
      });
      return {
        a: await list("A", "Route Sales"),
        b: await list("B", "PMOT"),
        k: await list("K", "Key Accounts"),
        uom,
        product,
      };
    });
  }

  it("two active lists for one channel resolve to none; one list resolves", async () => {
    const t: T = convexTest(schema, modules);
    const ids = await lists(t);
    await t.run(async (ctx) => {
      expect(await priceListForChannel(ctx, "Route Sales")).toBeNull();
      expect((await priceListForChannel(ctx, "KA"))?._id).toBe(ids.k);
      expect(await priceListForChannel(ctx, "")).toBeNull();
    });
  });

  it("overlapping effective lines for the same product+unit price nothing", async () => {
    const t: T = convexTest(schema, modules);
    const ids = await lists(t);
    await t.run(async (ctx) => {
      const line = (
        unitPriceMinor: bigint,
        effectiveFrom: number,
        effectiveTo?: number,
      ) =>
        ctx.db.insert("priceListLines", {
          organizationId: "sunpride",
          priceListId: ids.k,
          productId: ids.product,
          uomId: ids.uom,
          unitPriceMinor,
          effectiveFrom,
          ...(effectiveTo ? { effectiveTo } : {}),
          actorSubject: "test",
          createdAt: 0,
        });
      await line(1000n, 0, 100);
      await line(1200n, 100);
      expect(
        (await priceLineAt(ctx, ids.k, ids.product, ids.uom, 50))
          ?.unitPriceMinor,
      ).toBe(1000n);
      expect(
        (await priceLineAt(ctx, ids.k, ids.product, ids.uom, 150))
          ?.unitPriceMinor,
      ).toBe(1200n);
      expect(await effectiveLines(ctx, ids.k, 150)).toHaveLength(1);
      await line(1300n, 120);
      expect(
        await priceLineAt(ctx, ids.k, ids.product, ids.uom, 150),
      ).toBeNull();
      expect(await effectiveLines(ctx, ids.k, 150)).toHaveLength(0);
    });
  });
});
