import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { localDate, manilaDate } from "../coverage/validation";
import type { AuthorizedDevice } from "../mobile/types";

/**
 * Field sales pilot acceptance (CVX-035): one salesperson's day across
 * domains. A signed MCP is approved and activated into planned visits; the
 * phone executes the planned call offline (check-in → order intent → End)
 * through the mobile push gateway; a lost-ack retry of the whole batch is a
 * no-op; and nobody else can execute or replay that call.
 */
type T = TestConvex<typeof schema>;
type Operation = FunctionArgs<
  typeof internal.mobile.push.applyOne
>["operation"];
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
afterEach(() => vi.useRealTimers());

async function pilotDay() {
  const t: T = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const month = manilaDate(Date.now() + 40 * 86_400_000).slice(0, 7);
  const date = `${month}-15`;
  const since = Date.now() - 100_000_000;
  const [cebu, position] = await t.run(async (ctx) => [
    await ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      code: "CEBU",
      name: "Cebu",
      typeCode: "REGION",
      parentId: rootUnitId,
      status: "active",
      effectiveFrom: since,
      createdAt: since,
      updatedAt: since,
    }),
    await ctx.db.insert("positions", {
      organizationId: "sunpride",
      code: "PSR",
      label: "PSR",
      category: "field",
      active: true,
      createdAt: since,
      updatedAt: since,
    }),
  ]);
  async function person(role: "sales" | "manager", name: string) {
    const email = `${name}@example.test`;
    await root.mutation(api.domains.profiles.invite, { email, role });
    const actor = t.withIdentity({ subject: name, email });
    await actor.mutation(api.domains.profiles.ensure, {});
    const profile = (await actor.query(api.domains.profiles.current, {}))!;
    await t.run(async (ctx) => {
      await ctx.db.patch(profile._id, { orgUnitId: cebu, role });
      for (const prior of await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", profile._id),
        )
        .collect())
        await ctx.db.delete(prior._id);
      await ctx.db.insert("employeeAssignments", {
        profileId: profile._id,
        orgUnitId: cebu,
        role,
        positionId: position,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
    });
    return { actor, id: profile._id, subject: profile.authSubject };
  }
  const sales = await person("sales", "pilot-psr");
  const peer = await person("sales", "pilot-peer");
  const manager = await person("manager", "pilot-manager");
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("positionStandards", {
      organizationId: "sunpride",
      positionId: position,
      effectiveFrom: since,
      dailyCallsTarget: 5,
      sourceRef: "memo §I",
      createdAt: since,
      updatedAt: since,
    });
    const territory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "CEB-1",
      name: "Cebu 1",
      status: "active",
      effectiveFrom: since,
      createdAt: since,
      updatedAt: since,
      createdBy: "fixture",
    });
    await ctx.db.insert("territoryOwnerships", {
      territoryId: territory,
      orgUnitId: cebu,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    const route = await ctx.db.insert("routes", {
      organizationId: "sunpride",
      code: "CEB-R1",
      name: "Cebu route 1",
      status: "active",
      effectiveFrom: since,
      createdAt: since,
      updatedAt: since,
      createdBy: "fixture",
    });
    await ctx.db.insert("routeTerritories", {
      routeId: route,
      territoryId: territory,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    await ctx.db.insert("routeSalespeople", {
      routeId: route,
      profileId: sales.id,
      primary: true,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    // One salesperson per territory at a time: the teammate is in the same
    // region but does not own this store.
    await ctx.db.insert("territorySalespeople", {
      territoryId: territory,
      profileId: sales.id,
      kind: "primary",
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    const outlet = await ctx.db.insert("outlets", {
      organizationId: "sunpride",
      code: "CEB-O1",
      name: "Sari-sari Store",
      status: "active",
      custodianOrgUnitId: cebu,
      createdAt: since,
      updatedAt: since,
      createdBy: "fixture",
    });
    await ctx.db.insert("outletAssignments", {
      outletId: outlet,
      territoryId: territory,
      routeId: route,
      sequence: 1,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    const customer = await ctx.db.insert("customers", {
      code: "CEB-C1",
      name: "Store customer",
      channel: "GT",
      territory: "CEB-1",
      creditLimit: 0,
      active: true,
      updatedAt: since,
    });
    await ctx.db.insert("outletCustomerLinks", {
      outletId: outlet,
      customerId: customer,
      source: "fixture",
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    const device = (
      profileId: Id<"profiles">,
      boundSubject: string,
      tag: string,
    ) =>
      ctx.db.insert("registeredDevices", {
        organizationId: "sunpride",
        orgUnitId: cebu,
        inventoryTag: tag,
        profileId,
        boundSubject,
        allowedApp: "ANDROID",
        platform: "android",
        model: "test",
        osVersion: "1",
        appVersion: "1",
        publicKey: "key",
        credentialId: tag,
        registeredAt: since,
        status: "active",
      });
    return {
      route,
      outlet,
      customer,
      device: await device(sales.id, sales.subject, "PSR-PHONE"),
      peerDevice: await device(peer.id, peer.subject, "PEER-PHONE"),
    };
  });
  const actorFor = (
    who: typeof sales,
    deviceId: Id<"registeredDevices">,
  ): AuthorizedDevice => ({
    deviceId,
    profileId: who.id,
    orgUnitId: cebu,
    role: "sales",
    subject: who.subject,
    scopeFingerprint: "fixture",
  });
  const push = (
    who: typeof sales,
    deviceId: Id<"registeredDevices">,
    operation: Operation,
  ) =>
    who.actor.mutation(internal.mobile.push.applyOne, {
      deviceId,
      actor: actorFor(who, deviceId),
      operation,
    });
  const counts = () =>
    t.run(async (ctx) => ({
      visits: (await ctx.db.query("visitExecutions").collect()).length,
      activities: (await ctx.db.query("visitActivities").collect()).length,
      events: (await ctx.db.query("executionEvents").collect()).length,
      changes: (await ctx.db.query("mobileChanges").collect()).length,
      processed: (await ctx.db.query("processedMobileOperations").collect())
        .length,
    }));
  return {
    t,
    month,
    date,
    sales,
    peer,
    manager,
    ...ids,
    push,
    counts,
  };
}

describe("field sales pilot day (MCP → mobile visit → order intent)", () => {
  it("executes an activated MCP call offline, replays the batch safely and keeps it the assignee's", async () => {
    const f = await pilotDay();
    // 1. The PSR authors and submits the month's MCP; the manager signs it.
    const plan = await f.sales.actor.mutation(api.coverage.plans.create, {
      assigneeProfileId: f.sales.id,
      localMonth: f.month,
    });
    await f.sales.actor.mutation(api.coverage.plans.saveSlots, {
      planId: plan._id,
      slots: [
        {
          slotKey: "store-1",
          serviceDate: f.date,
          kind: "outlet_visit",
          outletId: f.outlet,
          routeId: f.route,
          activityKind: "sell",
          requiredObjectives: [],
          intents: ["sell"],
          sequence: 1,
          expectedDurationMinutes: 30,
        },
      ],
    });
    await f.sales.actor.mutation(api.coverage.plans.submit, {
      planId: plan._id,
    });
    await expect(
      f.sales.actor.mutation(api.coverage.plans.approve, { planId: plan._id }),
    ).rejects.toThrow();
    await f.manager.actor.mutation(api.coverage.plans.approve, {
      planId: plan._id,
    });

    // 2. On the service day (10:00 Manila) the plan activates into visits.
    vi.useFakeTimers();
    const dayStart = localDate(f.date);
    vi.setSystemTime(dayStart + 10 * 3_600_000);
    expect(
      await f.t.mutation(internal.coverage.activation.activateDue, {}),
    ).toBe(1);
    const [planned] = await f.sales.actor.query(
      api.coverage.activation.plannedForMonth,
      { assigneeProfileId: f.sales.id, localMonth: f.month },
    );
    expect(planned).toMatchObject({
      outletId: f.outlet,
      serviceDate: f.date,
      status: "planned",
    });
    const plannedVisitId = planned!._id as Id<"plannedVisits">;

    // 3. The phone queued the whole call offline and now pushes it in order.
    const deviceTime = Date.now() - 60_000;
    const checkIn: Operation = {
      kind: "visit.checkIn",
      clientRequestId: uuid(1),
      payload: {
        clientVisitId: uuid(101),
        plannedVisitId,
        outletId: f.outlet,
        serviceDate: f.date,
        deviceTime,
        location: null,
        intents: ["sell"],
      },
    };
    const checkInAck = await f.push(f.sales, f.device, checkIn);
    if (checkInAck.status !== "accepted")
      throw new Error(`check-in ${JSON.stringify(checkInAck)}`);
    const visitId = checkInAck.ack.entityId as Id<"visitExecutions">;
    const orderIntent: Operation = {
      kind: "visit.activity",
      clientRequestId: uuid(2),
      dependsOn: [uuid(1)],
      payload: {
        visitId,
        activity: {
          kind: "order_intent",
          clientOrderId: uuid(201),
          note: "2 cases pineapple juice",
        },
        deviceTime,
      },
    };
    const checkOut: Operation = {
      kind: "visit.checkOut",
      clientRequestId: uuid(3),
      dependsOn: [uuid(2)],
      payload: {
        visitId,
        outcome: "completed",
        reasonCode: null,
        deviceTime,
        location: null,
      },
    };
    const intentAck = await f.push(f.sales, f.device, orderIntent);
    const outAck = await f.push(f.sales, f.device, checkOut);
    expect(intentAck.status).toBe("accepted");
    expect(outAck.status).toBe("accepted");

    const stored = await f.t.run(async (ctx) => ({
      visit: await ctx.db.get(visitId),
      activities: (await ctx.db.query("visitActivities").collect()).filter(
        (row) => row.visitId === visitId,
      ),
    }));
    // The execution is bound to the signed plan, slot and version.
    expect(stored.visit).toMatchObject({
      plannedVisitId,
      planId: plan._id,
      planVersion: planned!.planVersion,
      source: "planned",
      assigneeProfileId: f.sales.id,
      outletId: f.outlet,
      customerId: f.customer,
      routeId: f.route,
      intents: ["sell"],
    });
    expect(stored.visit?.state).not.toBe("checked-in");
    expect(stored.visit?.unplannedReason).toBeUndefined();
    expect(stored.activities).toHaveLength(1);
    expect(stored.activities[0]?.activity).toMatchObject({
      kind: "order_intent",
      clientOrderId: uuid(201),
    });
    const dayView = await f.sales.actor.query(api.visits.commands.forDay, {
      serviceDate: f.date,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(JSON.stringify(dayView)).toContain(visitId);

    // 4. Acks were lost: the phone resends the whole batch after reconnecting.
    const before = await f.counts();
    expect(before).toMatchObject({ visits: 1, activities: 1, processed: 3 });
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect(await f.push(f.sales, f.device, checkIn)).toEqual(checkInAck);
    expect(await f.push(f.sales, f.device, orderIntent)).toEqual(intentAck);
    expect(await f.push(f.sales, f.device, checkOut)).toEqual(outAck);
    expect(await f.counts()).toEqual(before);

    // 5. The same planned call cannot be executed twice, edited on replay,
    // or taken over by a teammate's phone.
    await expect(
      f.push(f.sales, f.device, {
        ...checkIn,
        clientRequestId: uuid(4),
        payload: { ...checkIn.payload, clientVisitId: uuid(104) },
      } as Operation),
    ).rejects.toThrow(/invalid_plan|conflict/);
    expect(
      await f.push(f.sales, f.device, {
        ...orderIntent,
        payload: {
          ...orderIntent.payload,
          activity: { kind: "note", text: "edited after the fact" },
        },
      } as Operation),
    ).toEqual({ status: "conflict", code: "conflict" });
    await expect(
      f.push(f.peer, f.peerDevice, {
        ...checkIn,
        clientRequestId: uuid(5),
        payload: { ...checkIn.payload, clientVisitId: uuid(105) },
      } as Operation),
    ).rejects.toThrow(/invalid_plan|out_of_scope/);
    await expect(
      f.push(f.peer, f.peerDevice, {
        ...orderIntent,
        clientRequestId: uuid(6),
        dependsOn: [],
      } as Operation),
    ).rejects.toThrow(/out_of_scope/);
    // A teammate replaying the PSR's exact operation is refused by scope
    // reauthorization before the replay registry is even consulted.
    await expect(f.push(f.peer, f.peerDevice, checkIn)).rejects.toThrow(
      /invalid_plan/,
    );
    expect(await f.counts()).toEqual(before);
  });
});
