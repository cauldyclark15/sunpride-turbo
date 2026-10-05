import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  daysToNextVisit,
  DEFAULT_CYCLE_DAYS,
  historyDays,
  historyFrom,
  leadTimeError,
  MIN_HISTORY_DAYS,
  overlaps,
  sortLines,
  storeStock,
  suggestLine,
  upliftError,
  type SkuFacts,
} from "./suggested_order_model";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
const AS_OF = "2026-09-29";
// 11:00 Manila on AS_OF.
const now = Date.parse("2026-09-29T03:00:00Z");
const at = (date: string, hhmm = "10:00") =>
  Date.parse(`${date}T${hhmm}:00+08:00`);
const ISSUER = "https://auth.test";
const subject = (name: string) => `${ISSUER}|${name}`;

afterEach(() => {
  vi.useRealTimers();
});

const settings = {
  asOfDate: AS_OF,
  historyDays: 84,
  nextVisitDays: 7,
  leadTimeDays: 1,
  coverDays: 8,
};
const facts = (over: Partial<SkuFacts> = {}): SkuFacts => ({
  code: "P1",
  unit: "CS",
  historyQuantity: 84,
  lastPurchaseDate: "2026-09-22",
  lastPurchaseQuantity: 4,
  observation: null,
  promotion: null,
  available: null,
  ...over,
});

