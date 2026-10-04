import { convexTest, type TestConvex } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { AuthorizedDevice } from "../mobile/types";
import schema from "../schema";
import { modules } from "../test.setup";

type Test = TestConvex<typeof schema>;
type Operation = FunctionArgs<
  typeof internal.mobile.push.applyOne
>["operation"];
const SERVICE_DATE = "2026-09-15"; // Tuesday, a selling day in Asia/Manila.
const MONTH = "2026-09";
const PREPARATION_TIME = Date.parse("2026-09-14T07:00:00+08:00");
const START = Date.parse(`${SERVICE_DATE}T08:00:00+08:00`);
const END = Date.parse(`${SERVICE_DATE}T08:30:00+08:00`);
const CLOSE = Date.parse(`${SERVICE_DATE}T22:00:00+08:00`);
const CUSTOMER_CODE = "CEBU-PILOT-CUSTOMER";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function story() {
  // Freeze only the domain clock, not Convex's scheduler timers. Each scenario
  // owns a fresh database: it can also run independently of the other scenarios.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PREPARATION_TIME);
  vi.stubEnv(
    "MOBILE_CURSOR_SECRET",
    "sfa-pilot-test-only-cursor-signing-key-32-bytes",
  );
  const t: Test = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({
    subject: "cebu-pilot-root",
    email: "jcing.jc@gmail.com",
    name: "Pilot administrator",
  });
  await root.mutation(api.domains.profiles.ensure, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const unit = await root.mutation(api.org.mutations.create, {
    code: "CEBU-PILOT",
    name: "Cebu field-sales pilot",
    typeCode: "REGION",
    parentId: rootUnitId,
    effectiveFrom: Date.now() + 1_000,
    reason: "Establish Cebu pilot scope",
  });
  vi.setSystemTime(PREPARATION_TIME + 2_000);
  const now = Date.now();
  const position = await t.run((ctx) =>
    ctx.db.insert("positions", {
      organizationId: "sunpride",
      code: "KAS",
      label: "Key Account Salesperson",
      category: "field",
      active: true,
      createdAt: now,
      updatedAt: now,
    }),
  );

  async function person(
    label: string,
    role: "sales" | "manager",
    supervisorId?: Id<"profiles">,
  ) {
    const email = `${label}@sfa-pilot.test`;
    await root.mutation(api.domains.profiles.invite, {
      email,
      name: label,
      role,
    });
    const caller = t.withIdentity({ subject: label, email, name: label });
    const profileId = await caller.mutation(api.domains.profiles.ensure, {});
    const profile = await caller.query(api.domains.profiles.current, {});
    if (!profile) throw new Error("Invited pilot person was not provisioned");
    // Master-data fixture only. No plan, execution, mobile ack, order or SAP
    // event is seeded; every business transition below uses a registered API.
    const assignmentId = await t.run(async (ctx) => {
      await ctx.db.patch(profileId, {
        orgUnitId: unit,
        positionId: role === "sales" ? position : undefined,
        channelScope: "KA",
        updatedAt: now,
      });
      for (const prior of await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", profileId),
        )
        .collect())
        await ctx.db.delete(prior._id);
      return ctx.db.insert("employeeAssignments", {
        profileId,
        orgUnitId: unit,
        role,
        positionId: role === "sales" ? position : undefined,
        supervisorId,
        effectiveFrom: now,
        actorSubject: "pilot-master-data-fixture",
        reason: "Assigned before the pilot service date",
        createdAt: now,
      });
    });
    return { caller, profileId, assignmentId, subject: profile.authSubject };
  }
  const manager = await person("cebu-supervisor", "manager");
  const sales = await person("cebu-salesperson", "sales", manager.profileId);

  const ids = await t.run(async (ctx) => {
    const territory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "CEBU-KA",
      name: "Cebu key accounts",
      status: "active",
      effectiveFrom: now,
      createdAt: now,
      updatedAt: now,
      createdBy: "pilot-master-data-fixture",
    });
    const route = await ctx.db.insert("routes", {
      organizationId: "sunpride",
      code: "CEBU-DAY",
      name: "Cebu pilot route",
      status: "active",
      effectiveFrom: now,
      createdAt: now,
      updatedAt: now,
      createdBy: "pilot-master-data-fixture",
    });
    const effective = {
      effectiveFrom: now,
      actorSubject: "pilot-master-data-fixture",
      reason: "Cebu pilot master data",
      createdAt: now,
    };
    await ctx.db.insert("territoryOwnerships", {
      territoryId: territory,
      orgUnitId: unit,
      ...effective,
    });
    await ctx.db.insert("territorySalespeople", {
      territoryId: territory,
      profileId: sales.profileId,
      kind: "primary",
      ...effective,
    });
    await ctx.db.insert("routeTerritories", {
      routeId: route,
      territoryId: territory,
      ...effective,
    });
    await ctx.db.insert("routeSalespeople", {
      routeId: route,
      profileId: sales.profileId,
      primary: true,
      ...effective,
    });
    const outlets: Id<"outlets">[] = [];
    for (let sequence = 1; sequence <= 6; sequence++) {
      const outlet = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: `CEBU-${sequence}`,
        name: `Cebu pilot store ${sequence}`,
        status: "active",
        custodianOrgUnitId: unit,
        createdAt: now,
        updatedAt: now,
        createdBy: "pilot-master-data-fixture",
      });
      await ctx.db.insert("outletAssignments", {
        outletId: outlet,
        territoryId: territory,
        routeId: route,
        sequence,
        ...effective,
      });
      await ctx.db.insert("outletPins", {
        outletId: outlet,
        latitude: 10.31 + sequence / 1_000,
        longitude: 123.9,
        radiusMeters: 75,
        source: "field",
        status: "verified",
        effectiveFrom: now,
        proposedBy: "pilot-master-data-fixture",
        proposedAt: now,
        verifiedBy: "pilot-master-data-fixture",
        verifiedAt: now,
        createdAt: now,
      });
      outlets.push(outlet);
    }
    const customer = await ctx.db.insert("customers", {
      code: CUSTOMER_CODE,
      name: "Cebu pilot store 1 customer",
      channel: "KA",
      territory: "CEBU-KA",
      creditLimit: 100_000,
      active: true,
      updatedAt: now,
    });
    await ctx.db.insert("outletCustomerLinks", {
      outletId: outlets[0]!,
      customerId: customer,
      source: "pilot-master-data-fixture",
      ...effective,
    });
    await ctx.db.insert("salesAssignments", {
      salespersonSubject: sales.subject,
      customerCode: CUSTOMER_CODE,
      territory: "CEBU-KA",
      active: true,
      updatedAt: now,
    });
    // The bound-device fixture mirrors mobile/push.test.ts. This exercises the
    // real push/pull authorization and persistence, not HTTP/WebCrypto enrolment.
    const credentialId = "cebu-pilot-credential";
    const device = await ctx.db.insert("registeredDevices", {
      organizationId: "sunpride",
      orgUnitId: unit,
      inventoryTag: "CEBU-PILOT-ANDROID-01",
      profileId: sales.profileId,
      boundSubject: sales.subject,
      allowedApp: "ANDROID",
      platform: "android",
      model: "Pilot test device",
      osVersion: "test",
      appVersion: "test",
      publicKey: "fixture-bound-key",
      credentialId,
      registeredAt: now,
      status: "active",
    });
    return { territory, route, outlets, customer, device, credentialId };
  });
  // pull.assertDevice checks the exact enrolment fingerprint. Use the full
  // server-provisioned tokenIdentifier, never the short JWT subject.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${sales.profileId}|${sales.subject}|${sales.assignmentId}|${unit}|sales|${ids.device}|ANDROID|${ids.credentialId}`,
    ),
  );
  const actor: AuthorizedDevice = {
    deviceId: ids.device,
    profileId: sales.profileId,
    subject: sales.subject,
    orgUnitId: unit,
    role: "sales",
    scopeFingerprint: Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
  };
  const apply = (operation: Operation) =>
    sales.caller.mutation(internal.mobile.push.applyOne, {
      actor,
      deviceId: ids.device,
      operation,
    });
  return { t, root, unit, sales, manager, ids, actor, apply };
}
type Story = Awaited<ReturnType<typeof story>>;

