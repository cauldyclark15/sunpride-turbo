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
import { HEADER } from "./adjustments";

const values = (overrides: Record<string, string> = {}) => ({
  source_reference: "ADJ-CSV",
  line_key: "1",
  adjustment_type: "addition",
  reason_code: "correction",
  product_code: "SP-TEST-1L",
  location_code: "WH-MNL",
  stock_status: "available",
  lot_number: "LOT-TEST-0001",
  quantity_delta: "+1.250",
  unit_cost_minor: "",
  note: "test",
  ...overrides,
});
const args = (rows: ReturnType<typeof row>[], runKey = "adj-1") => ({
  rows,
  rowCount: rows.length,
  runKey,
  chunkIndex: 0,
  idempotencyKey: chunkKey("stock_adjustment", runKey, 0),
  fileHash: fileHashOf(rows.length, rows),
});
async function setup() {
  const t = convexTest(schema, modules);
  const { admin, superAdmin } = await provisionAdmin(t);
  await provisionInventory(admin);
  const p = [row(productValues())];
  await admin.mutation(api.imports.products.commitProducts, {
    runKey: "p",
    chunkIndex: 0,
    idempotencyKey: chunkKey("products", "p", 0),
    fileHash: fileHashOf(1, p),
    rows: p,
  });
  const o = [row(openingStockValues())];
  await admin.mutation(api.imports.openingStock.commitOpeningStock, {
    runKey: "o",
    chunkIndex: 0,
    idempotencyKey: chunkKey("opening_stock", "o", 0),
    fileHash: fileHashOf(1, o),
    sourceReference: "CUTOVER-TEST",
    rows: o,
  });
  return { t, admin, superAdmin };
}

