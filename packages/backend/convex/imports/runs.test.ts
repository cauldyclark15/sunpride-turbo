import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";
import { chunkKey, fileHashOf } from "./shared";
import {
  openingStockValues,
  productValues,
  provisionAdmin,
  provisionInventory,
  row,
} from "./test_helpers";

function newTest() {
  return convexTest(schema, modules);
}

async function setup() {
  const t = newTest();
  const { admin } = await provisionAdmin(t);
  await provisionInventory(admin);
  return { t, admin };
}

describe("import run history", () => {
  it("groups chunks by run and reports their counts", async () => {
    const { admin } = await setup();
    const productRows = [row(productValues())];
    await admin.mutation(api.imports.products.commitProducts, {
      runKey: "products-run",
      chunkIndex: 0,
      idempotencyKey: chunkKey("products", "products-run", 0),
      fileHash: fileHashOf(productRows.length, productRows),
      rows: productRows,
    });
    const openingRows = [row(openingStockValues())];
    await admin.mutation(api.imports.openingStock.commitOpeningStock, {
      runKey: "cutover-run",
      chunkIndex: 0,
      idempotencyKey: chunkKey("opening_stock", "cutover-run", 0),
      fileHash: fileHashOf(openingRows.length, openingRows),
      sourceReference: "CUTOVER-TEST",
      rows: openingRows,
    });

    const runs = await admin.query(api.imports.runs.list, {});
    expect(runs).toHaveLength(2);
    const opening = runs.find((run) => run.importType === "opening_stock");
    expect(opening?.runKey).toBe("cutover-run");
    expect(opening?.chunkCount).toBe(1);
    expect(opening?.createdCount).toBe(1);
    expect(opening?.failedCount).toBe(0);
    expect(opening?.status).toBe("completed");
    expect(opening?.movementIds).toHaveLength(1);

    const products = runs.find((run) => run.importType === "products");
    expect(products?.createdCount).toBe(1);
    expect(products?.movementIds).toHaveLength(0);
  });

  it("keeps the row errors of a rejected opening-stock chunk", async () => {
    const { admin } = await setup();
    const rows = [
      row(openingStockValues({ product_code: "SP-MISSING-1L" }), 2),
    ];
    const failed = await admin.mutation(
      api.imports.openingStock.commitOpeningStock,
      {
        runKey: "bad-cutover",
        chunkIndex: 0,
        idempotencyKey: chunkKey("opening_stock", "bad-cutover", 0),
        fileHash: fileHashOf(rows.length, rows),
        sourceReference: "CUTOVER-BAD",
        rows,
      },
    );
    expect(failed.failed).toBe(1);

    const detail = await admin.query(api.imports.runs.detail, {
      runKey: "bad-cutover",
      importType: "opening_stock",
    });
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]?.status).toBe("failed");
    expect(detail.errors).toHaveLength(1);
    expect(detail.errors[0]?.code).toBe("unknown_reference");
    expect(detail.errors[0]?.rowNumber).toBe(2);
    expect(detail.movements).toHaveLength(0);

    const history = await admin.query(api.imports.runs.list, {});
    expect(history[0]?.status).toBe("failed");
    expect(history[0]?.failedCount).toBe(1);
  });

  it("requires an authenticated profile", async () => {
    const { t } = await setup();
    await expect(t.query(api.imports.runs.list, {})).rejects.toThrow(
      /Authentication required/,
    );
  });
});
