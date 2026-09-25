import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import type { AuthorizedDevice } from "../mobile/types";
import { applyVisitOperation } from "./commands";
import { manilaDate } from "../coverage/validation";

const now = Date.parse("2026-09-28T04:00:00Z");
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type T = TestConvex<typeof schema>;
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
      effectiveFrom: now - 10e7,
      createdAt: now,
      updatedAt: now,
    });
    const otherUnit = await ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      code: "OTHER",
      name: "Other",
      typeCode: "REGION",
      parentId: unit,
      status: "active",
      effectiveFrom: now - 10e7,
      createdAt: now,
      updatedAt: now,
    });
    const profile = (subject: string, role: "sales" | "manager") =>
      ctx.db.insert("profiles", {
        authSubject: `https://auth.test|${subject}`,
        name: subject,
        email: `${subject}@test.local`,
        role,
        status: "active",
        orgUnitId: unit,
        updatedAt: now,
      });
    const sales = await profile("sales", "sales"),
      other = await profile("other", "sales"),
      manager = await profile("manager", "manager");
    const position = await ctx.db.insert("positions", {
      organizationId: "sunpride",
      code: "FIELD",
      label: "Field",
      category: "field",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    const assignment = await ctx.db.insert("employeeAssignments", {
      profileId: sales,
      orgUnitId: unit,
      role: "sales",
      positionId: position,
      effectiveFrom: now - 10e7,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    for (const [id, role] of [
      [other, "sales"],
      [manager, "manager"],
    ] as const)
      await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId: unit,
        role,
        positionId: position,
        effectiveFrom: now - 10e7,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: now,
      });
    const territory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "T",
      name: "Territory",
      status: "active",
      effectiveFrom: now - 10e7,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    const ownership = await ctx.db.insert("territoryOwnerships", {
      territoryId: territory,
      orgUnitId: unit,
      effectiveFrom: now - 10e7,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    await ctx.db.insert("territorySalespeople", {
      territoryId: territory,
      profileId: sales,
      kind: "primary",
      effectiveFrom: now - 10e7,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    const outlet = await ctx.db.insert("outlets", {
      organizationId: "sunpride",
      code: "PROSPECT",
      name: "Prospect",
      status: "active",
      custodianOrgUnitId: unit,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    const outletAssignment = await ctx.db.insert("outletAssignments", {
      outletId: outlet,
      territoryId: territory,
      effectiveFrom: now - 10e7,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    const pin = await ctx.db.insert("outletPins", {
      outletId: outlet,
      latitude: 14.6,
      longitude: 121,
      radiusMeters: 75,
      source: "field",
      status: "verified",
      effectiveFrom: now - 10e7,
      proposedBy: "fixture",
      proposedAt: now,
      verifiedBy: "fixture",
      verifiedAt: now,
      createdAt: now,
    });
    const date = manilaDate(now);
    const plan = await ctx.db.insert("coveragePlans", {
      organizationId: "sunpride",
      assigneeProfileId: sales,
      localMonth: date.slice(0, 7),
      version: 1,
      cycleType: "monthly",
      orgUnitId: unit,
      territoryIds: [territory],
      requestedFrom: now - 10e7,
      requestedTo: now + 10e7,
      effectiveFrom: now - 10e7,
      effectiveTo: now + 10e7,
      status: "active",
      preparedBy: "https://auth.test|sales",
      preparedAt: now,
      approvedBy: "https://auth.test|manager",
      approvedAt: now,
      approvalSignature: "signed",
      contentRevision: 1,
      createdBy: "https://auth.test|sales",
      createdAt: now,
      updatedBy: "https://auth.test|manager",
      updatedAt: now,
    });
    const approvedSnapshot = {
      outletId: outlet,
      outletCode: "PROSPECT",
      outletName: "Prospect",
      territoryId: territory,
      territoryCode: "T",
      outletAssignmentId: outletAssignment,
      territoryOwnershipId: ownership,
      employeeAssignmentId: assignment,
      orgUnitId: unit,
      activityKind: "sell",
      approvedAssigneeProfileId: sales,
    };
    const slot = await ctx.db.insert("coveragePlanSlots", {
      slotKey: "first",
      planId: plan,
      assigneeProfileId: sales,
      serviceDate: date,
      kind: "outlet_visit",
      outletId: outlet,
      activityKind: "sell",
      requiredObjectives: [],
      intents: ["sell"],
      sequence: 1,
      expectedDurationMinutes: 20,
      approvedSnapshot,
      contentRevision: 1,
      updatedBy: "fixture",
      updatedAt: now,
    });
    const planned = await ctx.db.insert("plannedVisits", {
      generationKey: "signed",
      planId: plan,
      planVersion: 1,
      planSlotId: slot,
      assigneeProfileId: sales,
      outletId: outlet,
      serviceDate: date,
      status: "planned",
      approvedSnapshot,
      requiredObjectives: [],
      intents: ["sell"],
      expectedDurationMinutes: 20,
      generatedAt: now,
    });
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
      otherUnit,
      sales,
      other,
      manager,
      outlet,
      pin,
      plan,
      slot,
      planned,
      device,
      date,
    };
  });
  const sales = t.withIdentity({
    issuer: "https://auth.test",
    subject: "sales",
    email: "sales@test.local",
  });
  const manager = t.withIdentity({
    issuer: "https://auth.test",
    subject: "manager",
    email: "manager@test.local",
  });
  const other = t.withIdentity({
    issuer: "https://auth.test",
    subject: "other",
    email: "other@test.local",
  });
  const actor: AuthorizedDevice = {
    deviceId: ids.device,
    profileId: ids.sales,
    subject: "https://auth.test|sales",
    orgUnitId: ids.unit,
    role: "sales",
    scopeFingerprint: "fixture",
  };
  const fix = {
    latitude: 14.6,
    longitude: 121,
    accuracyMeters: 5,
    provider: "gps" as const,
    fixTime: now,
  };
  const check = (n = 1, location: typeof fix | null = fix) => ({
    kind: "visit.checkIn" as const,
    clientRequestId: uuid(n),
    payload: {
      clientVisitId: uuid(n + 100),
      plannedVisitId: ids.planned,
      outletId: ids.outlet,
      serviceDate: ids.date,
      deviceTime: now,
      location,
      intents: ["sell" as const],
    },
  });
  const apply = (operation: Parameters<typeof applyVisitOperation>[2]) =>
    sales.run((ctx) => applyVisitOperation(ctx, actor, operation));
  return { t, ids, sales, manager, other, actor, fix, check, apply };
}

describe("visit execution", () => {
  it("checks in within radius, records activity and checks out without productive credit; redacts events", async () => {
    const f = await fixture();
    try {
      const ack = await f.apply(f.check());
      const visitId = ack.entityId as Id<"visitExecutions">;
      const activity = await f.apply({
        kind: "visit.activity",
        clientRequestId: uuid(2),
        payload: {
          visitId,
          activity: { kind: "merchandising", displayCondition: "compliant" },
          deviceTime: now,
        },
      });
      await f.apply({
        kind: "visit.checkOut",
        clientRequestId: uuid(3),
        payload: {
          visitId,
          outcome: "completed",
          reasonCode: null,
          location: f.fix,
          deviceTime: now,
        },
      });
      const rows = await f.t.run((ctx) =>
        Promise.all([
          ctx.db.get(visitId),
          ctx.db.query("visitLocationEvidence").collect(),
          ctx.db.query("executionEvents").collect(),
          ctx.db.query("mobileChanges").collect(),
        ]),
      );
      expect(rows[0]).toMatchObject({
        state: "checked-out",
        productivity: "pending",
      });
      expect(rows[0]?.customerId).toBeUndefined();
      expect(rows[1].map((x) => x.reviewStatus)).toEqual([
        "verified",
        "verified",
      ]);
      expect(rows[2]).toHaveLength(3);
      expect(rows[3]).toHaveLength(3);
      expect(rows[2][0]).toMatchObject({
        actorSubject: f.actor.subject,
        occurredAt: now,
        serverAt: now,
      });
      expect(JSON.stringify(rows[2])).not.toContain("14.6");
      expect(activity.entityId).toBeTruthy();
      expect(
        await f.sales.query(api.visits.commands.detail, { visitId }),
      ).toMatchObject({ id: visitId, state: "checked-out" });
      expect(
        (
          await f.sales.query(api.visits.commands.forDay, {
            serviceDate: f.ids.date,
            paginationOpts: { numItems: 10, cursor: null },
          })
        ).page,
      ).toHaveLength(1);
      await expect(
        f.other.query(api.visits.commands.detail, { visitId }),
      ).rejects.toThrow(/own|scope/);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    "out_of_radius",
    "poor_accuracy",
    "stale",
    "mock",
    "no_fix",
    "no_pin",
  ])("keeps %s pending review", async (variant) => {
    const f = await fixture();
    try {
      if (variant === "no_pin")
        await f.t.run((ctx) =>
          ctx.db.patch(f.ids.pin, { status: "superseded" }),
        );
      const location =
        variant === "no_fix"
          ? null
          : variant === "out_of_radius"
            ? { ...f.fix, latitude: 14.61 }
            : variant === "poor_accuracy"
              ? { ...f.fix, accuracyMeters: 60 }
              : variant === "stale"
                ? { ...f.fix, fixTime: now - 61_000 }
                : variant === "mock"
                  ? { ...f.fix, mockSignal: true }
                  : f.fix;
      const ack = await f.apply(f.check(1, location));
      const evidence = await f.t.run((ctx) =>
        ctx.db.query("visitLocationEvidence").first(),
      );
      expect(evidence?.reviewStatus).toBe("pending_review");
      expect(
        (
          await f.t.run((ctx) =>
            ctx.db.get(ack.entityId as Id<"visitExecutions">),
          )
        )?.productivity,
      ).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects wrong date, cancelled plan, duplicate execution and other person's visit", async () => {
    const f = await fixture();
    try {
      await expect(
        f.apply({
          ...f.check(),
          payload: { ...f.check().payload, serviceDate: "2026-09-27" },
        }),
      ).rejects.toThrow(/wrong_date/);
      await f.t.run((ctx) =>
        ctx.db.patch(f.ids.planned, { status: "cancelled" }),
      );
      await expect(f.apply(f.check())).rejects.toThrow(/invalid_plan/);
      await f.t.run((ctx) =>
        ctx.db.patch(f.ids.planned, { status: "planned" }),
      );
      const ack = await f.apply(f.check());
      await expect(f.apply(f.check(2))).rejects.toThrow(/conflict/);
      await expect(
        f.other.run((ctx) =>
          applyVisitOperation(
            ctx,
            {
              ...f.actor,
              profileId: f.ids.other,
              subject: "https://auth.test|other",
            },
            {
              kind: "visit.activity",
              clientRequestId: uuid(5),
              payload: {
                visitId: ack.entityId as Id<"visitExecutions">,
                activity: { kind: "note", text: "test" },
                deviceTime: now,
              },
            },
          ),
        ),
      ).rejects.toThrow(/out_of_scope/);
    } finally {
      vi.useRealTimers();
    }
  });
  it("requires unplanned reason and assigned outlet", async () => {
    const f = await fixture();
    try {
      await expect(
        f.apply({
          ...f.check(),
          payload: { ...f.check().payload, plannedVisitId: null },
        }),
      ).rejects.toThrow(/invalid_request/);
      const ack = await f.apply({
        ...f.check(),
        payload: {
          ...f.check().payload,
          plannedVisitId: null,
          unplannedReason: "urgent_follow_up",
        },
      });
      expect(
        (
          await f.t.run((ctx) =>
            ctx.db.get(ack.entityId as Id<"visitExecutions">),
          )
        )?.source,
      ).toBe("unplanned");
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    { outcome: "completed", reasonCode: null, expectedCode: undefined },
    {
      outcome: "nonproductive",
      reasonCode: "store_closed",
      expectedCode: "store_closed",
    },
  ] as const)(
    "retains the unplanned check-in reason after $outcome check-out",
    async ({ outcome, reasonCode, expectedCode }) => {
      const f = await fixture();
      try {
        const ack = await f.apply({
          ...f.check(),
          payload: {
            ...f.check().payload,
            plannedVisitId: null,
            unplannedReason: "  urgent_follow_up  ",
          },
        });
        const visitId = ack.entityId as Id<"visitExecutions">;
        await f.apply({
          kind: "visit.checkOut",
          clientRequestId: uuid(2),
          payload: {
            visitId,
            outcome,
            reasonCode,
            deviceTime: now,
            location: f.fix,
          },
        });
        const row = await f.t.run((ctx) => ctx.db.get(visitId));
        expect(row?.unplannedReason).toBe("urgent_follow_up");
        expect(row?.reasonCode).toBe(expectedCode);
        expect(
          await f.manager.query(api.visits.commands.detail, { visitId }),
        ).toMatchObject({
          unplannedReason: "urgent_follow_up",
        });
        expect(
          (
            await f.sales.query(api.visits.commands.forDay, {
              serviceDate: f.ids.date,
              paginationOpts: { numItems: 10, cursor: null },
            })
          ).page[0]?.unplannedReason,
        ).toBe("urgent_follow_up");
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("approves an exception independently, never self-approves, retaining original proof", async () => {
    const f = await fixture();
    try {
      const ack = await f.apply(f.check(1, { ...f.fix, latitude: 14.61 }));
      const evidence = (await f.t.run((ctx) =>
        ctx.db.query("visitLocationEvidence").first(),
      ))!;
      await f.t.run(async (ctx) => {
        await ctx.db.patch(f.ids.sales, { role: "manager" });
        const assignment = await ctx.db
          .query("employeeAssignments")
          .withIndex("by_profileId_and_effectiveFrom", (q) =>
            q.eq("profileId", f.ids.sales),
          )
          .first();
        await ctx.db.patch(assignment!._id, { role: "manager" });
      });
      await expect(
        f.sales.mutation(api.visits.location.decideLocationException, {
          evidenceId: evidence._id,
          decision: "approve",
          reason: "field_review",
        }),
      ).rejects.toThrow(/self_approval_denied/);
      expect(
        await f.manager.mutation(api.visits.location.decideLocationException, {
          evidenceId: evidence._id,
          decision: "approve",
          reason: "field_review",
        }),
      ).toEqual({ reviewStatus: "approved_exception" });
      const after = (await f.t.run((ctx) => ctx.db.get(evidence._id)))!;
      expect(after).toEqual(evidence);
      await expect(
        f.manager.mutation(api.visits.location.decideLocationException, {
          evidenceId: evidence._id,
          decision: "reject",
          reason: "reconsidered",
        }),
      ).rejects.toThrow(/already_reviewed/);
      expect(
        (
          await f.t.run((ctx) =>
            ctx.db
              .query("executionEvents")
              .withIndex("by_entityType_and_entityId_and_serverAt", (q) =>
                q.eq("entityType", "visit").eq("entityId", evidence._id),
              )
              .first(),
          )
        )?.summary,
      ).toEqual({ after: "approved_exception", reasonCode: "field_review" });
      expect(
        (
          await f.t.run((ctx) =>
            ctx.db.get(ack.entityId as Id<"visitExecutions">),
          )
        )?.productivity,
      ).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects forged storage and unsupported task/collection kinds", async () => {
    const f = await fixture();
    try {
      const ack = await f.apply(f.check());
      const visitId = ack.entityId as Id<"visitExecutions">;
      const upload = await f.sales.mutation(
        api.visits.evidence.generateUploadUrl,
        { visitId },
      );
      expect(upload.url).toContain("http");
      await expect(
        f.sales.mutation(api.visits.evidence.attach, {
          visitId,
          storageId: "forged" as Id<"_storage">,
          mime: "image/jpeg",
          size: 10,
          checksum: "a".repeat(64),
          capturedAt: now,
        }),
      ).rejects.toThrow();
      for (const kind of ["task.complete", "collection.record"] as const)
        await expect(
          f.apply({ kind, clientRequestId: uuid(50) }),
        ).rejects.toThrow(/unsupported_operation/);
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects untrusted event summaries before writing either event or change", async () => {
    const f = await fixture();
    try {
      const { append } = await import("./events");
      await expect(
        f.sales.run((ctx) =>
          append(ctx, {
            orgUnitId: f.ids.unit,
            entityType: "visit",
            entityId: "forged",
            kind: "visit.checked_in",
            actorSubject: f.actor.subject,
            actorRole: "sales",
            actorOrgUnitId: f.ids.unit,
            source: "mobile",
            occurredAt: now,
            serverAt: now,
            summary: { after: "14.6,121.0" },
          }),
        ),
      ).rejects.toThrow(/invalid_event_summary/);
      expect(
        await f.t.run((ctx) => ctx.db.query("executionEvents").collect()),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
