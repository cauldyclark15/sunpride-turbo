import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";
import { chunkKey, fileHashOf } from "./shared";
import {
  balanceFor,
  openingStockValues,
  productByCode,
  productValues,
  provisionAdmin,
  provisionInventory,
  row,
} from "./test_helpers";

function newTest() {
  return convexTest(schema, modules);
}

async function setup(options: { withProduct?: boolean } = {}) {
  const t = newTest();
  const { admin, superAdmin } = await provisionAdmin(t);
  await provisionInventory(admin);
  if (options.withProduct !== false) {
    const productRows = [row(productValues())];
    await admin.mutation(api.imports.products.commitProducts, {
      runKey: "products-1",
      chunkIndex: 0,
      idempotencyKey: chunkKey("products", "products-1", 0),
      fileHash: fileHashOf(productRows.length, productRows),
      rows: productRows,
    });
  }
  return { t, admin, superAdmin };
}

function openingArgs(
  rows: Array<{ rowNumber: number; values: Record<string, string> }>,
  options: { runKey?: string; fileHash?: string } = {},
) {
  const runKey = options.runKey ?? "cutover-1";
  return {
    runKey,
    chunkIndex: 0,
    idempotencyKey: chunkKey("opening_stock", runKey, 0),
    fileHash: options.fileHash ?? fileHashOf(rows.length, rows),
    sourceReference: "CUTOVER-TEST",
    rows,
  };
}

