import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id, TableNames } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { manilaDate } from "../coverage/validation";
import type { AuthorizedDevice } from "../mobile/types";
import { postMovement } from "../inventory/posting";
import { resetBlockers } from "./sample";
import { schemaReferences, valuesAt } from "./sample_dependencies";
import { pricingCache, priceListFor, productPrices } from "../pricing/model";
import { topology } from "../org/validation";
import {
  SAMPLE_ACTOR,
  SAMPLE_BATCH,
  SAMPLE_PEOPLE,
  SAMPLE_PRICE_LISTS,
  SAMPLE_PRODUCTS,
  gs1CheckDigit,
  samplePrice,
  sampleBarcodes,
} from "./sample_data";

type T = TestConvex<typeof schema>;
// Wednesday 7 Oct 2026, 10:00 Manila.
const NOW = Date.parse("2026-10-07T02:00:00Z");
const LATER = NOW + 60_000;
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
afterEach(() => vi.useRealTimers());

const SAMPLE_TABLES = [
  "unitsOfMeasure",
  "orgUnits",
  "orgUnitParentEdges",
  "products",
  "productInventoryPolicies",
  "uomConversions",
  "productBarcodes",
  "priceLists",
  "priceListLines",
  "promotions",
  "territories",
  "territoryOwnerships",
  "routes",
  "routeTerritories",
  "customers",
  "outlets",
  "outletCustomerLinks",
  "outletPins",
  "outletAssignments",
  "callSheetAccounts",
  "inventoryLocations",
  "vehicles",
  "inventoryMovements",
  "inventoryMovementLines",
  "inventoryLedgerEntries",
  "inventoryBalances",
  "accessInvitations",
] as const;

async function counts(t: T) {
  return t.run(async (ctx) => {
    const out = {} as Record<(typeof SAMPLE_TABLES)[number], number>;
    for (const table of SAMPLE_TABLES)
      out[table] = (await ctx.db.query(table).collect()).length;
    return out;
  });
}

/** Every schema ID field of every row that does not resolve to an existing row. */
async function danglingReferences(t: T) {
  return t.run(async (ctx) => {
    const dangling: string[] = [];
    const byTable = new Map<string, ReturnType<typeof schemaReferences>>();
    for (const reference of schemaReferences())
      byTable.set(reference.table, [
        ...(byTable.get(reference.table) ?? []),
        reference,
      ]);
    for (const [table, references] of byTable) {
      for (const row of await ctx.db.query(table as TableNames).collect())
        for (const reference of references)
          for (const value of valuesAt(row, reference.path)) {
            if (typeof value !== "string") continue;
            const id = ctx.db.normalizeId(reference.target, value);
            if (!id || !(await ctx.db.get(id)))
              dangling.push(`${table}.${reference.path.join(".")} ${value}`);
          }
    }
    return dangling;
  });
}

async function fresh() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const t: T = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  return t;
}

function tester(t: T, key: string) {
  const person = SAMPLE_PEOPLE.find((row) => row.key === key)!;
  return t.withIdentity({
    subject: key,
    issuer: "https://auth.test",
    email: person.email,
    name: person.name,
  });
}

async function byCode<
  Table extends "products" | "outlets" | "orgUnits" | "routes" | "vehicles",
>(t: T, table: Table, code: string) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query(table).collect();
    const row = rows.find((r) => {
      const record = r as unknown as { code?: string; vehicleCode?: string };
      return (record.code ?? record.vehicleCode) === code;
    });
    if (!row) throw new Error(`${table} ${code} missing`);
    return row;
  });
}

const rs = SAMPLE_PRICE_LISTS.find((list) => list.channel === "ROUTE_SALES")!;
const productNamed = (code: string) =>
  SAMPLE_PRODUCTS.find((product) => product.code === code)!;

