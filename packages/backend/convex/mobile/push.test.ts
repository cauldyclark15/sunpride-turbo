import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FunctionArgs } from "convex/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { manilaDate } from "../coverage/validation";
import type { AuthorizedDevice } from "./types";

const now = Date.parse("2026-09-28T04:00:00Z");
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type T = TestConvex<typeof schema>;
afterEach(() => vi.useRealTimers());
async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const t: T = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const unit = await ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      code: "SUNPRIDE",
      name: "National",
      typeCode: "NATIONAL",
      status: "active",
      effectiveFrom: now - 1000000,
      createdAt: now,
      updatedAt: now,
    });
    const position = await ctx.db.insert("positions", {
      organizationId: "sunpride",
      code: "FIELD",
      label: "Field",
      category: "field",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    const addPerson = async (name: string) => {
      const profile = await ctx.db.insert("profiles", {
        authSubject: `https://auth.test|${name}`,
        name,
        email: `${name}@test.local`,
        role: "sales",
        status: "active",
        orgUnitId: unit,
        updatedAt: now,
      });
      await ctx.db.insert("employeeAssignments", {
        profileId: profile,
        orgUnitId: unit,
        role: "sales",
        positionId: position,
        effectiveFrom: now - 1000000,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: now,
      });
      return profile;
    };
    const profile = await addPerson("sales"),
      other = await addPerson("other");
    const territory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "T",
      name: "Territory",
      status: "active",
      effectiveFrom: now - 1000000,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    await ctx.db.insert("territoryOwnerships", {
      territoryId: territory,
      orgUnitId: unit,
      effectiveFrom: now - 1000000,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    await ctx.db.insert("territorySalespeople", {
      territoryId: territory,
      profileId: profile,
      kind: "primary",
      effectiveFrom: now - 1000000,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    const outlet = await ctx.db.insert("outlets", {
      organizationId: "sunpride",
      code: "O",
      name: "Prospect",
      status: "active",
      custodianOrgUnitId: unit,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    await ctx.db.insert("outletAssignments", {
      outletId: outlet,
      territoryId: territory,
      effectiveFrom: now - 1000000,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    const addDevice = (person: Id<"profiles">, tag: string) =>
      ctx.db.insert("registeredDevices", {
        organizationId: "sunpride",
        orgUnitId: unit,
        inventoryTag: tag,
        profileId: person,
        boundSubject: `https://auth.test|${tag === "D1" ? "sales" : "other"}`,
        allowedApp: "ANDROID",
        platform: "android",
        model: "test",
        osVersion: "1",
        appVersion: "1",
        publicKey: "key",
        credentialId: tag,
        registeredAt: now,
        status: "active",
      });
    const device = await addDevice(profile, "D1"),
      otherDevice = await addDevice(other, "D2");
    return { unit, profile, other, outlet, device, otherDevice };
  });
  const actor: AuthorizedDevice = {
    deviceId: ids.device,
    profileId: ids.profile,
    orgUnitId: ids.unit,
    role: "sales",
    subject: "https://auth.test|sales",
    scopeFingerprint: "fixture",
  };
  const sales = t.withIdentity({
    subject: "sales",
    issuer: "https://auth.test",
    tokenIdentifier: actor.subject,
  });
  const other = t.withIdentity({
    subject: "other",
    issuer: "https://auth.test",
    tokenIdentifier: "https://auth.test|other",
  });
  const check = (n: number) => ({
    kind: "visit.checkIn" as const,
    clientRequestId: uuid(n),
    payload: {
      clientVisitId: uuid(100 + n),
      plannedVisitId: null,
      outletId: ids.outlet,
      serviceDate: manilaDate(now),
      deviceTime: now,
      location: null,
      intents: ["sell" as const],
      unplannedReason: "Prospect call",
    },
  });
  const apply = (
    op: FunctionArgs<typeof internal.mobile.push.applyOne>["operation"],
  ) =>
    sales.mutation(internal.mobile.push.applyOne, {
      deviceId: ids.device,
      actor,
      operation: op,
    });
  const counts = () =>
    t.run(async (ctx) =>
      Promise.all(
        [
          "visitExecutions",
          "visitActivities",
          "executionEvents",
          "mobileChanges",
          "processedMobileOperations",
        ].map(
          async (name) =>
            (await ctx.db.query(name as "visitExecutions").collect()).length,
        ),
      ),
    );
  return { t, ids, actor, sales, other, check, apply, counts };
}

describe("ordered push", () => {
  it("replays a batch across calls and clock advance without new domain/event/change rows", async () => {
    const f = await fixture();
    const first = f.check(1);
    const check = await f.apply(first);
    expect(check.status).toBe("accepted");
    if (check.status !== "accepted") throw new Error("not accepted");
    const activity = {
      kind: "visit.activity" as const,
      clientRequestId: uuid(2),
      dependsOn: [first.clientRequestId],
      payload: {
        visitId: check.ack.entityId as Id<"visitExecutions">,
        activity: { kind: "note" as const, text: "Visited" },
        deviceTime: now,
      },
    };
    const a = await f.apply(activity);
    const out = {
      kind: "visit.checkOut" as const,
      clientRequestId: uuid(3),
      dependsOn: [activity.clientRequestId],
      payload: {
        visitId: check.ack.entityId as Id<"visitExecutions">,
        outcome: "completed" as const,
        reasonCode: null,
        deviceTime: now,
        location: null,
      },
    };
    const b = await f.apply(out);
    const counts = await f.counts();
    vi.setSystemTime(now + 1000);
    expect(await f.apply(first)).toEqual(check);
    expect(await f.apply(activity)).toEqual(a);
    expect(await f.apply(out)).toEqual(b);
    expect(await f.counts()).toEqual(counts);
    expect(counts).toEqual([1, 1, 3, 3, 3]);
  });
  it("conflicts on changed payload or different device, and concurrent same-key calls commit once", async () => {
    const f = await fixture();
    const op = f.check(4);
    const [one, two] = await Promise.all([f.apply(op), f.apply(op)]);
    expect(one).toEqual(two);
    const before = await f.counts();
    expect(
      await f.apply({
        ...op,
        payload: { ...op.payload, unplannedReason: "Changed" },
      }),
    ).toEqual({ status: "conflict", code: "conflict" });
    expect(
      await f.other.mutation(internal.mobile.push.applyOne, {
        deviceId: f.ids.otherDevice,
        actor: {
          ...f.actor,
          deviceId: f.ids.otherDevice,
          profileId: f.ids.other,
          subject: "https://auth.test|other",
        },
        operation: op,
      }),
    ).toEqual({ status: "conflict", code: "conflict" });
    expect(await f.counts()).toEqual(before);
  });
  it("rejects missing dependency and unsupported middle item without consuming keys; later independent operation works", async () => {
    const f = await fixture();
    expect(await f.apply({ ...f.check(5), dependsOn: [uuid(99)] })).toEqual({
      status: "rejected",
      code: "dependency_missing",
    });
    expect(
      await f.apply({
        kind: "task.complete",
        clientRequestId: uuid(6),
        payload: {},
      }),
    ).toEqual({ status: "rejected", code: "unsupported_operation" });
    expect((await f.apply(f.check(5))).status).toBe("accepted");
    expect((await f.apply(f.check(7))).status).toBe("accepted");
    expect(await f.counts()).toEqual([2, 0, 2, 2, 2]);
  });
  it("rolls back a domain-rejected check-in and leaves its key available", async () => {
    const f = await fixture();
    const op = f.check(11);
    const payload = { ...op.payload };
    delete (payload as { unplannedReason?: string }).unplannedReason;
    await expect(f.apply({ ...op, payload })).rejects.toThrow(
      /invalid_request/,
    );
    expect(await f.counts()).toEqual([0, 0, 0, 0, 0]);
    expect((await f.apply(op)).status).toBe("accepted");
    expect(await f.counts()).toEqual([1, 0, 1, 1, 1]);
  });
  it("rejects replaced planned visits before consuming the operation key", async () => {
    const f = await fixture();
    const plannedVisitId = await f.t.run(async (ctx) => {
      const assignment = await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", f.ids.profile),
        )
        .first();
      const outletAssignment = await ctx.db
        .query("outletAssignments")
        .withIndex("by_outletId_and_effectiveFrom", (q) =>
          q.eq("outletId", f.ids.outlet),
        )
        .first();
      const territory = (await ctx.db.get(outletAssignment!.territoryId))!;
      const ownership = await ctx.db
        .query("territoryOwnerships")
        .withIndex("by_territoryId_and_effectiveFrom", (q) =>
          q.eq("territoryId", territory._id),
        )
        .first();
      const snapshot = {
        outletId: f.ids.outlet,
        outletCode: "O",
        outletName: "Prospect",
        territoryId: territory._id,
        territoryCode: "T",
        outletAssignmentId: outletAssignment!._id,
        territoryOwnershipId: ownership!._id,
        employeeAssignmentId: assignment!._id,
        orgUnitId: f.ids.unit,
        activityKind: "sell",
        approvedAssigneeProfileId: f.ids.profile,
      };
      const plan = await ctx.db.insert("coveragePlans", {
        organizationId: "sunpride",
        assigneeProfileId: f.ids.profile,
        localMonth: "2026-09",
        version: 1,
        cycleType: "monthly",
        orgUnitId: f.ids.unit,
        territoryIds: [territory._id],
        requestedFrom: now - 1000000,
        requestedTo: now + 1000000,
        effectiveFrom: now - 1000000,
        effectiveTo: now + 1000000,
        status: "active",
        preparedBy: f.actor.subject,
        preparedAt: now,
        approvedBy: f.actor.subject,
        approvedAt: now,
        approvalSignature: "signed",
        contentRevision: 1,
        createdBy: f.actor.subject,
        createdAt: now,
        updatedBy: f.actor.subject,
        updatedAt: now,
      });
      const slot = await ctx.db.insert("coveragePlanSlots", {
        slotKey: "first",
        planId: plan,
        assigneeProfileId: f.ids.profile,
        serviceDate: manilaDate(now),
        kind: "outlet_visit",
        outletId: f.ids.outlet,
        activityKind: "sell",
        requiredObjectives: [],
        intents: ["sell"],
        sequence: 1,
        expectedDurationMinutes: 20,
        approvedSnapshot: snapshot,
        contentRevision: 1,
        updatedBy: f.actor.subject,
        updatedAt: now,
      });
      return ctx.db.insert("plannedVisits", {
        generationKey: "signed",
        planId: plan,
        planVersion: 1,
        planSlotId: slot,
        assigneeProfileId: f.ids.profile,
        outletId: f.ids.outlet,
        serviceDate: manilaDate(now),
        status: "cancelled",
        approvedSnapshot: snapshot,
        requiredObjectives: [],
        intents: ["sell"],
        expectedDurationMinutes: 20,
        generatedAt: now,
      });
    });
    await expect(
      f.apply({
        ...f.check(10),
        payload: { ...f.check(10).payload, plannedVisitId, intents: ["sell"] },
      }),
    ).rejects.toThrow(/invalid_plan/);
    expect(await f.counts()).toEqual([0, 0, 0, 0, 0]);
  });
  it("denies revoked devices, retired assignment and another person's visit before replay lookup", async () => {
    const f = await fixture();
    const op = f.check(8);
    const ack = await f.apply(op);
    if (ack.status !== "accepted") throw new Error("not accepted");
    const foreign = {
      kind: "visit.activity" as const,
      clientRequestId: uuid(9),
      payload: {
        visitId: ack.ack.entityId as Id<"visitExecutions">,
        activity: { kind: "note" as const, text: "wrong owner" },
        deviceTime: now,
      },
    };
    await expect(
      f.other.mutation(internal.mobile.push.applyOne, {
        deviceId: f.ids.otherDevice,
        actor: {
          ...f.actor,
          deviceId: f.ids.otherDevice,
          profileId: f.ids.other,
          subject: "https://auth.test|other",
        },
        operation: foreign,
      }),
    ).rejects.toThrow();
    await f.t.run((ctx) => ctx.db.patch(f.ids.device, { status: "revoked" }));
    await expect(f.apply(op)).rejects.toThrow();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.ids.device, { status: "active" });
      const assignment = await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", f.ids.profile),
        )
        .first();
      await ctx.db.patch(assignment!._id, { effectiveTo: now });
    });
    await expect(f.apply(op)).rejects.toThrow();
    expect(await f.counts()).toEqual([1, 0, 1, 1, 1]);
  });
});