async function activatePilotDay(f: Story) {
  const plan = await f.sales.caller.mutation(api.coverage.plans.create, {
    assigneeProfileId: f.sales.profileId,
    localMonth: MONTH,
  });
  expect(plan.status).toBe("draft");
  expect(
    await f.sales.caller.mutation(api.coverage.plans.saveOutlets, {
      planId: plan._id,
      outlets: f.ids.outlets.map((outletId, index) => ({
        outletId,
        territoryId: f.ids.territory,
        routeId: f.ids.route,
        frequency: "custom" as const,
        preferredWeekdays: [],
        customLocalDates: [SERVICE_DATE],
        sequence: index + 1,
        priority: 1,
        expectedDurationMinutes: 30,
        requiredObjectives: ["sell", "merchandise"],
      })),
    }),
  ).toHaveLength(6);
  await f.sales.caller.mutation(api.coverage.plans.saveSlots, {
    planId: plan._id,
    slots: f.ids.outlets.map((outletId, index) => ({
      slotKey: `cebu-stop-${index + 1}`,
      serviceDate: SERVICE_DATE,
      kind: "outlet_visit" as const,
      outletId,
      routeId: f.ids.route,
      activityKind: "sell",
      requiredObjectives: ["sell", "merchandise"],
      intents: ["sell", "merchandise"],
      sequence: index + 1,
      expectedDurationMinutes: 30,
    })),
  });
  expect(
    (
      await f.sales.caller.mutation(api.coverage.plans.submit, {
        planId: plan._id,
      })
    ).status,
  ).toBe("submitted");
  await expect(
    f.sales.caller.mutation(api.coverage.plans.approve, { planId: plan._id }),
  ).rejects.toThrow(/Insufficient permission/);
  const approved = await f.manager.caller.mutation(api.coverage.plans.approve, {
    planId: plan._id,
  });
  expect(approved).toMatchObject({
    status: "approved",
    approvedBy: f.manager.subject,
    preparedBy: f.sales.subject,
    approverProfileId: f.manager.profileId,
  });
  expect(approved.approvalSignature).toBeTruthy();
  const signed = await f.sales.caller.query(api.coverage.plans.detail, {
    planId: plan._id,
  });
  const activation = await f.manager.caller.mutation(
    api.coverage.activation.activate,
    { planId: plan._id },
  );
  expect(activation.count).toBe(6);
  const planned = await f.sales.caller.query(
    api.coverage.activation.plannedForMonth,
    { assigneeProfileId: f.sales.profileId, localMonth: MONTH },
  );
  expect(planned).toHaveLength(6);
  const visits = [...planned].sort(
    (a, b) =>
      (a.approvedSnapshot.sequence ?? 0) - (b.approvedSnapshot.sequence ?? 0),
  );
  expect(visits.map((v) => v.outletId)).toEqual(f.ids.outlets);
  for (const visit of visits) {
    expect(visit).toMatchObject({
      planId: plan._id,
      planVersion: approved.version,
      assigneeProfileId: f.sales.profileId,
      serviceDate: SERVICE_DATE,
      status: "planned",
    });
    expect(visit.approvedSnapshot).toEqual(
      signed.slots.find((slot) => slot._id === visit.planSlotId)
        ?.approvedSnapshot,
    );
  }
  expect(
    (
      await f.sales.caller.query(api.coverage.plans.detail, {
        planId: plan._id,
      })
    ).plan,
  ).toMatchObject({
    status: "active",
    approvalSignature: approved.approvalSignature,
  });
  vi.setSystemTime(START);
  const check = (
    index: number,
    key: number,
  ): Extract<Operation, { kind: "visit.checkIn" }> => ({
    kind: "visit.checkIn",
    clientRequestId: uuid(key),
    payload: {
      clientVisitId: uuid(key + 100),
      plannedVisitId: visits[index]!._id,
      outletId: visits[index]!.outletId,
      serviceDate: SERVICE_DATE,
      deviceTime: START,
      location: {
        latitude: 10.31 + (index + 1) / 1_000,
        longitude: 123.9,
        accuracyMeters: 5,
        provider: "gps",
        fixTime: START,
      },
      intents: ["sell", "merchandise"],
    },
  });
  return { planId: plan._id, visits, check };
}

