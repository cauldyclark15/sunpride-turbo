import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { MOBILE_EXCEPTION_LIMIT } from "./mobile";
import {
  channelOf,
  dayCloseAt,
  isLateSync,
  LATE_SYNC_MS,
  outOfSequence,
} from "./model";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
const date = "2026-09-28";
// 11:00 Manila on the service date.
const now = Date.parse("2026-09-28T03:00:00Z");
const at = (hhmm: string) => Date.parse(`${date}T${hhmm}:00+08:00`);
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
    const since = now - 30 * 24 * HOUR;
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
    const position = await ctx.db.insert("positions", {
      organizationId: "sunpride",
      code: "PMS",
      label: "Route Salesman",
      category: "field",
      active: true,
      createdAt: since,
      updatedAt: since,
    });
    const person = async (
      name: string,
      role: "sales" | "manager" | "viewer" | "analyst",
      orgUnitId: Id<"orgUnits">,
      extra: { channelScope?: string; supervisorId?: Id<"profiles"> } = {},
    ) => {
      const id = await ctx.db.insert("profiles", {
        authSubject: subject(name),
        name,
        email: `${name}@test.local`,
        role,
        status: "active",
        orgUnitId,
        positionId: role === "sales" ? position : undefined,
        ...(extra.channelScope ? { channelScope: extra.channelScope } : {}),
        updatedAt: since,
      });
      const assignment = await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId,
        role,
        positionId: role === "sales" ? position : undefined,
        ...(extra.supervisorId ? { supervisorId: extra.supervisorId } : {}),
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      return { id, assignment };
    };
    const managerA = await person("managerA", "manager", regionA);
    const managerB = await person("managerB", "manager", regionB);
    await person("viewerA", "viewer", regionA);
    const s1 = await person("Ana", "sales", regionA, {
      channelScope: "PMOT",
      supervisorId: managerA.id,
    });
    const s2 = await person("Ben", "sales", regionA);
    const s3 = await person("Cara", "sales", regionB);
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
    const ownership = await ctx.db.insert("territoryOwnerships", {
      territoryId: territory,
      orgUnitId: regionA,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    const outlets: {
      id: Id<"outlets">;
      assignment: Id<"outletAssignments">;
    }[] = [];
    for (const n of [1, 2, 3]) {
      const id = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: `O${n}`,
        name: `Outlet ${n}`,
        status: "active",
        custodianOrgUnitId: regionA,
        createdAt: since,
        updatedAt: since,
        createdBy: "fixture",
      });
      const assignment = await ctx.db.insert("outletAssignments", {
        outletId: id,
        territoryId: territory,
        sequence: n,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      await ctx.db.insert("outletPins", {
        outletId: id,
        latitude: 14.5 + n / 100,
        longitude: 121,
        radiusMeters: 75,
        source: "field",
        status: "verified",
        effectiveFrom: since,
        proposedBy: "fixture",
        proposedAt: since,
        createdAt: since,
      });
      outlets.push({ id, assignment });
    }
    const plan = await ctx.db.insert("coveragePlans", {
      organizationId: "sunpride",
      assigneeProfileId: s1.id,
      localMonth: "2026-09",
      version: 1,
      cycleType: "monthly",
      orgUnitId: regionA,
      territoryIds: [territory],
      requestedFrom: since,
      requestedTo: now + 10 * 24 * HOUR,
      effectiveFrom: since,
      effectiveTo: now + 10 * 24 * HOUR,
      status: "active",
      preparedBy: subject("Ana"),
      preparedAt: since,
      approvedBy: subject("managerA"),
      approvedAt: since,
      approvalSignature: "signed",
      contentRevision: 1,
      createdBy: subject("Ana"),
      createdAt: since,
      updatedBy: subject("managerA"),
      updatedAt: since,
    });
    const planned: Id<"plannedVisits">[] = [];
    for (const [index, outlet] of outlets.entries()) {
      const approvedSnapshot = {
        outletId: outlet.id,
        outletCode: `O${index + 1}`,
        outletName: `Outlet ${index + 1}`,
        territoryId: territory,
        territoryCode: "T-A",
        sequence: index + 1,
        outletAssignmentId: outlet.assignment,
        territoryOwnershipId: ownership,
        employeeAssignmentId: s1.assignment,
        orgUnitId: regionA,
        activityKind: "sell",
        approvedAssigneeProfileId: s1.id,
      };
      const slot = await ctx.db.insert("coveragePlanSlots", {
        slotKey: `slot-${index}`,
        planId: plan,
        assigneeProfileId: s1.id,
        serviceDate: date,
        kind: "outlet_visit",
        outletId: outlet.id,
        activityKind: "sell",
        requiredObjectives: [],
        intents: ["sell"],
        sequence: index + 1,
        expectedDurationMinutes: 20,
        approvedSnapshot,
        contentRevision: 1,
        updatedBy: "fixture",
        updatedAt: since,
      });
      planned.push(
        await ctx.db.insert("plannedVisits", {
          generationKey: `gen-${index}`,
          planId: plan,
          planVersion: 1,
          planSlotId: slot,
          assigneeProfileId: s1.id,
          outletId: outlet.id,
          serviceDate: date,
          status: "planned",
          approvedSnapshot,
          requiredObjectives: [],
          intents: ["sell"],
          expectedDurationMinutes: 20,
          generatedAt: since,
        }),
      );
    }
    const visit = (
      n: number,
      fields: {
        profileId: Id<"profiles">;
        orgUnitId: Id<"orgUnits">;
        outletId: Id<"outlets">;
        plannedVisitId?: Id<"plannedVisits">;
        state: "checked-in" | "checked-out";
        productivity: "pending" | "verified" | "nonproductive";
        checkedInAt: number;
        checkedOutAt?: number;
        reasonCode?: string;
        unplannedReason?: string;
      },
    ) =>
      ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: `client-${n}`,
        assigneeProfileId: fields.profileId,
        outletId: fields.outletId,
        orgUnitId: fields.orgUnitId,
        serviceDate: date,
        source: fields.plannedVisitId ? "planned" : "unplanned",
        intents: ["sell"],
        state: fields.state,
        productivity: fields.productivity,
        createdAt: fields.checkedInAt,
        lastServerTime: fields.checkedOutAt ?? fields.checkedInAt,
        checkedInAt: fields.checkedInAt,
        ...(fields.plannedVisitId
          ? { plannedVisitId: fields.plannedVisitId, planId: plan }
          : {}),
        ...(fields.checkedOutAt ? { checkedOutAt: fields.checkedOutAt } : {}),
        ...(fields.reasonCode ? { reasonCode: fields.reasonCode } : {}),
        ...(fields.unplannedReason
          ? { unplannedReason: fields.unplannedReason }
          : {}),
      });
    const evidence = (
      visitId: Id<"visitExecutions">,
      orgUnitId: Id<"orgUnits">,
      result: "within_radius" | "outside_radius" | "unreliable",
      serverTime: number,
      deviceTime = serverTime,
    ) =>
      ctx.db.insert("visitLocationEvidence", {
        organizationId: "sunpride",
        orgUnitId,
        visitId,
        event: "check_in",
        latitude: 14.7,
        longitude: 121.1,
        provider: "gps",
        accuracyMeters: 12,
        policyVersion: "test",
        radiusMeters: 75,
        distanceMeters: result === "within_radius" ? 10 : 320,
        result,
        reviewStatus:
          result === "within_radius" ? "verified" : "pending_review",
        deviceTime,
        serverTime,
      });
    // Ana: stop 2 first (productive), then stop 1 (out of MCP order, nonproductive),
    // then an unplanned call at outlet 3 still in progress and synced late.
    const v2 = await visit(2, {
      profileId: s1.id,
      orgUnitId: regionA,
      outletId: outlets[1]!.id,
      plannedVisitId: planned[1],
      state: "checked-out",
      productivity: "verified",
      checkedInAt: at("08:00"),
      checkedOutAt: at("08:30"),
    });
    await evidence(v2, regionA, "within_radius", at("08:00"));
    const v1 = await visit(1, {
      profileId: s1.id,
      orgUnitId: regionA,
      outletId: outlets[0]!.id,
      plannedVisitId: planned[0],
      state: "checked-out",
      productivity: "nonproductive",
      checkedInAt: at("09:00"),
      checkedOutAt: at("09:20"),
      reasonCode: "store_closed",
    });
    const outside = await evidence(v1, regionA, "outside_radius", at("09:00"));
    const v4 = await visit(4, {
      profileId: s1.id,
      orgUnitId: regionA,
      outletId: outlets[2]!.id,
      state: "checked-in",
      productivity: "pending",
      checkedInAt: at("10:00"),
      unplannedReason: "Store called",
    });
    const unreliable = await evidence(
      v4,
      regionA,
      "unreliable",
      at("10:00"),
      at("10:00") - LATE_SYNC_MS - HOUR,
    );
    // Cara is in region B: invisible to region A.
    const v9 = await visit(9, {
      profileId: s3.id,
      orgUnitId: regionB,
      outletId: outlets[0]!.id,
      state: "checked-in",
      productivity: "pending",
      checkedInAt: at("09:30"),
      unplannedReason: "Other region",
    });
    await evidence(v9, regionB, "outside_radius", at("09:30"));
    return {
      root,
      regionA,
      regionB,
      managerA,
      managerB,
      s1,
      s2,
      s3,
      planned,
      v1,
      v2,
      v4,
      outside,
      unreliable,
    };
  });
  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });
  return { t, ids, as };
}

