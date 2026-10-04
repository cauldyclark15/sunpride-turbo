import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  combineSkuFigures,
  emptySkuFigures,
  skuRates,
  sortGapOutlets,
  type SkuFigures,
} from "./sku_model";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
const DAY_MS = 86_400_000;
const D1 = "2026-09-28";
const D2 = "2026-09-29";
// 11:00 Manila on D2.
const now = Date.parse("2026-09-29T03:00:00Z");
const at = (date: string, hhmm: string) =>
  Date.parse(`${date}T${hhmm}:00+08:00`);
const ISSUER = "https://auth.test";
const subject = (name: string) => `${ISSUER}|${name}`;

afterEach(() => {
  vi.useRealTimers();
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const t: T = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const since = now - 60 * 24 * HOUR;
    const base = {
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    };
    const unit = (code: string, parentId?: Id<"orgUnits">) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code === "SUNPRIDE" ? "National" : `Region ${code}`,
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
      role: "sales" | "manager" | "analyst",
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
        ...base,
      });
      return id;
    };
    await person("managerA", "manager", regionA);
    await person("analyst", "analyst", root);
    const ana = await person("Ana", "sales", regionA);

    const territory = async (
      code: string,
      orgUnitId: Id<"orgUnits">,
      channel: string,
    ) => {
      const id = await ctx.db.insert("territories", {
        organizationId: "sunpride",
        code,
        name: `Territory ${code}`,
        channel,
        status: "active",
        effectiveFrom: since,
        createdAt: since,
        updatedAt: since,
        createdBy: "fixture",
      });
      await ctx.db.insert("territoryOwnerships", {
        territoryId: id,
        orgUnitId,
        effectiveFrom: since,
        ...base,
      });
      return id;
    };
    const ta = await territory("T-A", regionA, "GT");
    const tb = await territory("T-B", regionB, "MT");

    const outlet = async (
      n: number,
      territoryId: Id<"territories">,
      opts: { status?: "active" | "prospect"; effectiveTo?: number } = {},
    ) => {
      const id = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: `O${n}`,
        name: `Outlet ${n}`,
        status: opts.status ?? "active",
        custodianOrgUnitId: regionA,
        createdAt: since,
        updatedAt: since,
        createdBy: "fixture",
      });
      await ctx.db.insert("outletAssignments", {
        outletId: id,
        territoryId,
        sequence: n,
        effectiveFrom: since,
        ...(opts.effectiveTo !== undefined
          ? { effectiveTo: opts.effectiveTo }
          : {}),
        ...base,
      });
      const customer = await ctx.db.insert("customers", {
        code: `C${n}`,
        name: `Customer ${n}`,
        channel: "GT",
        territory: "T-A",
        creditLimit: 0,
        active: true,
        updatedAt: since,
      });
      await ctx.db.insert("outletCustomerLinks", {
        outletId: id,
        customerId: customer,
        source: "fixture",
        effectiveFrom: since,
        ...base,
      });
      return id;
    };
    // T-A: O1–O4 active, O5 a prospect, O6 moved out before the period; O7 in T-B.
    const o = [
      await outlet(1, ta),
      await outlet(2, ta),
      await outlet(3, ta),
      await outlet(4, ta),
      await outlet(5, ta, { status: "prospect" }),
      await outlet(6, ta, { effectiveTo: at(D1, "00:00") - DAY_MS }),
      await outlet(7, tb),
    ];

    const product = (code: string, name: string) =>
      ctx.db.insert("products", {
        code,
        name,
        category: "Canned",
        uom: "CS",
        unitPrice: 100,
        active: true,
        updatedAt: since,
      });
    const p1 = await product("P1", "Corned beef");
    const p2 = await product("P2", "Luncheon meat");
    const p3 = await product("P3", "Vienna sausage");

    const order = async (
      clientRequestId: string,
      customerCode: string,
      createdAt: number,
      lines: [string, number, number][],
      status: "submitted" | "draft" | "returned" = "submitted",
    ) => {
      const total = lines.reduce((sum, [, , value]) => sum + value, 0);
      const id = await ctx.db.insert("orders", {
        organizationId: "sunpride",
        clientRequestId,
        orderNumber: `SO-${clientRequestId}`,
        customerCode,
        salespersonSubject: subject("Ana"),
        status,
        subtotal: total,
        total,
        createdAt,
        updatedAt: createdAt,
      });
      for (const [productCode, quantity, lineTotal] of lines)
        await ctx.db.insert("orderLines", {
          orderId: id,
          productCode,
          description: productCode,
          quantity,
          unitPrice: quantity ? lineTotal / quantity : 0,
          lineTotal,
        });
    };
    await order("so-1", "C1", at(D1, "09:00"), [
      ["P1", 10, 600],
      ["P2", 5, 400],
    ]);
    await order("so-2", "C2", at(D1, "10:00"), [["P1", 3, 300]]);
    await order("ret-1", "C1", at(D2, "09:00"), [["P1", -1, -100]], "returned");
    await order("draft-1", "C3", at(D1, "11:00"), [["P2", 9, 900]], "draft");
    await order("old-1", "C3", at("2026-09-20", "10:00"), [["P2", 1, 100]]);
    await order("moved-1", "C6", at(D1, "10:00"), [["P1", 1, 100]]);
    await order("tb-1", "C7", at(D1, "10:00"), [["P2", 2, 200]]);

    let n = 0;
    const audit = async (
      index: number,
      serviceDate: string,
      lines: [
        Id<"products">,
        "available" | "low_stock" | "out_of_stock" | "not_carried",
      ][],
    ) => {
      const visitId = await ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: `client-${++n}`,
        assigneeProfileId: ana,
        outletId: o[index]!,
        orgUnitId: regionA,
        serviceDate,
        source: "unplanned",
        intents: ["sell"],
        state: "checked-out",
        productivity: "pending",
        createdAt: at(serviceDate, "08:00"),
        lastServerTime: at(serviceDate, "08:30"),
        checkedInAt: at(serviceDate, "08:00"),
        checkedOutAt: at(serviceDate, "08:30"),
      });
      const auditId = await ctx.db.insert("merchandisingAudits", {
        organizationId: "sunpride",
        orgUnitId: regionA,
        visitId,
        outletId: o[index]!,
        assigneeProfileId: ana,
        serviceDate,
        clientAuditId: `audit-${n}`,
        payloadHash: "hash",
        auditVersion: "test",
        requiredCount: 0,
        requiredAvailableCount: 0,
        requiredOutOfStockCount: 0,
        missingRequiredProductIds: [],
        evidenceIds: [],
        actorSubject: subject("Ana"),
        source: "mobile",
        deviceTime: at(serviceDate, "08:10"),
        serverTime: at(serviceDate, "08:10"),
      });
      for (const [productId, status] of lines)
        await ctx.db.insert("merchandisingAvailability", {
          organizationId: "sunpride",
          orgUnitId: regionA,
          auditId,
          outletId: o[index]!,
          productId,
          serviceDate,
          required: false,
          status,
          evidenceIds: [],
        });
    };
    // O3: an older audit had P1 on shelf; the latest one finds it out of stock.
    await audit(2, D1, [[p1, "available"]]);
    await audit(2, D2, [
      [p1, "out_of_stock"],
      [p3, "not_carried"],
    ]);
    await audit(3, D2, [
      [p1, "low_stock"],
      [p2, "available"],
    ]);
    // An audit before the period gives no signal.
    await audit(1, "2026-09-20", [[p1, "out_of_stock"]]);
    return { ta, tb };
  });
  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });
  return { t, ids, as };
}

