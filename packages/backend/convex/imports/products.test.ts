import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  productByCode,
  productValues,
  provisionAdmin,
  provisionInventory,
  row,
  uomIdByCode,
} from "./test_helpers";
import { chunkKey, fileHashOf } from "./shared";

function newTest() {
  return convexTest(schema, modules);
}

async function setup() {
  const t = newTest();
  const { superAdmin, admin } = await provisionAdmin(t);
  await provisionInventory(admin);
  return { t, admin, superAdmin };
}

function commitArgs(
  rows: ReturnType<typeof productValues> extends never
    ? never
    : Array<{
        rowNumber: number;
        values: Record<string, string>;
      }>,
  options: { runKey?: string; chunkIndex?: number; fileHash?: string } = {},
) {
  const runKey = options.runKey ?? "run-1";
  const chunkIndex = options.chunkIndex ?? 0;
  return {
    runKey,
    chunkIndex,
    idempotencyKey: chunkKey("products", runKey, chunkIndex),
    fileHash: options.fileHash ?? fileHashOf(rows.length, rows),
    rows,
  };
}

describe("product master import", () => {
  it("creates a product with policy, selling uoms and barcode", async () => {
    const { t, admin } = await setup();
    const rows = [row(productValues())];

    const result = await admin.mutation(
      api.imports.products.commitProducts,
      commitArgs(rows),
    );
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.duplicate).toBe(false);

    const product = await productByCode(t, "SP-TEST-1L");
    expect(product?.active).toBe(true);
    expect(product?.unitPrice).toBe(0);
    expect(product?.catalogSource).toBe("import");
    expect(product?.quantityScale).toBe(1000n);
    expect(product?.trackingMode).toBe("lot");
    expect(product?.allocationPolicy).toBe("fefo");
    expect(product?.policyVersion).toBe(1);
    expect(product?.sellingUomIds).toHaveLength(2);
    expect(product?.sellingUomIds?.[0]).toBe(await uomIdByCode(t, "CASE"));

    const policy = await t.run(async (ctx) =>
      ctx.db
        .query("productInventoryPolicies")
        .withIndex("by_organizationId_and_productId", (q) =>
          q.eq("organizationId", "sunpride").eq("productId", product!._id),
        )
        .unique(),
    );
    expect(policy?.trackingMode).toBe("lot");
    expect(policy?.expiryDateRequired).toBe(true);
    expect(policy?.manufactureDateRequired).toBe(false);
    expect(policy?.shelfLifeDays).toBe(365);
    expect(policy?.minimumRemainingShelfLifeDays).toBe(7);
    expect(policy?.allowNegativeStock).toBe(false);

    const barcode = await t.run(async (ctx) =>
      ctx.db
        .query("productBarcodes")
        .withIndex("by_organizationId_and_barcode", (q) =>
          q.eq("organizationId", "sunpride").eq("barcode", "4800000000001"),
        )
        .unique(),
    );
    expect(barcode?.productId).toBe(product?._id);
    expect(barcode?.active).toBe(true);
    expect(barcode?.source).toBe("import");
  });

  it("updates an existing product without changing its code", async () => {
    const { t, admin } = await setup();
    await admin.mutation(
      api.imports.products.commitProducts,
      commitArgs([row(productValues())]),
    );

    const second = await admin.mutation(
      api.imports.products.commitProducts,
      commitArgs([row(productValues({ name: "Renamed Juice" }))], {
        runKey: "run-2",
      }),
    );
    expect(second.updated).toBe(1);
    expect(second.created).toBe(0);

    const product = await productByCode(t, "SP-TEST-1L");
    expect(product?.name).toBe("Renamed Juice");
    expect(product?.code).toBe("SP-TEST-1L");
  });

  it("reports unchanged rows as skipped on a repeated import", async () => {
    const { admin } = await setup();
    await admin.mutation(
      api.imports.products.commitProducts,
      commitArgs([row(productValues())]),
    );
    const repeat = await admin.mutation(
      api.imports.products.commitProducts,
      commitArgs([row(productValues())], { runKey: "run-2" }),
    );
    expect(repeat.created).toBe(0);
    expect(repeat.updated).toBe(0);
    expect(repeat.skipped).toBe(1);
  });

  it("returns duplicate_in_file for a repeated product_code", async () => {
    const { t, admin } = await setup();
    const rows = [
      row(productValues(), 2),
      row(productValues({ name: "Duplicate" }), 3),
    ];
    const result = await admin.mutation(
      api.imports.products.commitProducts,
      commitArgs(rows),
    );
    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]?.code).toBe("duplicate_in_file");
    expect(result.errors[0]?.rowNumber).toBe(3);
    const products = await t.run(async (ctx) =>
      ctx.db.query("products").collect(),
    );
    expect(products.filter((p) => p.code === "SP-TEST-1L")).toHaveLength(1);
  });

  it("returns unknown_reference for an unknown base_uom", async () => {
    const { admin } = await setup();
    const result = await admin.mutation(
      api.imports.products.commitProducts,
      commitArgs([row(productValues({ base_uom: "PALLET" }))]),
    );
    expect(result.created).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]?.code).toBe("unknown_reference");
    expect(result.errors[0]?.column).toBe("base_uom");
  });

  it("returns barcode_conflict when a barcode belongs to another active product", async () => {
    const { admin } = await setup();
    await admin.mutation(
      api.imports.products.commitProducts,
      commitArgs([row(productValues())]),
    );
    const conflict = await admin.mutation(
      api.imports.products.commitProducts,
      commitArgs(
        [
          row(
            productValues({
              product_code: "SP-OTHER-1L",
              name: "Other Juice",
            }),
          ),
        ],
        { runKey: "run-2" },
      ),
    );
    expect(conflict.created).toBe(0);
    expect(conflict.errors[0]?.code).toBe("barcode_conflict");
    expect(conflict.errors[0]?.column).toBe("barcode");
  });

  it("replaying the same chunk returns duplicate and writes nothing", async () => {
    const { t, admin } = await setup();
    const args = commitArgs([row(productValues())]);
    const first = await admin.mutation(
      api.imports.products.commitProducts,
      args,
    );
    const replay = await admin.mutation(
      api.imports.products.commitProducts,
      args,
    );
    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.created).toBe(first.created);
    expect(replay.runId).toBe(first.runId);

    const runs = await t.run(async (ctx) =>
      ctx.db.query("importRuns").collect(),
    );
    expect(runs).toHaveLength(1);
    const audits = await t.run(async (ctx) =>
      ctx.db.query("auditLogs").collect(),
    );
    expect(
      audits.filter((log) => log.action === "import.products"),
    ).toHaveLength(1);
  });

  it("rejects an idempotency key reused with different content", async () => {
    const { admin } = await setup();
    const args = commitArgs([row(productValues())]);
    await admin.mutation(api.imports.products.commitProducts, args);
    await expect(
      admin.mutation(api.imports.products.commitProducts, {
        ...args,
        fileHash: "fnv1a-deadbeef",
      }),
    ).rejects.toThrow(/different payload/);
  });

  it("rejects a caller without the admin role", async () => {
    const { t, superAdmin } = await setup();
    await superAdmin.mutation(api.domains.profiles.invite, {
      email: "viewer@sunpride.local",
      name: "Viewer",
      role: "viewer",
    });
    const viewer = t.withIdentity({
      subject: "viewer@sunpride.local",
      email: "viewer@sunpride.local",
      name: "Viewer",
    });
    await viewer.mutation(api.domains.profiles.ensure);
    await expect(
      viewer.mutation(
        api.imports.products.commitProducts,
        commitArgs([row(productValues())]),
      ),
    ).rejects.toThrow(/Insufficient permission/);
  });

  it("previews without writing", async () => {
    const { t, admin } = await setup();
    const preview = await admin.query(api.imports.products.validateProducts, {
      rows: [row(productValues())],
    });
    expect(preview.wouldCreate).toBe(1);
    expect(preview.wouldUpdate).toBe(0);
    expect(preview.errorCount).toBe(0);
    expect(await productByCode(t, "SP-TEST-1L")).toBeNull();

    const invalid = await admin.query(api.imports.products.validateProducts, {
      rows: [row(productValues({ tracking_mode: "maybe" }))],
    });
    expect(invalid.errorCount).toBe(1);
    expect(invalid.errors[0]?.code).toBe("invalid_format");
    expect(invalid.errors[0]?.column).toBe("tracking_mode");
    expect(await productByCode(t, "SP-TEST-1L")).toBeNull();
  });
});
