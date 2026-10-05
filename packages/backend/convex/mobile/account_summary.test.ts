/* Convex runtime secret is not a Turborepo build input. */
/* eslint-disable turbo/no-undeclared-env-vars */
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { fixture } from "./bootstrap.test";
import type { Id } from "../_generated/dataModel";
import {
  ACCOUNT_SUMMARY_MAX_BYTES,
  MAX_SUMMARY_ORDERS,
  accountSummary,
  summarizeOrders,
} from "./account_summary";
import { jsonBytes } from "./budget";

process.env.MOBILE_CURSOR_SECRET =
  "test-only-mobile-cursor-secret-32-bytes-long";
afterEach(() => vi.useRealTimers());

const DAY = 86_400_000;
type Order = Pick<
  Doc<"orders">,
  "status" | "total" | "createdAt" | "offlineCreatedAt" | "organizationId"
>;
// 2026-10-05 04:00 UTC = noon in Manila.
const NOON = Date.parse("2026-10-05T04:00:00Z");
const order = (
  daysAgo: number,
  total: number,
  status: Order["status"] = "posted",
  extra: Partial<Order> = {},
): Order => ({ status, total, createdAt: NOON - daysAgo * DAY, ...extra });

describe("account summary figures", () => {
  it("counts DSR sales over 13 weeks and 4 weeks, open orders and the last positive order", () => {
    const { sales, openOrders } = summarizeOrders(
      [
        order(0, 100, "submitted"),
        order(1, -20, "returned"),
        order(2, 50, "draft"),
        order(3, 70, "voided"),
        order(5, 40, "posted", { organizationId: "other-org" }),
        order(10, 200),
        order(40, 300),
        order(95, 999),
      ],
      "2026-10-05",
      false,
    );
    expect(sales).toEqual({
      from: "2026-07-07",
      to: "2026-10-05",
      complete: true,
      orders: 4,
      amountMinor: 58_000,
      recentOrders: 3,
      recentAmountMinor: 28_000,
      lastOrderDate: "2026-10-05",
      lastOrderAmountMinor: 10_000,
    });
    expect(openOrders).toEqual({ count: 1, amountMinor: 10_000 });
  });

  it("flags a capped read and starts the window at the oldest order read", () => {
    const { sales } = summarizeOrders(
      [order(1, 10), order(20, 10)],
      "2026-10-05",
      true,
    );
    expect(sales).toMatchObject({
      from: "2026-09-15",
      complete: false,
      orders: 2,
    });
  });

  it("stays within the reserved page bytes at the largest figures", () => {
    const big = Number.MAX_SAFE_INTEGER;
    const worst = {
      outletId: "k".repeat(32),
      asOfDate: "2026-10-05",
      availability: "available",
      creditLimitMinor: big,
      sales: {
        from: "2026-07-07",
        to: "2026-10-05",
        complete: false,
        orders: MAX_SUMMARY_ORDERS,
        amountMinor: -big,
        recentOrders: MAX_SUMMARY_ORDERS,
        recentAmountMinor: -big,
        lastOrderDate: "2026-10-05",
        lastOrderAmountMinor: big,
      },
      openOrders: { count: MAX_SUMMARY_ORDERS, amountMinor: -big },
    };
    expect(jsonBytes(worst)).toBeLessThanOrEqual(ACCOUNT_SUMMARY_MAX_BYTES);
  });
});