// Each test seeds a whole deployment (~1,000 rows through the domain writers): slower than
// the 5 s default when the full suite runs in parallel.
describe("beta sample seed (SP-0129)", { timeout: 30_000 }, () => {
  it("fills a fresh deployment, is idempotent, and every row is marked as sample", async () => {
    const t = await fresh();
    const before = await counts(t);
    const first = await t.mutation(internal.beta.sample.seed, {});
    expect(first.batch).toBe(SAMPLE_BATCH);
    expect(first.testersPending).toHaveLength(SAMPLE_PEOPLE.length);
    const after = await counts(t);
    expect(after.products - before.products).toBe(40);
    expect(after.priceLists).toBe(3);
    expect(after.promotions).toBe(3);
    expect(after.outlets).toBe(30);
    expect(after.outletPins).toBe(30);
    expect(after.callSheetAccounts).toBe(30);
    expect(after.customers - before.customers).toBe(30);
    expect(after.vehicles).toBe(2);
    expect(after.territories).toBe(3);
    expect(after.routes).toBe(3);
    // National root (foundation) > Visayas > Cebu > Cebu North / Cebu South.
    expect(after.orgUnits).toBe(5);
    expect(after.accessInvitations - before.accessInvitations).toBe(7);
    // Barcodes: one piece EAN-13 and one case GTIN-14 per product, valid check digits.
    expect(after.productBarcodes).toBe(80);
    const { piece, case: caseCode } = sampleBarcodes(0);
    expect(piece).toHaveLength(13);
    expect(caseCode).toHaveLength(14);
    expect(gs1CheckDigit(piece.slice(0, 12))).toBe(piece[12]);
    expect(gs1CheckDigit(caseCode.slice(0, 13))).toBe(caseCode[13]);

    const second = await t.mutation(internal.beta.sample.seed, {});
    expect(second.created).toEqual({});
    expect(await counts(t)).toEqual(after);

    await t.run(async (ctx) => {
      const lists = await ctx.db.query("priceLists").collect();
      expect(lists.every((list) => list.source === "sample")).toBe(true);
      const outlets = await ctx.db.query("outlets").collect();
      expect(outlets.every((o) => o.code.startsWith("SMP-"))).toBe(true);
      // Every sample row is listed in the one marker table.
      const tracked = await ctx.db
        .query("sampleDataRows")
        .withIndex("by_batch", (q) => q.eq("batch", SAMPLE_BATCH))
        .collect();
      const ids = new Set(tracked.map((row) => row.rowId));
      for (const outlet of outlets) expect(ids.has(outlet._id)).toBe(true);
      for (const list of lists) expect(ids.has(list._id)).toBe(true);
      // Index exercise for the additive tables.
      const list = lists[0]!;
      expect(
        await ctx.db
          .query("priceLists")
          .withIndex("by_organizationId_and_code", (q) =>
            q.eq("organizationId", "sunpride").eq("code", list.code),
          )
          .unique(),
      ).not.toBeNull();
      expect(
        (
          await ctx.db
            .query("priceListLines")
            .withIndex("by_priceListId_and_productId", (q) =>
              q.eq("priceListId", list._id),
            )
            .collect()
        ).length,
      ).toBeGreaterThanOrEqual(80);
      expect(
        await ctx.db
          .query("promotions")
          .withIndex("by_organizationId_and_code", (q) =>
            q.eq("organizationId", "sunpride").eq("code", "SMP-PROMO-MERIENDA"),
          )
          .unique(),
      ).not.toBeNull();
      expect(
        await ctx.db
          .query("sampleDataRows")
          .withIndex("by_batch_and_key", (q) =>
            q.eq("batch", SAMPLE_BATCH).eq("key", "pricelist:SAMPLE-RS"),
          )
          .unique(),
      ).not.toBeNull();
    });
  });

  it("writes effective-dated master data through the domain writers, as an audited system actor", async () => {
    const t = await fresh();
    await t.mutation(internal.beta.sample.seed, {});
    await t.run(async (ctx) => {
      const audits = await ctx.db.query("auditLogs").collect();
      const by = (action: string, subject = SAMPLE_ACTOR) =>
        audits.filter((row) => row.action === action && row.subject === subject)
          .length;
      expect(by("org.created")).toBe(4);
      expect(by("territory.created")).toBe(3);
      expect(by("route.created")).toBe(3);
      expect(by("outlet.created")).toBe(30);
      expect(by("outlet.customer_link_changed")).toBe(30);
      expect(by("outlet.pin_proposed")).toBe(30);
      expect(by("outlet.assignment_changed")).toBe(30);
      expect(by("inventory.uom_conversion.created")).toBeGreaterThanOrEqual(40);
      // The pin writer still demands an independent reviewer.
      expect(by("outlet.pin_verified", `${SAMPLE_ACTOR}:verifier`)).toBe(30);
      const pins = await ctx.db.query("outletPins").collect();
      expect(
        pins.every(
          (pin) =>
            pin.status === "verified" &&
            pin.proposedBy === SAMPLE_ACTOR &&
            pin.verifiedBy === `${SAMPLE_ACTOR}:verifier`,
        ),
      ).toBe(true);
      // Units, territories, routes and assignments are in force now, in a valid tree.
      const tree = await topology(ctx, Date.now());
      for (const code of ["SMP-VIS", "SMP-CEBU", "SMP-CEBU-N", "SMP-CEBU-S"])
        expect(tree.some((unit) => unit.code === code)).toBe(true);
      const root = tree.find((unit) => !unit.parentId)!;
      for (const row of [
        ...(await ctx.db.query("orgUnits").collect()),
        ...(await ctx.db.query("territories").collect()),
        ...(await ctx.db.query("routes").collect()),
        ...(await ctx.db.query("outletAssignments").collect()),
      ]) {
        expect(row.effectiveFrom).toBeGreaterThanOrEqual(root.effectiveFrom);
        expect(row.effectiveFrom).toBeLessThanOrEqual(Date.now());
      }
    });
    // The office writers themselves still accept only future-effective changes.
    await expect(
      t.mutation(api.territories.mutations.create, {
        code: "SMP-T-PAST",
        name: "Backdated",
        orgUnitId: (await byCode(t, "orgUnits", "SMP-CEBU"))._id,
        effectiveFrom: NOW - 1,
        reason: "should fail",
      }),
    ).rejects.toThrow(/future-effective/);
  });

  it("posts opening depot stock through postMovement and prices every product per channel", async () => {
    const t = await fresh();
    await t.mutation(internal.beta.sample.seed, {});
    await t.run(async (ctx) => {
      const movements = await ctx.db.query("inventoryMovements").collect();
      expect(movements).toHaveLength(1);
      expect(movements[0]!.movementType).toBe("opening_balance");
      const depot = (await ctx.db.query("inventoryLocations").collect()).find(
        (row) => row.code === "SMP-DEPOT-CEBU",
      )!;
      const balances = (
        await ctx.db.query("inventoryBalances").collect()
      ).filter((row) => row.locationId === depot._id);
      expect(balances).toHaveLength(40);
      const corned = (await ctx.db.query("products").collect()).find(
        (p) => p.code === "SMP-CB-150",
      )!;
      expect(
        balances.find((row) => row.productId === corned._id)?.availableBase,
      ).toBe(BigInt(48 * 40));
      expect(
        (await ctx.db.query("inventoryLedgerEntries").collect()).length,
      ).toBe(40);
    });
    // Each store's channel resolves exactly one SP-0088 list with every product priced.
    const outlets = await t.run((ctx) => ctx.db.query("outlets").collect());
    const corned = await byCode(t, "products", "SMP-CB-150");
    const resolved = await t.run(async (ctx) => {
      const cache = pricingCache();
      const out = [];
      for (const outlet of outlets) {
        const list = await priceListFor(ctx, outlet, null, NOW, cache);
        out.push({
          code: outlet.code,
          list: list?.code ?? null,
          sample: list?.source === "sample",
          corned: list
            ? Object.fromEntries(
                await productPrices(ctx, list._id, corned._id, NOW, cache),
              )
            : {},
        });
      }
      return out;
    });
    expect(resolved.every((row) => row.list !== null && row.sample)).toBe(true);
    expect([...new Set(resolved.map((row) => row.list))].sort()).toEqual([
      "SAMPLE-KA",
      "SAMPLE-PM",
      "SAMPLE-RS",
    ]);
    const market = resolved.find((row) => row.code === "SMP-O-0301")!;
    expect(market.list).toBe("SAMPLE-PM");
    const marketList = SAMPLE_PRICE_LISTS.find((l) => l.code === "SAMPLE-PM")!;
    expect(market.corned).toEqual({
      PC: samplePrice(productNamed("SMP-CB-150"), marketList, "PC"),
      CASE: samplePrice(productNamed("SMP-CB-150"), marketList, "CASE"),
    });
    expect(resolved.find((row) => row.code === "SMP-O-0001")!.list).toBe(
      "SAMPLE-KA",
    );
  });

  it("shares SP-0088's sample lists, so either seed order leaves one list per channel", async () => {
    for (const pricingFirst of [false, true]) {
      const t = await fresh();
      const runPricingSeed = async () => {
        let cursor: string | null = null;
        for (;;) {
          const page: { isDone: boolean; continueCursor: string } =
            await t.mutation(internal.pricing.sample.seed, { cursor });
          if (page.isDone) break;
          cursor = page.continueCursor;
        }
      };
      if (pricingFirst) await runPricingSeed();
      await t.mutation(internal.beta.sample.seed, {});
      if (!pricingFirst) await runPricingSeed();
      const lists = await t.run((ctx) => ctx.db.query("priceLists").collect());
      expect(lists.map((list) => list.code).sort()).toEqual([
        "SAMPLE-KA",
        "SAMPLE-PM",
        "SAMPLE-RS",
        "SAMPLE-STD",
      ]);
      const juice = await byCode(t, "products", "SMP-PJ-240");
      const outlet = await byCode(t, "outlets", "SMP-O-0101");
      const prices = await t.run(async (ctx) => {
        const list = await priceListFor(ctx, outlet, null, NOW);
        return list
          ? Object.fromEntries(
              await productPrices(ctx, list._id, juice._id, NOW),
            )
          : null;
      });
      // The beta seed's realistic prices win for its own products in either order.
      expect(prices?.PC).toBe(
        samplePrice(productNamed("SMP-PJ-240"), rs, "PC"),
      );
    }
  });

  it("never adds a competing sample list where an office list already prices the channel", async () => {
    const t = await fresh();
    await t.run((ctx) =>
      ctx.db.insert("priceLists", {
        organizationId: "sunpride",
        code: "OFFICE-RS",
        name: "Route Sales",
        channelKey: "route sales",
        currency: "PHP",
        status: "active",
        source: "office",
        effectiveFrom: 0,
        updatedAt: NOW,
      }),
    );
    const result = await t.mutation(internal.beta.sample.seed, {});
    expect(result.skipped).toEqual([
      "price list SAMPLE-RS: channel already priced",
    ]);
    const lists = await t.run((ctx) => ctx.db.query("priceLists").collect());
    expect(lists.map((list) => list.code).sort()).toEqual([
      "OFFICE-RS",
      "SAMPLE-KA",
      "SAMPLE-PM",
    ]);
    // The Route Sales bundle belongs to the skipped list and is not created.
    const promotions = await t.run((ctx) =>
      ctx.db.query("promotions").collect(),
    );
    expect(promotions.map((p) => p.code).sort()).toEqual([
      "SMP-PROMO-CB150-CASE5",
      "SMP-PROMO-PJ240-B10G1",
    ]);
  });

  it("reset removes exactly the sample rows, in bounded batches, and the seed can run again", async () => {
    const t = await fresh();
    const before = await counts(t);
    await t.mutation(internal.beta.sample.seed, {});
    // A non-sample row with a sample-looking table must survive.
    const keep = await t.run((ctx) =>
      ctx.db.insert("customers", {
        code: "REAL-001",
        name: "Real customer",
        channel: "Key Accounts",
        territory: "Cebu",
        creditLimit: 1,
        active: true,
        updatedAt: NOW,
      }),
    );
    let rounds = 0;
    for (;;) {
      const result = await t.mutation(internal.beta.sample.reset, {
        confirm: "remove-beta-sample",
        limit: 300,
      });
      rounds += 1;
      if (result.isDone) break;
      expect(rounds).toBeLessThan(20);
    }
    expect(rounds).toBeGreaterThan(1);
    const after = await counts(t);
    expect({
      ...after,
      customers: after.customers - 1,
      orgUnits: after.orgUnits,
    }).toEqual({
      ...before,
      // The national root comes from the organization foundation, not the sample.
      orgUnits: 1,
    });
    expect(await t.run((ctx) => ctx.db.get(keep))).not.toBeNull();
    expect(
      await t.run((ctx) => ctx.db.query("sampleDataRows").collect()),
    ).toHaveLength(0);
    const again = await t.mutation(internal.beta.sample.seed, {});
    expect(again.created.outlets).toBe(30);
  });

  it("every reset batch leaves no row pointing at a deleted row (default and small batches)", async () => {
    for (const limit of [undefined, 37]) {
      const t = await fresh();
      await t.mutation(internal.beta.sample.seed, {});
      expect(await danglingReferences(t)).toEqual([]);
      let rounds = 0;
      for (;;) {
        const result = await t.mutation(internal.beta.sample.reset, {
          confirm: "remove-beta-sample",
          ...(limit === undefined ? {} : { limit }),
        });
        rounds += 1;
        // Stopping here (an interrupted reset) must leave the data whole.
        expect(await danglingReferences(t)).toEqual([]);
        if (limit !== undefined)
          expect(result.deleted).toBeLessThanOrEqual(limit);
        if (result.isDone) break;
        expect(rounds).toBeLessThan(60);
      }
      expect(rounds).toBeGreaterThan(1);
      expect(
        await t.run((ctx) => ctx.db.query("sampleDataRows").collect()),
      ).toHaveLength(0);
      expect(await t.run((ctx) => ctx.db.query("products").collect())).toEqual(
        [],
      );
      vi.useRealTimers();
    }
  });

  it("reset refuses, removing nothing, once a tester has signed up or is assigned to a sample unit", async () => {
    const t = await fresh();
    await t.mutation(internal.beta.sample.seed, {});
    await tester(t, "sales").mutation(api.domains.profiles.ensure, {});
    await t.mutation(internal.beta.sample.seed, {});
    const before = await counts(t);
    await expect(
      t.mutation(internal.beta.sample.reset, { confirm: "remove-beta-sample" }),
    ).rejects.toThrow(/in use.*sales@sunpride\.test has signed up.*SMP-CEBU-N/);
    expect(await counts(t)).toEqual(before);
  });

  it("reset refuses, removing nothing, when stock moved at a sample location after the opening balance", async () => {
    const t = await fresh();
    await t.mutation(internal.beta.sample.seed, {});
    const juice = await byCode(t, "products", "SMP-PJ-240");
    await t.run(async (ctx) => {
      const depot = (await ctx.db.query("inventoryLocations").collect()).find(
        (row) => row.code === "SMP-DEPOT-CEBU",
      )!;
      await postMovement(ctx, {
        idempotencyKey: "beta-test-issue",
        payloadHash: "beta-test-issue",
        commandType: "test.issue",
        movementType: "inventory_issue",
        sourceType: "test",
        actorSubject: "inventory-admin",
        lines: [
          { productId: juice._id, fromLocationId: depot._id, quantityBase: 1n },
        ],
      });
    });
    const before = await counts(t);
    await expect(
      t.mutation(internal.beta.sample.reset, { confirm: "remove-beta-sample" }),
    ).rejects.toThrow(/stock has moved at SMP-DEPOT-CEBU/);
    expect(await counts(t)).toEqual(before);
  });

  it("reset refuses, removing nothing, when a sample product is stocked at a non-sample warehouse", async () => {
    const t = await fresh();
    await t.mutation(internal.beta.sample.seed, {});
    const juice = await byCode(t, "products", "SMP-PJ-240");
    await t.run(async (ctx) => {
      const root = (await ctx.db.query("orgUnits").collect()).find(
        (unit) => unit.code === "SUNPRIDE",
      )!;
      const warehouse = await ctx.db.insert("inventoryLocations", {
        organizationId: "sunpride",
        siteCode: "REAL-CEBU",
        code: "REAL-DEPOT",
        name: "Real depot",
        type: "warehouse",
        active: true,
        orgUnitId: root._id,
        allowsPicking: true,
        allowsReceiving: true,
        allowsSale: false,
        allowsProduction: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await postMovement(ctx, {
        idempotencyKey: "external-receipt",
        payloadHash: "external-receipt",
        commandType: "inventory.receipt",
        movementType: "goods_receipt",
        sourceType: "review",
        sourceDocumentId: "external-receipt",
        actorSubject: "reviewer",
        lines: [
          {
            productId: juice._id,
            toLocationId: warehouse,
            toStockStatus: "available",
            quantityBase: 5n,
          },
        ],
        emitIntegrationEvent: false,
      });
    });
    const blockers = await t.run((ctx) => resetBlockers(ctx));
    expect(blockers.join("; ")).toMatch(
      new RegExp(
        `inventoryBalances\\.productId uses sample products ${juice._id}`,
      ),
    );
    const before = await counts(t);
    await expect(
      t.mutation(internal.beta.sample.reset, {
        confirm: "remove-beta-sample",
        limit: 1_000,
      }),
    ).rejects.toThrow(/in use/);
    expect(await counts(t)).toEqual(before);
    expect(await t.run((ctx) => ctx.db.get(juice._id))).not.toBeNull();
  });

  it("the dependency check sees every ID-holding field, nested arrays included", () => {
    const references = schemaReferences();
    // Every ID field the sample tables can be reached through appears, indexed or scanned.
    const toProducts = references.filter((r) => r.target === "products");
    expect(toProducts.length).toBeGreaterThan(5);
    expect(
      toProducts.some(
        (r) =>
          r.table === "inventoryBalances" && r.path.join(".") === "productId",
      ),
    ).toBe(true);
    expect(
      valuesAt({ lines: [{ p: "a" }, { p: "b" }] }, ["lines", "[]", "p"]),
    ).toEqual(["a", "b"]);
  });

  it("attaches invited testers on a re-run: unit, position, supervisor, territory and route", async () => {
    const t = await fresh();
    await t.mutation(internal.beta.sample.seed, {});
    const salesId = await tester(t, "sales").mutation(
      api.domains.profiles.ensure,
      {},
    );
    const first = await t.mutation(internal.beta.sample.seed, {});
    expect(first.testersAttached).toEqual(["sales@sunpride.test"]);
    const managerId = await tester(t, "manager").mutation(
      api.domains.profiles.ensure,
      {},
    );
    const second = await t.mutation(internal.beta.sample.seed, {});
    // The manager gets their unit; the salesperson now also gets the supervisor link.
    expect(second.testersAttached.sort()).toEqual([
      "sales@sunpride.test",
      "supervisor@sunpride.test",
    ]);
    expect(
      (await t.mutation(internal.beta.sample.seed, {})).testersAttached,
    ).toEqual([]);
    const north = await byCode(t, "orgUnits", "SMP-CEBU-N");
    await t.run(async (ctx) => {
      const sales = (await ctx.db.get(salesId))!;
      const manager = (await ctx.db.get(managerId))!;
      expect(sales.orgUnitId).toBe(north._id);
      expect(sales.supervisorSubject).toBe(manager.authSubject);
      const position = (await ctx.db.get(sales.positionId!))!;
      expect(position.code).toBe("RS");
      const history = await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", salesId),
        )
        .collect();
      // provisioned (closed) -> unit -> supervisor: history, never overwritten.
      expect(history).toHaveLength(3);
      expect(
        history.filter((row) => row.effectiveTo === undefined),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("territorySalespeople")
          .withIndex("by_profileId_and_effectiveFrom", (q) =>
            q.eq("profileId", salesId),
          )
          .collect(),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("routeSalespeople")
          .withIndex("by_profileId_and_effectiveFrom", (q) =>
            q.eq("profileId", salesId),
          )
          .collect(),
      ).toHaveLength(1);
      // Both links went through the territory/route salesperson writers (audited).
      const audits = await ctx.db.query("auditLogs").collect();
      for (const action of [
        "territory.salesperson_assigned",
        "route.salesperson_assigned",
      ])
        expect(
          audits.filter(
            (row) => row.action === action && row.subject === SAMPLE_ACTOR,
          ),
        ).toHaveLength(1);
    });
  });

  it("end to end: a field order at a sample store is priced from its channel list at receipt", async () => {
    const t = await fresh();
    await t.mutation(internal.beta.sample.seed, {});
    const sales = tester(t, "sales");
    const profileId = await sales.mutation(api.domains.profiles.ensure, {});
    await t.mutation(internal.beta.sample.seed, {});
    // The new assignment starts just after the provisioning row.
    vi.setSystemTime(LATER);
    const outlet = await byCode(t, "outlets", "SMP-O-0101");
    const juice = await byCode(t, "products", "SMP-PJ-240");
    const beans = await byCode(t, "products", "SMP-PB-230");
    const profile = (await t.run((ctx) => ctx.db.get(profileId)))!;
    const deviceId = await t.run((ctx) =>
      ctx.db.insert("registeredDevices", {
        organizationId: "sunpride",
        orgUnitId: profile.orgUnitId!,
        inventoryTag: "BETA-1",
        profileId,
        boundSubject: profile.authSubject,
        allowedApp: "ANDROID",
        platform: "android",
        model: "test",
        osVersion: "1",
        appVersion: "1",
        publicKey: "key",
        credentialId: "BETA-1",
        registeredAt: NOW,
        status: "active",
      }),
    );
    const actor: AuthorizedDevice = {
      deviceId,
      profileId,
      orgUnitId: profile.orgUnitId!,
      role: "sales",
      subject: profile.authSubject,
      scopeFingerprint: "fixture",
    };
    const apply = (operation: Parameters<typeof sales.mutation>[1]) =>
      sales.mutation(internal.mobile.push.applyOne, {
        deviceId,
        actor,
        operation,
      } as never);
    const check = (await apply({
      kind: "visit.checkIn",
      clientRequestId: uuid(1),
      payload: {
        clientVisitId: uuid(101),
        plannedVisitId: null,
        outletId: outlet._id,
        serviceDate: manilaDate(LATER),
        deviceTime: LATER,
        location: null,
        intents: ["sell"],
        unplannedReason: "Beta test call",
      },
    })) as { status: string; ack: { entityId: string } };
    expect(check.status).toBe("accepted");
    const order = (await apply({
      kind: "visit.activity",
      clientRequestId: uuid(2),
      dependsOn: [uuid(1)],
      payload: {
        visitId: check.ack.entityId,
        activity: {
          kind: "order_intent",
          clientOrderId: uuid(90),
          lines: [
            { productId: juice._id, uom: "PC", quantity: 12 },
            { productId: beans._id, uom: "PC", quantity: 3 },
          ],
        },
        deviceTime: LATER,
      },
    })) as { status: string };
    expect(order.status).toBe("accepted");
    // SP-0088 prices the order on the server at capture time from the store's channel list.
    const priced = await t.run((ctx) =>
      ctx.db
        .query("fieldOrderPricings")
        .withIndex("by_visitId", (q) =>
          q.eq("visitId", check.ack.entityId as Id<"visitExecutions">),
        )
        .unique(),
    );
    const juicePrice = samplePrice(productNamed("SMP-PJ-240"), rs, "PC")!;
    const beansPrice = samplePrice(productNamed("SMP-PB-230"), rs, "PC")!;
    const list = await t.run((ctx) => ctx.db.get(priced!.priceListId!));
    expect(list?.code).toBe("SAMPLE-RS");
    expect(priced).toMatchObject({
      priceListSource: "sample",
      currency: "PHP",
      clientOrderId: uuid(90),
      unpricedLines: 0,
      totalMinor: juicePrice * 12 + beansPrice * 3,
    });
    expect(priced!.lines.map((line) => line.unitPriceMinor)).toEqual([
      juicePrice,
      beansPrice,
    ]);
    // The sample store carries a sample credit limit, so the order gets a real credit check.
    expect(priced!.credit.limitMinor).toBeGreaterThan(0);
    expect(priced!.credit.status).toBe("within");
  });

  it("end to end: the van bootstrap carries Route Sales prices and promotions for the loaded truck", async () => {
    const t = await fresh();
    await t.mutation(internal.beta.sample.seed, {});
    const van = tester(t, "van");
    const operations = tester(t, "operations");
    const sellerId = await van.mutation(api.domains.profiles.ensure, {});
    await operations.mutation(api.domains.profiles.ensure, {});
    await t.mutation(internal.beta.sample.seed, {});
    vi.setSystemTime(LATER);
    const vehicle = await byCode(t, "vehicles", "SMP-TRK-01");
    const route = await byCode(t, "routes", "SMP-R-CBS-1");
    const juice = await byCode(t, "products", "SMP-PJ-240");
    const corned = await byCode(t, "products", "SMP-CB-150");
    const { tripId } = await operations.mutation(api.van.trips.plan, {
      vehicleId: vehicle._id,
      salespersonProfileId: sellerId,
      serviceDate: manilaDate(NOW),
      routeId: route._id,
      driverName: "Nonoy Pepito",
    });
    await operations.mutation(api.van.loads.plan, {
      tripId,
      lines: [
        { productId: juice._id, expectedBase: 240n },
        { productId: corned._id, expectedBase: 96n },
      ],
    });
    const seller = (await t.run((ctx) => ctx.db.get(sellerId)))!;
    const deviceId = await t.run((ctx) =>
      ctx.db.insert("registeredDevices", {
        organizationId: "sunpride",
        orgUnitId: seller.orgUnitId!,
        inventoryTag: "H10P-1",
        profileId: sellerId,
        boundSubject: seller.authSubject,
        allowedApp: "VAN_ANDROID",
        platform: "Android",
        model: "H10P",
        osVersion: "14",
        appVersion: "1",
        publicKey: "fixture-key",
        credentialId: "H10P-1",
        registeredAt: NOW,
        status: "active",
      }),
    );
    const boot = (await t.query(internal.van.device.bootstrap, {
      actor: {
        deviceId,
        profileId: sellerId,
        subject: seller.authSubject,
        orgUnitId: seller.orgUnitId!,
        role: "sales",
        scopeFingerprint: "fixture",
      },
      now: LATER,
    })) as unknown as {
      trip: { tripId: string } | null;
      customers: { code: string }[];
      priceLines: {
        productId: string;
        unitPriceMinor: string;
        uomCode: string;
        priceListCode: string;
        currency: string;
      }[];
      promotions: {
        code: string;
        rule: { kind: string; bundlePriceMinor?: string };
      }[];
    };
    expect(boot.trip?.tripId).toBe(tripId);
    expect(boot.customers.length).toBeGreaterThan(0);
    expect(
      boot.priceLines
        .map((line) => [line.productId, line.uomCode, line.unitPriceMinor])
        .sort(),
    ).toEqual(
      [
        [
          juice._id,
          "PC",
          String(samplePrice(productNamed("SMP-PJ-240"), rs, "PC")),
        ],
        [
          corned._id,
          "PC",
          String(samplePrice(productNamed("SMP-CB-150"), rs, "PC")),
        ],
      ].sort(),
    );
    expect(boot.priceLines.every((l) => l.priceListCode === "SAMPLE-RS")).toBe(
      true,
    );
    expect(boot.priceLines.every((l) => l.currency === "PHP")).toBe(true);
    // The Merienda bundle needs Pancake Mix and 1L juice, which this truck does not carry.
    expect(boot.promotions.map((p) => p.code).sort()).toEqual([
      "SMP-PROMO-CB150-CASE5",
      "SMP-PROMO-PJ240-B10G1",
    ]);
  });

  it("plans the van tester's sample day (trip + load sheet) idempotently, priced on the handheld", async () => {
    const t = await fresh();
    await t.mutation(internal.beta.sample.seed, {});
    expect(await t.mutation(internal.beta.sample.planVanDay, {})).toBeNull();
    const sellerId = await tester(t, "van").mutation(
      api.domains.profiles.ensure,
      {},
    );
    await t.mutation(internal.beta.sample.seed, {});
    vi.setSystemTime(LATER);
    const planned = await t.mutation(internal.beta.sample.planVanDay, {});
    expect(planned?.tripNumber).toMatch(/^TRIP-20261007-SMP-TRK-01-1$/);
    expect(await t.mutation(internal.beta.sample.planVanDay, {})).toEqual(
      planned,
    );
    await expect(
      t.mutation(internal.beta.sample.planVanDay, {
        serviceDate: "2026-10-01",
      }),
    ).rejects.toThrow(/past day/);
    const seller = (await t.run((ctx) => ctx.db.get(sellerId)))!;
    const deviceId = await t.run((ctx) =>
      ctx.db.insert("registeredDevices", {
        organizationId: "sunpride",
        orgUnitId: seller.orgUnitId!,
        inventoryTag: "H10P-2",
        profileId: sellerId,
        boundSubject: seller.authSubject,
        allowedApp: "VAN_ANDROID",
        platform: "Android",
        model: "H10P",
        osVersion: "14",
        appVersion: "1",
        publicKey: "fixture-key",
        credentialId: "H10P-2",
        registeredAt: NOW,
        status: "active",
      }),
    );
    const boot = (await t.query(internal.van.device.bootstrap, {
      actor: {
        deviceId,
        profileId: sellerId,
        subject: seller.authSubject,
        orgUnitId: seller.orgUnitId!,
        role: "sales",
        scopeFingerprint: "fixture",
      },
      now: LATER,
    })) as unknown as {
      trip: { tripId: string; status: string } | null;
      load: { lines: { productCode: string; expectedBase: string }[] } | null;
      priceLines: unknown[];
      promotions: {
        code: string;
        rule: { kind: string; bundlePriceMinor?: string };
      }[];
    };
    expect(boot.trip).toMatchObject({
      tripId: planned!.tripId,
      status: "loading",
    });
    expect(boot.load?.lines).toHaveLength(10);
    expect(
      boot.load?.lines.find((line) => line.productCode === "SMP-PJ-240")
        ?.expectedBase,
    ).toBe(String(24 * 5));
    expect(boot.priceLines).toHaveLength(10);
    // The sample day's load carries every product of all three promotions.
    expect(boot.promotions.map((p) => p.code).sort()).toEqual([
      "SMP-PROMO-CB150-CASE5",
      "SMP-PROMO-MERIENDA",
      "SMP-PROMO-PJ240-B10G1",
    ]);
    expect(
      boot.promotions.find((p) => p.rule.kind === "bundle")?.rule
        .bundlePriceMinor,
    ).toBe("15900");
  });
});