async function checkedIn(f: Story, operation: Operation) {
  const result = await f.apply(operation);
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted")
    throw new Error("Pilot check-in was rejected");
  return { result, visitId: result.ack.entityId as Id<"visitExecutions"> };
}

async function finishCall(
  f: Story,
  visitId: Id<"visitExecutions">,
  dependsOn: string,
) {
  const orderIntent = await f.apply({
    kind: "visit.activity",
    clientRequestId: uuid(2),
    dependsOn: [dependsOn],
    payload: {
      visitId,
      activity: {
        kind: "order_intent",
        clientOrderId: uuid(500),
        note: "Cebu PO captured offline",
      },
      deviceTime: START + 10 * 60_000,
    },
  });
  expect(orderIntent.status).toBe("accepted");
  const merchandising = await f.apply({
    kind: "visit.activity",
    clientRequestId: uuid(3),
    dependsOn: [uuid(2)],
    payload: {
      visitId,
      activity: {
        kind: "merchandising",
        displayCondition: "compliant",
        actionTaken: "Faced the shelf",
      },
      deviceTime: START + 15 * 60_000,
    },
  });
  expect(merchandising.status).toBe("accepted");
  expect(
    (
      await f.apply({
        kind: "visit.checkOut",
        clientRequestId: uuid(4),
        dependsOn: [uuid(3)],
        payload: {
          visitId,
          outcome: "completed",
          reasonCode: null,
          deviceTime: END,
          location: {
            latitude: 10.311,
            longitude: 123.9,
            accuracyMeters: 5,
            provider: "gps",
            fixTime: END,
          },
        },
      })
    ).status,
  ).toBe("accepted");
  expect(
    await f.sales.caller.query(api.visits.commands.detail, { visitId }),
  ).toMatchObject({
    state: "checked-out",
    plannedVisitId: expect.any(String),
    callDurationMs: 30 * 60_000,
  });
}