describe("supervision rules", () => {
  it("flags a call checked in after a later MCP stop", () => {
    const visits = [
      { _id: "a", checkedInAt: 3, seq: 1 },
      { _id: "b", checkedInAt: 1, seq: 2 },
      { _id: "c", checkedInAt: 2, seq: 3 },
      { _id: "d", checkedInAt: 4, seq: undefined },
    ].map((row) => ({
      ...row,
      state: "checked-out",
      source: "planned",
      productivity: "pending",
      lastServerTime: 0,
    }));
    const broken = outOfSequence(
      visits,
      (v) => visits.find((row) => row._id === v._id)?.seq,
    );
    expect([...broken.entries()]).toEqual([["a", { sequence: 1, after: 3 }]]);
  });
  it("counts late syncs after the 10 PM close or long after the fix", () => {
    const close = dayCloseAt(date);
    expect(new Date(close).toISOString()).toBe("2026-09-28T14:00:00.000Z");
    const visit = {
      _id: "v",
      state: "checked-out",
      source: "planned",
      productivity: "pending",
      lastServerTime: close - 1,
    };
    expect(isLateSync(visit, [], close)).toBe(false);
    expect(isLateSync({ ...visit, lastServerTime: close + 1 }, [], close)).toBe(
      true,
    );
    expect(
      isLateSync(
        visit,
        [{ deviceTime: 0, serverTime: LATE_SYNC_MS + 1 }],
        close,
      ),
    ).toBe(true);
  });
  it("groups by channel, then position, then unassigned", () => {
    expect(channelOf("PMOT", "Route Salesman")).toBe("PMOT");
    expect(channelOf(undefined, "Route Salesman")).toBe("Route Salesman");
    expect(channelOf("  ", undefined)).toBe("Unassigned");
  });
});

