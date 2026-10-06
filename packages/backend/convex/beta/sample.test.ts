import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { manilaDate } from "../coverage/validation";
import type { AuthorizedDevice } from "../mobile/types";
import { mobilePricing } from "../pricing/wire";
import {
  SAMPLE_BATCH,
  SAMPLE_PEOPLE,
  SAMPLE_PRICE_LISTS,
  SAMPLE_PRODUCTS,
  SAMPLE_STORES,
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
    const out: Record<string, number> = {};
    for (const table of SAMPLE_TABLES)
      out[table] = (await ctx.db.query(table).collect()).length;
    return out;
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

describe("beta sample seed (SP-0129)", () => {
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
      expect(lists.every((list) => list.source === "beta_sample")).toBe(true);
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
            .withIndex("by_priceListId_and_effectiveFrom", (q) =>
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
            q.eq("batch", SAMPLE_BATCH).eq("key", "pricelist:SMP-PL-RS"),
          )
          .unique(),
      ).not.toBeNull();
    });
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
    // Each store's channel resolves exactly one list with every product priced per piece.
    const outlets = await t.run((ctx) => ctx.db.query("outlets").collect());
    const pricing = await t.run((ctx) => mobilePricing(ctx, outlets, NOW));
    expect(pricing.outletPriceLists).toHaveLength(30);
    expect(pricing.priceLists.map((list) => list.code).sort()).toEqual([
      "SMP-PL-KA",
      "SMP-PL-PM",
      "SMP-PL-RS",
    ]);
    const store = SAMPLE_STORES.find((row) => row.code === "SMP-O-0301")!;
    const outlet = outlets.find((row) => row.code === store.code)!;
    const listId = pricing.outletPriceLists.find(
      (row) => row.outletId === outlet._id,
    )!.priceListId;
    const market = pricing.priceLists.find((l) => l.priceListId === listId)!;
    expect(market.code).toBe("SMP-PL-PM");
    expect(market.currency).toBe("PHP");
    const pieceLines = market.lines.filter((line) => line.uomCode === "PC");
    expect(pieceLines).toHaveLength(40);
    const caseLines = market.lines.filter((line) => line.uomCode === "CASE");
    expect(caseLines).toHaveLength(40);
    const marketList = SAMPLE_PRICE_LISTS.find((l) => l.code === "SMP-PL-PM")!;
    const corned = await byCode(t, "products", "SMP-CB-150");
    expect(
      market.lines.find(
        (l) => l.productId === corned._id && l.uomCode === "CASE",
      )?.unitPriceMinor,
    ).toBe(samplePrice(productNamed("SMP-CB-150"), marketList, "CASE"));
    // Every-list promotions plus the Route Sales bundle (Route Sales stores are on the page).
    expect(pricing.promotions.map((p) => p.code).sort()).toEqual([
      "SMP-PROMO-CB150-CASE5",
      "SMP-PROMO-MERIENDA",
      "SMP-PROMO-PJ240-B10G1",
    ]);
    const kaOnly = await t.run((ctx) =>
      mobilePricing(
        ctx,
        outlets.filter((row) => row.code === "SMP-O-0001"),
        NOW,
      ),
    );
    expect(kaOnly.priceLists.map((list) => list.code)).toEqual(["SMP-PL-KA"]);
    expect(kaOnly.promotions.map((p) => p.code).sort()).toEqual([
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
    const priced = await t.run((ctx) =>
      ctx.db
        .query("fieldOrderPrices")
        .withIndex("by_visitId", (q) =>
          q.eq("visitId", check.ack.entityId as Id<"visitExecutions">),
        )
        .unique(),
    );
    const juicePrice = BigInt(
      samplePrice(productNamed("SMP-PJ-240"), rs, "PC")!,
    );
    const beansPrice = BigInt(
      samplePrice(productNamed("SMP-PB-230"), rs, "PC")!,
    );
    expect(priced).toMatchObject({
      status: "priced",
      currency: "PHP",
      clientOrderId: uuid(90),
      promotionCodes: ["SMP-PROMO-PJ240-B10G1"],
      grossMinor: juicePrice * 12n + beansPrice * 3n,
      discountMinor: 0n,
      totalMinor: juicePrice * 12n + beansPrice * 3n,
    });
    expect(priced!.lines[0]).toMatchObject({
      unitPriceMinor: juicePrice,
      freeQuantity: 1,
    });
    const byActivity = await t.run((ctx) =>
      ctx.db
        .query("fieldOrderPrices")
        .withIndex("by_activityId", (q) =>
          q.eq("activityId", priced!.activityId),
        )
        .unique(),
    );
    expect(byActivity?._id).toBe(priced!._id);
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
    expect(boot.priceLines.every((l) => l.priceListCode === "SMP-PL-RS")).toBe(
      true,
    );
    expect(boot.priceLines.every((l) => l.currency === "PHP")).toBe(true);
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
  });
});