describe("stock adjustment CSV", () => {
  it("returns per-lot projected totals without mixing unlike partitions", async () => {
    const { admin } = await setup();
    const result = await admin.query(api.imports.adjustments.preview, {
      header: HEADER.split(","),
      rows: [
        row(values(), 2),
        row(values({ line_key: "2", quantity_delta: "-0.250" }), 3),
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.requestChunks).toBe(1);
    expect(result.partitions).toEqual([
      expect.objectContaining({
        productCode: "SP-TEST-1L",
        locationCode: "WH-MNL",
        stockStatus: "available",
        lotNumber: "LOT-TEST-0001",
        positiveBase: 1250n,
        negativeBase: 250n,
        netDeltaBase: 1000n,
        currentBase: 240000n,
        projectedBase: 241000n,
      }),
    ]);
  });
  it("rejects missing, unknown, and reordered headers before staging", async () => {
    const { t, admin } = await setup();
    const header = HEADER.split(",");
    for (const bad of [
      header.slice(1),
      [...header, "surprise"],
      [header[1]!, header[0]!, ...header.slice(2)],
    ]) {
      const preview = await admin.query(api.imports.adjustments.preview, {
        rows: [row(values())],
        header: bad,
      });
      expect(preview.errors).toEqual([
        expect.objectContaining({
          rowNumber: 1,
          column: "header",
          code: "invalid_format",
        }),
      ]);
      expect(preview.partitions).toEqual([]);
      await expect(
        admin.mutation(api.imports.adjustments.commit, {
          ...args([row(values())]),
          header: bad,
        }),
      ).rejects.toThrow(/invalid_format/);
    }
    expect(
      await t.run((ctx) => ctx.db.query("inventoryAdjustments").collect()),
    ).toHaveLength(0);
  });
  it("publishes the exact header and required fields with original row numbers", async () => {
    expect(HEADER).toBe(
      "source_reference,line_key,adjustment_type,reason_code,product_code,location_code,stock_status,lot_number,quantity_delta,unit_cost_minor,note",
    );
    const { admin } = await setup();
    const result = await admin.query(api.imports.adjustments.preview, {
      rows: [row(values({ reason_code: "" }), 19)],
    });
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        rowNumber: 19,
        column: "reason_code",
        code: "required_missing",
      }),
    );
  });
  it("rejects zero, malformed delta and cost override atomically", async () => {
    const { t, admin } = await setup();
    const rows = [
      row(values(), 2),
      row(
        values({ line_key: "2", quantity_delta: "0", unit_cost_minor: "1" }),
        3,
      ),
    ];
    const result = await admin.mutation(
      api.imports.adjustments.commit,
      args(rows),
    );
    expect(result.accepted).toBe(0);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rowNumber: 3, code: "zero_delta" }),
        expect.objectContaining({
          rowNumber: 3,
          code: "cost_override_not_allowed",
        }),
      ]),
    );
    expect(
      await t.run((ctx) => ctx.db.query("inventoryAdjustments").collect()),
    ).toHaveLength(0);
  });
  it("reports insufficient lot stock before staging a negative delta", async () => {
    const { admin } = await setup();
    const result = await admin.query(api.imports.adjustments.preview, {
      rows: [row(values({ quantity_delta: "-241" }), 12)],
    });
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        rowNumber: 12,
        code: "insufficient_stock",
        column: "quantity_delta",
      }),
    );
  });
  it("requires an existing lot and unique source line key", async () => {
    const { admin } = await setup();
    const result = await admin.query(api.imports.adjustments.preview, {
      rows: [
        row(values({ lot_number: "" }), 8),
        row(values({ lot_number: "MISSING" }), 9),
      ],
    });
    expect(result.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining([
        "lot_required",
        "duplicate_in_file",
        "unknown_reference",
      ]),
    );
  });
  it("stages submitted request, cross-key replay is duplicate, and separate approval posts", async () => {
    const { t, admin, superAdmin } = await setup();
    const rows = [row(values())];
    const first = await admin.mutation(
      api.imports.adjustments.commit,
      args(rows),
    );
    expect(first.accepted).toBe(1);
    expect(first.adjustmentId).toBeDefined();
    expect(
      (await t.run((ctx) => ctx.db.get(first.adjustmentId!)))?.status,
    ).toBe("submitted");
    expect(
      await t.run((ctx) => ctx.db.query("inventoryMovements").collect()),
    ).toHaveLength(1);
    expect(
      (
        await admin.mutation(
          api.imports.adjustments.commit,
          args(rows, "other"),
        )
      ).runId,
    ).toBe(first.runId);
    await expect(
      admin.mutation(api.inventory.adjustments.decide, {
        adjustmentId: first.adjustmentId!,
        decision: "approved",
        idempotencyKey: "decision-1",
      }),
    ).rejects.toThrow(/own adjustment/);
    const movement = await superAdmin.mutation(
      api.inventory.adjustments.decide,
      {
        adjustmentId: first.adjustmentId!,
        decision: "approved",
        idempotencyKey: "decision-1",
      },
    );
    expect(movement).toBeDefined();
    expect(
      await t.run((ctx) => ctx.db.query("inventoryMovements").collect()),
    ).toHaveLength(2);
  });
  it("refuses changed payload under a used key", async () => {
    const { admin } = await setup();
    await admin.mutation(api.imports.adjustments.commit, args([row(values())]));
    await expect(
      admin.mutation(
        api.imports.adjustments.commit,
        args([row(values({ quantity_delta: "-1" }))]),
      ),
    ).rejects.toThrow(/different payload/);
  });
  it("rejects duplicate source line keys across chunks without a second request", async () => {
    const { admin, t } = await setup();
    const rows = [row(values(), 2), row(values(), 3)];
    const fileHash = fileHashOf(2, rows);
    const first = await admin.mutation(api.imports.adjustments.commit, {
      ...args(rows.slice(0, 1), "chunks"),
      rowCount: 2,
      fileHash,
    });
    expect(first.adjustmentId).toBeDefined();
    const second = await admin.mutation(api.imports.adjustments.commit, {
      ...args(rows.slice(1), "chunks"),
      rowCount: 2,
      fileHash,
      chunkIndex: 1,
      idempotencyKey: chunkKey("stock_adjustment", "chunks", 1),
    });
    expect(second.errors.map((e) => e.code)).toContain("duplicate_in_file");
    expect(second.adjustmentId).toBeUndefined();
    expect(
      await t.run((ctx) => ctx.db.query("inventoryAdjustments").collect()),
    ).toHaveLength(1);
  });
  it("reports out-of-scope row without staging and hides another region's history", async () => {
    const { t, admin, superAdmin } = await setup();
    const root = (
      await t.run((ctx) => ctx.db.query("orgUnits").collect())
    ).find((u) => u.code === "SUNPRIDE")!;
    const region = await t.run((ctx) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code: "REGION-CSV",
        name: "Other region",
        typeCode: "REGION",
        parentId: root._id,
        status: "active",
        effectiveFrom: 0,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await superAdmin.mutation(api.domains.profiles.invite, {
      email: "region-csv@example.test",
      name: "Region CSV",
      role: "manager",
    });
    const regional = t.withIdentity({
      subject: "region-csv@example.test",
      email: "region-csv@example.test",
      name: "Region CSV",
    });
    const profileId = await regional.mutation(api.domains.profiles.ensure, {});
    await t.run((ctx) => ctx.db.patch(profileId, { orgUnitId: region }));
    const rows = [row(values())];
    const denied = await regional.mutation(
      api.imports.adjustments.commit,
      args(rows),
    );
    expect(denied.errors.map((e) => e.code)).toContain("scope_denied");
    expect(denied.adjustmentId).toBeUndefined();
    const approved = await admin.mutation(
      api.imports.adjustments.commit,
      args([row(values({ note: "national" }))], "national-run"),
    );
    expect(approved.adjustmentId).toBeDefined();
    const history = await regional.query(
      api.imports.operational_history.list,
      {},
    );
    expect(history).toHaveLength(0);
    const detail = await regional.query(
      api.imports.operational_history.detail,
      { runKey: "national-run", importType: "stock_adjustment" },
    );
    expect(detail.runs).toHaveLength(0);
    await superAdmin.mutation(api.domains.profiles.invite, {
      email: "viewer-csv@example.test",
      name: "Viewer CSV",
      role: "viewer",
    });
    const viewer = t.withIdentity({
      subject: "viewer-csv@example.test",
      email: "viewer-csv@example.test",
      name: "Viewer CSV",
    });
    await viewer.mutation(api.domains.profiles.ensure, {});
    await expect(
      viewer.query(api.imports.operational_history.list, {}),
    ).rejects.toThrow();
  });
});