describe("team execution", () => {
  it("summarizes each field person in the supervisor's scope", async () => {
    const { ids, as } = await fixture();
    const result = await as("managerA").query(api.supervision.team.day, {
      serviceDate: date,
    });
    expect(result.people.map((p) => p.name)).toEqual(["Ana", "Ben"]);
    expect(result.channels).toEqual(["PMOT", "Route Salesman"]);
    expect(result.canDecide).toBe(true);
    expect(result.units.map((u) => u.code)).toEqual(["A"]);
    const ana = result.people[0]!;
    expect(ana).toMatchObject({
      profileId: ids.s1.id,
      channel: "PMOT",
      positionLabel: "Route Salesman",
      direct: true,
      planned: 3,
      plannedDone: 2,
      done: 2,
      productive: 1,
      nonproductive: 1,
      unplanned: 1,
      inProgress: true,
      outOfSequence: 1,
      openExceptions: 2,
      lateSync: 1,
      firstCheckInAt: at("08:00"),
      lastCheckOutAt: at("09:20"),
      lastActivityAt: at("10:00"),
    });
    expect(result.people[1]).toMatchObject({
      name: "Ben",
      channel: "Route Salesman",
      direct: false,
      planned: 0,
      done: 0,
      firstCheckInAt: null,
      lastActivityAt: null,
    });
  });

  it("filters by channel and direct reports, and never widens scope", async () => {
    const { ids, as } = await fixture();
    const manager = as("managerA");
    const pmot = await manager.query(api.supervision.team.day, {
      serviceDate: date,
      channel: "PMOT",
    });
    expect(pmot.people.map((p) => p.name)).toEqual(["Ana"]);
    expect(pmot.channels).toEqual(["PMOT", "Route Salesman"]);
    const direct = await manager.query(api.supervision.team.day, {
      serviceDate: date,
      directOnly: true,
    });
    expect(direct.people.map((p) => p.name)).toEqual(["Ana"]);
    await expect(
      manager.query(api.supervision.team.day, {
        serviceDate: date,
        orgUnitId: ids.regionB,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    const other = await as("managerB").query(api.supervision.team.day, {
      serviceDate: date,
    });
    expect(other.people.map((p) => p.name)).toEqual(["Cara"]);
  });

  it("refuses field sales and invalid dates", async () => {
    const { as } = await fixture();
    const options = await as("managerA").query(api.supervision.team.options, {
      serviceDate: date,
    });
    expect(options).toMatchObject({
      canDecide: true,
      channels: ["PMOT", "Route Salesman"],
    });
    expect(options.units.map((u) => u.code)).toEqual(["A"]);
    await expect(
      as("Ana").query(api.supervision.team.day, { serviceDate: date }),
    ).rejects.toThrow(/Insufficient permission/);
    await expect(
      as("managerA").query(api.supervision.team.day, {
        serviceDate: "2026-02-30",
      }),
    ).rejects.toThrow(/Invalid Manila date/);
  });
});

describe("exception queue", () => {
  it("lists open geofence evidence first with the informational exceptions", async () => {
    const { ids, as } = await fixture();
    const result = await as("managerA").query(
      api.supervision.exceptions.queue,
      {
        serviceDate: date,
      },
    );
    expect(JSON.stringify(result)).not.toContain(`${ISSUER}|`);
    const open = result.items.filter((item) => item.open);
    expect(open.map((item) => item.evidenceId).sort()).toEqual(
      [ids.outside, ids.unreliable].sort(),
    );
    expect(open.every((item) => item.canDecide)).toBe(true);
    expect(result.items.slice(0, 2).every((item) => item.open)).toBe(true);
    const kinds = result.items.map((item) => item.kind).sort();
    expect(kinds).toEqual([
      "location",
      "location",
      "nonproductive",
      "not_visited",
      "out_of_sequence",
      "unplanned",
    ]);
    expect(
      result.items.find((item) => item.kind === "out_of_sequence"),
    ).toMatchObject({ visitId: ids.v1, sequence: 1, after: 2 });
    expect(
      result.items.find((item) => item.kind === "nonproductive"),
    ).toMatchObject({ reason: "store_closed", outletName: "Outlet 1" });
    expect(
      result.items.find((item) => item.kind === "unplanned"),
    ).toMatchObject({ reason: "Store called", personName: "Ana" });
    expect(result.items.some((item) => item.personName === "Cara")).toBe(false);
  });

  it("lists planned stops never visited and reschedules", async () => {
    const { t, ids, as } = await fixture();
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.planned[2]!, {
        status: "replaced",
        cancellationReason: "Moved to Friday",
        cancelledAt: at("07:00"),
      });
    });
    const result = await as("managerA").query(
      api.supervision.exceptions.queue,
      {
        serviceDate: date,
      },
    );
    expect(
      result.items.find((item) => item.kind === "rescheduled"),
    ).toMatchObject({ reason: "Moved to Friday", sequence: 3 });
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.planned[2]!, { status: "planned" });
    });
    const again = await as("managerA").query(api.supervision.exceptions.queue, {
      serviceDate: date,
    });
    expect(
      again.items.find((item) => item.kind === "not_visited"),
    ).toMatchObject({ outletCode: "O3", sequence: 3 });
  });

  it("shows the decision and its author once a manager decides", async () => {
    const { ids, as } = await fixture();
    const manager = as("managerA");
    await manager.mutation(api.visits.location.decideLocationException, {
      evidenceId: ids.outside,
      decision: "approve",
      reason: "store_relocated",
    });
    const result = await manager.query(api.supervision.exceptions.queue, {
      serviceDate: date,
    });
    const decided = result.items.find(
      (item) => item.evidenceId === ids.outside,
    );
    expect(decided).toMatchObject({
      open: false,
      canDecide: false,
      decision: {
        status: "approved_exception",
        reasonCode: "store_relocated",
        actorName: "managerA",
      },
    });
    expect(decided!.history.at(-1)).toMatchObject({
      kind: "location.exception.decided",
      actorName: "managerA",
    });
    const team = await manager.query(api.supervision.team.day, {
      serviceDate: date,
    });
    expect(team.people[0]!.openExceptions).toBe(1);
  });

  it("lets a viewer read the queue but not decide", async () => {
    const { as } = await fixture();
    const result = await as("viewerA").query(api.supervision.exceptions.queue, {
      serviceDate: date,
    });
    expect(result.canDecide).toBe(false);
    expect(result.items.some((item) => item.canDecide)).toBe(false);
  });
});

