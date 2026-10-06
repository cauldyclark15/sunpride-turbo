/* Convex runtime secret is not a Turborepo build input. */
/* eslint-disable turbo/no-undeclared-env-vars */
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";
import { localDate, manilaDate } from "../coverage/validation";
import { EVIDENCE_PHOTO_TYPES, nextDayCloseAt } from "../visits/policy";
import {
  DEFAULT_ACTIVITY_RULE_VERSION,
  VISIT_INTENTS,
} from "../visits/activity_rules";
import type { AuthorizedDevice } from "./types";

const SECRET = "test-only-mobile-cursor-secret-32-bytes-long";
process.env.MOBILE_CURSOR_SECRET = SECRET;
export async function fixture(
  t: TestConvex<typeof schema> = convexTest(schema, modules),
) {
  const now = Date.now();
  const day = manilaDate(now);
  const subject = "https://auth.fixture|sales";
  const ids = await t.run(async (ctx) => {
    // A valid tree (one national root) so scope subtrees resolve. A caller-supplied
    // instance may already hold the seeded root (e.g. after provisionAdmin); reuse it.
    const seededRoot = await ctx.db
      .query("orgUnits")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", "sunpride").eq("code", "SUNPRIDE"),
      )
      .unique();
    const national =
      seededRoot?._id ??
      (await ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code: "SUNPRIDE",
        name: "National",
        typeCode: "NATIONAL",
        status: "active",
        effectiveFrom: now - 100000,
        createdAt: now - 100000,
        updatedAt: now,
      }));
    const unit = await ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      parentId: national,
      code: "LOCAL",
      name: "Local",
      typeCode: "REGION",
      status: "active",
      effectiveFrom: now - 100000,
      createdAt: now - 100000,
      updatedAt: now,
    });
    const foreignUnit = await ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      parentId: national,
      code: "FOREIGN",
      name: "Foreign",
      typeCode: "REGION",
      status: "active",
      effectiveFrom: now - 100000,
      createdAt: now - 100000,
      updatedAt: now,
    });
    const person = await ctx.db.insert("profiles", {
      authSubject: subject,
      name: "Sales",
      email: "sales@test.local",
      role: "sales",
      status: "active",
      orgUnitId: unit,
      updatedAt: now,
    });
    const stranger = await ctx.db.insert("profiles", {
      authSubject: "https://auth.fixture|foreign",
      name: "Foreign",
      email: "foreign@test.local",
      role: "sales",
      status: "active",
      orgUnitId: foreignUnit,
      updatedAt: now,
    });
    const assignment = await ctx.db.insert("employeeAssignments", {
      profileId: person,
      orgUnitId: unit,
      role: "sales",
      effectiveFrom: now - 100000,
      actorSubject: subject,
      reason: "fixture",
      createdAt: now - 100000,
    });
    const device = await ctx.db.insert("registeredDevices", {
      organizationId: "sunpride",
      orgUnitId: unit,
      inventoryTag: "TEST",
      profileId: person,
      boundSubject: subject,
      allowedApp: "ANDROID",
      platform: "Android",
      model: "fixture",
      osVersion: "1",
      appVersion: "1",
      publicKey: "fixture-public-key",
      credentialId: "cred",
      registeredAt: now,
      status: "active",
    });
    const territory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "T",
      name: "Territory",
      status: "active",
      effectiveFrom: now - 100000,
      createdAt: now,
      updatedAt: now,
      createdBy: subject,
    });
    const ownership = await ctx.db.insert("territoryOwnerships", {
      territoryId: territory,
      orgUnitId: unit,
      effectiveFrom: now - 100000,
      actorSubject: subject,
      reason: "fixture",
      createdAt: now,
    });
    const outlet = await ctx.db.insert("outlets", {
      organizationId: "sunpride",
      code: "O",
      name: "Signed outlet",
      status: "active",
      custodianOrgUnitId: unit,
      createdAt: now,
      updatedAt: now,
      createdBy: subject,
    });
    const outletAssignment = await ctx.db.insert("outletAssignments", {
      outletId: outlet,
      territoryId: territory,
      effectiveFrom: now - 100000,
      actorSubject: subject,
      reason: "fixture",
      createdAt: now,
    });
    const customer = await ctx.db.insert("customers", {
      code: "LOCAL-C",
      name: "Local",
      channel: "local",
      territory: "T",
      creditLimit: 0,
      active: true,
      updatedAt: now,
    });
    const plan = await ctx.db.insert("coveragePlans", {
      organizationId: "sunpride",
      assigneeProfileId: person,
      localMonth: day.slice(0, 7),
      version: 1,
      cycleType: "monthly",
      orgUnitId: unit,
      territoryIds: [territory],
      requestedFrom: now - 100000,
      requestedTo: now + 5 * 86400000,
      effectiveFrom: now - 100000,
      effectiveTo: now + 5 * 86400000,
      status: "active",
      preparedBy: subject,
      preparedAt: now,
      approvedBy: subject,
      approvedAt: now,
      approvalSignature: "signed",
      activatedAt: now,
      contentRevision: 1,
      createdBy: subject,
      createdAt: now,
      updatedBy: subject,
      updatedAt: now,
    });
    const snapshot = {
      outletId: outlet,
      outletCode: "O",
      outletName: "Signed outlet",
      customerId: customer,
      territoryId: territory,
      territoryCode: "T",
      outletAssignmentId: outletAssignment,
      territoryOwnershipId: ownership,
      employeeAssignmentId: assignment,
      orgUnitId: unit,
      activityKind: "visit",
      approvedAssigneeProfileId: person,
    };
    const slot = await ctx.db.insert("coveragePlanSlots", {
      slotKey: "slot",
      planId: plan,
      assigneeProfileId: person,
      serviceDate: day,
      kind: "outlet_visit",
      outletId: outlet,
      requiredObjectives: [],
      intents: ["sell"],
      sequence: 1,
      expectedDurationMinutes: 30,
      approvedSnapshot: snapshot,
      contentRevision: 1,
      updatedBy: subject,
      updatedAt: now,
    });
    const visit = await ctx.db.insert("plannedVisits", {
      generationKey: "fixture",
      planId: plan,
      planVersion: 1,
      planSlotId: slot,
      assigneeProfileId: person,
      outletId: outlet,
      serviceDate: day,
      status: "planned",
      approvedSnapshot: snapshot,
      requiredObjectives: [],
      intents: ["sell"],
      expectedDurationMinutes: 30,
      generatedAt: now,
    });
    return {
      unit,
      foreignUnit,
      person,
      stranger,
      assignment,
      device,
      territory,
      ownership,
      outlet,
      outletAssignment,
      plan,
      slot,
      visit,
      snapshot,
    };
  });
  const scope = `${ids.person}|${subject}|${ids.assignment}|${ids.unit}|sales|${ids.device}|ANDROID|cred`;
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(scope),
  );
  const scopeFingerprint = Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const actor: AuthorizedDevice = {
    deviceId: ids.device,
    profileId: ids.person,
    subject,
    orgUnitId: ids.unit,
    role: "sales",
    scopeFingerprint,
  };
  const caller = t.withIdentity({
    subject: "sales",
    issuer: "https://auth.fixture",
    email: "sales@test.local",
  });
  return { t, ids, actor, caller, day, now };
}

