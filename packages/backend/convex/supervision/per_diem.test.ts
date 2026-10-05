import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  claimPeriod,
  classifyVisit,
  missingForms,
  summarizePeriod,
  type VisitFacts,
} from "./per_diem_model";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
// 11:00 Manila on 28 Sep 2026; the claim week 21–27 Sep is closed.
const now = Date.parse("2026-09-28T03:00:00Z");
const at = (date: string, hhmm: string) =>
  Date.parse(`${date}T${hhmm}:00+08:00`);
const ISSUER = "https://auth.test";
const subject = (name: string) => `${ISSUER}|${name}`;
const D1 = "2026-09-25";
const D2 = "2026-09-26";
const period = { from: "2026-09-21", to: "2026-09-27" };

afterEach(() => {
  vi.useRealTimers();
});

const base: VisitFacts = {
  source: "planned",
  state: "checked-out",
  hasPlannedLink: true,
  planned: { status: "planned", planStatus: "active" },
  location: [{ event: "check_in", hasFix: true, status: "verified" }],
  lateReviewStatus: null,
  activityCount: 1,
  hasCallSheet: false,
  callSheetRequired: false,
  requiredMissing: [],
};

describe("per-diem rules", () => {
  it("counts a finished MCP call backed by location and a report", () => {
    expect(classifyVisit(base)).toEqual({
      status: "valid",
      reasons: [],
      notes: [],
    });
  });

  it("never counts a call outside the approved MCP", () => {
    expect(
      classifyVisit({
        ...base,
        source: "unplanned",
        hasPlannedLink: false,
        planned: null,
      }),
    ).toMatchObject({ status: "invalid", reasons: ["outside_mcp"] });
    expect(
      classifyVisit({
        ...base,
        planned: { status: "cancelled", planStatus: "active" },
      }).reasons,
    ).toEqual(["removed_from_plan"]);
    expect(
      classifyVisit({
        ...base,
        planned: { status: "planned", planStatus: "draft" },
      }).reasons,
    ).toEqual(["plan_not_approved"]);
  });

  it("holds calls a review can still clear and rejects the rest", () => {
    expect(
      classifyVisit({ ...base, lateReviewStatus: "pending_review" }),
    ).toMatchObject({
      status: "held",
      reasons: ["late_pending"],
    });
    expect(classifyVisit({ ...base, state: "checked-in" })).toMatchObject({
      status: "held",
      reasons: ["still_open"],
    });
    expect(
      classifyVisit({
        ...base,
        location: [
          { event: "check_in", hasFix: false, status: "pending_review" },
        ],
      }),
    ).toMatchObject({ status: "held", reasons: ["no_location"] });
    expect(
      classifyVisit({
        ...base,
        location: [
          { event: "check_in", hasFix: false, status: "approved_exception" },
        ],
      }),
    ).toMatchObject({
      status: "valid",
      notes: ["location_exception_approved"],
    });
    expect(
      classifyVisit({ ...base, lateReviewStatus: "rejected" }).status,
    ).toBe("invalid");
    expect(classifyVisit({ ...base, state: "missed" }).reasons).toEqual([
      "not_completed",
    ]);
    // A held reason next to an invalid one is invalid.
    expect(
      classifyVisit({
        ...base,
        lateReviewStatus: "pending_review",
        activityCount: 0,
      }).status,
    ).toBe("invalid");
  });

  it("needs the call report and, for Annex C accounts, the call sheet", () => {
    expect(classifyVisit({ ...base, activityCount: 0 }).reasons).toEqual([
      "no_report",
    ]);
    expect(classifyVisit({ ...base, callSheetRequired: true }).reasons).toEqual(
      ["no_call_sheet"],
    );
    expect(
      classifyVisit({ ...base, callSheetRequired: true, hasCallSheet: true })
        .status,
    ).toBe("valid");
  });

  it("holds a completed call missing its purpose's required forms", () => {
    // Release counterexample: merchandise intent, only a note recorded.
    const requiredMissing = missingForms({
      outcome: "completed",
      storedMissing: ["merchandising"],
      required: ["merchandising"],
      recorded: ["note"],
    });
    expect(requiredMissing).toEqual(["merchandising"]);
    expect(classifyVisit({ ...base, requiredMissing })).toEqual({
      status: "held",
      reasons: ["forms_missing"],
      notes: [],
    });
    // Once recorded, the form no longer blocks (even if End had flagged it).
    expect(
      missingForms({
        outcome: "completed",
        storedMissing: ["merchandising"],
        required: ["merchandising"],
        recorded: ["note", "merchandising"],
      }),
    ).toEqual([]);
    // What End flagged still counts when today's recomputation misses it.
    expect(
      missingForms({
        outcome: "completed",
        storedMissing: ["inventory_check"],
        required: [],
        recorded: ["note"],
      }),
    ).toEqual(["inventory_check"]);
    // A nonproductive End owes no purpose forms; an unknown outcome fails closed.
    const merch = {
      storedMissing: null,
      required: ["merchandising"],
      recorded: ["note"],
    };
    expect(missingForms({ ...merch, outcome: "nonproductive" })).toEqual([]);
    expect(missingForms({ ...merch, outcome: null })).toEqual([
      "merchandising",
    ]);
    // Missing forms next to an invalid reason stay invalid.
    expect(
      classifyVisit({
        ...base,
        requiredMissing,
        callSheetRequired: true,
      }),
    ).toMatchObject({
      status: "invalid",
      reasons: ["no_call_sheet", "forms_missing"],
    });
  });

  it("shows an off-pin fix without blocking (no fixed distance)", () => {
    expect(
      classifyVisit({
        ...base,
        location: [
          { event: "check_in", hasFix: true, status: "pending_review" },
        ],
      }),
    ).toEqual({ status: "valid", reasons: [], notes: ["location_unreviewed"] });
    expect(
      classifyVisit({
        ...base,
        location: [{ event: "check_in", hasFix: true, status: "rejected" }],
      }).reasons,
    ).toEqual(["location_rejected"]);
  });

  it("keeps a claim period inside one month", () => {
    expect(claimPeriod("2026-09-16", "2026-09-30").dates).toHaveLength(15);
    expect(() => claimPeriod("2026-09-30", "2026-10-01")).toThrow(
      "inside one month",
    );
    expect(() => claimPeriod("2026-09-10", "2026-09-01")).toThrow();
    expect(() => claimPeriod("2026-02-30", "2026-02-28")).toThrow();
  });

  it("counts valid days and holds days with undecided calls", () => {
    const result = summarizePeriod(
      ["2026-09-01", "2026-09-02", "2026-09-03"],
      new Map([
        ["2026-09-01", 2],
        ["2026-09-02", 1],
      ]),
      [
        { serviceDate: "2026-09-01", status: "valid", kind: "visit" },
        { serviceDate: "2026-09-01", status: "invalid", kind: "not_visited" },
        { serviceDate: "2026-09-02", status: "held", kind: "visit" },
        { serviceDate: "2026-09-02", status: "valid", kind: "visit" },
      ],
    );
    expect(result.days.map((day) => day.dayStatus)).toEqual(["valid", "held"]);
    expect(result.totals).toEqual({
      plannedStops: 3,
      validCalls: 2,
      heldCalls: 1,
      invalidCalls: 0,
      notVisited: 1,
      validDays: 1,
      heldDays: 1,
    });
  });
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const t: T = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const since = now - 40 * 24 * HOUR;
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
      role: "sales" | "manager" | "viewer",
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
      const assignment = await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId,
        role,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      return { id, assignment };
    };
    const managerA = await person("managerA", "manager", regionA);
    await person("managerB", "manager", regionB);
    await person("viewerA", "viewer", regionA);
    const ana = await person("Ana", "sales", regionA);
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
      outlets.push({ id, assignment });
    }
    // Outlet 2 is an Annex C account: its calls need a call sheet.
    const product = await ctx.db.insert("products", {
      code: "SKU-1",
      name: "Corned beef",
      category: "canned",
      uom: "can",
      unitPrice: 1,
      active: true,
      updatedAt: since,
    });
    await ctx.db.insert("callSheetAccounts", {
      organizationId: "sunpride",
      outletId: outlets[1]!.id,
      revision: 1,
      header: { accountName: "Outlet 2" },
      lines: [{ productId: product }],
      updatedAt: since,
      updatedBy: "fixture",
    });
    const plan = await ctx.db.insert("coveragePlans", {
      organizationId: "sunpride",
      assigneeProfileId: ana.id,
      localMonth: "2026-09",
      version: 1,
      cycleType: "monthly",
      orgUnitId: regionA,
      territoryIds: [territory],
      requestedFrom: since,
      requestedTo: now + 3 * 24 * HOUR,
      effectiveFrom: since,
      effectiveTo: now + 3 * 24 * HOUR,
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
    const planned: Record<string, Id<"plannedVisits">> = {};
    for (const serviceDate of [D1, D2])
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
          employeeAssignmentId: ana.assignment,
          orgUnitId: regionA,
          activityKind: "sell",
          approvedAssigneeProfileId: ana.id,
        };
        const slot = await ctx.db.insert("coveragePlanSlots", {
          slotKey: `slot-${serviceDate}-${index}`,
          planId: plan,
          assigneeProfileId: ana.id,
          serviceDate,
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
        planned[`${serviceDate}/${index + 1}`] = await ctx.db.insert(
          "plannedVisits",
          {
            generationKey: `gen-${serviceDate}-${index}`,
            planId: plan,
            planVersion: 1,
            planSlotId: slot,
            assigneeProfileId: ana.id,
            outletId: outlet.id,
            serviceDate,
            status: "planned",
            approvedSnapshot,
            requiredObjectives: [],
            intents: ["sell"],
            expectedDurationMinutes: 20,
            generatedAt: since,
          },
        );
      }
    let n = 0;
    const visit = async (
      serviceDate: string,
      outlet: number,
      opts: {
        planned?: boolean;
        late?: "pending_review";
        evidence?: "within_radius" | "outside_radius";
        note?: boolean;
        callSheet?: boolean;
        intents?: ("follow-up" | "merchandise")[];
      },
    ) => {
      const checkedInAt = at(serviceDate, `0${outlet + 7}:00`);
      const plannedVisitId = opts.planned
        ? planned[`${serviceDate}/${outlet}`]
        : undefined;
      const outletId = outlets[outlet - 1]!.id;
      const id = await ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: `client-${++n}`,
        assigneeProfileId: ana.id,
        outletId,
        orgUnitId: regionA,
        serviceDate,
        source: plannedVisitId ? "planned" : "unplanned",
        // Follow-up calls require a note under the provisional activity-form rules.
        intents: opts.intents ?? ["follow-up"],
        state: "checked-out",
        outcome: "completed",
        productivity: "verified",
        createdAt: checkedInAt,
        lastServerTime: checkedInAt + HOUR / 2,
        checkedInAt,
        checkedOutAt: checkedInAt + HOUR / 2,
        ...(plannedVisitId ? { plannedVisitId, planId: plan } : {}),
        ...(opts.late
          ? { lateSyncAt: checkedInAt + 20 * HOUR, lateReviewStatus: opts.late }
          : {}),
      });
      const evidenceId = await ctx.db.insert("visitLocationEvidence", {
        organizationId: "sunpride",
        orgUnitId: regionA,
        visitId: id,
        event: "check_in",
        latitude: 14.6,
        longitude: 121,
        provider: "gps",
        accuracyMeters: 10,
        policyVersion: "test",
        radiusMeters: 75,
        distanceMeters: opts.evidence === "outside_radius" ? 400 : 5,
        result: opts.evidence ?? "within_radius",
        reviewStatus:
          opts.evidence === "outside_radius" ? "pending_review" : "verified",
        deviceTime: checkedInAt,
        serverTime: checkedInAt,
      });
      const activity = (activity: never) =>
        ctx.db.insert("visitActivities", {
          organizationId: "sunpride",
          orgUnitId: regionA,
          visitId: id,
          assigneeProfileId: ana.id,
          outletId,
          activity,
          evidenceIds: [],
          deviceTime: checkedInAt,
          serverTime: checkedInAt,
        });
      if (opts.note) await activity({ kind: "note", text: "ok" } as never);
      if (opts.callSheet)
        await activity({
          kind: "call_sheet",
          lines: [
            {
              productId: product,
              order: 1,
              beginningInventory: null,
              take: null,
              delivered: null,
              offtake: null,
              endInventory: null,
            },
          ],
        } as never);
      return { id, evidenceId };
    };
    // 25 Sep: stop 1 valid; stop 2 sent late (held); stop 3 skipped, an unplanned call there.
    const v1 = await visit(D1, 1, { planned: true, note: true });
    const v2 = await visit(D1, 2, {
      planned: true,
      late: "pending_review",
      note: true,
      callSheet: true,
    });
    const v3 = await visit(D1, 3, { note: true });
    // 26 Sep: stop 1 off-pin but unreviewed (still valid); stop 2 lacks its call sheet;
    // stop 3 has no report and its location was rejected by a supervisor.
    const v4 = await visit(D2, 1, {
      planned: true,
      evidence: "outside_radius",
      note: true,
    });
    const v5 = await visit(D2, 2, { planned: true, note: true });
    const v6 = await visit(D2, 3, {
      planned: true,
      evidence: "outside_radius",
    });
    await ctx.db.insert("executionEvents", {
      organizationId: "sunpride",
      orgUnitId: regionA,
      entityType: "visit",
      entityId: v6.evidenceId,
      kind: "location.exception.decided",
      actorSubject: subject("managerA"),
      actorRole: "manager",
      actorOrgUnitId: regionA,
      source: "web",
      occurredAt: at(D2, "20:00"),
      serverAt: at(D2, "20:00"),
      summary: { after: "rejected", reasonCode: "wrong_place" },
      schemaVersion: 1,
    });
    return { ana, managerA, v1, v2, v3, v4, v5, v6 };
  });
  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });
  return { t, ids, as };
}