describe("field activity map", () => {
  it("plots check-ins at verified outlet pins in check-in order", async () => {
    const { ids, as } = await fixture();
    const result = await as("managerA").query(api.supervision.activity.map, {
      serviceDate: date,
      profileId: ids.s1.id,
    });
    expect(result.showsFixes).toBe(true);
    expect(result.people).toHaveLength(1);
    const stops = result.people[0]!.stops;
    expect(stops.map((s) => [s.outletCode, s.source])).toEqual([
      ["O2", "planned"],
      ["O1", "planned"],
      ["O3", "unplanned"],
      ["O3", "not_visited"],
    ]);
    expect(stops[0]).toMatchObject({
      territoryCode: "T-A",
      sequence: 2,
      point: { latitude: 14.52, longitude: 121 },
      fix: { latitude: 14.7, longitude: 121.1, result: "within_radius" },
    });
    expect(stops[2]!.territoryCode).toBe("T-A");
  });

  it("adds planned stops not visited and hides raw fixes from viewers", async () => {
    const { t, ids, as } = await fixture();
    await t.run(async (ctx) => {
      await ctx.db.delete(ids.v4);
    });
    const result = await as("viewerA").query(api.supervision.activity.map, {
      serviceDate: date,
    });
    expect(result.showsFixes).toBe(false);
    const ana = result.people.find((p) => p.name === "Ana")!;
    expect(ana.stops.at(-1)).toMatchObject({
      outletCode: "O3",
      source: "not_visited",
      visitId: null,
      point: { latitude: 14.53, longitude: 121 },
    });
    expect(ana.stops.every((s) => s.fix === null)).toBe(true);
  });
});

