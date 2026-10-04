import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { manilaDate } from "../coverage/validation";
import { chunkKey, fileHashOf } from "../imports/shared";
import {
  locationIdByCode,
  openingStockValues,
  productByCode,
  productValues,
  provisionAdmin,
  provisionInventory,
  row,
} from "../imports/test_helpers";
import { fixture } from "./bootstrap.test";
import { readCursor } from "./cursor";

// Manila noon today: two-minute steps never cross the field-day boundary.
const NOON = Date.parse(`${manilaDate(Date.now())}T04:00:00Z`);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOON);
});
afterEach(() => vi.useRealTimers());
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

async function productImport(
  admin: Awaited<ReturnType<typeof provisionAdmin>>["admin"],
  runKey: string,
  overrides: Record<string, string> = {},
) {
  const rows = [row(productValues(overrides))];
  return admin.mutation(api.imports.products.commitProducts, {
    runKey,
    chunkIndex: 0,
    idempotencyKey: chunkKey("products", runKey, 0),
    fileHash: fileHashOf(rows.length, rows),
    rows,
  });
}

/** Office CSV path (product master, then opening stock) feeding a field phone's account. */
async function setup() {
  const t = convexTest(schema, modules);
  const { admin } = await provisionAdmin(t);
  await provisionInventory(admin);
  await productImport(admin, "products-1");
  await productImport(admin, "products-other", {
    product_code: "SP-OFF-SHEET",
    name: "Not on any call sheet",
    barcode: "4800000000099",
    external_id: "SP-OFF-SHEET",
  });
  const f = await fixture(t);
  const product = (await productByCode(t, "SP-TEST-1L"))!;
  const offSheet = (await productByCode(t, "SP-OFF-SHEET"))!;
  const sale = await locationIdByCode(t, "WH-MNL");
  const ids = await t.run(async (ctx) => {
    // The unit's own sale location; others must stay invisible.
    await ctx.db.patch(sale, { orgUnitId: f.ids.unit, allowsSale: true });
    const base = {
      organizationId: "sunpride",
      siteCode: "LOCAL",
      allowsPicking: true,
      allowsReceiving: true,
      allowsProduction: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const staging = await ctx.db.insert("inventoryLocations", {
      ...base,
      orgUnitId: f.ids.unit,
      code: "LOCAL-STAGING",
      name: "Staging (no sale)",
      type: "zone",
      active: true,
      allowsSale: false,
    });
    const foreign = await ctx.db.insert("inventoryLocations", {
      ...base,
      orgUnitId: f.ids.foreignUnit,
      code: "FOREIGN-WH",
      name: "Foreign warehouse",
      type: "warehouse",
      active: true,
      allowsSale: true,
    });
    const account = await ctx.db.insert("callSheetAccounts", {
      organizationId: "sunpride",
      outletId: f.ids.outlet,
      revision: 1,
      header: { accountName: "Signed outlet" },
      lines: [{ productId: product._id }],
      updatedAt: Date.now(),
      updatedBy: "fixture",
    });
    return { staging, foreign, account };
  });
  return { ...f, admin, product, offSheet, sale, ...ids };
}

async function openingStock(
  f: Awaited<ReturnType<typeof setup>>,
  runKey: string,
  overrides: Record<string, string> = {},
) {
  const rows = [row(openingStockValues(overrides))];
  return f.admin.mutation(api.imports.openingStock.commitOpeningStock, {
    runKey,
    chunkIndex: 0,
    idempotencyKey: chunkKey("opening_stock", runKey, 0),
    fileHash: fileHashOf(rows.length, rows),
    sourceReference: overrides.source_reference ?? "CUTOVER-TEST",
    rows,
  });
}

async function postBalance(
  f: Awaited<ReturnType<typeof setup>>,
  productId: Id<"products">,
  locationId: Id<"inventoryLocations">,
  availableBase: bigint,
) {
  return f.t.run((ctx) =>
    ctx.db.insert("inventoryBalances", {
      productCode: "X",
      warehouseCode: "X",
      onHand: 0,
      reserved: 0,
      available: 0,
      asOf: Date.now(),
      organizationId: "sunpride",
      productId,
      locationId,
      physicalBase: availableBase,
      availableBase,
      reservedBase: 0n,
      version: 1,
    }),
  );
}

describe("mobile reference data (SP-0051)", () => {
  it("keeps the legacy bootstrap unchanged without the opt-in", async () => {
    const f = await setup();
    await openingStock(f, "cutover-1");
    const r = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(r.productCatalog).toEqual([]);
    expect(r).not.toHaveProperty("inventoryAvailability");
    const cursor = await readCursor(r.syncCursor!, "pull", f.actor, Date.now());
    expect(cursor.reference).toBeUndefined();
    // Legacy phones still get a fresh snapshot when product content changes.
    advance(1000);
    await productImport(f.admin, "products-2", { name: "Renamed juice" });
    await expect(
      f.caller.query(internal.mobile.pull.delta, {
        actor: f.actor,
        cursor: r.syncCursor!,
      }),
    ).rejects.toThrow("rebootstrap_required");
  });

  it("ships only call-sheet products and the unit's sale-location stock", async () => {
    const f = await setup();
    await openingStock(f, "cutover-1");
    await postBalance(f, f.offSheet._id, f.sale, 5_000n);
    await postBalance(f, f.product._id, f.staging, 7_000n);
    await postBalance(f, f.product._id, f.foreign, 9_000n);
    const r = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      referenceData: true,
    });
    expect(r.productCatalog).toHaveLength(1);
    const [item] = r.productCatalog;
    expect(item).toMatchObject({
      id: f.product._id,
      code: "SP-TEST-1L",
      name: "Sunpride Test Juice 1L",
      uom: "CASE",
      quantityScale: 1000,
      baseUom: { code: "CASE" },
      barcodes: [{ barcode: "4800000000001", uom: "CASE" }],
    });
    expect(item!.revision).toBeGreaterThan(0);
    expect(item!.sellingUoms!.map((u) => u.code)).toEqual(["CASE", "EACH"]);
    expect(r.inventoryAvailability).toEqual([
      {
        id: expect.any(String),
        productId: f.product._id,
        locationId: f.sale,
        locationCode: "WH-MNL",
        locationName: expect.any(String),
        availableBase: 240_000,
        physicalBase: 240_000,
        reservedBase: 0,
        revision: NOON,
        asOf: NOON,
      },
    ]);
    expect(JSON.stringify(r)).not.toContain("SP-OFF-SHEET");
    expect(JSON.stringify(r)).not.toContain(f.foreign);
    expect(JSON.stringify(r)).not.toContain(f.staging);
  });

  it("pages reference rows after visits and keeps the first page's mode", async () => {
    const f = await setup();
    await openingStock(f, "cutover-1");
    const pages = [];
    let page = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      referenceData: true,
      limit: 1,
    });
    pages.push(page);
    await expect(
      f.caller.query(internal.mobile.bootstrap.snapshot, {
        actor: f.actor,
        pageCursor: page.nextPageCursor!,
        referenceData: false,
        limit: 1,
      }),
    ).rejects.toThrow("invalid_request");
    while (page.nextPageCursor) {
      page = await f.caller.query(internal.mobile.bootstrap.snapshot, {
        actor: f.actor,
        pageCursor: page.nextPageCursor,
        limit: 1,
      });
      pages.push(page);
    }
    expect(
      pages.map((p) => [
        p.plannedVisits.length,
        p.productCatalog.length,
        p.inventoryAvailability?.length,
      ]),
    ).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(pages.at(-1)!.syncCursor).toBeTruthy();
  });

  it("delivers product and stock CSV changes as pull upserts without a fresh snapshot", async () => {
    const f = await setup();
    const boot = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      referenceData: true,
    });
    expect(boot.inventoryAvailability).toEqual([]);
    // First pull re-reads the one-minute overlap: the catalog row comes again (idempotent).
    const overlap = await f.caller.query(internal.mobile.pull.delta, {
      actor: f.actor,
      cursor: boot.syncCursor!,
    });
    expect(overlap.changes.map((c) => [c.entity, c.id])).toEqual([
      ["product", f.product._id],
    ]);
    advance(2 * 60_000);
    const quiet = await f.caller.query(internal.mobile.pull.delta, {
      actor: f.actor,
      cursor: overlap.nextCursor,
    });
    const settled = await f.caller.query(internal.mobile.pull.delta, {
      actor: f.actor,
      cursor: quiet.nextCursor,
    });
    expect(settled.changes).toEqual([]);

    advance(1000);
    await productImport(f.admin, "products-2", { name: "Renamed juice" });
    await openingStock(f, "cutover-1");
    const delta = await f.caller.query(internal.mobile.pull.delta, {
      actor: f.actor,
      cursor: settled.nextCursor,
    });
    expect(delta.hasMore).toBe(false);
    // Same revision: ordered by entity, then ID.
    expect(delta.changes).toMatchObject([
      {
        entity: "inventory",
        op: "upsert",
        revision: Date.now(),
        value: {
          productId: f.product._id,
          locationId: f.sale,
          availableBase: 240_000,
        },
      },
      {
        entity: "product",
        id: f.product._id,
        op: "upsert",
        revision: Date.now(),
        value: { name: "Renamed juice", code: "SP-TEST-1L" },
      },
    ]);
    // An off-sheet product edit is never sent.
    advance(2 * 60_000);
    const drained = await f.caller.query(internal.mobile.pull.delta, {
      actor: f.actor,
      cursor: delta.nextCursor,
    });
    advance(1000);
    await productImport(f.admin, "products-3", {
      product_code: "SP-OFF-SHEET",
      name: "Still private",
      barcode: "4800000000099",
      external_id: "SP-OFF-SHEET",
    });
    const none = await f.caller.query(internal.mobile.pull.delta, {
      actor: f.actor,
      cursor: drained.nextCursor,
    });
    expect(JSON.stringify(none.changes)).not.toContain("Still private");
  });

  it("pages reference changes within the pull limit after the person's own feed", async () => {
    const f = await setup();
    await openingStock(f, "cutover-1");
    const boot = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      referenceData: true,
    });
    await f.t.run((ctx) =>
      ctx.db.insert("mobileChanges", {
        organizationId: "sunpride",
        orgUnitId: f.ids.unit,
        sequence: 1,
        entity: "visit",
        entityId: f.ids.visit,
        revision: 1,
        op: "tombstone",
        ownerProfileId: f.ids.person,
        serverAt: Date.now(),
        payloadVersion: 1,
      }),
    );
    const seen: string[] = [];
    let cursor = boot.syncCursor!;
    for (let i = 0; i < 5; i++) {
      const page = await f.caller.query(internal.mobile.pull.delta, {
        actor: f.actor,
        cursor,
        limit: 1,
      });
      expect(page.changes.length).toBeLessThanOrEqual(1);
      seen.push(...page.changes.map((c) => c.entity));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual(["visit", "inventory", "product"]);
  });

  it("still forces a fresh snapshot when the assortment or locations change", async () => {
    const f = await setup();
    const boot = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      referenceData: true,
    });
    await f.t.run((ctx) =>
      ctx.db.patch(f.account, {
        revision: 2,
        lines: [{ productId: f.product._id }, { productId: f.offSheet._id }],
        updatedAt: Date.now() + 1,
      }),
    );
    await expect(
      f.caller.query(internal.mobile.pull.delta, {
        actor: f.actor,
        cursor: boot.syncCursor!,
      }),
    ).rejects.toThrow("rebootstrap_required");
    const again = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      referenceData: true,
    });
    expect(again.productCatalog.map((p) => p.code).sort()).toEqual([
      "SP-OFF-SHEET",
      "SP-TEST-1L",
    ]);
    await f.t.run((ctx) => ctx.db.patch(f.staging, { allowsSale: true }));
    await expect(
      f.caller.query(internal.mobile.pull.delta, {
        actor: f.actor,
        cursor: again.syncCursor!,
      }),
    ).rejects.toThrow("rebootstrap_required");
  });
});
