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
  locationIdByCode,
} from "./test_helpers";
import { HEADER } from "./counts";

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
  const locationId = await locationIdByCode(t, "WH-MNL");
  const sessionId = await admin.mutation(api.inventory.counts.start, {
    locationId,
    countType: "cycle",
    blindCount: true,
  });
  const session = await t.run((ctx) => ctx.db.get(sessionId));
  const values = {
    count_reference: session!.countNumber,
    location_code: "WH-MNL",
    product_code: "SP-TEST-1L",
    stock_status: "available",
    lot_number: "LOT-TEST-0001",
    counted_quantity: "240",
    finding: "",
    note: "",
  };
  const args = (rows: ReturnType<typeof row>[], runKey = "count-1") => ({
    rows,
    rowCount: rows.length,
    runKey,
    chunkIndex: 0,
    idempotencyKey: chunkKey("cycle_count", runKey, 0),
    fileHash: fileHashOf(rows.length, rows),
  });
  return { t, admin, superAdmin, sessionId, values, args };
}
describe("cycle count CSV", () => {
  it("keeps open preview blind for a non-creator manager who can submit and approve", async () => {
    const { t, admin, superAdmin, sessionId, values, args } = await setup();
    const rootUnitId = await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", "admin@sunpride.local"))
        .unique();
      return profile?.orgUnitId;
    });
    if (!rootUnitId) throw new Error("Admin needs an org unit");
    await t.run(async (ctx) => {
      const session = await ctx.db.get(sessionId);
      if (!session) throw new Error("Missing count session");
      await ctx.db.patch(session.locationId, { orgUnitId: rootUnitId });
    });
    const email = "count-manager@sunpride.local";
    await superAdmin.mutation(api.domains.profiles.invite, {
      email,
      name: "Count manager",
      role: "manager",
    });
    const manager = t.withIdentity({
      subject: email,
      email,
      name: "Count manager",
    });
    const profileId = await manager.mutation(api.domains.profiles.ensure);
    await superAdmin.mutation(api.domains.profiles.assignPersona, {
      profileId,
      orgUnitId: rootUnitId,
    });
    const rows = [row({ ...values, counted_quantity: "239" }, 12)];
    for (const actor of [admin, manager, superAdmin]) {
      const preview = await actor.query(api.imports.counts.preview, {
        rows,
        header: HEADER.split(","),
      });
      expect(preview.lines).toEqual([
        { rowNumber: 12, countedBase: 239000n, status: "valid" },
      ]);
      expect(preview.approvalPartitions).toBeUndefined();
      expect(preview.zeroVarianceCount).toBeUndefined();
      expect(preview.proposedMovementLines).toBeUndefined();
      expect(
        JSON.stringify(preview, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ).not.toMatch(/expectedBase|varianceBase|projectedBase|systemBase/);
    }
    const submitted = await admin.mutation(
      api.imports.counts.commit,
      args(rows),
    );
    expect(submitted.sessionId).toBe(sessionId);
    const detail = await superAdmin.query(api.inventory.counts.detail, {
      sessionId,
    });
    expect(detail.session.status).toBe("submitted");
    expect(detail.lines).toEqual([
      expect.objectContaining({
        productCode: "SP-TEST-1L",
        lotNumber: "LOT-TEST-0001",
        systemBase: 240000n,
        countedBase: 239000n,
        varianceBase: -1000n,
      }),
    ]);
  });
  it("rejects missing, unknown, and reordered headers with no count staged", async () => {
    const { t, admin, sessionId, values, args } = await setup();
    const header = HEADER.split(",");
    for (const bad of [
      header.slice(1),
      [...header, "surprise"],
      [header[1]!, header[0]!, ...header.slice(2)],
    ]) {
      const preview = await admin.query(api.imports.counts.preview, {
        rows: [row(values)],
        header: bad,
      });
      expect(preview.errors).toEqual([
        expect.objectContaining({
          rowNumber: 1,
          column: "header",
          code: "invalid_format",
        }),
      ]);
      expect(preview.lines).toEqual([]);
      await expect(
        admin.mutation(api.imports.counts.commit, {
          ...args([row(values)]),
          header: bad,
        }),
      ).rejects.toThrow(/invalid_format/);
    }
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.status).toBe(
      "counting",
    );
  });
  it("rejects a changed-and-restored balance after snapshot", async () => {
    const { t, admin, superAdmin, values, args, sessionId } = await setup();
    const line = (await t.run((ctx) =>
      ctx.db.query("stockCountLines").first(),
    ))!;
    const location = (await t.run((ctx) => ctx.db.get(sessionId)))!.locationId;
    for (const [index, delta] of [5000n, -5000n].entries()) {
      const adjustmentId = await admin.mutation(
        api.inventory.adjustments.request,
        {
          adjustmentType: "correction",
          reasonCode: "TEST",
          lines: [
            {
              productId: line.productId,
              lotId: line.lotId,
              locationId: location,
              stockStatus: "available",
              varianceBase: delta,
            },
          ],
        },
      );
      await superAdmin.mutation(api.inventory.adjustments.decide, {
        adjustmentId,
        decision: "approved",
        idempotencyKey: `restored-${index}`,
      });
    }
    const live = (await t.run((ctx) =>
      ctx.db.query("inventoryLotBalances").first(),
    ))!;
    expect(live.physicalBase).toBe(line.systemBase);
    expect(live.version).toBeGreaterThan(line.snapshotBalanceVersion!);
    const preview = await admin.query(api.imports.counts.preview, {
      rows: [row(values)],
    });
    expect(preview.errors.map((e) => e.code)).toContain("stale_snapshot");
    const commit = await admin.mutation(
      api.imports.counts.commit,
      args([row(values)]),
    );
    expect(commit.errors.map((e) => e.code)).toContain("stale_snapshot");
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.status).toBe(
      "counting",
    );
  });
  it("has exact template and hides expected/variance in blind preview", async () => {
    expect(HEADER).toBe(
      "count_reference,location_code,product_code,stock_status,lot_number,counted_quantity,finding,note",
    );
    const { admin, values } = await setup();
    const result = await admin.query(api.imports.counts.preview, {
      rows: [row(values)],
    });
    expect(result.accepted).toBe(1);
    expect(
      JSON.stringify(result, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toMatch(/systemBase|varianceBase|expectedBase/);
  });
  it("accepts zero observation, submits once, and posts variance only on another actor's approval", async () => {
    const { t, admin, superAdmin, sessionId, values, args } = await setup();
    const rows = [row({ ...values, counted_quantity: "0" })];
    const first = await admin.mutation(api.imports.counts.commit, args(rows));
    expect(first.sessionId).toBe(sessionId);
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.status).toBe(
      "submitted",
    );
    expect(
      (await admin.mutation(api.imports.counts.commit, args(rows, "again")))
        .runId,
    ).toBe(first.runId);
    await expect(
      admin.mutation(api.inventory.counts.approveAndPost, {
        sessionId,
        idempotencyKey: "post-count",
        reasonCode: "CYCLE",
      }),
    ).rejects.toThrow(/own stock count/);
    await superAdmin.mutation(api.inventory.counts.approveAndPost, {
      sessionId,
      idempotencyKey: "post-count",
      reasonCode: "CYCLE",
    });
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.status).toBe(
      "posted",
    );
  });
  it("rejects missing, duplicate, unknown and negative rows without submitting", async () => {
    const { t, admin, sessionId, values, args } = await setup();
    const duplicate = await admin.mutation(
      api.imports.counts.commit,
      args([row(values, 2), row(values, 3)]),
    );
    expect(duplicate.errors.map((e) => e.code)).toContain("duplicate_in_file");
    const unknown = await admin.query(api.imports.counts.preview, {
      rows: [row({ ...values, lot_number: "UNKNOWN" }, 8)],
    });
    expect(unknown.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(["count_line_missing", "count_incomplete"]),
    );
    const negative = await admin.query(api.imports.counts.preview, {
      rows: [row({ ...values, counted_quantity: "-1" }, 9)],
    });
    expect(negative.errors).toContainEqual(
      expect.objectContaining({
        rowNumber: 9,
        column: "counted_quantity",
        code: "invalid_format",
      }),
    );
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.status).toBe(
      "counting",
    );
  });
  it("refuses a stale snapshot and >100-line session", async () => {
    const { t, admin, sessionId, values, args } = await setup();
    await t.run(async (ctx) => {
      const line = (await ctx.db.query("stockCountLines").collect())[0]!;
      for (let i = 0; i < 100; i++)
        await ctx.db.insert("stockCountLines", {
          organizationId: "sunpride",
          sessionId,
          productId: line.productId,
          lotId: line.lotId,
          stockStatus: "available",
          systemBase: line.systemBase,
        });
    });
    const large = await admin.mutation(
      api.imports.counts.commit,
      args([row(values)]),
    );
    expect(large.errors.map((e) => e.code)).toContain("session_too_large");
  });
  it("refuses stale live quantity at preview and commit", async () => {
    const { t, admin, values, args } = await setup();
    await t.run(async (ctx) => {
      const balance = (
        await ctx.db.query("inventoryLotBalances").collect()
      )[0]!;
      await ctx.db.patch(balance._id, {
        physicalBase: balance.physicalBase + 1000n,
        version: balance.version + 1,
      });
    });
    const preview = await admin.query(api.imports.counts.preview, {
      rows: [row(values)],
    });
    expect(preview.errors.map((e) => e.code)).toContain("stale_snapshot");
    const result = await admin.mutation(
      api.imports.counts.commit,
      args([row(values)]),
    );
    expect(result.errors.map((e) => e.code)).toContain("stale_snapshot");
  });
  it("posts no movement for a zero variance session and keeps blind counter redacted", async () => {
    const { t, admin, superAdmin, sessionId, values, args } = await setup();
    const result = await admin.mutation(
      api.imports.counts.commit,
      args([row(values)]),
    );
    expect(result.accepted).toBe(1);
    const before = (
      await t.run((ctx) => ctx.db.query("inventoryMovements").collect())
    ).length;
    const detail = await admin.query(api.inventory.counts.detail, {
      sessionId,
    });
    expect(detail.lines[0]?.systemBase).toBeUndefined();
    expect(detail.lines[0]?.varianceBase).toBeUndefined();
    await superAdmin.mutation(api.inventory.counts.approveAndPost, {
      sessionId,
      idempotencyKey: "zero-count",
      reasonCode: "CYCLE",
    });
    expect(
      (await t.run((ctx) => ctx.db.query("inventoryMovements").collect()))
        .length,
    ).toBe(before);
    const history = await admin.query(api.imports.operational_history.detail, {
      runKey: "count-1",
      importType: "cycle_count",
    });
    expect(history.runs[0]?.status).toBe("posted");
  });
});