describe("suggested order rules", () => {
  it("divides velocity by the customer's history, at least four weeks", () => {
    expect(historyFrom(AS_OF)).toBe("2026-07-08");
    expect(historyDays(null, AS_OF)).toBe(84);
    expect(historyDays("2026-07-08", AS_OF)).toBe(84);
    expect(historyDays("2026-08-31", AS_OF)).toBe(30);
    expect(historyDays("2026-09-25", AS_OF)).toBe(MIN_HISTORY_DAYS);
  });

  it("takes the next planned stop, else the cycle, else the default", () => {
    expect(
      daysToNextVisit({
        asOfDate: AS_OF,
        nextStopDate: "2026-10-03",
        cycleDays: 7,
      }),
    ).toEqual({ days: 4, source: "planned_stop", date: "2026-10-03" });
    expect(
      daysToNextVisit({ asOfDate: AS_OF, nextStopDate: null, cycleDays: 14 }),
    ).toEqual({ days: 14, source: "cycle", date: null });
    expect(
      daysToNextVisit({ asOfDate: AS_OF, nextStopDate: null, cycleDays: null }),
    ).toEqual({ days: DEFAULT_CYCLE_DAYS, source: "default", date: null });
  });

  it("validates lead time and uplift", () => {
    expect(leadTimeError(0)).toBeNull();
    expect(leadTimeError(1.5)).not.toBeNull();
    expect(leadTimeError(31)).not.toBeNull();
    expect(upliftError(50)).toBeNull();
    expect(upliftError(0)).not.toBeNull();
    expect(upliftError(301)).not.toBeNull();
  });

  it("applies the ICO formula: demand × cover − store stock", () => {
    const line = suggestLine(facts(), settings);
    expect(line).toMatchObject({
      status: "suggest",
      dailyDemand: 1,
      storeStock: 0,
      stockSource: "estimated",
      icoQuantity: 8,
      suggestedQuantity: 8,
      daysSinceLastPurchase: 7,
      cappedByAvailability: false,
    });
    expect(line.reasons.join(" | ")).toMatch(
      /Bought 84 CS in 84 days: 1 a day.*Last bought 4 on 2026-09-22, 7 day\(s\) ago.*Cover 8 day\(s\) \(7 to next visit \+ 1 lead time\): 8 needed.*Suggest 8 CS/,
    );
    // Same facts, same answer.
    expect(suggestLine(facts(), settings)).toEqual(line);
  });

  it("uses a store count taken since the last purchase, run down by demand", () => {
    const counted = facts({
      historyQuantity: 42,
      observation: { date: "2026-09-27", quantity: 3, source: "counted" },
    });
    // 0.5/day; 3 − 2 × 0.5 = 2 left; 0.5 × 8 = 4 needed → 2.
    expect(suggestLine(counted, settings)).toMatchObject({
      storeStock: 2,
      stockSource: "counted",
      suggestedQuantity: 2,
    });
    // A count older than the last purchase is ignored for the purchase estimate.
    expect(
      storeStock(
        {
          lastPurchaseDate: "2026-09-22",
          lastPurchaseQuantity: 10,
          observation: { date: "2026-09-20", quantity: 99, source: "counted" },
        },
        1,
        AS_OF,
      ),
    ).toMatchObject({ quantity: 3, source: "estimated" });
    expect(
      storeStock(
        {
          lastPurchaseDate: "2026-09-22",
          lastPurchaseQuantity: 10,
          observation: {
            date: "2026-09-28",
            quantity: 0,
            source: "reported_out",
          },
        },
        1,
        AS_OF,
      ),
    ).toMatchObject({ quantity: 0, source: "reported_out" });
  });

  it("raises demand during a promotion but not the stock run-down", () => {
    const line = suggestLine(
      facts({ promotion: { programRef: "PROMO-1", upliftPct: 50 } }),
      settings,
    );
    expect(line.dailyDemand).toBe(1.5);
    expect(line.suggestedQuantity).toBe(12);
    expect(line.reasons.join(" ")).toMatch(/Promotion PROMO-1 adds 50%/);
  });

  it("caps by availability and reports enough stock / no history", () => {
    expect(suggestLine(facts({ available: 3.9 }), settings)).toMatchObject({
      status: "suggest",
      icoQuantity: 8,
      suggestedQuantity: 3,
      cappedByAvailability: true,
    });
    expect(suggestLine(facts({ available: 0 }), settings)).toMatchObject({
      status: "unavailable",
      suggestedQuantity: 0,
      cappedByAvailability: true,
    });
    expect(
      suggestLine(
        facts({ lastPurchaseDate: AS_OF, lastPurchaseQuantity: 50 }),
        settings,
      ),
    ).toMatchObject({ status: "enough_stock", suggestedQuantity: 0 });
    expect(
      suggestLine(
        facts({
          historyQuantity: 0,
          lastPurchaseDate: null,
          lastPurchaseQuantity: null,
        }),
        settings,
      ),
    ).toMatchObject({ status: "no_history", suggestedQuantity: 0 });
  });

  it("sorts suggestions first and detects overlapping promotions", () => {
    expect(
      sortLines([
        { status: "no_history" as const, code: "A" },
        { status: "enough_stock" as const, code: "B" },
        { status: "suggest" as const, code: "Z" },
        { status: "suggest" as const, code: "C" },
      ]).map((row) => row.code),
    ).toEqual(["C", "Z", "B", "A"]);
    expect(
      overlaps({ effectiveFrom: 0, effectiveTo: 10 }, { effectiveFrom: 10 }),
    ).toBe(false);
    expect(overlaps({ effectiveFrom: 0 }, { effectiveFrom: 100 })).toBe(true);
  });
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const t: T = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const since = now - 200 * 24 * HOUR;
    const unit = (code: string, parentId?: Id<"orgUnits">) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: parentId ? "REGION" : "NATIONAL",
        ...(parentId ? { parentId } : {}),
        status: "active",
        effectiveFrom: since,
        createdAt: since,
        updatedAt: since,
      });
    const root = await unit("SUNPRIDE");
    const regionA = await unit("A", root);
    const regionB = await unit("B", root);
    const person = async (
      name: string,
      role: "sales" | "manager" | "viewer" | "admin",
      orgUnitId: Id<"orgUnits">,
    ) => {
      const id = await ctx.db.insert("profiles", {
        authSubject: subject(name),
        name,
        email: `${name}@test.local`,
        role,
        status: "active",
        orgUnitId,
        updatedAt: since,
      });
      await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId,
        role,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      return id;
    };
    await person("admin", "admin", root);
    await person("managerA", "manager", regionA);
    await person("managerB", "manager", regionB);
    await person("viewerA", "viewer", regionA);
    const ana = await person("Ana", "sales", regionA);
    await person("Ben", "sales", regionA);
    await person("Cara", "sales", regionB);

    const territory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "T-A",
      name: "Territory A",
      status: "active",
      effectiveFrom: since,
      createdAt: since,
      updatedAt: since,
      createdBy: "fixture",
    });
    await ctx.db.insert("territoryOwnerships", {
      territoryId: territory,
      orgUnitId: regionA,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    await ctx.db.insert("territorySalespeople", {
      territoryId: territory,
      profileId: ana,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    const customer = await ctx.db.insert("customers", {
      code: "C1",
      name: "Customer C1",
      channel: "GT",
      territory: "T-A",
      creditLimit: 0,
      active: true,
      updatedAt: since,
    });
    const outlet = await ctx.db.insert("outlets", {
      organizationId: "sunpride",
      code: "O1",
      name: "Store O1",
      status: "active",
      custodianOrgUnitId: regionA,
      createdAt: since,
      updatedAt: since,
      createdBy: "fixture",
    });
    await ctx.db.insert("outletAssignments", {
      outletId: outlet,
      territoryId: territory,
      sequence: 1,
      cycleDays: 7,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    await ctx.db.insert("outletCustomerLinks", {
      outletId: outlet,
      customerId: customer,
      source: "fixture",
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });

    const product = (code: string) =>
      ctx.db.insert("products", {
        code,
        name: `Product ${code}`,
        category: "Canned",
        uom: "CS",
        unitPrice: 100,
        active: true,
        updatedAt: since,
      });
    const p = {
      P1: await product("P1"),
      P2: await product("P2"),
      P3: await product("P3"),
      P4: await product("P4"),
      P5: await product("P5"),
    };
    let r = 0;
    const order = async (
      date: string,
      lines: [string, number][],
      fields: { status?: "submitted" | "draft"; total?: number } = {},
    ) => {
      const id = await ctx.db.insert("orders", {
        organizationId: "sunpride",
        clientRequestId: `req-${++r}`,
        orderNumber: `SO-${r}`,
        customerCode: "C1",
        salespersonSubject: subject("Ana"),
        status: fields.status ?? "submitted",
        subtotal: fields.total ?? 1000,
        total: fields.total ?? 1000,
        createdAt: at(date),
        updatedAt: at(date),
      });
      for (const [code, quantity] of lines)
        await ctx.db.insert("orderLines", {
          orderId: id,
          productCode: code,
          description: code,
          quantity,
          unitPrice: 100,
          lineTotal: quantity * 100,
        });
    };
    // Outside the window: never counted.
    await order("2026-06-01", [["P1", 500]]);
    // Window starts 8 Jul (84 days).
    await order("2026-07-08", [
      ["P1", 80],
      ["P2", 10],
      ["P4", 84],
      ["P5", 8],
    ]);
    await order("2026-09-22", [["P1", 4]]);
    await order("2026-09-25", [["P2", 32]]);
    await order("2026-09-28", [["P5", 20]]);
    // Draft and return orders never count.
    await order("2026-09-26", [["P1", 1000]], { status: "draft" });
    await order("2026-09-27", [["P1", -5]], { total: -500 });

    await ctx.db.insert("outletAssortments", {
      organizationId: "sunpride",
      outletId: outlet,
      productIds: [p.P1, p.P3],
      effectiveFrom: since,
      sourceRef: "fixture",
      actorSubject: subject("admin"),
      createdAt: since,
    });

    // 28 Sep visit: P2 counted at 1 case; audit finds P4 out of stock.
    const visit = await ctx.db.insert("visitExecutions", {
      organizationId: "sunpride",
      clientVisitId: "visit-1",
      assigneeProfileId: ana,
      outletId: outlet,
      orgUnitId: regionA,
      serviceDate: "2026-09-28",
      source: "unplanned",
      intents: ["sell"],
      state: "checked-out",
      productivity: "pending",
      createdAt: at("2026-09-28", "09:00"),
      lastServerTime: at("2026-09-28", "09:20"),
    });
    await ctx.db.insert("visitActivities", {
      organizationId: "sunpride",
      orgUnitId: regionA,
      visitId: visit,
      assigneeProfileId: ana,
      outletId: outlet,
      activity: {
        kind: "inventory_check",
        productId: p.P2,
        observedQuantity: 1,
        icoFinding: "present",
      },
      evidenceIds: [],
      deviceTime: at("2026-09-28", "09:05"),
      serverTime: at("2026-09-28", "09:05"),
    });
    const audit = await ctx.db.insert("merchandisingAudits", {
      organizationId: "sunpride",
      orgUnitId: regionA,
      visitId: visit,
      outletId: outlet,
      assigneeProfileId: ana,
      serviceDate: "2026-09-28",
      clientAuditId: "audit-1",
      payloadHash: "hash",
      auditVersion: "v1",
      requiredCount: 0,
      requiredAvailableCount: 0,
      requiredOutOfStockCount: 0,
      missingRequiredProductIds: [],
      evidenceIds: [],
      actorSubject: subject("Ana"),
      source: "mobile",
      deviceTime: at("2026-09-28", "09:10"),
      serverTime: at("2026-09-28", "09:10"),
    });
    await ctx.db.insert("merchandisingAvailability", {
      organizationId: "sunpride",
      orgUnitId: regionA,
      auditId: audit,
      outletId: outlet,
      productId: p.P4,
      serviceDate: "2026-09-28",
      required: false,
      status: "out_of_stock",
      evidenceIds: [],
    });

    const location = (code: string, orgUnitId: Id<"orgUnits">) =>
      ctx.db.insert("inventoryLocations", {
        organizationId: "sunpride",
        orgUnitId,
        siteCode: code,
        code,
        name: `Depot ${code}`,
        type: "warehouse",
        active: true,
        allowsPicking: true,
        allowsReceiving: true,
        allowsSale: true,
        allowsProduction: false,
        createdAt: since,
        updatedAt: since,
      });
    const depotA = await location("DEPOT-A", regionA);
    const depotB = await location("DEPOT-B", regionB);
    for (const [code, available] of [
      ["P1", 100],
      ["P4", 2],
    ] as const)
      await ctx.db.insert("inventoryBalances", {
        organizationId: "sunpride",
        productCode: code,
        productId: p[code],
        locationId: depotA,
        warehouseCode: "DEPOT-A",
        onHand: available,
        reserved: 0,
        available,
        asOf: since,
      });
    return { outlet, customer, regionB, p, depotA, depotB };
  });
  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });
  return { t, ids, as };
}

describe("suggested order for a store", () => {
  it("suggests quantities from velocity, last purchase, store counts and cycle", async () => {
    const { ids, as } = await fixture();
    const result = await as("Ana").query(
      api.analytics.suggested_orders.forOutlet,
      { outletId: ids.outlet, asOfDate: AS_OF },
    );
    expect(result).toMatchObject({
      customer: { code: "C1" },
      historyStatus: "complete",
      historyFrom: "2026-07-08",
      historyDays: 84,
      nextVisit: { days: 7, source: "cycle", date: null },
      leadTimeDays: 1,
      leadTimeProvisional: true,
      coverDays: 8,
      location: null,
      truncated: false,
    });
    const byCode = Object.fromEntries(
      result.lines.map((row) => [row.code, row]),
    );
    expect(result.lines.map((row) => row.code)).toEqual([
      "P1",
      "P2",
      "P4",
      "P5",
      "P3",
    ]);
    // P1: 84 in 84 days (draft, return and June orders excluded) → 1/day; 4 bought
    // 7 days ago are gone; 8 days of cover → 8.
    expect(byCode.P1).toMatchObject({
      status: "suggest",
      required: true,
      historyQuantity: 84,
      dailyDemand: 1,
      lastPurchaseDate: "2026-09-22",
      daysSinceLastPurchase: 7,
      storeStock: 0,
      stockSource: "estimated",
      suggestedQuantity: 8,
      available: null,
    });
    // P2: 42 → 0.5/day; counted 1 yesterday → 0.5 left; 4 needed → 3.5 → 4.
    expect(byCode.P2).toMatchObject({
      stockSource: "counted",
      storeStock: 0.5,
      suggestedQuantity: 4,
    });
    // P4: audit found none yesterday → full cover.
    expect(byCode.P4).toMatchObject({
      stockSource: "reported_out",
      suggestedQuantity: 8,
    });
    // P5: 20 bought yesterday cover the period.
    expect(byCode.P5).toMatchObject({
      status: "enough_stock",
      suggestedQuantity: 0,
    });
    // P3: required but never bought.
    expect(byCode.P3).toMatchObject({
      status: "no_history",
      required: true,
      suggestedQuantity: 0,
    });
    expect(result.totals).toEqual({
      skus: 5,
      suggestedSkus: 3,
      suggestedQuantity: 20,
      cappedSkus: 0,
    });
  });

  it("caps by the selling location's availability and honours lead time", async () => {
    const { ids, as } = await fixture();
    const result = await as("managerA").query(
      api.analytics.suggested_orders.forOutlet,
      {
        outletId: ids.outlet,
        asOfDate: AS_OF,
        locationId: ids.depotA,
        leadTimeDays: 3,
      },
    );
    expect(result.coverDays).toBe(10);
    expect(result.leadTimeProvisional).toBe(false);
    expect(result.location?.code).toBe("DEPOT-A");
    const byCode = Object.fromEntries(
      result.lines.map((row) => [row.code, row]),
    );
    expect(byCode.P1).toMatchObject({ suggestedQuantity: 10, available: 100 });
    expect(byCode.P4).toMatchObject({
      icoQuantity: 10,
      suggestedQuantity: 2,
      cappedByAvailability: true,
    });
    expect(byCode.P2).toMatchObject({
      status: "unavailable",
      suggestedQuantity: 0,
      available: 0,
    });
    await expect(
      as("managerA").query(api.analytics.suggested_orders.forOutlet, {
        outletId: ids.outlet,
        asOfDate: AS_OF,
        locationId: ids.depotB,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
  });

  it("refuses callers outside the store's scope or assignment", async () => {
    const { ids, as } = await fixture();
    const args = { outletId: ids.outlet, asOfDate: AS_OF };
    const q = api.analytics.suggested_orders.forOutlet;
    await expect(as("managerB").query(q, args)).rejects.toThrow(
      /outside your organizational scope/,
    );
    await expect(as("Ben").query(q, args)).rejects.toThrow(
      /outside salesperson assignment/,
    );
    // A read-only viewer in the store's region may read it.
    expect((await as("viewerA").query(q, args)).totals.skus).toBe(5);
    await expect(
      as("Ana").query(q, { ...args, asOfDate: "2026-09-30" }),
    ).rejects.toThrow(/future/);
    await expect(
      as("Ana").query(q, { ...args, leadTimeDays: -1 }),
    ).rejects.toThrow(/Lead time/);
  });

  it("applies a scheduled promotion uplift while it runs", async () => {
    const { t, ids, as } = await fixture();
    const schedule = api.analytics.suggested_orders.schedulePromotion;
    const base = {
      productId: ids.p.P1,
      programRef: "SEPT-BUNDLE",
      upliftPct: 50,
      effectiveFrom: now + 60_000,
      effectiveTo: now + 10 * 24 * HOUR,
      sourceRef: "Trade memo 2026-09",
    };
    await expect(as("managerA").mutation(schedule, base)).rejects.toThrow(
      /Insufficient permission/,
    );
    await expect(
      as("admin").mutation(schedule, { ...base, effectiveFrom: now - 1 }),
    ).rejects.toThrow(/future-effective/);
    await expect(
      as("admin").mutation(schedule, { ...base, upliftPct: 0 }),
    ).rejects.toThrow(/uplift/);
    const id = await as("admin").mutation(schedule, base);
    await expect(
      as("admin").mutation(schedule, {
        ...base,
        effectiveFrom: now + 5 * 24 * HOUR,
        effectiveTo: undefined,
      }),
    ).rejects.toThrow(/already has a promotion/);

    vi.setSystemTime(now + 2 * HOUR);
    const result = await as("Ana").query(
      api.analytics.suggested_orders.forOutlet,
      { outletId: ids.outlet, asOfDate: AS_OF },
    );
    const p1 = result.lines.find((row) => row.code === "P1")!;
    expect(p1).toMatchObject({
      promotion: { programRef: "SEPT-BUNDLE", upliftPct: 50 },
      dailyDemand: 1.5,
      suggestedQuantity: 12,
    });

    await as("admin").mutation(api.analytics.suggested_orders.endPromotion, {
      promotionId: id,
      effectiveTo: now + 3 * HOUR,
    });
    expect(
      await as("managerA").query(api.analytics.suggested_orders.promotions, {
        productId: ids.p.P1,
      }),
    ).toEqual([
      expect.objectContaining({
        programRef: "SEPT-BUNDLE",
        effectiveTo: now + 3 * HOUR,
      }),
    ]);
    vi.setSystemTime(now + 4 * HOUR);
    const after = await as("Ana").query(
      api.analytics.suggested_orders.forOutlet,
      { outletId: ids.outlet, asOfDate: AS_OF },
    );
    expect(after.lines.find((row) => row.code === "P1")?.promotion).toBeNull();
    const stored = await t.run((ctx) => ctx.db.get(id));
    expect(stored?.actorSubject).toBe(subject("admin"));
  });

  it("uses only orders in the caller's scope, never another region's", async () => {
    const { t, ids, as } = await fixture();
    await t.run(async (ctx) => {
      const product = (code: string) =>
        ctx.db.insert("products", {
          code,
          name: `Product ${code}`,
          category: "Canned",
          uom: "CS",
          unitPrice: 100,
          active: true,
          updatedAt: now,
        });
      await product("P8");
      await product("P9");
      const order = async (
        ref: string,
        author: string,
        code: string,
        sourceLocationId?: Id<"inventoryLocations">,
      ) => {
        const id = await ctx.db.insert("orders", {
          organizationId: "sunpride",
          clientRequestId: ref,
          orderNumber: ref,
          customerCode: "C1",
          salespersonSubject: subject(author),
          status: "submitted",
          subtotal: 1000,
          total: 1000,
          ...(sourceLocationId ? { sourceLocationId } : {}),
          createdAt: at("2026-09-20"),
          updatedAt: at("2026-09-20"),
        });
        await ctx.db.insert("orderLines", {
          orderId: id,
          productCode: code,
          description: code,
          quantity: 40,
          unitPrice: 100,
          lineTotal: 4000,
        });
      };
      // A Region B seller's order on the same account, and a Region A order sold
      // from a Region B depot: neither belongs to a Region A reader.
      await order("B-1", "Cara", "P9");
      await order("A-B", "Ana", "P8", ids.depotB);
    });
    const q = api.analytics.suggested_orders.forOutlet;
    const args = { outletId: ids.outlet, asOfDate: AS_OF };
    for (const name of ["managerA", "viewerA", "Ana"]) {
      const result = await as(name).query(q, args);
      expect(result.historyStatus).toBe("partial_scope");
      const codes = result.lines.map((row) => row.code);
      expect(codes).not.toContain("P8");
      expect(codes).not.toContain("P9");
      // In-scope figures are unchanged by the foreign orders.
      expect(result.lines.find((row) => row.code === "P1")).toMatchObject({
        historyQuantity: 84,
        suggestedQuantity: 8,
      });
    }
    // The national administrator sees both.
    const national = await as("admin").query(q, args);
    expect(national.historyStatus).toBe("complete");
    expect(national.lines.map((row) => row.code)).toEqual(
      expect.arrayContaining(["P8", "P9"]),
    );
  });

  it("withholds history when the account is shared with another store", async () => {
    const { t, ids, as } = await fixture();
    await t.run(async (ctx) => {
      const other = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: "O2",
        name: "Store O2",
        status: "active",
        custodianOrgUnitId: ids.regionB,
        createdAt: now - 1000,
        updatedAt: now - 1000,
        createdBy: "fixture",
      });
      await ctx.db.insert("outletCustomerLinks", {
        outletId: other,
        customerId: ids.customer,
        source: "fixture",
        effectiveFrom: now - 1000,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: now - 1000,
      });
    });
    const result = await as("managerA").query(
      api.analytics.suggested_orders.forOutlet,
      { outletId: ids.outlet, asOfDate: AS_OF, locationId: ids.depotA },
    );
    expect(result.historyStatus).toBe("shared_account");
    // Only the required assortment remains, with no invented velocity or stock.
    expect(result.lines.map((row) => row.code)).toEqual(["P1", "P3"]);
    for (const row of result.lines) {
      expect(row).toMatchObject({
        status: "no_history",
        historyQuantity: 0,
        lastPurchaseDate: null,
        storeStock: 0,
        stockSource: "none",
        suggestedQuantity: 0,
      });
      expect(row.reasons.join(" ")).toMatch(/shared with other stores/);
    }
    expect(result.totals.suggestedSkus).toBe(0);
  });

  it("lists the selling locations the caller may check, latest source first", async () => {
    const { t, ids, as } = await fixture();
    await t.run(async (ctx) => {
      const order = await ctx.db
        .query("orders")
        .withIndex("by_client_request", (q) => q.eq("clientRequestId", "req-4"))
        .unique();
      await ctx.db.patch(order!._id, { sourceLocationId: ids.depotA });
    });
    const list = api.analytics.suggested_orders.sellingLocations;
    const args = { outletId: ids.outlet };
    expect(await as("managerA").query(list, args)).toEqual([
      expect.objectContaining({ code: "DEPOT-A", recent: true }),
    ]);
    expect(await as("Ana").query(list, args)).toEqual([
      expect.objectContaining({ code: "DEPOT-A", recent: true }),
    ]);
    expect(
      (await as("admin").query(list, args)).map((row) => row.code),
    ).toEqual(["DEPOT-A", "DEPOT-B"]);
    await expect(as("managerB").query(list, args)).rejects.toThrow(
      /outside your organizational scope/,
    );
    // The listed location is accepted by the suggestion itself.
    const [depot] = await as("Ana").query(list, args);
    const result = await as("Ana").query(
      api.analytics.suggested_orders.forOutlet,
      { outletId: ids.outlet, asOfDate: AS_OF, locationId: depot!.locationId },
    );
    expect(result.location?.code).toBe("DEPOT-A");
  });
});
