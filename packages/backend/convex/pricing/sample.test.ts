import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  SAMPLE_PRICE_LISTS,
  sampleCreditLimit,
  samplePiecePriceMinor,
} from "./sample";

const now = Date.parse("2026-10-07T04:00:00Z");
type T = TestConvex<typeof schema>;

async function setup() {
  const t: T = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const unit = (code: string) =>
      ctx.db.insert("unitsOfMeasure", {
        organizationId: "sunpride",
        code,
        name: code,
        dimension: "count",
        decimalPlaces: 0,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
    const pc = await unit("PC");
    const cs = await unit("CS");
    const product = await ctx.db.insert("products", {
      code: "SUNP-HOTDOG-1KG",
      name: "Sunpride Hotdog 1kg",
      category: "frozen",
      uom: "PC",
      unitPrice: 0,
      active: true,
      organizationId: "sunpride",
      baseUomId: pc,
      sellingUomIds: [pc, cs],
      updatedAt: now,
    });
    await ctx.db.insert("uomConversions", {
      organizationId: "sunpride",
      productId: product,
      fromUomId: cs,
      toUomId: pc,
      numerator: 12n,
      denominator: 1n,
      roundingMode: "exact",
      active: true,
      effectiveFrom: 0,
      createdAt: now,
      updatedAt: now,
    });
    const retired = await ctx.db.insert("products", {
      code: "OLD-1",
      name: "Retired",
      category: "canned",
      uom: "PC",
      unitPrice: 0,
      active: false,
      updatedAt: now,
    });
    const store = (code: string, creditLimit: number) =>
      ctx.db.insert("customers", {
        code,
        name: code,
        channel: "Key Accounts",
        territory: "T",
        creditLimit,
        active: true,
        updatedAt: now,
      });
    return {
      product,
      retired,
      noLimit: await store("C-1", 0),
      officeLimit: await store("C-2", 80_000),
    };
  });
  return { t, ids };
}

async function drain<R extends { isDone: boolean; continueCursor: string }>(
  run: (cursor: string | null) => Promise<R>,
) {
  const results: R[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result = await run(cursor);
    results.push(result);
    if (result.isDone) return results;
    cursor = result.continueCursor;
  }
}

describe("beta sample prices and credit limits (SP-0088)", () => {
  it("seeds marked sample lists for every selling unit, idempotently, and reset removes only them", async () => {
    const { t, ids } = await setup();
    const seed = (cursor: string | null) =>
      t.mutation(internal.pricing.sample.seed, { cursor, batch: 1 });
    const first = await drain(seed);
    expect(first.reduce((n, r) => n + r.linesCreated, 0)).toBe(
      SAMPLE_PRICE_LISTS.length * 2,
    );
    // A second run adds nothing.
    expect((await drain(seed)).reduce((n, r) => n + r.linesCreated, 0)).toBe(0);
    const { lists, lines } = await t.run(async (ctx) => ({
      lists: await ctx.db.query("priceLists").collect(),
      lines: await ctx.db.query("priceListLines").collect(),
    }));
    expect(
      lists.every((l) => l.source === "sample" && l.code.startsWith("SAMPLE-")),
    ).toBe(true);
    expect(lines.every((l) => l.productId === ids.product)).toBe(true);
    const std = lists.find((l) => l.code === "SAMPLE-STD")!;
    const piece = samplePiecePriceMinor("SUNP-HOTDOG-1KG");
    const price = (uom: string) =>
      lines.find((l) => l.priceListId === std._id && l.uom === uom)!
        .unitPriceMinor;
    expect(price("PC")).toBe(Math.round(piece / 25) * 25);
    // A case of 12 is a little cheaper per piece.
    expect(price("CS")).toBe(Math.round((piece * 12 * 0.97) / 25) * 25);
    expect(price("CS")).toBeLessThan(price("PC") * 12);

    // An office list and its line survive a reset.
    await t.run(async (ctx) => {
      const office = await ctx.db.insert("priceLists", {
        organizationId: "sunpride",
        code: "KA-2026",
        name: "Key Accounts 2026",
        channelKey: "key accounts",
        currency: "PHP",
        status: "active",
        source: "office",
        effectiveFrom: 0,
        updatedAt: now,
      });
      await ctx.db.insert("priceListLines", {
        organizationId: "sunpride",
        priceListId: office,
        productId: ids.product,
        uom: "PC",
        unitPriceMinor: 9_900,
        effectiveFrom: 0,
        updatedAt: now,
      });
    });
    for (;;) {
      const r = await t.mutation(internal.pricing.sample.reset, { batch: 3 });
      if (r.isDone) break;
    }
    const after = await t.run(async (ctx) => ({
      lists: await ctx.db.query("priceLists").collect(),
      lines: await ctx.db.query("priceListLines").collect(),
    }));
    expect(after.lists.map((l) => l.code)).toEqual(["KA-2026"]);
    expect(after.lines.map((l) => l.unitPriceMinor)).toEqual([9_900]);
  });

  it("gives stores without a limit a recorded sample limit and restores it on reset", async () => {
    const { t, ids } = await setup();
    const seed = (cursor: string | null) =>
      t.mutation(internal.pricing.sample.seedCreditLimits, { cursor });
    expect(
      (await drain(seed)).reduce((n, r) => n + r.customersChanged, 0),
    ).toBe(1);
    expect(
      (await drain(seed)).reduce((n, r) => n + r.customersChanged, 0),
    ).toBe(0);
    const limits = await t.run(async (ctx) => [
      (await ctx.db.get(ids.noLimit))!.creditLimit,
      (await ctx.db.get(ids.officeLimit))!.creditLimit,
    ]);
    expect(limits).toEqual([sampleCreditLimit("C-1"), 80_000]);
    expect(limits[0]).toBeGreaterThanOrEqual(50_000);
    expect(limits[0]).toBeLessThanOrEqual(300_000);
    await t.mutation(internal.pricing.sample.reset, {});
    const restored = await t.run(async (ctx) => ({
      limit: (await ctx.db.get(ids.noLimit))!.creditLimit,
      markers: await ctx.db.query("sampleDataChanges").collect(),
    }));
    expect(restored).toEqual({ limit: 0, markers: [] });
  });
});