describe("per-diem validation", () => {
  it("lists every call against the approved MCP with its exceptions", async () => {
    const { ids, as } = await fixture();
    const result = await as("managerA").query(
      api.supervision.per_diem.validation,
      { ...period, profileId: ids.ana.id },
    );
    expect(result.people.map((row) => row.name)).toEqual(["Ana"]);
    const selected = result.selected!;
    expect(selected.canDecide).toBe(true);
    expect(selected.totals).toEqual({
      plannedStops: 6,
      validCalls: 2,
      heldCalls: 1,
      invalidCalls: 3,
      notVisited: 1,
      validDays: 1,
      heldDays: 1,
    });
    const byId = new Map(selected.items.map((row) => [row.id, row]));
    expect(byId.get(ids.v1.id)).toMatchObject({ status: "valid", reasons: [] });
    expect(byId.get(ids.v2.id)).toMatchObject({
      status: "held",
      reasons: ["late_pending"],
    });
    expect(byId.get(ids.v3.id)).toMatchObject({
      status: "invalid",
      reasons: ["outside_mcp"],
    });
    expect(byId.get(ids.v4.id)).toMatchObject({
      status: "valid",
      notes: ["location_unreviewed"],
    });
    expect(byId.get(ids.v5.id)!.reasons).toEqual(["no_call_sheet"]);
    expect(byId.get(ids.v6.id)!.reasons).toEqual([
      "location_rejected",
      "no_report",
    ]);
    const missed = selected.items.filter((row) => row.kind === "not_visited");
    expect(missed).toMatchObject([
      { serviceDate: D1, outletCode: "O3", reasons: ["not_visited"] },
    ]);
    expect(
      selected.days.map((day) => [day.serviceDate, day.dayStatus]),
    ).toEqual([
      [D1, "held"],
      [D2, "valid"],
    ]);
  });

  it("is scoped: another region cannot see the person, viewers cannot decide", async () => {
    const { ids, as } = await fixture();
    await expect(
      as("managerB").query(api.supervision.per_diem.validation, {
        ...period,
        profileId: ids.ana.id,
      }),
    ).rejects.toThrow("outside your current view");
    const viewer = await as("viewerA").query(
      api.supervision.per_diem.validation,
      { ...period, profileId: ids.ana.id },
    );
    expect(viewer.selected!.canDecide).toBe(false);
    await expect(
      as("viewerA").mutation(api.supervision.per_diem.decide, {
        profileId: ids.ana.id,
        ...period,
        decision: "validated",
        contentHash: viewer.selected!.contentHash,
      }),
    ).rejects.toThrow("Insufficient permission");
    await expect(
      as("Ana").query(api.supervision.per_diem.validation, period),
    ).rejects.toThrow("Insufficient permission");
  });

  it("validates only after held calls are decided, and refuses a stale view", async () => {
    const { t, ids, as } = await fixture();
    const manager = as("managerA");
    const first = (
      await manager.query(api.supervision.per_diem.validation, {
        ...period,
        profileId: ids.ana.id,
      })
    ).selected!;
    const decide = (
      decision: "validated" | "returned",
      contentHash: string,
      note?: string,
    ) =>
      manager.mutation(api.supervision.per_diem.decide, {
        profileId: ids.ana.id,
        ...period,
        decision,
        contentHash,
        ...(note ? { note } : {}),
      });
    await expect(decide("validated", first.contentHash)).rejects.toThrow(
      "Decide the held calls",
    );
    await expect(decide("returned", first.contentHash)).rejects.toThrow(
      "Say why",
    );
    // The late call is accepted: the validation changes, so the old view is stale.
    await t.run((ctx) =>
      ctx.db.patch(ids.v2.id, { lateReviewStatus: "accepted" }),
    );
    await expect(decide("validated", first.contentHash)).rejects.toThrow(
      "stale_validation",
    );
    const second = (
      await manager.query(api.supervision.per_diem.validation, {
        ...period,
        profileId: ids.ana.id,
      })
    ).selected!;
    expect(second.totals).toMatchObject({
      validCalls: 3,
      heldCalls: 0,
      validDays: 2,
    });
    const id = await decide("validated", second.contentHash);
    const stored = await t.run((ctx) => ctx.db.get(id));
    expect(stored).toMatchObject({
      decision: "validated",
      validCalls: 3,
      validDays: 2,
      validDates: [D1, D2],
      decidedBy: subject("managerA"),
      localMonth: "2026-09",
    });
    const after = await manager.query(api.supervision.per_diem.validation, {
      ...period,
      profileId: ids.ana.id,
    });
    expect(after.people[0]!.latest).toMatchObject({ decision: "validated" });
    expect(after.selected!.decisions).toMatchObject([
      { decision: "validated", deciderName: "managerA", stale: false },
    ]);
    // A later change to the period marks the decision stale for the supervisor.
    await t.run((ctx) => ctx.db.patch(ids.v1.id, { state: "missed" }));
    const changed = await manager.query(api.supervision.per_diem.validation, {
      ...period,
      profileId: ids.ana.id,
    });
    expect(changed.selected!.decisions[0]!.stale).toBe(true);
    const returned = await decide(
      "returned",
      changed.selected!.contentHash,
      "Stop 1 was not done",
    );
    expect((await t.run((ctx) => ctx.db.get(returned)))!.note).toBe(
      "Stop 1 was not done",
    );
  });

  it("holds a call missing its purpose's required forms and refuses validation", async () => {
    const { t, ids, as } = await fixture();
    const manager = as("managerA");
    const view = async () =>
      (
        await manager.query(api.supervision.per_diem.validation, {
          ...period,
          profileId: ids.ana.id,
        })
      ).selected!;
    // Clear the late hold so only the forms gap blocks validation.
    await t.run((ctx) =>
      ctx.db.patch(ids.v2.id, { lateReviewStatus: "accepted" }),
    );
    // Stop 1 was a merchandise call with only a note: End flagged the missing form.
    await t.run((ctx) =>
      ctx.db.patch(ids.v1.id, {
        intents: ["merchandise"],
        missingActivities: ["merchandising"],
      }),
    );
    const held = await view();
    expect(held.items.find((row) => row.id === ids.v1.id)).toMatchObject({
      status: "held",
      reasons: ["forms_missing"],
      missingForms: ["merchandising"],
    });
    expect(held.totals).toMatchObject({ validCalls: 2, heldCalls: 1 });
    await expect(
      manager.mutation(api.supervision.per_diem.decide, {
        profileId: ids.ana.id,
        ...period,
        decision: "validated",
        contentHash: held.contentHash,
      }),
    ).rejects.toThrow("Decide the held calls");
    // The rule governs even without End's flag: the recomputation still holds the call.
    await t.run((ctx) =>
      ctx.db.patch(ids.v1.id, { missingActivities: undefined }),
    );
    expect(
      (await view()).items.find((row) => row.id === ids.v1.id)!.missingForms,
    ).toEqual(["merchandising"]);
    // Recording the form changes what was decided: the old view is stale, the call counts.
    await t.run(async (ctx) => {
      const visit = (await ctx.db.get(ids.v1.id))!;
      await ctx.db.insert("visitActivities", {
        organizationId: "sunpride",
        orgUnitId: visit.orgUnitId,
        visitId: visit._id,
        assigneeProfileId: visit.assigneeProfileId,
        outletId: visit.outletId,
        activity: { kind: "merchandising", displayCondition: "compliant" },
        evidenceIds: [],
        deviceTime: visit.checkedInAt!,
        serverTime: visit.checkedInAt!,
      });
    });
    await expect(
      manager.mutation(api.supervision.per_diem.decide, {
        profileId: ids.ana.id,
        ...period,
        decision: "validated",
        contentHash: held.contentHash,
      }),
    ).rejects.toThrow("stale_validation");
    const complete = await view();
    expect(complete.items.find((row) => row.id === ids.v1.id)).toMatchObject({
      status: "valid",
      missingForms: [],
    });
    expect(complete.contentHash).not.toBe(held.contentHash);
    await manager.mutation(api.supervision.per_diem.decide, {
      profileId: ids.ana.id,
      ...period,
      decision: "validated",
      contentHash: complete.contentHash,
    });
  });

  it("reads past the 50th activity: a form recorded 51st counts and changes the hash", async () => {
    const { t, ids, as } = await fixture();
    const manager = as("managerA");
    const view = async () =>
      (
        await manager.query(api.supervision.per_diem.validation, {
          ...period,
          profileId: ids.ana.id,
        })
      ).selected!;
    await t.run((ctx) => ctx.db.patch(ids.v1.id, { intents: ["merchandise"] }));
    const add = (
      activity:
        | { kind: "note"; text: string }
        | { kind: "merchandising"; displayCondition: "compliant" },
      offset: number,
    ) =>
      t.run(async (ctx) => {
        const visit = (await ctx.db.get(ids.v1.id))!;
        await ctx.db.insert("visitActivities", {
          organizationId: "sunpride",
          orgUnitId: visit.orgUnitId,
          visitId: visit._id,
          assigneeProfileId: visit.assigneeProfileId,
          outletId: visit.outletId,
          activity,
          evidenceIds: [],
          deviceTime: visit.checkedInAt! + offset,
          serverTime: visit.checkedInAt! + offset,
        });
      });
    for (let i = 0; i < 50; i += 1)
      await add({ kind: "note", text: `note ${i}` }, i + 1);
    const held = await view();
    expect(
      held.items.find((row) => row.id === ids.v1.id)!.missingForms,
    ).toEqual(["merchandising"]);
    await add({ kind: "merchandising", displayCondition: "compliant" }, 51);
    const complete = await view();
    expect(
      complete.items.find((row) => row.id === ids.v1.id)!.missingForms,
    ).toEqual([]);
    expect(complete.contentHash).not.toBe(held.contentHash);
  });
});