describe("mobile supervisor summary (AND-020)", () => {
  it("returns direct-report coverage and exceptions by default", async () => {
    const { ids, as } = await fixture();
    const result = await as("managerA").query(api.supervision.mobile.team, {
      serviceDate: date,
    });
    expect(result.directOnly).toBe(true);
    expect(result.generatedAt).toBe(now);
    expect(result.dayCloseAt).toBe(dayCloseAt(date));
    expect(result.people.map((p) => p.name)).toEqual(["Ana"]);
    expect(result.people[0]).toMatchObject({
      profileId: ids.s1.id,
      direct: true,
      planned: 3,
      plannedDone: 2,
      productive: 1,
      nonproductive: 1,
      unplanned: 1,
      outOfSequence: 1,
      openExceptions: 2,
      lateSync: 1,
    });
    expect(result.openExceptions).toBe(2);
    expect(result.totalExceptions).toBe(6);
    expect(result.exceptions.slice(0, 2).every((e) => e.open)).toBe(true);
    expect(result.exceptions.map((e) => e.kind).sort()).toEqual([
      "location",
      "location",
      "nonproductive",
      "not_visited",
      "out_of_sequence",
      "unplanned",
    ]);
    expect(
      result.exceptions.find((e) => e.kind === "out_of_sequence"),
    ).toMatchObject({ sequence: 1, after: 2, outletName: "Outlet 1" });
    // Compact: no raw fixes, actor tokens or audit history reach the phone.
    const text = JSON.stringify(result);
    expect(text).not.toContain(`${ISSUER}|`);
    expect(text).not.toContain("14.7");
    expect(text).not.toContain("history");
    expect(result.truncated).toBe(false);
  });

  it("widens to the whole subtree only on request, never beyond scope", async () => {
    const { as } = await fixture();
    const all = await as("managerA").query(api.supervision.mobile.team, {
      serviceDate: date,
      directOnly: false,
    });
    expect(all.directOnly).toBe(false);
    expect(all.people.map((p) => [p.name, p.direct])).toEqual([
      ["Ana", true],
      ["Ben", false],
    ]);
    expect(all.exceptions.some((e) => e.personName === "Cara")).toBe(false);
    const other = await as("managerB").query(api.supervision.mobile.team, {
      serviceDate: date,
      directOnly: false,
    });
    expect(other.people.map((p) => p.name)).toEqual(["Cara"]);
    // managerB supervises nobody directly: the default view is empty, not widened.
    const otherDirect = await as("managerB").query(
      api.supervision.mobile.team,
      { serviceDate: date },
    );
    expect(otherDirect.people).toEqual([]);
    expect(otherDirect.exceptions).toEqual([]);
  });

  it("refuses field sales, the unauthenticated and invalid dates", async () => {
    const { t, as } = await fixture();
    await expect(
      as("Ana").query(api.supervision.mobile.team, { serviceDate: date }),
    ).rejects.toThrow(/Insufficient permission/);
    await expect(
      t.query(api.supervision.mobile.team, { serviceDate: date }),
    ).rejects.toThrow();
    await expect(
      as("managerA").query(api.supervision.mobile.team, {
        serviceDate: "2026-13-01",
      }),
    ).rejects.toThrow(/Invalid Manila date/);
  });

  it("caps the exception list and reports truncation", async () => {
    const { t, ids, as } = await fixture();
    await t.run(async (ctx) => {
      for (let n = 0; n < MOBILE_EXCEPTION_LIMIT; n++)
        await ctx.db.insert("visitExecutions", {
          organizationId: "sunpride",
          clientVisitId: `extra-${n}`,
          assigneeProfileId: ids.s1.id,
          outletId: (await ctx.db.query("outlets").first())!._id,
          orgUnitId: ids.regionA,
          serviceDate: date,
          source: "unplanned",
          intents: ["sell"],
          state: "checked-in",
          productivity: "pending",
          createdAt: at("10:30"),
          lastServerTime: at("10:30"),
          checkedInAt: at("10:30"),
          unplannedReason: "Walk-in",
        });
    });
    const result = await as("managerA").query(api.supervision.mobile.team, {
      serviceDate: date,
    });
    expect(result.exceptions).toHaveLength(MOBILE_EXCEPTION_LIMIT);
    expect(result.totalExceptions).toBeGreaterThan(MOBILE_EXCEPTION_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.exceptions.slice(0, 2).every((e) => e.open)).toBe(true);
  });
});