describe("opening stock import", () => {
  it("posts one movement, a lot, ledger entries and a versioned balance", async () => {
    const { t, admin } = await setup();
    const rows = [row(openingStockValues())];
    const result = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs(rows),
    );
    expect(result.accepted).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.duplicate).toBe(false);
    expect(result.movementNumber!).toMatch(/^MV-/);

    const product = await productByCode(t, "SP-TEST-1L");
    const location = await t.run(async (ctx) =>
      ctx.db
        .query("inventoryLocations")
        .withIndex("by_organizationId_and_code", (q) =>
          q.eq("organizationId", "sunpride").eq("code", "WH-MNL"),
        )
        .unique(),
    );
    const balance = await balanceFor(t, product!._id, location!._id);
    expect(balance?.physicalBase).toBe(240_000n);
    expect(balance?.availableBase).toBe(240_000n);
    expect(balance?.reservedBase).toBe(0n);
    expect(balance?.version).toBe(1);
    expect(balance?.lastMovementId).toBe(result.movementId);

    const lot = await t.run(async (ctx) =>
      ctx.db
        .query("inventoryLots")
        .withIndex(
          "by_organizationId_and_productId_and_normalizedLotNumber",
          (q) =>
            q
              .eq("organizationId", "sunpride")
              .eq("productId", product!._id)
              .eq("normalizedLotNumber", "LOT-TEST-0001"),
        )
        .unique(),
    );
    expect(lot?.qualityStatus).toBe("released");
    expect(lot?.unitCostMinor).toBe(118_800n);
    expect(lot?.sourceType).toBe("opening_balance");

    const trace = await admin.query(api.inventory.queries.trace, {
      movementId: result.movementId!,
    });
    expect(trace.lines).toHaveLength(1);
    expect(trace.allocations).toHaveLength(1);
    expect(trace.entries).toHaveLength(1);
    expect(trace.entries[0]?.quantityBeforeBase).toBe(0n);
    expect(trace.entries[0]?.quantityAfterBase).toBe(240_000n);
    expect(trace.command?.status).toBe("posted");
  });

  it("rejects the whole chunk when any row is invalid and posts nothing", async () => {
    const { t, admin } = await setup();
    const rows = [
      row(openingStockValues(), 2),
      row(
        openingStockValues({ lot_number: "LOT-TEST-0002", quantity: "0" }),
        3,
      ),
    ];
    const result = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs(rows),
    );
    expect(result.accepted).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.movementId).toBeUndefined();
    expect(result.errors[0]?.code).toBe("not_positive");
    expect(result.errors[0]?.rowNumber).toBe(3);

    const movements = await t.run(async (ctx) =>
      ctx.db.query("inventoryMovements").collect(),
    );
    expect(movements).toHaveLength(0);
    const balances = await t.run(async (ctx) =>
      ctx.db.query("inventoryBalances").collect(),
    );
    expect(balances).toHaveLength(0);
  });

  it("requires a lot number for a lot-tracked product", async () => {
    const { admin } = await setup();
    const result = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs([row(openingStockValues({ lot_number: "" }))]),
    );
    expect(result.accepted).toBe(0);
    expect(result.errors[0]?.code).toBe("required_missing");
    expect(result.errors[0]?.column).toBe("lot_number");
  });

  it("requires expiry when the product policy requires it", async () => {
    const { admin } = await setup();
    const result = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs([row(openingStockValues({ expires_at: "" }))]),
    );
    expect(result.errors[0]?.code).toBe("required_missing");
    expect(result.errors[0]?.column).toBe("expires_at");
  });

  it("rejects a malformed date and a non-numeric quantity", async () => {
    const { admin } = await setup();
    const result = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs([row(openingStockValues({ expires_at: "01/08/2027" }))]),
    );
    expect(result.errors[0]?.column).toBe("expires_at");
    expect(result.errors[0]?.code).toBe("invalid_format");
  });

  it("reports policy_missing for a product without an inventory policy", async () => {
    const { t, admin } = await setup({ withProduct: false });
    await t.run(async (ctx) =>
      ctx.db.insert("products", {
        code: "SP-NOPOL-1L",
        name: "No Policy",
        category: "Juice",
        uom: "CASE",
        unitPrice: 0,
        active: true,
        updatedAt: Date.now(),
      }),
    );
    const result = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs([
        row(openingStockValues({ product_code: "SP-NOPOL-1L" }), 2),
      ]),
    );
    expect(result.accepted).toBe(0);
    expect(result.errors[0]?.code).toBe("policy_missing");
  });

  it("rejects an inactive location", async () => {
    const { t, admin } = await setup();
    const now = Date.now();
    await t.run(async (ctx) =>
      ctx.db.insert("inventoryLocations", {
        organizationId: "sunpride",
        siteCode: "SUNPRIDE-MAIN",
        code: "WH-CLOSED",
        name: "Closed warehouse",
        type: "warehouse",
        active: false,
        allowsPicking: false,
        allowsReceiving: false,
        allowsSale: false,
        allowsProduction: false,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const result = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs([row(openingStockValues({ location_code: "WH-CLOSED" }))]),
    );
    expect(result.accepted).toBe(0);
    expect(result.errors[0]?.code).toBe("unknown_reference");
    expect(result.errors[0]?.message).toMatch(/inactive/);
  });

  it("rejects a duplicate product, location and lot in one file", async () => {
    const { admin } = await setup();
    const rows = [
      row(openingStockValues(), 2),
      row(openingStockValues({ quantity: "10" }), 3),
    ];
    const result = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs(rows),
    );
    expect(result.accepted).toBe(0);
    expect(result.errors[0]?.code).toBe("duplicate_in_file");
  });

  it("rejects a file that mixes cutover source references", async () => {
    const { admin } = await setup();
    const rows = [
      row(openingStockValues(), 2),
      row(
        openingStockValues({
          lot_number: "LOT-TEST-0002",
          source_reference: "CUTOVER-OTHER",
        }),
        3,
      ),
    ];
    const result = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs(rows),
    );
    expect(result.failed).toBe(2);
    expect(result.errors[0]?.column).toBe("source_reference");
  });

  it("replaying the same file adds no stock", async () => {
    const { t, admin } = await setup();
    const rows = [row(openingStockValues())];
    const args = openingArgs(rows);
    const first = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      args,
    );
    const replay = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      args,
    );
    expect(replay.duplicate).toBe(true);
    expect(replay.accepted).toBe(first.accepted);
    expect(replay.movementNumber).toBe(first.movementNumber);

    const product = await productByCode(t, "SP-TEST-1L");
    const location = await t.run(async (ctx) =>
      ctx.db
        .query("inventoryLocations")
        .withIndex("by_organizationId_and_code", (q) =>
          q.eq("organizationId", "sunpride").eq("code", "WH-MNL"),
        )
        .unique(),
    );
    const balance = await balanceFor(t, product!._id, location!._id);
    expect(balance?.physicalBase).toBe(240_000n);

    const movements = await t.run(async (ctx) =>
      ctx.db.query("inventoryMovements").collect(),
    );
    expect(movements).toHaveLength(1);
  });

  it("refuses to post opening stock twice for the same product, location and lot", async () => {
    const { t, admin } = await setup();
    const rows = [row(openingStockValues())];
    await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs(rows),
    );

    // A different run key and a different file hash, same physical stock.
    const second = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs([row(openingStockValues({ quantity: "500" }))], {
        runKey: "cutover-2",
      }),
    );
    expect(second.accepted).toBe(0);
    expect(second.failed).toBe(1);
    expect(second.errors[0]?.code).toBe("duplicate_stock");
    expect(second.movementId).toBeUndefined();

    const product = await productByCode(t, "SP-TEST-1L");
    const location = await t.run(async (ctx) =>
      ctx.db
        .query("inventoryLocations")
        .withIndex("by_organizationId_and_code", (q) =>
          q.eq("organizationId", "sunpride").eq("code", "WH-MNL"),
        )
        .unique(),
    );
    const balance = await balanceFor(t, product!._id, location!._id);
    expect(balance?.physicalBase).toBe(240_000n);
    const movements = await t.run(async (ctx) =>
      ctx.db.query("inventoryMovements").collect(),
    );
    expect(movements).toHaveLength(1);
  });

  it("rejects non-lot stock already physically present at the location", async () => {
    const { t, admin } = await setup({ withProduct: false });
    const products = [
      row(
        productValues({
          product_code: "SP-NONLOT",
          barcode: "4800000000002",
          tracking_mode: "none",
          expiry_required: "N",
          manufacture_date_required: "N",
        }),
      ),
    ];
    await admin.mutation(api.imports.products.commitProducts, {
      runKey: "nonlot-product",
      chunkIndex: 0,
      idempotencyKey: chunkKey("products", "nonlot-product", 0),
      fileHash: fileHashOf(products.length, products),
      rows: products,
    });
    const rows = [
      row(
        openingStockValues({
          product_code: "SP-NONLOT",
          lot_number: "",
          expires_at: "",
          manufactured_at: "",
        }),
      ),
    ];
    const first = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs(rows),
    );
    expect(first.accepted).toBe(1);
    const second = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs(rows, { runKey: "cutover-nonlot-again" }),
    );
    expect(second.accepted).toBe(0);
    expect(second.errors[0]).toMatchObject({
      code: "duplicate_stock",
      column: "product_code",
    });
    expect(
      await t.run(async (ctx) => ctx.db.query("inventoryMovements").collect()),
    ).toHaveLength(1);
  });

  it("rejects a second opening import after the product policy is removed", async () => {
    const { t, admin } = await setup();
    const rows = [row(openingStockValues())];
    const first = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs(rows),
    );
    expect(first.accepted).toBe(1);

    await t.run(async (ctx) => {
      const product = await ctx.db
        .query("products")
        .withIndex("by_code", (q) => q.eq("code", "SP-TEST-1L"))
        .unique();
      const policy = await ctx.db
        .query("productInventoryPolicies")
        .withIndex("by_organizationId_and_productId", (q) =>
          q.eq("organizationId", "sunpride").eq("productId", product!._id),
        )
        .unique();
      await ctx.db.delete(policy!._id);
    });

    const second = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs(rows, { runKey: "cutover-without-policy" }),
    );
    expect(second.accepted).toBe(0);
    expect(second.errors).toContainEqual(
      expect.objectContaining({
        code: "duplicate_stock",
        column: "product_code",
      }),
    );
    expect(
      await t.run(async (ctx) => ctx.db.query("inventoryMovements").collect()),
    ).toHaveLength(1);
  });

  it("rejects lot stock even when its physical balance is entirely on hold", async () => {
    const { t, admin } = await setup();
    const rows = [row(openingStockValues())];
    await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs(rows),
    );
    await t.run(async (ctx) => {
      const available = (
        await ctx.db.query("inventoryLotBalances").collect()
      )[0]!;
      await ctx.db.patch(available._id, {
        physicalBase: 0n,
        availableBase: 0n,
      });
      await ctx.db.insert("inventoryLotBalances", {
        organizationId: available.organizationId,
        productId: available.productId,
        lotId: available.lotId,
        locationId: available.locationId,
        stockStatus: "quality_hold",
        physicalBase: 240_000n,
        reservedBase: 0n,
        availableBase: 0n,
        expirySortKey: available.expirySortKey,
        receiptSequence: available.receiptSequence,
        version: 1,
        updatedAt: Date.now(),
      });
    });
    const preview = await admin.query(
      api.imports.openingStock.validateOpeningStock,
      { rows },
    );
    expect(preview.errors[0]?.code).toBe("duplicate_stock");
    const second = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs(rows, { runKey: "cutover-hold-again" }),
    );
    expect(second.errors[0]?.code).toBe("duplicate_stock");
  });

  it("rejects changed opening rows under the same key and claimed file hash", async () => {
    const { t, admin } = await setup();
    const args = openingArgs([row(openingStockValues())]);
    await admin.mutation(api.imports.openingStock.commitOpeningStock, args);
    await expect(
      admin.mutation(api.imports.openingStock.commitOpeningStock, {
        ...args,
        rows: [row(openingStockValues({ quantity: "500" }))],
      }),
    ).rejects.toThrow(/different payload/);
    expect(
      await t.run(async (ctx) => ctx.db.query("inventoryMovements").collect()),
    ).toHaveLength(1);
  });

  it("refuses a row source reference different from posting provenance", async () => {
    const { t, admin } = await setup();
    const rows = [
      row(openingStockValues({ source_reference: "OTHER-REFERENCE" })),
    ];
    const result = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      openingArgs(rows),
    );
    expect(result.accepted).toBe(0);
    expect(result.errors[0]).toMatchObject({
      code: "invalid_format",
      column: "source_reference",
    });
    expect(
      await t.run(async (ctx) => ctx.db.query("inventoryMovements").collect()),
    ).toHaveLength(0);
  });

  it("refuses a region-scoped admin in opening stock preview and commit", async () => {
    const { t, admin, superAdmin } = await setup();
    const root = (await admin.query(api.domains.profiles.myScope)).orgUnitId!;
    const area = await t.run(async (ctx) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code: "REG-TEST",
        name: "Test Region",
        typeCode: "REGION",
        parentId: root,
        status: "active",
        effectiveFrom: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await superAdmin.mutation(api.domains.profiles.assignPersona, {
      profileId: (await admin.query(api.domains.profiles.current))!._id,
      orgUnitId: area,
    });
    const rows = [row(openingStockValues())];
    await expect(
      admin.query(api.imports.openingStock.validateOpeningStock, { rows }),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      admin.mutation(
        api.imports.openingStock.commitOpeningStock,
        openingArgs(rows),
      ),
    ).rejects.toThrow(/outside your organizational scope/);
  });

  it("previews without posting", async () => {
    const { t, admin } = await setup();
    const preview = await admin.query(
      api.imports.openingStock.validateOpeningStock,
      { rows: [row(openingStockValues())] },
    );
    expect(preview.accepted).toBe(1);
    expect(preview.errorCount).toBe(0);
    expect(preview.totalQuantityBase).toBe("240000");
    const movements = await t.run(async (ctx) =>
      ctx.db.query("inventoryMovements").collect(),
    );
    expect(movements).toHaveLength(0);
  });
});
