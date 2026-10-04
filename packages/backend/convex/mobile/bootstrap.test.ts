/* Convex runtime secret is not a Turborepo build input. */
/* eslint-disable turbo/no-undeclared-env-vars */
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";
import { manilaDate } from "../coverage/validation";
import { nextDayCloseAt } from "../visits/policy";
import type { AuthorizedDevice } from "./types";

const SECRET = "test-only-mobile-cursor-secret-32-bytes-long";
process.env.MOBILE_CURSOR_SECRET = SECRET;
export async function fixture() {
  const t: TestConvex<typeof schema> = convexTest(schema, modules);
  const now = Date.now();
  const day = manilaDate(now);
  const subject = "https://auth.fixture|sales";
  const ids = await t.run(async (ctx) => {
    const unit = await ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
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