afterEach(() => vi.useRealTimers());
describe("mobile day bootstrap", () => {
  it("returns own signed plan, scoped outlet and link; no legacy price or order capture", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const foreignOutlet = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: "FOREIGN",
        name: "Private outlet",
        status: "active",
        custodianOrgUnitId: f.ids.foreignUnit,
        createdAt: f.now,
        updatedAt: f.now,
        createdBy: f.actor.subject,
      });
      await ctx.db.insert("plannedVisits", {
        generationKey: "foreign",
        planId: f.ids.plan,
        planVersion: 1,
        planSlotId: f.ids.slot,
        assigneeProfileId: f.ids.stranger,
        outletId: foreignOutlet,
        serviceDate: f.day,
        status: "planned",
        approvedSnapshot: {
          ...f.ids.snapshot,
          approvedAssigneeProfileId: f.ids.stranger,
          outletId: foreignOutlet,
          outletName: "Private outlet",
        },
        requiredObjectives: [],
        intents: [],
        expectedDurationMinutes: 15,
        generatedAt: f.now,
      });
    });
    const r = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(r.plannedVisits).toMatchObject([
      { id: f.ids.visit, planId: f.ids.plan, sequence: 1 },
    ]);
    // Client answer 14: the offline lease ends at the next 10 PM Manila close.
    const close = nextDayCloseAt(r.serverTime);
    expect(r.appConfig.offlineLeaseExpiresAt).toBe(close);
    expect(r.appConfig.cacheExpiresAt).toBe(close);
    expect(new Date(close + 8 * 3_600_000).toISOString().slice(11, 16)).toBe(
      "22:00",
    );
    expect(close - r.serverTime).toBeGreaterThan(0);
    expect(close - r.serverTime).toBeLessThanOrEqual(86_400_000);
    expect(r.outlets).toEqual([
      {
        id: f.ids.outlet,
        name: "Signed outlet",
        routeId: null,
        code: "O",
        customerId: f.ids.snapshot.customerId,
        territoryId: f.ids.snapshot.territoryId,
        territoryCode: f.ids.snapshot.territoryCode,
      },
    ]);
    expect(r.localCustomers).toEqual([
      { id: expect.any(String), code: "LOCAL-C" },
    ]);
    expect(r.productCatalog).toEqual([]);
    expect(r.appConfig).toMatchObject({
      orderCaptureEnabled: false,
      priceAvailability: "unavailable",
      promotionsAvailability: "unavailable",
    });
    expect(r.syncCursor).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain(f.actor.subject);
  });
  it("keeps order territory association from the signed visit, not the current outlet assignment", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const territory = await ctx.db.insert("territories", {
        organizationId: "sunpride",
        code: "CURRENT-T",
        name: "Current territory",
        status: "active",
        effectiveFrom: f.now - 100000,
        createdAt: f.now,
        updatedAt: f.now,
        createdBy: f.actor.subject,
      });
      await ctx.db.insert("territoryOwnerships", {
        territoryId: territory,
        orgUnitId: f.ids.unit,
        effectiveFrom: f.now - 100000,
        actorSubject: f.actor.subject,
        reason: "fixture",
        createdAt: f.now,
      });
      await ctx.db.patch(f.ids.outletAssignment, { territoryId: territory });
    });
    const r = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(r.outlets[0]).toMatchObject({
      territoryId: f.ids.snapshot.territoryId,
      territoryCode: f.ids.snapshot.territoryCode,
    });
  });
  it("carries the person's daily position standard as the Today target", async () => {
    const f = await fixture();
    const none = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    // No position on the assignment or profile: the phone shows "No target set".
    expect(none).not.toHaveProperty("dayTarget");
    await f.t.run(async (ctx) => {
      const position = await ctx.db.insert("positions", {
        organizationId: "sunpride",
        code: "RDS",
        label: "Route Distribution Salesman",
        category: "field",
        active: true,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.patch(f.ids.assignment, { positionId: position });
      // A superseded standard and the current memo standard.
      await ctx.db.insert("positionStandards", {
        organizationId: "sunpride",
        positionId: position,
        effectiveFrom: 1,
        effectiveTo: f.now - 50_000_000,
        dailyCallsTarget: 20,
        sourceRef: "old-memo",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("positionStandards", {
        organizationId: "sunpride",
        positionId: position,
        effectiveFrom: f.now - 50_000_000,
        dailyCallsTarget: 30,
        productiveCallTargetPct: 85,
        sourceRef: "memo-2026-01-20",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const r = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(r.dayTarget).toEqual({
      dailyCalls: 30,
      productivePct: 85,
      sourceRef: "memo-2026-01-20",
    });
  });
  it("carries the position's productive-call rule even without call targets", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const position = await ctx.db.insert("positions", {
        organizationId: "sunpride",
        code: "PMOT",
        label: "PMOT",
        category: "field",
        active: true,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.patch(f.ids.assignment, { positionId: position });
      await ctx.db.insert("positionStandards", {
        organizationId: "sunpride",
        positionId: position,
        effectiveFrom: f.now - 50_000_000,
        productiveCallRule: "truck_seller",
        sourceRef: "call-2026-10-02",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const r = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(r.dayTarget).toEqual({
      sourceRef: "call-2026-10-02",
      productiveCallRule: "truck_seller",
    });
  });
  it("carries today's sales like the Daily Sales Report, with the daily sales target", async () => {
    const f = await fixture();
    const empty = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(empty.daySales).toEqual({ amountMinor: 0, orders: 0 });
    const dayStart = localDate(f.day);
    const at = Math.max(dayStart, f.now - 60_000);
    await f.t.run(async (ctx) => {
      let n = 0;
      const order = (
        total: number,
        extra: {
          status?: "posted" | "voided" | "draft";
          subject?: string;
          createdAt?: number;
          offlineCreatedAt?: number;
        } = {},
      ) =>
        ctx.db.insert("orders", {
          organizationId: "sunpride",
          clientRequestId: `req-${++n}`,
          orderNumber: `SI-${n}`,
          customerCode: "LOCAL-C",
          salespersonSubject: extra.subject ?? f.actor.subject,
          status: extra.status ?? "posted",
          subtotal: total,
          total,
          ...(extra.offlineCreatedAt
            ? { offlineCreatedAt: extra.offlineCreatedAt }
            : {}),
          createdAt: extra.createdAt ?? at,
          updatedAt: extra.createdAt ?? at,
        });
      await order(1500.5);
      await order(250);
      await order(999, { status: "voided" }); // never a sale
      await order(999, { status: "draft" });
      await order(777, { subject: "https://auth.fixture|foreign" });
      // Written offline yesterday, synced today: yesterday's sale.
      await order(333, { offlineCreatedAt: dayStart - 3_600_000 });
      await order(444, { createdAt: dayStart - 1 }); // yesterday
      await ctx.db.insert("salesTargets", {
        organizationId: "sunpride",
        subjectKind: "employee",
        profileId: f.ids.person,
        period: "daily",
        metric: "sales_value",
        value: 500_000,
        effectiveFrom: dayStart,
        sourceRef: "daily allocation",
        createdBy: "fixture",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const r = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(r.daySales).toEqual({
      amountMinor: 175_050,
      orders: 2,
      targetMinor: 500_000,
    });
  });
  it("gives the daily route the single current verified pin and address, never a pending or ambiguous pin", async () => {
    const f = await fixture();
    const pin = (status: "verified" | "pending", latitude: number) =>
      f.t.run((ctx) =>
        ctx.db.insert("outletPins", {
          outletId: f.ids.outlet,
          latitude,
          longitude: 121.05,
          radiusMeters: 75,
          source: "fixture",
          status,
          effectiveFrom: f.now - 50_000,
          proposedBy: f.actor.subject,
          proposedAt: f.now - 50_000,
          createdAt: f.now - 50_000,
        }),
      );
    await f.t.run((ctx) =>
      ctx.db.patch(f.ids.outlet, { address: "  12 Rizal Ave, Pasig  " }),
    );
    await pin("pending", 10);
    const first = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(first.outlets[0]).toMatchObject({ address: "12 Rizal Ave, Pasig" });
    expect(first.outlets[0]).not.toHaveProperty("latitude");
    expect(first.outlets[0]).not.toHaveProperty("longitude");
    const verified = await pin("verified", 14.58);
    const second = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(second.outlets[0]).toMatchObject({
      latitude: 14.58,
      longitude: 121.05,
    });
    await f.t.run((ctx) =>
      ctx.db.insert("plannedVisits", {
        generationKey: "second-stop",
        planId: f.ids.plan,
        planVersion: 1,
        planSlotId: f.ids.slot,
        assigneeProfileId: f.ids.person,
        outletId: f.ids.outlet,
        serviceDate: f.day,
        status: "planned",
        approvedSnapshot: f.ids.snapshot,
        requiredObjectives: [],
        intents: [],
        expectedDurationMinutes: 15,
        generatedAt: f.now,
      }),
    );
    const paged = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      limit: 1,
    });
    expect(paged.nextPageCursor).toBeTruthy();
    // A moved pin changes the signed manifest, so a half-finished download restarts.
    await f.t.run((ctx) => ctx.db.patch(verified, { latitude: 14.59 }));
    await expect(
      f.caller.query(internal.mobile.bootstrap.snapshot, {
        actor: f.actor,
        pageCursor: paged.nextPageCursor!,
        limit: 1,
      }),
    ).rejects.toThrow("rebootstrap_required");
    const extra = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(extra.outlets[0]!.latitude).toBe(14.59);
    await pin("verified", 14.6);
    const ambiguous = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(ambiguous.outlets[0]).not.toHaveProperty("latitude");
    expect(ambiguous.outlets[0]).not.toHaveProperty("longitude");
  });
  it("ships each visited account's Annex C call sheet once; an office edit forces a fresh snapshot", async () => {
    const f = await fixture();
    const empty = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(empty.callSheets).toEqual([]);
    const ids = await f.t.run(async (ctx) => {
      const product = (code: string, active: boolean) =>
        ctx.db.insert("products", {
          code,
          name: `Product ${code}`,
          category: "canned",
          uom: "CAN",
          unitPrice: 0,
          active,
          updatedAt: f.now,
        });
      const active = await product("SUNP-001", true);
      const retired = await product("HOL-OLD", false);
      const uom = await ctx.db.insert("unitsOfMeasure", {
        organizationId: "sunpride",
        code: "CAN",
        name: "Can",
        dimension: "count",
        decimalPlaces: 0,
        active: true,
        createdAt: f.now,
        updatedAt: f.now,
      });
      await ctx.db.insert("productBarcodes", {
        organizationId: "sunpride",
        productId: active,
        barcode: "4800000000017",
        uomId: uom,
        active: true,
        source: "fixture",
        createdAt: f.now,
        updatedAt: f.now,
      });
      // A second planned day at the same outlet must not duplicate the sheet.
      await ctx.db.insert("plannedVisits", {
        generationKey: "tomorrow",
        planId: f.ids.plan,
        planVersion: 1,
        planSlotId: f.ids.slot,
        assigneeProfileId: f.ids.person,
        outletId: f.ids.outlet,
        serviceDate: manilaDate(f.now + 86_400_000),
        status: "planned",
        approvedSnapshot: f.ids.snapshot,
        requiredObjectives: [],
        intents: ["sell"],
        expectedDurationMinutes: 30,
        generatedAt: f.now,
      });
      const account = await ctx.db.insert("callSheetAccounts", {
        organizationId: "sunpride",
        outletId: f.ids.outlet,
        revision: 1,
        header: { accountName: "Signed outlet", buyerName: "A. Buyer" },
        lines: [
          { productId: active, pricing: "₱189.00" },
          { productId: retired },
        ],
        updatedAt: f.now,
        updatedBy: "fixture",
      });
      return { active, account };
    });
    const first = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      limit: 1,
    });
    expect(first.callSheets).toEqual([
      {
        outletId: f.ids.outlet,
        revision: 1,
        header: {
          accountName: "Signed outlet",
          address: null,
          buyerName: "A. Buyer",
          contactNumber: null,
          accountInCharge: null,
          receivingInCharge: null,
          distributorName: null,
          distributorSchedule: null,
          foc: null,
          pricing: null,
        },
        lines: [
          {
            productId: ids.active,
            code: "SUNP-001",
            name: "Product SUNP-001",
            uom: "CAN",
            barcode: "4800000000017",
            pricing: "₱189.00",
          },
        ],
      },
    ]);
    const all = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(all.plannedVisits).toHaveLength(2);
    expect(all.callSheets).toHaveLength(1);
    await f.t.run((ctx) =>
      ctx.db.patch(ids.account, {
        revision: 2,
        header: { accountName: "Renamed account" },
        updatedAt: f.now + 1,
      }),
    );
    await expect(
      f.caller.query(internal.mobile.bootstrap.snapshot, {
        actor: f.actor,
        pageCursor: first.nextPageCursor!,
        limit: 1,
      }),
    ).rejects.toThrow("rebootstrap_required");
  });
  it("SP-0129: ships the outlet's channel price list and promotions on every page", async () => {
    const f = await fixture();
    const productId = await f.t.run(async (ctx) => {
      await ctx.db.patch(f.ids.outlet, { channel: "Route Sales" });
      await ctx.db.insert("plannedVisits", {
        generationKey: "second-stop-priced",
        planId: f.ids.plan,
        planVersion: 1,
        planSlotId: f.ids.slot,
        assigneeProfileId: f.ids.person,
        outletId: f.ids.outlet,
        serviceDate: f.day,
        status: "planned",
        approvedSnapshot: f.ids.snapshot,
        requiredObjectives: [],
        intents: [],
        expectedDurationMinutes: 15,
        generatedAt: f.now,
      });
      const uom = await ctx.db.insert("unitsOfMeasure", {
        organizationId: "sunpride",
        code: "PC",
        name: "Piece",
        dimension: "count",
        decimalPlaces: 0,
        active: true,
        createdAt: f.now,
        updatedAt: f.now,
      });
      const product = await ctx.db.insert("products", {
        code: "PRICED",
        name: "Priced",
        category: "C",
        uom: "PC",
        unitPrice: 0,
        active: true,
        updatedAt: f.now,
      });
      const list = await ctx.db.insert("priceLists", {
        organizationId: "sunpride",
        code: "PL-RS",
        name: "Route Sales",
        channel: "ROUTE_SALES",
        currency: "PHP",
        vatInclusive: true,
        status: "active",
        source: "office",
        createdAt: f.now,
        updatedAt: f.now,
      });
      await ctx.db.insert("priceListLines", {
        organizationId: "sunpride",
        priceListId: list,
        productId: product,
        uomId: uom,
        unitPriceMinor: 4_650n,
        effectiveFrom: f.now - 1_000,
        actorSubject: "office",
        createdAt: f.now,
      });
      await ctx.db.insert("promotions", {
        organizationId: "sunpride",
        code: "B10G1",
        name: "Buy 10 get 1",
        rule: {
          kind: "buy_x_get_y",
          buy: { productId: product, uomId: uom, quantity: 10 },
          free: { productId: product, uomId: uom, quantity: 1 },
        },
        status: "active",
        source: "office",
        effectiveFrom: f.now - 1_000,
        createdAt: f.now,
        updatedAt: f.now,
      });
      return product;
    });
    const first = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      limit: 1,
    });
    expect(first.nextPageCursor).toBeTruthy();
    expect(first.pricing).toMatchObject({
      priceLists: [
        {
          code: "PL-RS",
          currency: "PHP",
          vatInclusive: true,
          lines: [{ productId, uomCode: "PC", unitPriceMinor: 4650 }],
        },
      ],
      outletPriceLists: [{ outletId: f.ids.outlet }],
      promotions: [{ code: "B10G1", rule: { kind: "buy_x_get_y" } }],
    });
    const second = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      pageCursor: first.nextPageCursor!,
      limit: 1,
    });
    expect(second.pricing).toEqual(first.pricing);
  });
  it("ships the activity-form rules on every page; an office rule change restarts a download", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.insert("plannedVisits", {
        generationKey: "second-stop",
        planId: f.ids.plan,
        planVersion: 1,
        planSlotId: f.ids.slot,
        assigneeProfileId: f.ids.person,
        outletId: f.ids.outlet,
        serviceDate: f.day,
        status: "planned",
        approvedSnapshot: f.ids.snapshot,
        requiredObjectives: [],
        intents: ["merchandise", "complaint"],
        expectedDurationMinutes: 15,
        generatedAt: f.now,
      }),
    );
    const first = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      limit: 1,
    });
    expect(first.nextPageCursor).toBeTruthy();
    expect(first.activityRules.map((r) => r.intent)).toEqual([
      ...VISIT_INTENTS,
    ]);
    expect(first.activityRules.find((r) => r.intent === "merchandise")).toEqual(
      {
        intent: "merchandise",
        version: DEFAULT_ACTIVITY_RULE_VERSION,
        activities: [
          { kind: "merchandising", required: true },
          { kind: "price_check", required: false },
        ],
      },
    );
    // Office-only provenance never reaches the phone.
    expect(JSON.stringify(first.activityRules)).not.toContain("sourceRef");
    const second = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      pageCursor: first.nextPageCursor!,
      limit: 1,
    });
    expect(second.activityRules).toEqual(first.activityRules);
    // AND-016: every page carries the same configured photo types, codes and labels only.
    expect(first.photoTypes).toEqual(
      EVIDENCE_PHOTO_TYPES.map(({ code, label }) => ({ code, label })),
    );
    expect(second.photoTypes).toEqual(first.photoTypes);
    await f.t.run((ctx) =>
      ctx.db.insert("visitActivityRules", {
        organizationId: "sunpride",
        intent: "complaint",
        activities: [{ kind: "note", required: false }],
        effectiveFrom: f.now - 1,
        sourceRef: "Office",
        provisional: false,
        actorSubject: "fixture",
        createdAt: f.now,
      }),
    );
    await expect(
      f.caller.query(internal.mobile.bootstrap.snapshot, {
        actor: f.actor,
        pageCursor: first.nextPageCursor!,
        limit: 1,
      }),
    ).rejects.toThrow("rebootstrap_required");
  });
  it("does not expose cancelled predecessor visits while retaining the active day", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.insert("plannedVisits", {
        generationKey: "cancelled",
        planId: f.ids.plan,
        planVersion: 1,
        planSlotId: f.ids.slot,
        assigneeProfileId: f.ids.person,
        outletId: f.ids.outlet,
        serviceDate: f.day,
        status: "cancelled",
        approvedSnapshot: f.ids.snapshot,
        requiredObjectives: [],
        intents: [],
        expectedDurationMinutes: 15,
        generatedAt: f.now,
        cancelledAt: f.now,
        cancellationReason: "superseded",
      }),
    );
    const day = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    expect(day.plannedVisits.map((v) => v.id)).toEqual([f.ids.visit]);
  });
  it("exhausts pages without issuing a sync cursor early, rejects changed assignments mid-page", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 3; i++)
        await ctx.db.insert("plannedVisits", {
          generationKey: `extra-${i}`,
          planId: f.ids.plan,
          planVersion: 1,
          planSlotId: f.ids.slot,
          assigneeProfileId: f.ids.person,
          outletId: f.ids.outlet,
          serviceDate: f.day,
          status: "planned",
          approvedSnapshot: f.ids.snapshot,
          requiredObjectives: [],
          intents: [],
          expectedDurationMinutes: 15,
          generatedAt: f.now,
        });
    });
    let r = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      limit: 1,
    });
    let count = 0;
    while (r.nextPageCursor) {
      expect(r.syncCursor).toBeNull();
      count += r.plannedVisits.length;
      r = await f.caller.query(internal.mobile.bootstrap.snapshot, {
        actor: f.actor,
        pageCursor: r.nextPageCursor,
        limit: 1,
      });
    }
    expect(count + r.plannedVisits.length).toBe(4);
    expect(r.syncCursor).toBeTruthy();
    const first = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      limit: 1,
    });
    await f.t.run((ctx) =>
      ctx.db.patch(f.ids.outletAssignment, { routeId: undefined, sequence: 9 }),
    );
    await expect(
      f.caller.query(internal.mobile.bootstrap.snapshot, {
        actor: f.actor,
        pageCursor: first.nextPageCursor!,
        limit: 1,
      }),
    ).rejects.toThrow("rebootstrap_required");
  });
  it("rejects a forged foreign person or wrong day and Manila midnight continuation", async () => {
    const f = await fixture();
    await expect(
      f.caller.query(internal.mobile.bootstrap.snapshot, {
        actor: { ...f.actor, profileId: f.ids.stranger },
      }),
    ).rejects.toThrow();
    await expect(
      f.caller.query(internal.mobile.bootstrap.snapshot, {
        actor: f.actor,
        dayFrom: "2000-01-01",
      }),
    ).rejects.toThrow("invalid_request");
    const first = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
    });
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(`${f.day}T16:00:01Z`));
    await expect(
      f.caller.query(internal.mobile.pull.delta, {
        actor: f.actor,
        cursor: first.syncCursor!,
      }),
    ).rejects.toThrow("rebootstrap_required");
  });
});