const figures = (over: Partial<SkuFigures>): SkuFigures => ({
  ...emptySkuFigures(),
  ...over,
});

describe("SKU distribution queries", () => {
  it("counts buying stores, sales and the latest shelf signals per SKU", async () => {
    const { ids, as } = await fixture();
    const result = await as("managerA").query(api.analytics.sku.territory, {
      territoryId: ids.ta,
      from: D1,
      to: D2,
    });
    expect(result).toMatchObject({
      code: "T-A",
      channel: "GT",
      activeOutlets: 4,
      auditedOutlets: 2,
      truncated: false,
    });
    expect(result.skus.map((row) => row.productCode)).toEqual([
      "P1",
      "P2",
      "P3",
    ]);
    const [p1, p2, p3] = result.skus;
    expect(p1).toMatchObject({ name: "Corned beef", category: "Canned" });
    expect(p1!.figures).toEqual(
      figures({
        buyingOutlets: 2,
        orders: 2,
        quantity: 13,
        salesMinor: 90_000,
        returnQuantity: 1,
        returnsMinor: 10_000,
        auditedOutlets: 2,
        onShelfOutlets: 1,
        lowStockOutlets: 1,
        outOfStockOutlets: 1,
      }),
    );
    expect(p2!.figures).toEqual(
      figures({
        buyingOutlets: 1,
        orders: 1,
        quantity: 5,
        salesMinor: 40_000,
        auditedOutlets: 1,
        onShelfOutlets: 1,
      }),
    );
    expect(p3!.figures).toEqual(
      figures({ auditedOutlets: 1, notCarriedOutlets: 1 }),
    );
    expect(skuRates(p1!.figures, result.activeOutlets)).toEqual({
      distributionPct: 50,
      distributionGaps: 2,
      onShelfPct: 50,
      netSalesMinor: 80_000,
    });
  });

  it("lists one SKU's gap stores, out of stock first", async () => {
    const { ids, as } = await fixture();
    const p1 = await as("managerA").query(api.analytics.sku.gaps, {
      territoryId: ids.ta,
      from: D1,
      to: D2,
      productCode: "P1",
    });
    expect(p1.gapCount).toBe(2);
    expect(p1.outlets.map((row) => [row.code, row.shelfStatus])).toEqual([
      ["O3", "out_of_stock"],
      ["O4", "low_stock"],
    ]);
    const p2 = await as("managerA").query(api.analytics.sku.gaps, {
      territoryId: ids.ta,
      from: D1,
      to: D2,
      productCode: "P2",
    });
    expect(p2.outlets.map((row) => [row.code, row.shelfStatus])).toEqual([
      ["O4", "available"],
      ["O2", null],
      ["O3", null],
    ]);
    const unsold = await as("managerA").query(api.analytics.sku.gaps, {
      territoryId: ids.ta,
      from: D1,
      to: D2,
      productCode: "NOPE",
    });
    expect(unsold.gapCount).toBe(4);
  });

  it("refuses territories outside scope, field sales and over-long periods", async () => {
    const { ids, as } = await fixture();
    await expect(
      as("managerA").query(api.analytics.sku.territory, {
        territoryId: ids.tb,
        from: D1,
        to: D2,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      as("managerA").query(api.analytics.sku.gaps, {
        territoryId: ids.tb,
        from: D1,
        to: D2,
        productCode: "P2",
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      as("Ana").query(api.analytics.sku.territory, {
        territoryId: ids.ta,
        from: D1,
        to: D2,
      }),
    ).rejects.toThrow(/Insufficient permission/);
    await expect(
      as("managerA").query(api.analytics.sku.territory, {
        territoryId: ids.ta,
        from: "2026-08-01",
        to: D2,
      }),
    ).rejects.toThrow(/at most 31 days/);
    await expect(
      as("managerA").query(api.analytics.sku.gaps, {
        territoryId: ids.ta,
        from: D1,
        to: D2,
        productCode: "  ",
      }),
    ).rejects.toThrow(/invalid_request/);
    const other = await as("analyst").query(api.analytics.sku.territory, {
      territoryId: ids.tb,
      from: D1,
      to: D2,
    });
    expect(other).toMatchObject({ channel: "MT", activeOutlets: 1 });
    expect(other.skus).toEqual([
      expect.objectContaining({
        productCode: "P2",
        figures: figures({
          buyingOutlets: 1,
          orders: 1,
          quantity: 2,
          salesMinor: 20_000,
        }),
      }),
    ]);
  });
});

describe("SKU distribution rules", () => {
  it("returns null rates without a base and sums before dividing", () => {
    expect(skuRates(emptySkuFigures(), 0)).toEqual({
      distributionPct: null,
      distributionGaps: 0,
      onShelfPct: null,
      netSalesMinor: 0,
    });
    const total = combineSkuFigures([
      figures({ buyingOutlets: 9, auditedOutlets: 10, onShelfOutlets: 9 }),
      figures({ buyingOutlets: 1, auditedOutlets: 30, onShelfOutlets: 15 }),
    ]);
    // 24 of 40 audited stores, not the mean of 90% and 50%.
    expect(skuRates(total, 40)).toMatchObject({
      distributionPct: 25,
      distributionGaps: 30,
      onShelfPct: 60,
    });
  });

  it("orders gap stores by urgency, then code", () => {
    expect(
      sortGapOutlets([
        { code: "B", shelfStatus: null },
        { code: "A", shelfStatus: "available" as const },
        { code: "C", shelfStatus: "out_of_stock" as const },
        { code: "A2", shelfStatus: null },
        { code: "D", shelfStatus: "not_carried" as const },
      ]).map((row) => row.code),
    ).toEqual(["C", "D", "A", "A2", "B"]);
  });
});
