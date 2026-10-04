import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import type { AuthorizedDevice } from "../mobile/types";
import { applyVisitOperation } from "./commands";
import { manilaDate } from "../coverage/validation";
import { dayCloseAt, nextDayCloseAt } from "./policy";

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
  it("AND-016: types phone photos, returns the original row on a lost-response retry and refuses a mismatched replay", async () => {
    const f = await fixture();
    try {
      const ack = await f.apply(f.check());
      const visitId = ack.entityId as Id<"visitExecutions">;
      const checksum = "b".repeat(64);
      // A real (unclaimed) upload: the retry's own fresh blob.
      const retryUpload = await f.t.run((ctx) =>
        ctx.storage.store(new Blob(["retry"])),
      );
      const base = {
        visitId,
        storageId: retryUpload,
        mime: "image/jpeg",
        size: 2048,
        checksum,
        capturedAt: now,
        photoType: "shelf_display",
        source: "mobile" as const,
      };
      // An unconfigured type never reaches the claim or storage checks.
      await expect(
        f.sales.mutation(api.visits.evidence.attach, {
          ...base,
          photoType: "selfie",
        }),
      ).rejects.toThrow(/invalid_request/);
      const original = await f.t.run(async (ctx) => {
        const visit = (await ctx.db.get(visitId))!;
        const storageId = await ctx.storage.store(new Blob(["photo"]));
        return ctx.db.insert("fieldEvidenceFiles", {
          organizationId: "sunpride",
          orgUnitId: visit.orgUnitId,
          storageId,
          visitId,
          ownerProfileId: f.ids.sales,
          outletId: visit.outletId,
          mime: "image/jpeg",
          sizeBytes: 2048,
          checksum,
          capturedAt: now,
          photoType: "shelf_display",
          uploadedAt: now,
          status: "pending",
        });
      });
      const claim = await f.sales.mutation(
        api.visits.evidence.generateUploadUrl,
        { visitId },
      );
      // Same bytes and metadata: the original row, no second file, the new claim untouched.
      await expect(
        f.sales.mutation(api.visits.evidence.attach, {
          ...base,
          checksum: checksum.toUpperCase(),
          uploadTokenRef: claim.uploadTokenRef,
        }),
      ).resolves.toEqual({ evidenceId: original });
      const after = await f.t.run(async (ctx) => ({
        files: await ctx.db
          .query("fieldEvidenceFiles")
          .withIndex("by_visitId_and_uploadedAt", (q) =>
            q.eq("visitId", visitId),
          )
          .collect(),
        claim: await ctx.db.get(
          claim.uploadTokenRef as Id<"evidenceUploadClaims">,
        ),
      }));
      expect(after.files).toHaveLength(1);
      expect(after.claim?.consumedAt).toBeUndefined();
      // The same bytes claimed with different metadata are a conflict, not a replay.
      for (const changed of [
        { capturedAt: now - 1 },
        { photoType: "price_tag" },
        { size: 2049 },
      ])
        await expect(
          f.sales.mutation(api.visits.evidence.attach, {
            ...base,
            ...changed,
          }),
        ).rejects.toThrow(/conflict/);
      // Another person's identical checksum is never treated as their replay.
      await expect(
        f.other.mutation(api.visits.evidence.attach, base),
      ).rejects.toThrow();
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

describe("field day rules (client call 2 Oct 2026)", () => {
  const HOUR = 3_600_000;
  type F = Awaited<ReturnType<typeof fixture>>;
  const checkOut = (
    f: F,
    n: number,
    visitId: Id<"visitExecutions">,
    deviceTime = Date.now(),
  ) =>
    f.apply({
      kind: "visit.checkOut",
      clientRequestId: uuid(n),
      payload: {
        visitId,
        outcome: "completed",
        reasonCode: null,
        deviceTime,
        location: { ...f.fix, fixTime: deviceTime },
      },
    });
  const unplanned = (f: F, n: number, deviceTime = Date.now()) => ({
    ...f.check(n, { ...f.fix, fixTime: deviceTime }),
    payload: {
      ...f.check(n).payload,
      plannedVisitId: null,
      intents: [],
      unplannedReason: "new_store_found",
      deviceTime,
      location: { ...f.fix, fixTime: deviceTime },
    },
  });

  it("closes the day at 10 PM Manila", () => {
    expect(dayCloseAt("2026-09-28")).toBe(Date.parse("2026-09-28T14:00:00Z"));
    expect(nextDayCloseAt(now)).toBe(Date.parse("2026-09-28T14:00:00Z"));
    expect(nextDayCloseAt(Date.parse("2026-09-28T14:00:00Z"))).toBe(
      Date.parse("2026-09-29T14:00:00Z"),
    );
    expect(nextDayCloseAt(Date.parse("2026-09-28T15:30:00Z"))).toBe(
      Date.parse("2026-09-29T14:00:00Z"),
    );
    // 00:30 Manila on the 29th is still before that day's close.
    expect(nextDayCloseAt(Date.parse("2026-09-28T16:30:00Z"))).toBe(
      Date.parse("2026-09-29T14:00:00Z"),
    );
  });

  it("records an Android fused fix with distance, radius, policy and mock indicator", async () => {
    const f = await fixture();
    try {
      // Exactly the wire shape the Android fused capture sends (mockSignal always explicit).
      await f.apply(
        f.check(1, {
          ...f.fix,
          provider: "fused",
          accuracyMeters: 12,
          mockSignal: false,
        } as unknown as typeof f.fix),
      );
      const evidence = await f.t.run((ctx) =>
        ctx.db.query("visitLocationEvidence").first(),
      );
      expect(evidence).toMatchObject({
        event: "check_in",
        provider: "fused",
        accuracyMeters: 12,
        mockSignal: false,
        result: "within_radius",
        reviewStatus: "verified",
        policyVersion: "field-day-2026-10-v2",
      });
      expect(evidence?.radiusMeters).toBeGreaterThan(0);
      expect(evidence?.distanceMeters).toBeGreaterThanOrEqual(0);
      expect(evidence?.pinId).toBe(f.ids.pin);
    } finally {
      vi.useRealTimers();
    }
  });

  it("has no distance limit: far fixes and bad pin data are recorded and flagged, never refused", async () => {
    const f = await fixture();
    try {
      const far = await f.apply(f.check(1, { ...f.fix, latitude: 14.7 }));
      const visitId = far.entityId as Id<"visitExecutions">;
      await f.t.run(async (ctx) => {
        // A second verified pin (bad master data) must not block the check-out either.
        const pin = (await ctx.db.get(f.ids.pin))!;
        const { _id, _creationTime, ...copy } = pin;
        void _id;
        void _creationTime;
        await ctx.db.insert("outletPins", { ...copy, radiusMeters: 900 });
      });
      await checkOut(f, 2, visitId);
      const evidence = await f.t.run((ctx) =>
        ctx.db
          .query("visitLocationEvidence")
          .withIndex("by_visitId_and_serverTime", (q) =>
            q.eq("visitId", visitId),
          )
          .collect(),
      );
      expect(evidence.map((e) => [e.event, e.result, e.reviewStatus])).toEqual([
        ["check_in", "outside_radius", "pending_review"],
        ["check_out", "unavailable", "pending_review"],
      ]);
      expect(evidence[0]).toMatchObject({
        latitude: 14.7,
        accuracyMeters: 5,
        provider: "gps",
      });
      expect(evidence[0]!.distanceMeters).toBeGreaterThan(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows one open call at a time and records Start, End and time per account", async () => {
    const f = await fixture();
    try {
      const start = now - 30 * 60_000;
      const ack = await f.apply({
        ...f.check(1, { ...f.fix, fixTime: start }),
        payload: {
          ...f.check(1).payload,
          deviceTime: start,
          location: { ...f.fix, fixTime: start },
        },
      });
      const visitId = ack.entityId as Id<"visitExecutions">;
      await expect(f.apply(unplanned(f, 2))).rejects.toThrow(/call_open/);
      await checkOut(f, 3, visitId, now);
      expect(
        await f.sales.query(api.visits.commands.detail, { visitId }),
      ).toMatchObject({
        state: "checked-out",
        startedAt: start,
        endedAt: now,
        callDurationMs: 30 * 60_000,
        lateReviewStatus: null,
      });
      expect((await f.apply(unplanned(f, 4))).entityId).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows the MCP order: an earlier planned stop must be closed first", async () => {
    const f = await fixture();
    try {
      const earlier = await f.t.run(async (ctx) => {
        await ctx.db.patch(f.ids.slot, { sequence: 2 });
        const slot = (await ctx.db.get(f.ids.slot))!;
        const planned = (await ctx.db.get(f.ids.planned))!;
        const outlet = await ctx.db.insert("outlets", {
          organizationId: "sunpride",
          code: "FIRST",
          name: "First stop",
          status: "active",
          custodianOrgUnitId: f.ids.unit,
          createdAt: now,
          updatedAt: now,
          createdBy: "fixture",
        });
        const { _id: s, _creationTime: sc, ...slotCopy } = slot;
        void s;
        void sc;
        const firstSlot = await ctx.db.insert("coveragePlanSlots", {
          ...slotCopy,
          slotKey: "zero",
          outletId: outlet,
          sequence: 1,
        });
        const { _id: p, _creationTime: pc, ...plannedCopy } = planned;
        void p;
        void pc;
        return ctx.db.insert("plannedVisits", {
          ...plannedCopy,
          generationKey: "first",
          planSlotId: firstSlot,
          outletId: outlet,
        });
      });
      await expect(f.apply(f.check(1))).rejects.toThrow(/mcp_order/);
      // Unplanned calls only need no open call.
      const extra = await f.apply(unplanned(f, 2));
      await checkOut(f, 3, extra.entityId as Id<"visitExecutions">);
      await expect(f.apply(f.check(4))).rejects.toThrow(/mcp_order/);
      await f.t.run(async (ctx) => {
        const stop = (await ctx.db.get(earlier))!;
        await ctx.db.insert("visitExecutions", {
          organizationId: "sunpride",
          clientVisitId: uuid(900),
          plannedVisitId: earlier,
          assigneeProfileId: f.ids.sales,
          outletId: stop.outletId,
          orgUnitId: f.ids.unit,
          serviceDate: f.ids.date,
          source: "planned",
          intents: ["sell"],
          state: "checked-out",
          productivity: "nonproductive",
          createdAt: now,
          lastServerTime: now,
        });
      });
      expect((await f.apply(f.check(5))).entityId).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts work after the 10 PM close, flags it late and holds it for supervisor review", async () => {
    const f = await fixture();
    try {
      vi.setSystemTime(dayCloseAt(f.ids.date) + 30 * 60_000);
      const ack = await f.apply(f.check(1));
      const visitId = ack.entityId as Id<"visitExecutions">;
      const visit = await f.t.run((ctx) => ctx.db.get(visitId));
      expect(visit).toMatchObject({
        lateReviewStatus: "pending_review",
        lateSyncAt: dayCloseAt(f.ids.date) + 30 * 60_000,
        startedAt: now,
      });
      const events = await f.t.run((ctx) =>
        ctx.db.query("executionEvents").collect(),
      );
      expect(events[0]?.summary).toEqual({
        after: "checked-in",
        reasonCode: "late_sync",
      });
      const queue = await f.manager.query(api.visits.review.lateQueue, {
        orgUnitId: f.ids.unit,
        paginationOpts: { numItems: 10, cursor: null },
      });
      expect(queue.page.map((row) => row.visitId)).toEqual([visitId]);
      await expect(
        f.sales.query(api.visits.review.lateQueue, {
          orgUnitId: f.ids.unit,
          paginationOpts: { numItems: 10, cursor: null },
        }),
      ).rejects.toThrow();
      await expect(
        f.sales.mutation(api.visits.review.decideLateSync, {
          visitId,
          decision: "accept",
          reason: "self",
        }),
      ).rejects.toThrow();
      expect(
        await f.manager.mutation(api.visits.review.decideLateSync, {
          visitId,
          decision: "accept",
          reason: "no_signal_area",
        }),
      ).toEqual({ lateReviewStatus: "accepted" });
      await expect(
        f.manager.mutation(api.visits.review.decideLateSync, {
          visitId,
          decision: "reject",
          reason: "again",
        }),
      ).rejects.toThrow(/already_reviewed/);
      // Further late work for the same call reopens the hold.
      await checkOut(f, 2, visitId, now + HOUR);
      expect(
        await f.sales.query(api.visits.commands.detail, { visitId }),
      ).toMatchObject({
        lateReviewStatus: "pending_review",
        callDurationMs: HOUR,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a day delivered the next morning, but never a check-in dated off the phone clock", async () => {
    const f = await fixture();
    try {
      vi.setSystemTime(now + 20 * HOUR); // 08:00 Manila the next day
      await expect(
        f.apply({
          ...f.check(1),
          payload: { ...f.check(1).payload, deviceTime: now + 20 * HOUR },
        }),
      ).rejects.toThrow(/wrong_date/);
      const ack = await f.apply(f.check(2));
      expect(
        (
          await f.t.run((ctx) =>
            ctx.db.get(ack.entityId as Id<"visitExecutions">),
          )
        )?.lateReviewStatus,
      ).toBe("pending_review");
      // The fix was taken at check-in time, so a late delivery is not "unreliable".
      expect(
        (await f.t.run((ctx) => ctx.db.query("visitLocationEvidence").first()))
          ?.result,
      ).toBe("within_radius");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives supervisors a per-day trace of check-in and check-out fixes", async () => {
    const f = await fixture();
    try {
      const ack = await f.apply(f.check(1, { ...f.fix, accuracyMeters: 12 }));
      const visitId = ack.entityId as Id<"visitExecutions">;
      vi.setSystemTime(now + 60_000);
      await checkOut(f, 2, visitId, now + 60_000);
      const trace = await f.manager.query(api.visits.review.trace, {
        profileId: f.ids.sales,
        serviceDate: f.ids.date,
      });
      expect(trace.closeAt).toBe(dayCloseAt(f.ids.date));
      expect(
        trace.points.map((p) => [p.event, p.accuracyMeters, p.result, p.late]),
      ).toEqual([
        ["check_in", 12, "within_radius", false],
        ["check_out", 5, "within_radius", false],
      ]);
      expect(trace.points[0]).toMatchObject({
        visitId,
        outletName: "Prospect",
        latitude: 14.6,
        longitude: 121,
      });
      await expect(
        f.sales.query(api.visits.review.trace, {
          profileId: f.ids.sales,
          serviceDate: f.ids.date,
        }),
      ).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("visit intents and required activity forms (AND-013)", () => {
  type F = Awaited<ReturnType<typeof fixture>>;
  const activity = (
    n: number,
    visitId: Id<"visitExecutions">,
    value: Parameters<typeof applyVisitOperation>[2] extends infer O
      ? O extends { kind: "visit.activity"; payload: { activity: infer A } }
        ? A
        : never
      : never,
  ) =>
    ({
      kind: "visit.activity",
      clientRequestId: uuid(n),
      payload: { visitId, activity: value, deviceTime: Date.now() },
    }) as const;
  const end = (
    f: F,
    n: number,
    visitId: Id<"visitExecutions">,
    outcome: "completed" | "nonproductive" = "completed",
  ) =>
    f.apply({
      kind: "visit.checkOut",
      clientRequestId: uuid(n),
      payload: {
        visitId,
        outcome,
        reasonCode: outcome === "nonproductive" ? "store_closed" : null,
        deviceTime: Date.now(),
        location: f.fix,
      },
    });
  const read = (f: F, visitId: Id<"visitExecutions">) =>
    f.t.run((ctx) => ctx.db.get(visitId));

  it("records a required form missing at End without refusing the queued End", async () => {
    const f = await fixture();
    try {
      const visitId = (await f.apply(f.check()))
        .entityId as Id<"visitExecutions">;
      await f.apply(activity(2, visitId, { kind: "note", text: "Buyer away" }));
      await end(f, 3, visitId);
      expect(await read(f, visitId)).toMatchObject({
        state: "checked-out",
        intents: ["sell"],
        missingActivities: ["call_sheet"],
        activityRuleVersion: "sell=visit-activities/2026-10-04",
      });
      expect(
        await f.sales.query(api.visits.commands.detail, { visitId }),
      ).toMatchObject({ intents: ["sell"], missingActivities: ["call_sheet"] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a multi-intent unplanned visit and clears every intent's required form", async () => {
    const f = await fixture();
    try {
      const visitId = (
        await f.apply({
          ...f.check(1),
          payload: {
            ...f.check(1).payload,
            plannedVisitId: null,
            intents: ["merchandise", "complaint"],
            unplannedReason: "Buyer called",
          },
        })
      ).entityId as Id<"visitExecutions">;
      await f.apply(
        activity(2, visitId, {
          kind: "merchandising",
          displayCondition: "needs_action",
          actionTaken: "Re-faced shelf",
        }),
      );
      await end(f, 3, visitId);
      expect(await read(f, visitId)).toMatchObject({
        intents: ["merchandise", "complaint"],
        missingActivities: ["note"],
      });
      const second = (
        await f.apply({
          ...f.check(4),
          payload: {
            ...f.check(4).payload,
            plannedVisitId: null,
            intents: ["merchandise", "complaint"],
            unplannedReason: "Second call",
          },
        })
      ).entityId as Id<"visitExecutions">;
      await f.apply(
        activity(5, second, {
          kind: "merchandising",
          displayCondition: "compliant",
        }),
      );
      await f.apply(activity(6, second, { kind: "note", text: "Fixed" }));
      await end(f, 7, second);
      expect((await read(f, second))?.missingActivities).toEqual([]);
      expect((await read(f, second))?.activityRuleVersion).toBe(
        "merchandise=visit-activities/2026-10-04,complaint=visit-activities/2026-10-04",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires no forms for a not-productive End", async () => {
    const f = await fixture();
    try {
      const visitId = (await f.apply(f.check()))
        .entityId as Id<"visitExecutions">;
      await end(f, 2, visitId, "nonproductive");
      expect((await read(f, visitId))?.missingActivities).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("judges the End by the office rule in effect when the call started", async () => {
    const f = await fixture();
    try {
      await f.t.run((ctx) =>
        ctx.db.insert("visitActivityRules", {
          organizationId: "sunpride",
          intent: "sell",
          activities: [
            { kind: "note", required: true },
            { kind: "call_sheet", required: false },
          ],
          effectiveFrom: now - 60_000,
          sourceRef: "Office rule",
          provisional: false,
          actorSubject: "fixture",
          createdAt: now,
        }),
      );
      const visitId = (await f.apply(f.check()))
        .entityId as Id<"visitExecutions">;
      await f.apply(activity(2, visitId, { kind: "note", text: "Done" }));
      await end(f, 3, visitId);
      const row = await read(f, visitId);
      expect(row?.missingActivities).toEqual([]);
      expect(row?.activityRuleVersion).toMatch(/^sell=rule:/);
    } finally {
      vi.useRealTimers();
    }
  });
});