describe("bootstrap account summaries", () => {
  async function addOrder(
    f: Awaited<ReturnType<typeof fixture>>,
    code: string,
    total: number,
    status: Order["status"],
    createdAt: number,
    extra: Partial<Doc<"orders">> = {},
  ) {
    await f.t.run((ctx) =>
      ctx.db.insert("orders", {
        organizationId: "sunpride",
        clientRequestId: `req-${total}-${status}-${createdAt}`,
        orderNumber: `SO-${total}`,
        customerCode: code,
        salespersonSubject: f.actor.subject,
        ...extra,
        status,
        subtotal: total,
        total,
        createdAt,
        updatedAt: createdAt,
      }),
    );
  }

  it("ships the planned account's sales history, open orders and credit limit", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.ids.snapshot.customerId, { creditLimit: 5000 });
      // Linked only to the planned outlet: figures are in scope.
      await ctx.db.insert("outletCustomerLinks", {
        outletId: f.ids.outlet,
        customerId: f.ids.snapshot.customerId,
        source: "fixture",
        effectiveFrom: f.now - 10_000,
        actorSubject: f.actor.subject,
        reason: "fixture",
        createdAt: f.now - 10_000,
      });
    });
    await addOrder(f, "LOCAL-C", 1234.5, "posted", f.now - 3 * DAY);
    await addOrder(f, "LOCAL-C", 300, "approved", f.now - 1000);
    await addOrder(f, "LOCAL-C", 999, "draft", f.now - 500);
    await addOrder(f, "OTHER", 777, "posted", f.now - 500);
    const r = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(r.accountSummaries).toHaveLength(1);
    const [summary] = r.accountSummaries;
    expect(summary).toMatchObject({
      outletId: f.ids.outlet,
      asOfDate: f.day,
      availability: "available",
      creditLimitMinor: 500_000,
      openOrders: { count: 1, amountMinor: 30_000 },
      sales: {
        to: f.day,
        complete: true,
        orders: 2,
        amountMinor: 153_450,
        recentOrders: 2,
        lastOrderDate: f.day,
        lastOrderAmountMinor: 30_000,
      },
    });
    expect(JSON.stringify(r)).not.toContain("77700");
  });

  it("withholds every figure when the account is shared with an outlet off this person's plan", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const elsewhere = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: "ELSEWHERE",
        name: "Other region outlet",
        status: "active",
        custodianOrgUnitId: f.ids.foreignUnit,
        createdAt: f.now,
        updatedAt: f.now,
        createdBy: f.actor.subject,
      });
      for (const outletId of [f.ids.outlet, elsewhere])
        await ctx.db.insert("outletCustomerLinks", {
          outletId,
          customerId: f.ids.snapshot.customerId,
          source: "fixture",
          effectiveFrom: f.now - 10_000,
          actorSubject: f.actor.subject,
          reason: "fixture",
          createdAt: f.now - 10_000,
        });
      await ctx.db.patch(f.ids.snapshot.customerId, { creditLimit: 5000 });
    });
    await addOrder(f, "LOCAL-C", 4321, "posted", f.now - DAY);
    const r = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(r.accountSummaries).toEqual([
      {
        outletId: f.ids.outlet,
        asOfDate: f.day,
        availability: "withheld",
        creditLimitMinor: null,
        sales: null,
        openOrders: null,
      },
    ]);
    expect(JSON.stringify(r)).not.toContain("432100");
  });

  it("ships a repeated outlet's summary once per snapshot, on its first page", async () => {
    const f = await fixture();
    const tomorrow = new Date(Date.parse(`${f.day}T00:00:00Z`) + DAY)
      .toISOString()
      .slice(0, 10);
    await f.t.run(async (ctx) => {
      const slot = await ctx.db.insert("coveragePlanSlots", {
        slotKey: "slot-2",
        planId: f.ids.plan,
        assigneeProfileId: f.ids.person,
        serviceDate: tomorrow,
        kind: "outlet_visit",
        outletId: f.ids.outlet,
        requiredObjectives: [],
        intents: ["sell"],
        sequence: 1,
        expectedDurationMinutes: 30,
        approvedSnapshot: f.ids.snapshot,
        contentRevision: 1,
        updatedBy: f.actor.subject,
        updatedAt: f.now,
      });
      await ctx.db.insert("plannedVisits", {
        generationKey: "fixture-2",
        planId: f.ids.plan,
        planVersion: 1,
        planSlotId: slot,
        assigneeProfileId: f.ids.person,
        outletId: f.ids.outlet,
        serviceDate: tomorrow,
        status: "planned",
        approvedSnapshot: f.ids.snapshot,
        requiredObjectives: [],
        intents: ["sell"],
        expectedDurationMinutes: 30,
        generatedAt: f.now,
      });
    });
    const first = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      limit: 1,
    });
    const second = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      limit: 1,
      pageCursor: first.nextPageCursor!,
    });
    expect(first.accountSummaries.map((s) => s.outletId)).toEqual([
      f.ids.outlet,
    ]);
    expect(second.plannedVisits).toHaveLength(1);
    expect(second.accountSummaries).toEqual([]);
  });
  async function linkPlannedOutlet(f: Awaited<ReturnType<typeof fixture>>) {
    await f.t.run((ctx) =>
      ctx.db.insert("outletCustomerLinks", {
        outletId: f.ids.outlet,
        customerId: f.ids.snapshot.customerId,
        source: "fixture",
        effectiveFrom: f.now - 10_000,
        actorSubject: f.actor.subject,
        reason: "fixture",
        createdAt: f.now - 10_000,
      }),
    );
  }

  async function location(
    f: Awaited<ReturnType<typeof fixture>>,
    code: string,
    orgUnitId: Id<"orgUnits"> | undefined,
  ) {
    return f.t.run((ctx) =>
      ctx.db.insert("inventoryLocations", {
        organizationId: "sunpride",
        ...(orgUnitId ? { orgUnitId } : {}),
        siteCode: code,
        code,
        name: code,
        type: "truck",
        active: true,
        allowsPicking: true,
        allowsReceiving: true,
        allowsSale: true,
        allowsProduction: false,
        createdAt: f.now,
        updatedAt: f.now,
      }),
    );
  }

  async function colleague(
    f: Awaited<ReturnType<typeof fixture>>,
    subject: string,
    orgUnitId: Id<"orgUnits">,
  ) {
    await f.t.run((ctx) =>
      ctx.db.insert("profiles", {
        authSubject: subject,
        name: subject,
        email: `${subject.split("|")[1]}@test.local`,
        role: "sales",
        status: "active",
        orgUnitId,
        updatedAt: f.now,
      }),
    );
  }

  it("never counts a foreign salesperson's order on a planned local account", async () => {
    // Release probe: the outlet is linked only to LOCAL-C, yet an order by the foreign-region
    // salesperson shares that customer code.
    const f = await fixture();
    await linkPlannedOutlet(f);
    await addOrder(f, "LOCAL-C", 4321, "posted", f.now - 1000, {
      salespersonSubject: "https://auth.fixture|foreign",
    });
    await addOrder(f, "LOCAL-C", 4322, "approved", f.now - 900, {
      salespersonSubject: "https://auth.fixture|foreign",
    });
    await addOrder(f, "LOCAL-C", 100, "posted", f.now - 2000);
    const r = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    const text = JSON.stringify(r);
    expect(text).not.toContain("432100");
    expect(text).not.toContain("432200");
    expect(r.accountSummaries[0]).toMatchObject({
      availability: "available",
      openOrders: { count: 0, amountMinor: 0 },
      sales: { orders: 1, amountMinor: 10_000 },
    });
  });

  it("counts only a salesperson's own orders, from in-scope source locations", async () => {
    const f = await fixture();
    await linkPlannedOutlet(f);
    await colleague(f, "https://auth.fixture|teammate", f.ids.unit);
    const local = await location(f, "TRUCK-L", f.ids.unit);
    const foreign = await location(f, "TRUCK-F", f.ids.foreignUnit);
    const unmapped = await location(f, "TRUCK-U", undefined);
    // A same-unit teammate's order: the web's orderAccessible hides it from a sales role.
    await addOrder(f, "LOCAL-C", 501, "posted", f.now - 1000, {
      salespersonSubject: "https://auth.fixture|teammate",
    });
    // Own orders sold from another region's or an unmapped truck stay out.
    await addOrder(f, "LOCAL-C", 502, "posted", f.now - 900, {
      sourceLocationId: foreign,
    });
    await addOrder(f, "LOCAL-C", 503, "posted", f.now - 800, {
      sourceLocationId: unmapped,
    });
    await addOrder(f, "LOCAL-C", 200, "posted", f.now - 700, {
      sourceLocationId: local,
    });
    const r = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(r.accountSummaries[0]?.sales).toMatchObject({
      orders: 1,
      amountMinor: 20_000,
      lastOrderAmountMinor: 20_000,
    });
  });

  it("gives a supervisor current-subtree orders only, never a moved author's history", async () => {
    const f = await fixture();
    await linkPlannedOutlet(f);
    await colleague(f, "https://auth.fixture|teammate", f.ids.unit);
    await colleague(f, "https://auth.fixture|moved", f.ids.foreignUnit);
    await addOrder(f, "LOCAL-C", 300, "posted", f.now - 1000, {
      salespersonSubject: "https://auth.fixture|teammate",
    });
    // Authored while in this region, but the author now belongs to the foreign region.
    await addOrder(f, "LOCAL-C", 601, "posted", f.now - 2 * DAY, {
      salespersonSubject: "https://auth.fixture|moved",
    });
    await addOrder(f, "LOCAL-C", 602, "posted", f.now - 900, {
      salespersonSubject: "https://auth.fixture|foreign",
    });
    const summary = await f.t.run((ctx) =>
      accountSummary(
        ctx,
        f.ids.outlet,
        f.ids.snapshot.customerId as Id<"customers">,
        new Set([f.ids.outlet as string]),
        {
          subject: "https://auth.fixture|manager",
          role: "manager",
          units: new Set([f.ids.unit]),
        },
        f.now,
      ),
    );
    expect(summary.sales).toMatchObject({ orders: 1, amountMinor: 30_000 });
  });

  it("flags a capped read whose orders are all out of scope as incomplete", () => {
    const { sales } = summarizeOrders([], "2026-10-05", true);
    expect(sales).toMatchObject({
      from: "2026-10-05",
      complete: false,
      orders: 0,
    });
  });
});
