import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convexTest, type TestConvex } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { beforeAll, describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
// The web client's own parser, templates and chunking: the server is exercised
// with exactly the bytes and arguments the import workspace sends.
import { hashText, parseCsv } from "../../../../apps/web/src/lib/csv";
import {
  IMPORT_TEMPLATES,
  chunkKeyFor,
  chunkRows,
} from "../../../../apps/web/src/lib/import-templates";
import { OPERATIONAL_HEADERS } from "../../../../apps/web/src/lib/import-csv-export";

/**
 * SFD-019 shared-foundation exit gate (SP-0050).
 *
 * One national cutover story through public functions only: the shipped web
 * product CSV template → opening stock → inventory ledger → web overview read
 * and van-POS (mobile) sale; opening-stock replay rejection; idempotent
 * adjustment retry; blind cycle-count variance approval; cross-scope denial
 * with no side effects; audit completeness for every movement; and frozen
 * client/server contracts. A failure here blocks the next vertical-slice gate
 * (docs/qa/FOUNDATION_EXIT_GATE.md).
 */
type T = TestConvex<typeof schema>;

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const SINCE = Date.now() - 30 * 86_400_000;

function template(kind: "products" | "opening_stock") {
  return readFileSync(
    resolve(
      repoRoot,
      "apps/web/public",
      `.${IMPORT_TEMPLATES[kind].templatePath}`,
    ),
    "utf8",
  );
}

/** Mirrors imports-workspace.tsx: parse, content-hash run key, 100-row chunks. */
function webChunks(kind: "products" | "opening_stock", text: string) {
  const parsed = parseCsv(text, IMPORT_TEMPLATES[kind].headers);
  expect(parsed.errors).toEqual([]);
  const runKey = hashText(text);
  return chunkRows(parsed.rows).map((rows, chunkIndex) => ({
    runKey,
    chunkIndex,
    idempotencyKey: chunkKeyFor(kind, runKey, chunkIndex),
    fileHash: runKey,
    rows,
  }));
}

function openingArgs(text: string) {
  return webChunks("opening_stock", text).map((base) => ({
    ...base,
    sourceReference: base.rows[0]?.values.source_reference ?? "",
  }));
}

function adjustmentArgs(text: string) {
  const header = OPERATIONAL_HEADERS.stock_adjustment.split(",");
  const parsed = parseCsv(text, header);
  expect(parsed.errors).toEqual([]);
  const runKey = hashText(text);
  return {
    runKey,
    chunkIndex: 0,
    idempotencyKey: `stock_adjustment:${runKey}:0`,
    fileHash: runKey,
    rows: parsed.rows,
    rowCount: parsed.rows.length,
    header: parsed.header,
  };
}

async function story() {
  const t: T = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({
    subject: "gate-root",
    email: "jcing.jc@gmail.com",
    name: "Gate root",
  });
  await root.mutation(api.domains.profiles.ensure, {});
  const rootSubject = (await root.query(api.domains.profiles.current, {}))!
    .authSubject;
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const [north, south] = await t.run(async (ctx) =>
    Promise.all(
      ["NORTH", "SOUTH"].map((code) =>
        ctx.db.insert("orgUnits", {
          organizationId: "sunpride",
          code,
          name: code,
          typeCode: "REGION",
          parentId: rootUnitId,
          status: "active",
          effectiveFrom: SINCE,
          createdAt: SINCE,
          updatedAt: SINCE,
        }),
      ),
    ),
  );
  async function person(
    label: string,
    role: "admin" | "manager" | "approver" | "sales",
    orgUnitId: Id<"orgUnits">,
  ) {
    const email = `${label}@gate.test`;
    await root.mutation(api.domains.profiles.invite, {
      email,
      name: label,
      role,
    });
    const actor = t.withIdentity({ subject: label, email, name: label });
    const profileId = await actor.mutation(api.domains.profiles.ensure, {});
    await root.mutation(api.people.mutations.assign, {
      profileId,
      orgUnitId,
      role,
      reason: `Place ${label}`,
    });
    const subject = (await actor.query(api.domains.profiles.current, {}))!
      .authSubject;
    return { actor, profileId, subject };
  }
  const northAdmin = await person("north-admin", "admin", north!);
  const northManager = await person("north-manager", "manager", north!);
  const northApprover = await person("north-approver", "approver", north!);
  const northSeller = await person("north-seller", "sales", north!);
  const southManager = await person("south-manager", "manager", south!);
  const southSeller = await person("south-seller", "sales", south!);

  await root.mutation(api.inventory.setup.foundation, {});
  const locations = await root.query(api.inventory.queries.locations, {});
  const warehouse = locations.find((l) => l.code === "WH-MNL")!;
  const truck = locations.find((l) => l.code === "TRUCK-001")!;
  for (const location of [warehouse, truck])
    await root.mutation(api.inventory.location_scope.assign, {
      locationId: location._id,
      orgUnitId: north!,
      reason: `Map ${location.code} to North`,
    });
  return {
    t,
    root,
    rootSubject,
    north: north!,
    south: south!,
    northAdmin,
    northManager,
    northApprover,
    northSeller,
    southManager,
    southSeller,
    warehouse,
    truck,
  };
}

let f: Awaited<ReturnType<typeof story>>;
let productId: Id<"products">;
let pendingAdjustment: Id<"inventoryAdjustments">;
let northSale: FunctionArgs<typeof api.inventory.pos.postSale>;

const SKU = "SP-PJ-1L";
const TRUCK_CSV = [
  IMPORT_TEMPLATES.opening_stock.headers.join(","),
  `${SKU},TRUCK-001,LOT-2026-0002,2026-08-01,2027-08-01,40,118800,VAN-CUTOVER-2026-10`,
].join("\n");
function adjustmentCsv(lineKey: string, delta: string, note: string) {
  return [
    OPERATIONAL_HEADERS.stock_adjustment,
    `ADJ-GATE,${lineKey},addition,correction,${SKU},WH-MNL,available,LOT-2026-0001,${delta},,${note}`,
  ].join("\r\n");
}

async function balance(locationId: Id<"inventoryLocations">) {
  return f.t.run(async (ctx) =>
    ctx.db
      .query("inventoryBalances")
      .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
        q
          .eq("organizationId", "sunpride")
          .eq("productId", productId)
          .eq("locationId", locationId),
      )
      .unique(),
  );
}