function orderArgs(clientRequestId = uuid(500)) {
  return {
    clientRequestId,
    customerCode: CUSTOMER_CODE,
    offlineCreatedAt: START + 10 * 60_000,
    lines: [
      {
        productCode: "SP-PJ-1L",
        description: "Pineapple Juice",
        quantity: 2,
        unitPrice: 100,
      },
    ],
  };
}

async function approvedOrder(f: Story) {
  const orderId = await f.sales.caller.mutation(
    api.domains.orders.create,
    orderArgs(),
  );
  expect(
    await f.sales.caller.mutation(api.domains.orders.create, orderArgs()),
  ).toBe(orderId);
  await expect(
    f.sales.caller.mutation(api.domains.orders.decide, {
      orderId,
      decision: "approved",
    }),
  ).rejects.toThrow(/Insufficient permission/);
  await f.manager.caller.mutation(api.domains.orders.decide, {
    orderId,
    decision: "approved",
    comment: "Cebu pilot approved",
  });
  const event = await f.t.run((ctx) =>
    ctx.db
      .query("integrationEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", `order-${orderId}`))
      .unique(),
  );
  if (!event)
    throw new Error("Approved order did not enqueue SAP outbound task");
  expect(event).toMatchObject({
    direction: "outbound",
    eventType: "sales-order.submit",
    status: "pending",
    attempts: 0,
    payload: { orderId, customerCode: CUSTOMER_CODE, total: 200 },
  });
  expect(
    (await f.manager.caller.query(api.domains.orders.list, {})).find(
      (order) => order._id === orderId,
    )?.status,
  ).toBe("approved");
  return { orderId, event };
}

