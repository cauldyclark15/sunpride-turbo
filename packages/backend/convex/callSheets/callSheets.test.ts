import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import type { AuthorizedDevice } from "../mobile/types";
import { applyVisitOperation } from "../visits/commands";
import { callSheetWeek } from "./model";
import type { CallSheetCaptureLine } from "./validators";

// 2026-09-28 12:00 Manila: day 28 of the month falls in Annex C week 4.
const now = Date.parse("2026-09-28T04:00:00Z");
const serviceDate = "2026-09-28";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type T = TestConvex<typeof schema>;
type Role = "sales" | "manager" | "admin" | "operations";

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const t: T = convexTest(schema, modules);
  const since = now - 10e7;
  const ids = await t.run(async (ctx) => {
    const unit = await ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      code: "SUNPRIDE",
      name: "National",
      typeCode: "NATIONAL",
      status: "active",
      effectiveFrom: since,
      createdAt: now,
      updatedAt: now,
    });
    const region = await ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      code: "NORTH",
      name: "North",
      typeCode: "REGION",
      parentId: unit,
      status: "active",
      effectiveFrom: since,
      createdAt: now,
      updatedAt: now,
    });
    const person = async (
      subject: string,
      role: Role,
      orgUnitId: Id<"orgUnits">,
    ) => {
      const id = await ctx.db.insert("profiles", {
        authSubject: `https://auth.test|${subject}`,
        name: subject,
        email: `${subject}@test.local`,
        role,
        status: "active",
        orgUnitId,
        updatedAt: now,
      });
      await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId,
        role,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: now,
      });
      return id;
    };
    const sales = await person("sales", "sales", unit);
    await person("admin", "admin", unit);
    await person("ops", "operations", unit);
    await person("manager", "manager", unit);
    await person("north", "manager", region);
    const territory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "T",
      name: "Territory",
      status: "active",
      effectiveFrom: since,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    await ctx.db.insert("territoryOwnerships", {
      territoryId: territory,
      orgUnitId: unit,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    await ctx.db.insert("territorySalespeople", {
      territoryId: territory,
      profileId: sales,
      kind: "primary",
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    const outlet = await ctx.db.insert("outlets", {
      organizationId: "sunpride",
      code: "PG-001",
      name: "Puregold Example",
      address: "12 Sample St",
      status: "active",
      custodianOrgUnitId: unit,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    await ctx.db.insert("outletAssignments", {
      outletId: outlet,
      territoryId: territory,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    await ctx.db.insert("outletPins", {
      outletId: outlet,
      latitude: 14.6,
      longitude: 121,
      radiusMeters: 75,
      source: "field",
      status: "verified",
      effectiveFrom: since,
      proposedBy: "fixture",
      proposedAt: now,
      verifiedBy: "fixture",
      verifiedAt: now,
      createdAt: now,
    });
    const product = (code: string, active = true) =>
      ctx.db.insert("products", {
        code,
        name: `Product ${code}`,
        category: "canned",
        uom: "CAN",
        unitPrice: 0,
        active,
        updatedAt: now,
      });
    const hotdog = await product("SUNP-001");
    const corned = await product("HOL-010");
    const extra = await product("SLAP-200");
    const retired = await product("HOL-OLD", false);
    const device = await ctx.db.insert("registeredDevices", {
      organizationId: "sunpride",
      orgUnitId: unit,
      inventoryTag: "D1",
      profileId: sales,
      boundSubject: "https://auth.test|sales",
      allowedApp: "ANDROID",
      platform: "android",
      model: "test",
      osVersion: "1",
      appVersion: "1",
      registeredAt: now,
      status: "active",
    });
    return {
      unit,
      sales,
      outlet,
      hotdog,
      corned,
      extra,
      retired,
      device,
    };
  });
  const as = (subject: string) =>
    t.withIdentity({
      issuer: "https://auth.test",
      subject,
      email: `${subject}@test.local`,
    });
  const actor: AuthorizedDevice = {
    deviceId: ids.device,
    profileId: ids.sales,
    subject: "https://auth.test|sales",
    orgUnitId: ids.unit,
    role: "sales",
    scopeFingerprint: "fixture",
  };
  const apply = (operation: Parameters<typeof applyVisitOperation>[2]) =>
    as("sales").run((ctx) => applyVisitOperation(ctx, actor, operation));
  const checkIn = async (n = 1) =>
    (
      await apply({
        kind: "visit.checkIn",
        clientRequestId: uuid(n),
        payload: {
          clientVisitId: uuid(n + 100),
          plannedVisitId: null,
          outletId: ids.outlet,
          serviceDate,
          deviceTime: now,
          location: {
            latitude: 14.6,
            longitude: 121,
            accuracyMeters: 5,
            provider: "gps",
            fixTime: now,
          },
          intents: ["sell"],
          unplannedReason: "urgent_follow_up",
        },
      })
    ).entityId as Id<"visitExecutions">;
  const capture = (
    n: number,
    visitId: Id<"visitExecutions">,
    lines: CallSheetCaptureLine[],
  ) =>
    apply({
      kind: "visit.activity",
      clientRequestId: uuid(n),
      payload: {
        visitId,
        activity: { kind: "call_sheet", lines },
        deviceTime: now,
      },
    });
  const line = (
    productId: Id<"products">,
    values: Partial<Omit<CallSheetCaptureLine, "productId">>,
  ): CallSheetCaptureLine => ({
    productId,
    order: null,
    beginningInventory: null,
    take: null,
    delivered: null,
    offtake: null,
    endInventory: null,
    ...values,
  });
  const header = {
    accountName: "  Puregold Example  ",
    buyerName: "A. Buyer",
    contactNumber: "0917 000 0000",
    distributorName: "Example Distributor",
    distributorSchedule: "Tue/Fri",
    foc: "",
  };
  const saveAccount = (
    subject = "ops",
    expectedRevision: number | null = null,
  ) =>
    as(subject).mutation(api.callSheets.accounts.save, {
      outletId: ids.outlet,
      expectedRevision,
      header,
      lines: [
        { productId: ids.hotdog, pricing: "₱189.00" },
        { productId: ids.corned },
      ],
    });
  return { t, ids, as, apply, checkIn, capture, line, saveAccount, header };
}

afterEach(() => vi.useRealTimers());

describe("Annex C week of month", () => {
  it.each([
    ["2026-10-01", 1],
    ["2026-10-07", 1],
    ["2026-10-08", 2],
    ["2026-10-21", 3],
    ["2026-10-22", 4],
    ["2026-10-31", 4],
    ["2026-02-28", 4],
  ])("%s is week %i", (date, week) => {
    expect(callSheetWeek(date)).toEqual({ localMonth: date.slice(0, 7), week });
  });
  it("rejects an impossible date", () => {
    expect(() => callSheetWeek("2026-02-30")).toThrow();
  });
});

describe("call sheet accounts", () => {
  it("lets outlet managers keep the header and product rows with optimistic revisions", async () => {
    const f = await fixture();
    expect(await f.saveAccount()).toEqual({ revision: 1 });
    const detail = await f.as("manager").query(api.callSheets.accounts.detail, {
      outletId: f.ids.outlet,
    });
    expect(detail.canEdit).toBe(false);
    expect(detail.outlet).toMatchObject({
      code: "PG-001",
      address: "12 Sample St",
    });
    expect(detail.account).toMatchObject({
      revision: 1,
      header: {
        accountName: "Puregold Example",
        buyerName: "A. Buyer",
        foc: null,
        address: null,
      },
      lines: [
        {
          productId: f.ids.hotdog,
          code: "SUNP-001",
          pricing: "₱189.00",
          active: true,
        },
        {
          productId: f.ids.corned,
          code: "HOL-010",
          pricing: null,
          active: true,
        },
      ],
    });
    expect(
      (
        await f.as("admin").query(api.callSheets.accounts.detail, {
          outletId: f.ids.outlet,
        })
      ).canEdit,
    ).toBe(true);
    // A stale editor cannot overwrite a newer revision.
    await expect(f.saveAccount("admin", null)).rejects.toThrow("changed since");
    expect(await f.saveAccount("admin", 1)).toEqual({ revision: 2 });
    const audits = await f.t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "outlet").eq("entityId", f.ids.outlet),
        )
        .collect(),
    );
    expect(audits.map((a) => a.action)).toEqual([
      "call_sheet.account_created",
      "call_sheet.account_updated",
    ]);
  });

  it("refuses sales, managers, blank names, duplicates, inactive products and oversized text", async () => {
    const f = await fixture();
    for (const subject of ["sales", "manager"])
      await expect(f.saveAccount(subject)).rejects.toThrow();
    const save = (
      header: typeof f.header & { accountName: string },
      lines: { productId: Id<"products">; pricing?: string }[],
    ) =>
      f.as("ops").mutation(api.callSheets.accounts.save, {
        outletId: f.ids.outlet,
        expectedRevision: null,
        header,
        lines,
      });
    await expect(
      save({ ...f.header, accountName: "  " }, [{ productId: f.ids.hotdog }]),
    ).rejects.toThrow("Account name required");
    await expect(
      save(f.header, [
        { productId: f.ids.hotdog },
        { productId: f.ids.hotdog },
      ]),
    ).rejects.toThrow("once");
    await expect(
      save(f.header, [{ productId: f.ids.retired }]),
    ).rejects.toThrow("inactive");
    await expect(
      save({ ...f.header, buyerName: "x".repeat(201) }, []),
    ).rejects.toThrow("too long");
    expect(
      await f.t.run((ctx) => ctx.db.query("callSheetAccounts").collect()),
    ).toEqual([]);
  });

  it("lists, finds and searches only within the caller's scope", async () => {
    const f = await fixture();
    await f.saveAccount();
    const page = await f.as("manager").query(api.callSheets.accounts.list, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page).toMatchObject([
      { outletCode: "PG-001", accountName: "Puregold Example", lineCount: 2 },
    ]);
    const north = await f.as("north").query(api.callSheets.accounts.list, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(north.page).toEqual([]);
    expect(
      await f.as("north").query(api.callSheets.accounts.outletByCode, {
        code: "pg-001",
      }),
    ).toBeNull();
    expect(
      await f.as("manager").query(api.callSheets.accounts.outletByCode, {
        code: "pg-001",
      }),
    ).toMatchObject({ id: f.ids.outlet, name: "Puregold Example" });
    await expect(
      f.as("north").query(api.callSheets.accounts.detail, {
        outletId: f.ids.outlet,
      }),
    ).rejects.toThrow();
    expect(
      (
        await f.as("ops").query(api.callSheets.accounts.productSearch, {
          prefix: "hol",
        })
      ).map((p) => p.code),
    ).toEqual(["HOL-010"]);
    await expect(
      f.as("manager").query(api.callSheets.accounts.productSearch, {
        prefix: "hol",
      }),
    ).rejects.toThrow();
  });
});

describe("call sheet capture and month report", () => {
  it("rejects a capture for an account without a sheet and malformed lines", async () => {
    const f = await fixture();
    const visitId = await f.checkIn();
    await expect(
      f.capture(2, visitId, [f.line(f.ids.hotdog, { order: 1 })]),
    ).rejects.toThrow("invalid_request");
    await f.saveAccount();
    for (const [n, lines] of [
      [3, []],
      [4, [f.line(f.ids.hotdog, {})]],
      [5, [f.line(f.ids.hotdog, { order: -1 })]],
      [6, [f.line(f.ids.hotdog, { order: 1.5 })]],
      [7, [f.line(f.ids.hotdog, { order: 1_000_001 })]],
      [
        8,
        [f.line(f.ids.hotdog, { order: 1 }), f.line(f.ids.hotdog, { take: 1 })],
      ],
      [9, [f.line(f.ids.retired, { order: 1 })]],
    ] as const)
      await expect(f.capture(n, visitId, [...lines])).rejects.toThrow(
        "invalid_request",
      );
    expect(
      await f.t.run((ctx) => ctx.db.query("callSheetEntries").collect()),
    ).toEqual([]);
  });

  it("records each row in the visit's week and merges later captures cell by cell", async () => {
    const f = await fixture();
    await f.saveAccount();
    const visitId = await f.checkIn();
    const ack = await f.capture(2, visitId, [
      f.line(f.ids.hotdog, {
        beginningInventory: 10,
        endInventory: 8,
        offtake: 26,
      }),
      f.line(f.ids.corned, { order: 12 }),
    ]);
    // A later save the same week corrects one cell and adds the order; blanks keep prior values.
    await f.capture(3, visitId, [
      f.line(f.ids.hotdog, { order: 24, delivered: 24, endInventory: 6 }),
      // Captured although not on the office sheet (sheet edited during the day).
      f.line(f.ids.extra, { take: 3 }),
    ]);
    const rows = await f.t.run(async (ctx) => ({
      entries: await ctx.db.query("callSheetEntries").collect(),
      activity: await ctx.db.get(ack.entityId as Id<"visitActivities">),
      events: await ctx.db.query("executionEvents").collect(),
      visit: await ctx.db.get(visitId),
    }));
    expect(rows.entries).toHaveLength(4);
    expect(rows.entries[0]).toMatchObject({
      outletId: f.ids.outlet,
      visitId,
      localMonth: "2026-09",
      week: 4,
      serviceDate,
      templateRevision: 1,
      productId: f.ids.hotdog,
      order: null,
      beginningInventory: 10,
    });
    expect(rows.activity?.activity.kind).toBe("call_sheet");
    expect(rows.visit?.state).toBe("in-progress");
    expect(rows.events.map((e) => e.kind)).toContain("activity.call_sheet");

    const report = await f.as("manager").query(api.callSheets.report.month, {
      outletId: f.ids.outlet,
      localMonth: "2026-09",
    });
    expect(report.configured).toBe(true);
    expect(report.header.accountName).toBe("Puregold Example");
    expect(report.capturedVisits).toBe(1);
    expect(report.rows.map((r) => [r.code, r.onSheet])).toEqual([
      ["SUNP-001", true],
      ["HOL-010", true],
      ["SLAP-200", false],
    ]);
    expect(report.rows[0]!.weeks.map((w) => w.week)).toEqual([1, 2, 3, 4]);
    expect(report.rows[0]!.weeks[0]).toMatchObject({
      order: null,
      endInventory: null,
    });
    expect(report.rows[0]!.weeks[3]).toEqual({
      week: 4,
      order: 24,
      beginningInventory: 10,
      take: null,
      delivered: 24,
      offtake: 26,
      endInventory: 6,
    });
    expect(report.rows[0]!.pricing).toBe("₱189.00");
    expect(report.rows[1]!.weeks[3]!.order).toBe(12);
    expect(report.rows[2]!.weeks[3]!.take).toBe(3);

    const other = await f.as("manager").query(api.callSheets.report.month, {
      outletId: f.ids.outlet,
      localMonth: "2026-08",
    });
    expect(other.capturedVisits).toBe(0);
    expect(
      other.rows.every((r) => r.weeks.every((w) => w.order === null)),
    ).toBe(true);
  });

  it("serves an unconfigured account from outlet details and enforces scope and month format", async () => {
    const f = await fixture();
    const report = await f.as("sales").query(api.callSheets.report.month, {
      outletId: f.ids.outlet,
      localMonth: "2026-09",
    });
    expect(report).toMatchObject({
      configured: false,
      revision: null,
      rows: [],
      header: { accountName: "Puregold Example", address: "12 Sample St" },
    });
    await expect(
      f.as("north").query(api.callSheets.report.month, {
        outletId: f.ids.outlet,
        localMonth: "2026-09",
      }),
    ).rejects.toThrow();
    await expect(
      f.as("manager").query(api.callSheets.report.month, {
        outletId: f.ids.outlet,
        localMonth: "2026-13",
      }),
    ).rejects.toThrow();
  });
});