/** Every table a foundation write can touch; equal snapshots prove no side effect. */
async function writeSnapshot() {
  return f.t.run(async (ctx) => ({
    products: await ctx.db.query("products").collect(),
    runs: await ctx.db.query("importRuns").collect(),
    movements: await ctx.db.query("inventoryMovements").collect(),
    ledger: await ctx.db.query("inventoryLedgerEntries").collect(),
    balances: await ctx.db.query("inventoryBalances").collect(),
    lotBalances: await ctx.db.query("inventoryLotBalances").collect(),
    lots: await ctx.db.query("inventoryLots").collect(),
    commands: await ctx.db.query("inventoryCommands").collect(),
    adjustments: await ctx.db.query("inventoryAdjustments").collect(),
    adjustmentLines: await ctx.db.query("inventoryAdjustmentLines").collect(),
    counts: await ctx.db.query("stockCountSessions").collect(),
    countLines: await ctx.db.query("stockCountLines").collect(),
    orders: await ctx.db.query("orders").collect(),
    routes: await ctx.db.query("truckRouteSessions").collect(),
    audit: await ctx.db.query("auditLogs").collect(),
    events: await ctx.db.query("integrationEvents").collect(),
  }));
}

describe.sequential("SFD-019 shared foundation exit gate", () => {
  beforeAll(async () => {
    f = await story();
  });

  it("imports the shipped web product template, posts opening stock to the ledger, and reads it on web and van POS", async () => {
    for (const args of webChunks("products", template("products"))) {
      const result = await f.root.mutation(
        api.imports.products.commitProducts,
        args,
      );
      expect(result).toMatchObject({ created: 1, failed: 0, duplicate: false });
    }
    const product = (
      await f.root.query(api.domains.masterData.products, { limit: 50 })
    ).find((p) => p.code === SKU);
    expect(product).toBeDefined();
    productId = product!._id;

    for (const text of [template("opening_stock"), TRUCK_CSV])
      for (const args of openingArgs(text)) {
        const result = await f.root.mutation(
          api.imports.openingStock.commitOpeningStock,
          args,
        );
        expect(result).toMatchObject({
          accepted: 1,
          failed: 0,
          duplicate: false,
        });
        const trace = await f.root.query(api.inventory.queries.trace, {
          movementId: result.movementId!,
        });
        expect(trace.command?.status).toBe("posted");
        expect(trace.entries).toHaveLength(1);
        expect(trace.entries[0]?.quantityBeforeBase).toBe(0n);
      }
    expect((await balance(f.warehouse._id))?.physicalBase).toBe(240_000n);
    expect((await balance(f.truck._id))?.physicalBase).toBe(40_000n);

    // Web read: the scoped overview shows the imported balances in display units.
    const web = await f.northManager.actor.query(
      api.inventory.queries.overview,
      {},
    );
    expect(
      web
        .filter((row) => row.productCode === SKU)
        .map((row) => [row.locationCode, row.available])
        .sort(),
    ).toEqual([
      ["TRUCK-001", "40"],
      ["WH-MNL", "240"],
    ]);

    // Mobile read/write: the van POS sells the imported product off the truck.
    const routeSessionId = await f.northSeller.actor.mutation(
      api.inventory.pos.openRoute,
      { truckLocationId: f.truck._id, deviceId: "gate-van" },
    );
    expect(
      (
        await f.northSeller.actor.query(api.inventory.pos.currentRoute, {
          deviceId: "gate-van",
        })
      )?._id,
    ).toBe(routeSessionId);
    const sale = {
      clientRequestId: "gate-sale-1",
      customerCode: "CUS-GATE",
      truckLocationId: f.truck._id,
      routeSessionId,
      deviceId: "gate-van",
      deviceSequence: 1,
      offlineCreatedAt: Date.now() - 60_000,
      lines: [
        {
          productCode: SKU,
          description: product!.name,
          quantityBase: 3_000n,
          quantity: 3,
          unitPrice: 100,
        },
      ],
    };
    northSale = sale;
    const sold = await f.northSeller.actor.mutation(
      api.inventory.pos.postSale,
      sale,
    );
    expect(sold.duplicate).toBe(false);
    // A lost-ack retry of the same sale is a no-op.
    const replay = await f.northSeller.actor.mutation(
      api.inventory.pos.postSale,
      sale,
    );
    expect(replay).toMatchObject({
      duplicate: true,
      movementId: sold.movementId,
    });
    expect((await balance(f.truck._id))?.availableStockBase).toBe(37_000n);
    expect(
      (
        await f.northSeller.actor.query(api.inventory.queries.overview, {
          locationId: f.truck._id,
        })
      ).find((row) => row.productCode === SKU)?.available,
    ).toBe("37");
  });

  it("rejects opening-stock replay: same file is a duplicate, a changed file under the key and any re-post are refused", async () => {
    const [args] = openingArgs(template("opening_stock"));
    const before = await writeSnapshot();
    const replay = await f.root.mutation(
      api.imports.openingStock.commitOpeningStock,
      args!,
    );
    expect(replay.duplicate).toBe(true);
    expect(await writeSnapshot()).toEqual(before);

    const edited = template("opening_stock").replace(",240,", ",250,");
    const [changed] = openingArgs(edited);
    await expect(
      f.root.mutation(api.imports.openingStock.commitOpeningStock, {
        ...changed!,
        runKey: args!.runKey,
        idempotencyKey: args!.idempotencyKey,
        fileHash: args!.fileHash,
      }),
    ).rejects.toThrow(/different payload/);
    expect(await writeSnapshot()).toEqual(before);

    // An edited file is a new run, but stock already landed for that product/lot/location.
    const fresh = await f.root.mutation(
      api.imports.openingStock.commitOpeningStock,
      changed!,
    );
    expect(fresh.accepted).toBe(0);
    expect(fresh.errors.map((e) => e.code)).toContain("duplicate_stock");
    const after = await writeSnapshot();
    expect(after.movements).toEqual(before.movements);
    expect(after.balances).toEqual(before.balances);
    expect(after.ledger).toEqual(before.ledger);
  });

  it("retries an adjustment idempotently: CSV replay returns the same request and approval posts exactly once", async () => {
    const args = adjustmentArgs(adjustmentCsv("1", "+2", "found case"));
    const first = await f.northManager.actor.mutation(
      api.imports.adjustments.commit,
      args,
    );
    expect(first).toMatchObject({ accepted: 1, duplicate: false });
    const retry = await f.northManager.actor.mutation(
      api.imports.adjustments.commit,
      args,
    );
    expect(retry).toMatchObject({
      duplicate: true,
      runId: first.runId,
      adjustmentId: first.adjustmentId,
    });
    const adjustments = await f.t.run((ctx) =>
      ctx.db.query("inventoryAdjustments").collect(),
    );
    expect(adjustments).toHaveLength(1);

    await expect(
      f.northManager.actor.mutation(api.inventory.adjustments.decide, {
        adjustmentId: first.adjustmentId!,
        decision: "approved",
        idempotencyKey: "gate-adj-1",
      }),
    ).rejects.toThrow(/own adjustment/);
    const decision = {
      adjustmentId: first.adjustmentId!,
      decision: "approved" as const,
      idempotencyKey: "gate-adj-1",
    };
    const movementId = await f.northApprover.actor.mutation(
      api.inventory.adjustments.decide,
      decision,
    );
    expect(movementId).not.toBeNull();
    const before = await writeSnapshot();
    // A lost-ack retry of the approval cannot post a second movement.
    await expect(
      f.northApprover.actor.mutation(
        api.inventory.adjustments.decide,
        decision,
      ),
    ).rejects.toThrow(/not awaiting a decision/);
    expect(await writeSnapshot()).toEqual(before);
    expect((await balance(f.warehouse._id))?.physicalBase).toBe(242_000n);
  });

  it("approves a blind cycle-count variance through a second person and posts it to the ledger", async () => {
    const sessionId = await f.northManager.actor.mutation(
      api.inventory.counts.start,
      { locationId: f.warehouse._id, countType: "cycle", blindCount: true },
    );
    const blind = await f.northManager.actor.query(
      api.inventory.counts.detail,
      {
        sessionId,
      },
    );
    expect(blind.lines).toHaveLength(1);
    expect(blind.lines[0]?.systemBase).toBeUndefined();
    await f.northManager.actor.mutation(api.inventory.counts.submit, {
      sessionId,
      lines: [
        {
          lineId: blind.lines[0]!.lineId,
          countedBase: 239_000n,
          finding: "missing",
        },
      ],
    });
    await expect(
      f.northManager.actor.mutation(api.inventory.counts.approveAndPost, {
        sessionId,
        idempotencyKey: "gate-count-1",
        reasonCode: "cycle_variance",
      }),
    ).rejects.toThrow(/own stock count/);
    const review = await f.northApprover.actor.query(
      api.inventory.counts.detail,
      {
        sessionId,
      },
    );
    expect(review.lines[0]).toMatchObject({
      systemBase: 242_000n,
      countedBase: 239_000n,
      varianceBase: -3_000n,
    });
    const adjustmentId = await f.northApprover.actor.mutation(
      api.inventory.counts.approveAndPost,
      {
        sessionId,
        idempotencyKey: "gate-count-1",
        reasonCode: "cycle_variance",
      },
    );
    const before = await writeSnapshot();
    await expect(
      f.northApprover.actor.mutation(api.inventory.counts.approveAndPost, {
        sessionId,
        idempotencyKey: "gate-count-1",
        reasonCode: "cycle_variance",
      }),
    ).rejects.toThrow(/not ready for approval/);
    expect(await writeSnapshot()).toEqual(before);
    const adjustment = before.adjustments.find((a) => a._id === adjustmentId)!;
    expect(adjustment).toMatchObject({
      adjustmentType: "stock_count",
      status: "posted",
      sourceCountId: sessionId,
      approvedBy: f.northApprover.subject,
      requestedBy: f.northManager.subject,
    });
    expect(
      before.adjustmentLines.filter((l) => l.adjustmentId === adjustmentId),
    ).toEqual([expect.objectContaining({ varianceBase: -3_000n })]);
    expect((await balance(f.warehouse._id))?.physicalBase).toBe(239_000n);
  });

  it("denies every cross-scope foundation read and write without side effects", async () => {
    // Stage one more North adjustment for the cross-scope approval attempt.
    pendingAdjustment = (
      await f.northManager.actor.mutation(
        api.imports.adjustments.commit,
        adjustmentArgs(adjustmentCsv("2", "+1", "pending")),
      )
    ).adjustmentId!;

    expect(
      await f.southManager.actor.query(api.inventory.queries.overview, {}),
    ).toEqual([]);
    expect(
      (
        await f.southManager.actor.query(api.inventory.adjustments.list, {})
      ).map((a) => a._id),
    ).not.toContain(pendingAdjustment);
    expect(
      await f.southManager.actor.query(api.inventory.counts.list, {}),
    ).toEqual([]);

    const southRoute = () =>
      f.southSeller.actor.mutation(api.inventory.pos.openRoute, {
        truckLocationId: f.truck._id,
        deviceId: "south-van",
      });
    const outside = /outside your organizational scope/;
    const attempts: Array<[string, () => Promise<unknown>, RegExp]> = [
      [
        "regional admin imports products (national only)",
        () =>
          f.northAdmin.actor.mutation(
            api.imports.products.commitProducts,
            webChunks("products", template("products"))[0]!,
          ),
        /Insufficient permission|organizational scope/,
      ],
      [
        "regional admin posts opening stock (national only)",
        () =>
          f.northAdmin.actor.mutation(
            api.imports.openingStock.commitOpeningStock,
            openingArgs(
              TRUCK_CSV.replace("LOT-2026-0002", "LOT-2026-0009"),
            )[0]!,
          ),
        /Insufficient permission|organizational scope/,
      ],
      [
        "South approves a North adjustment",
        () =>
          f.southManager.actor.mutation(api.inventory.adjustments.decide, {
            adjustmentId: pendingAdjustment,
            decision: "approved",
            idempotencyKey: "south-steal",
          }),
        outside,
      ],
      [
        "South requests a North adjustment",
        () =>
          f.southManager.actor.mutation(api.inventory.adjustments.request, {
            adjustmentType: "correction",
            reasonCode: "CROSS",
            lines: [
              {
                productId,
                locationId: f.warehouse._id,
                stockStatus: "available",
                varianceBase: 1_000n,
              },
            ],
          }),
        outside,
      ],
      [
        "South counts a North warehouse",
        () =>
          f.southManager.actor.mutation(api.inventory.counts.start, {
            locationId: f.warehouse._id,
            countType: "cycle",
            blindCount: true,
          }),
        outside,
      ],
      ["South seller opens the North truck", southRoute, outside],
      [
        "South seller replays the North sale",
        () =>
          f.southSeller.actor.mutation(api.inventory.pos.postSale, northSale),
        /belongs to another salesperson/,
      ],
    ];
    for (const [label, attempt, expected] of attempts) {
      const before = await writeSnapshot();
      await expect(attempt(), label).rejects.toThrow(expected);
      expect(await writeSnapshot(), label).toEqual(before);
    }

    // Operational CSV refuses a South row per line, without staging anything.
    const before = await writeSnapshot();
    const denied = await f.southManager.actor.mutation(
      api.imports.adjustments.commit,
      adjustmentArgs(adjustmentCsv("3", "+1", "south")),
    );
    expect(denied.adjustmentId).toBeUndefined();
    expect(denied.errors.map((e) => e.code)).toContain("scope_denied");
    const after = await writeSnapshot();
    expect(after.adjustments).toEqual(before.adjustments);
    expect(after.movements).toEqual(before.movements);
    expect(after.ledger).toEqual(before.ledger);
    // The refused file is still recorded, as a failed run under the caller's name.
    const run = after.runs.find((r) => r._id === denied.runId);
    expect(run).toMatchObject({
      actorSubject: f.southManager.subject,
      createdCount: 0,
    });
    expect(run!.failedCount).toBeGreaterThan(0);
  });

  it("audits every movement with its command, actor, outbound event and a reconciling ledger", async () => {
    const s = await writeSnapshot();
    const people = new Set(
      [
        f.northAdmin,
        f.northManager,
        f.northApprover,
        f.northSeller,
        f.southManager,
        f.southSeller,
      ].map((p) => p.subject),
    );
    people.add(f.rootSubject);
    expect(s.movements.length).toBe(5); // 2 opening, 1 sale, 1 adjustment, 1 count
    for (const movement of s.movements) {
      const commands = s.commands.filter((c) => c.movementId === movement._id);
      expect(commands, movement.movementNumber).toHaveLength(1);
      const command = commands[0]!;
      expect(command.status).toBe("posted");
      expect(people.has(command.actorSubject)).toBe(true);
      expect(
        s.audit.filter(
          (a) =>
            a.entityId === movement._id &&
            a.action === `inventory.${movement.movementType}.posted` &&
            a.subject === command.actorSubject,
        ),
        movement.movementNumber,
      ).toHaveLength(1);
      // Cutover balances already exist in SAP, so opening stock emits no outbound event.
      expect(
        s.events.filter(
          (e) =>
            e.eventId === `inventory-${movement._id}` &&
            e.direction === "outbound",
        ),
        movement.movementNumber,
      ).toHaveLength(movement.movementType === "opening_balance" ? 0 : 1);
      expect(
        s.ledger.filter((e) => e.movementId === movement._id).length,
      ).toBeGreaterThan(0);
    }
    // Ledger, lot balances and balance projection agree for every location.
    for (const location of [f.warehouse, f.truck]) {
      const row = s.balances.find(
        (b) => b.locationId === location._id && b.productId === productId,
      )!;
      const ledger = s.ledger
        .filter(
          (e) =>
            e.locationId === location._id &&
            e.productId === productId &&
            e.stockStatus === "available",
        )
        .reduce((sum, e) => sum + e.quantityDeltaBase, 0n);
      const lots = s.lotBalances
        .filter(
          (l) => l.locationId === location._id && l.productId === productId,
        )
        .reduce((sum, l) => sum + l.physicalBase, 0n);
      expect(ledger, location.code).toBe(row.availableStockBase);
      expect(lots, location.code).toBe(row.physicalBase);
    }
    // Reason-bearing and lifecycle transitions are tied to the server-derived caller.
    const expected: Array<[string, string]> = [
      ["import.products", f.rootSubject],
      ["import.opening_stock", f.rootSubject],
      ["inventory.location_scope.assigned", f.rootSubject],
      ["inventory.adjustment.requested", f.northManager.subject],
      ["inventory.count.started", f.northManager.subject],
      ["inventory.count.submitted", f.northManager.subject],
      ["inventory.count.approved_and_posted", f.northApprover.subject],
    ];
    for (const [action, subject] of expected)
      expect(
        s.audit.some((a) => a.action === action && a.subject === subject),
        action,
      ).toBe(true);
    // Every import run names the person who committed it.
    for (const run of s.runs)
      expect(people.has(run.actorSubject), run.runKey).toBe(true);
  });
});