async function mobileRows(t: Test) {
  return t.run(async (ctx) => ({
    visits: await ctx.db.query("visitExecutions").collect(),
    activities: await ctx.db.query("visitActivities").collect(),
    evidence: await ctx.db.query("visitLocationEvidence").collect(),
    events: await ctx.db.query("executionEvents").collect(),
    changes: await ctx.db.query("mobileChanges").collect(),
    operations: await ctx.db.query("processedMobileOperations").collect(),
  }));
}

describe("SP-0026 Cebu SFA pilot acceptance (real Convex functions)", () => {
  it("UAT-E2E-01 happy pilot day signs MCP, syncs a call, posts an approved order to SAP and monitors completion", async () => {
    const f = await story();
    const day = await activatePilotDay(f);
    const boot = await f.sales.caller.query(
      internal.mobile.bootstrap.snapshot,
      { actor: f.actor },
    );
    expect(boot.employee.id).toBe(f.sales.profileId);
    expect(boot.plannedVisits).toHaveLength(6);
    if (!boot.syncCursor) throw new Error("Pilot bootstrap did not finish");
    const first = day.check(0, 1);
    vi.setSystemTime(END); // Offline Start/forms/End arrive together on reconnect.
    const { visitId } = await checkedIn(f, first);
    await finishCall(f, visitId, first.clientRequestId);
    const rows = await mobileRows(f.t);
    expect(rows.visits).toHaveLength(1);
    expect(rows.activities.map((row) => row.activity.kind).sort()).toEqual([
      "merchandising",
      "order_intent",
    ]);
    expect(rows.operations).toHaveLength(4);
    expect(rows.evidence.every((row) => row.result === "within_radius")).toBe(
      true,
    );
    // An intent is visit evidence, not an order: the actual order uses the
    // existing order API. Mobile bootstrap explicitly disables order capture.
    expect(boot.appConfig.orderCaptureEnabled).toBe(false);
    expect(await f.sales.caller.query(api.domains.orders.list, {})).toEqual([]);
    const { orderId, event } = await approvedOrder(f);
    // Prove requester separation even when the requester HAS order.approve.
    const own = await f.manager.caller.mutation(
      api.domains.orders.create,
      orderArgs(uuid(501)),
    );
    await expect(
      f.manager.caller.mutation(api.domains.orders.decide, {
        orderId: own,
        decision: "approved",
      }),
    ).rejects.toThrow(/Requester cannot approve own order/);
    expect(
      (await f.manager.caller.query(api.domains.orders.list, {})).find(
        (order) => order._id === own,
      )?.status,
    ).toBe("pending_approval");
    const tasks = await f.t.query(internal.integration.sap.pendingTasks, {
      limit: 25,
      now: Date.now(),
    });
    expect(tasks.map((task) => task.eventId)).toEqual([event.eventId]);
    await f.t.mutation(internal.integration.sap.acknowledgeTask, {
      eventId: event.eventId,
      success: true,
      sapDocumentNumber: "CEBU-SAP-450000026",
    });
    expect(await f.t.run((ctx) => ctx.db.get(event._id))).toMatchObject({
      status: "completed",
      attempts: 1,
      externalDocumentNumber: "CEBU-SAP-450000026",
      acknowledgedAt: END,
    });
    expect(
      (await f.sales.caller.query(api.domains.orders.list, {})).find(
        (order) => order._id === orderId,
      ),
    ).toMatchObject({
      status: "sent_to_sap",
      sapDocumentNumber: "CEBU-SAP-450000026",
    });
    expect(
      await f.t.query(internal.integration.sap.pendingTasks, {
        limit: 25,
        now: Date.now(),
      }),
    ).toEqual([]);
    const pull = await f.sales.caller.query(internal.mobile.pull.delta, {
      actor: f.actor,
      cursor: boot.syncCursor,
      limit: 50,
    });
    expect(pull.hasMore).toBe(false);
    expect(
      pull.changes.filter((change) => change.entity === "visit"),
    ).toHaveLength(2);
    expect(pull.changes).toContainEqual(
      expect.objectContaining({
        entity: "visit",
        id: visitId,
        op: "upsert",
        value: expect.objectContaining({
          id: visitId,
          plannedVisitId: day.visits[0]!._id,
          state: "checked-out",
        }),
      }),
    );
    expect(
      (
        await f.sales.caller.query(internal.mobile.pull.delta, {
          actor: f.actor,
          cursor: pull.nextCursor,
        })
      ).changes,
    ).toEqual([]);
    const team = await f.manager.caller.query(api.supervision.team.day, {
      serviceDate: SERVICE_DATE,
    });
    expect(
      team.people.find((person) => person.profileId === f.sales.profileId),
    ).toMatchObject({
      direct: true,
      planned: 6,
      plannedDone: 1,
      done: 1,
      inProgress: false,
      lateSync: 0,
    });
    const map = await f.manager.caller.query(api.supervision.activity.map, {
      serviceDate: SERVICE_DATE,
      profileId: f.sales.profileId,
    });
    expect(
      map.people[0]?.stops.find((stop) => stop.visitId === visitId),
    ).toMatchObject({
      sequence: 1,
      state: "checked-out",
      source: "planned",
      outletCode: "CEBU-1",
    });
  });

  it("UAT-E2E-02 offline replay is idempotent, payload conflicts and missing dependencies reject, and MCP call order is enforced", async () => {
    const f = await story();
    const day = await activatePilotDay(f);
    const second = day.check(1, 10);
    await expect(f.apply(second)).rejects.toThrow(/mcp_order/);
    expect((await mobileRows(f.t)).visits).toEqual([]);
    const first = day.check(0, 1);
    const { result, visitId } = await checkedIn(f, first);
    const before = await mobileRows(f.t);
    vi.setSystemTime(END);
    expect(await f.apply(first)).toEqual(result);
    expect(await mobileRows(f.t)).toEqual(before);
    expect(
      await f.apply({
        ...first,
        payload: { ...first.payload, deviceTime: START + 1 },
      }),
    ).toEqual({ status: "conflict", code: "conflict" });
    const dependent: Operation = {
      kind: "visit.activity",
      clientRequestId: uuid(20),
      dependsOn: [uuid(99)],
      payload: {
        visitId,
        activity: { kind: "note", text: "Wait for check-in acknowledgement" },
        deviceTime: START,
      },
    };
    expect(await f.apply(dependent)).toEqual({
      status: "rejected",
      code: "dependency_missing",
    });
    await expect(f.apply(second)).rejects.toThrow(/call_open/);
    expect(await mobileRows(f.t)).toEqual(before);
    // Rejections must not consume a key: the same activity can be retried after
    // its actual check-in dependency is known, then the same next-store key works.
    expect(
      (await f.apply({ ...dependent, dependsOn: [first.clientRequestId] }))
        .status,
    ).toBe("accepted");
    await finishCall(f, visitId, first.clientRequestId);
    const next = await checkedIn(f, second);
    expect(
      await f.sales.caller.query(api.visits.commands.detail, {
        visitId: next.visitId,
      }),
    ).toMatchObject({ outletId: f.ids.outlets[1], state: "checked-in" });
    const final = await mobileRows(f.t);
    expect(final.visits).toHaveLength(2);
    expect(final.operations).toHaveLength(6);
  });

  it("UAT-E2E-03a a pilot call arriving after the 22:00 Manila close enters the supervisor late queue and can be decided", async () => {
    const f = await story();
    const day = await activatePilotDay(f);
    const first = day.check(0, 1);
    vi.setSystemTime(CLOSE + 30 * 60_000);
    const { visitId } = await checkedIn(f, first);
    await finishCall(f, visitId, first.clientRequestId);
    expect(await f.t.run((ctx) => ctx.db.get(visitId))).toMatchObject({
      startedAt: START,
      endedAt: END,
      lateSyncAt: CLOSE + 30 * 60_000,
      lateReviewStatus: "pending_review",
    });
    const queueArgs = {
      orgUnitId: f.unit,
      paginationOpts: { numItems: 10, cursor: null },
    };
    const queue = await f.manager.caller.query(
      api.visits.review.lateQueue,
      queueArgs,
    );
    expect(queue.page).toMatchObject([
      {
        visitId,
        assigneeProfileId: f.sales.profileId,
        serviceDate: SERVICE_DATE,
        closeAt: CLOSE,
      },
    ]);
    expect(queue.isDone).toBe(true);
    expect(
      (
        await f.manager.caller.query(api.supervision.team.day, {
          serviceDate: SERVICE_DATE,
        })
      ).people.find((person) => person.profileId === f.sales.profileId)
        ?.lateSync,
    ).toBe(1);
    await expect(
      f.sales.caller.mutation(api.visits.review.decideLateSync, {
        visitId,
        decision: "accept",
        reason: "self",
      }),
    ).rejects.toThrow(/Insufficient permission/);
    expect(
      await f.manager.caller.mutation(api.visits.review.decideLateSync, {
        visitId,
        decision: "accept",
        reason: "no_signal_area",
      }),
    ).toEqual({ lateReviewStatus: "accepted" });
    expect(
      await f.sales.caller.query(api.visits.commands.detail, { visitId }),
    ).toMatchObject({ lateReviewStatus: "accepted", state: "checked-out" });
    expect(
      (await f.manager.caller.query(api.visits.review.lateQueue, queueArgs))
        .page,
    ).toEqual([]);
    const decisionEvents = await f.t.run((ctx) =>
      ctx.db.query("executionEvents").collect(),
    );
    expect(decisionEvents).toContainEqual(
      expect.objectContaining({
        entityId: visitId,
        kind: "visit.late_sync.decided",
        actorSubject: f.manager.subject,
        summary: { after: "accepted", reasonCode: "no_signal_area" },
      }),
    );
    await expect(
      f.manager.caller.mutation(api.visits.review.decideLateSync, {
        visitId,
        decision: "reject",
        reason: "again",
      }),
    ).rejects.toThrow(/already_reviewed/);
  });

  it("UAT-E2E-03b SAP failures keep the approved order pending with exponential backoff and dead-letter the tenth failure", async () => {
    const f = await story();
    vi.setSystemTime(END);
    const { orderId, event } = await approvedOrder(f);
    for (let attempt = 1; attempt <= 10; attempt++) {
      const attemptAt = Date.now();
      const tasks = await f.t.query(internal.integration.sap.pendingTasks, {
        limit: 25,
        now: attemptAt,
      });
      expect(tasks).toMatchObject([
        { eventId: event.eventId, attempts: attempt - 1 },
      ]);
      await f.t.mutation(internal.integration.sap.acknowledgeTask, {
        eventId: event.eventId,
        success: false,
        error: `SAP unavailable, attempt ${attempt}`,
      });
      const stored = await f.t.run((ctx) => ctx.db.get(event._id));
      expect(stored).toMatchObject({
        attempts: attempt,
        status: attempt === 10 ? "dead_letter" : "pending",
        lastError: `SAP unavailable, attempt ${attempt}`,
        nextAttemptAt: attemptAt + Math.min(60_000, 1_000 * 2 ** (attempt - 1)),
      });
      expect(stored?.processedAt).toBeUndefined();
      expect(stored?.acknowledgedAt).toBeUndefined();
      if (!stored?.nextAttemptAt)
        throw new Error("Failed SAP task has no backoff");
      expect(
        await f.t.query(internal.integration.sap.pendingTasks, {
          limit: 25,
          now: stored.nextAttemptAt - 1,
        }),
      ).toEqual([]);
      vi.setSystemTime(stored.nextAttemptAt);
    }
    expect(
      await f.t.query(internal.integration.sap.pendingTasks, {
        limit: 25,
        now: Date.now(),
      }),
    ).toEqual([]);
    expect(
      (await f.sales.caller.query(api.domains.orders.list, {})).find(
        (order) => order._id === orderId,
      ),
    ).toMatchObject({ status: "approved" });
    expect(
      (await f.sales.caller.query(api.domains.orders.list, {})).find(
        (order) => order._id === orderId,
      )?.sapDocumentNumber,
    ).toBeUndefined();
  });
});
