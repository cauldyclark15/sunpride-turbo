import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id, TableNames } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { NO_SALES_DUE_TO_INVENTORY } from "./productive_call";

type Test = TestConvex<typeof schema>;

// The scorecard never dereferences planned visits, outlets or routes, so dangling ids of the
// right table (convex-test's `<counter><table>` format) keep the fixture small.
let fakeCounter = 900000;
function fakeId<T extends TableNames>(table: T): Id<T> {
  fakeCounter += 1;
  return `${fakeCounter}${table}` as Id<T>;
}

const SATURDAY = "2026-10-03";
const SUNDAY = "2026-10-04";

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  await t.mutation(internal.sfa.setup.foundation, {});
  // Standards were seeded "now"; backdate them so past service dates are covered.
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("positionStandards").collect())
      await ctx.db.patch(row._id, { effectiveFrom: 0 });
  });
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  const unit = async (code: string) =>
    t.run((ctx) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: "AREA",
        parentId: rootUnitId,
        status: "active",
        effectiveFrom: 0,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
  const areaA = await unit("A");
  const areaB = await unit("B");
  const position = async (code: string) =>
    (await t.run((ctx) =>
      ctx.db
        .query("positions")
        .withIndex("by_organizationId_and_code", (q) =>
          q.eq("organizationId", "sunpride").eq("code", code),
        )
        .unique(),
    ))!._id;

  async function person(
    name: string,
    role: "sales" | "manager" | "viewer",
    orgUnitId: Id<"orgUnits">,
    positionCode?: string,
  ) {
    const email = `${name}@example.test`;
    await root.mutation(api.domains.profiles.invite, { email, role });
    const actor = t.withIdentity({ subject: name, email });
    const profileId = await actor.mutation(api.domains.profiles.ensure, {});
    const positionId = positionCode ? await position(positionCode) : undefined;
    await t.run(async (ctx) => {
      await ctx.db.patch(profileId, { orgUnitId, positionId });
      for (const row of await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", profileId),
        )
        .collect())
        await ctx.db.delete(row._id);
      await ctx.db.insert("employeeAssignments", {
        profileId,
        orgUnitId,
        role,
        positionId,
        effectiveFrom: 0,
        actorSubject: "test",
        reason: "fixture",
        createdAt: 1,
      });
    });
    return { actor, profileId };
  }
  return { t, root, areaA, areaB, person };
}

async function visit(
  t: Test,
  input: {
    assigneeProfileId: Id<"profiles">;
    orgUnitId: Id<"orgUnits">;
    serviceDate: string;
    routeId?: Id<"routes">;
    planned?: boolean;
    state?: "completed" | "checked-out" | "missed" | "in-progress";
    reasonCode?: string;
    activities?: ("order_intent" | "merchandising" | "note")[];
    collection?: boolean;
  },
) {
  return t.run(async (ctx) => {
    const outletId = fakeId("outlets");
    const planned = input.planned ?? true;
    const visitId = await ctx.db.insert("visitExecutions", {
      organizationId: "sunpride",
      clientVisitId: `visit-${fakeCounter}`,
      ...(planned ? { plannedVisitId: fakeId("plannedVisits") } : {}),
      assigneeProfileId: input.assigneeProfileId,
      outletId,
      orgUnitId: input.orgUnitId,
      ...(input.routeId ? { routeId: input.routeId } : {}),
      serviceDate: input.serviceDate,
      source: planned ? "planned" : "unplanned",
      intents: ["sell"],
      state: input.state ?? "completed",
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      productivity: "pending",
      createdAt: 1,
      lastServerTime: 1,
    });
    const common = {
      organizationId: "sunpride",
      orgUnitId: input.orgUnitId,
      visitId,
      assigneeProfileId: input.assigneeProfileId,
      outletId,
    };
    for (const kind of input.activities ?? [])
      await ctx.db.insert("visitActivities", {
        ...common,
        activity:
          kind === "order_intent"
            ? { kind, clientOrderId: `order-${visitId}` }
            : kind === "merchandising"
              ? { kind, displayCondition: "compliant" }
              : { kind, text: "note" },
        evidenceIds: [],
        deviceTime: 1,
        serverTime: 1,
      });
    if (input.collection)
      await ctx.db.insert("fieldCollections", {
        ...common,
        customerId: fakeId("customers"),
        amountMinor: 1000n,
        currency: "PHP",
        method: "cash",
        reference: "OR-1",
        status: "recorded",
        deviceTime: 1,
        serverTime: 1,
      });
    return visitId;
  });
}

describe("sfa standards", () => {
  it("lists every position's current standard and the productive-call definition", async () => {
    const { areaA, person } = await setup();
    const viewer = await person("viewer", "viewer", areaA);
    const result = await viewer.actor.query(api.sfa.standards.current, {});
    expect(result.definition.activities.map((a) => a.code)).toHaveLength(8);
    expect(result.definition.defaultSellingWeekdays).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    const byCode = new Map(result.positions.map((p) => [p.code, p]));
    expect(byCode.get("PMOT")?.standard).toMatchObject({
      dailyCallsTarget: 30,
      productiveCallTargetPct: 85,
      productiveCallRule: "truck_seller",
    });
    expect(byCode.get("KAS")?.standard).toMatchObject({
      dailyCallsTarget: 5,
      productiveCallTargetPct: 90,
    });
    expect(byCode.get("SALES_HEAD")?.standard).toBeNull();
  });

  it("scores a truck seller's Saturday per visit and per route", async () => {
    const { t, areaA, person } = await setup();
    const seller = await person("pmot", "sales", areaA, "PMOT");
    const base = {
      t,
      assigneeProfileId: seller.profileId,
      orgUnitId: areaA,
      serviceDate: SATURDAY,
    };
    const r1 = fakeId("routes");
    const r2 = fakeId("routes");
    await visit(t, { ...base, routeId: r1, activities: ["order_intent"] });
    // Merchandising alone does not make a truck seller's call productive…
    await visit(t, { ...base, routeId: r1, activities: ["merchandising"] });
    // …unless the visit is marked "visited, no sales due to inventory".
    await visit(t, {
      ...base,
      routeId: r1,
      state: "checked-out",
      activities: ["merchandising"],
      reasonCode: NO_SALES_DUE_TO_INVENTORY,
    });
    // Not calls: an off-plan visit and a planned store that was missed.
    await visit(t, {
      ...base,
      routeId: r1,
      planned: false,
      activities: ["order_intent"],
    });
    await visit(t, { ...base, routeId: r1, state: "missed" });
    await visit(t, { ...base, routeId: r2, collection: true });

    const card = await seller.actor.query(api.sfa.standards.dailyScorecard, {
      assigneeProfileId: seller.profileId,
      serviceDate: SATURDAY,
    });
    expect(card.sellingDay).toBe(true);
    expect(card.weekday).toBe(6);
    expect(card.perDiemBasis).toBe("eligible");
    expect(card.position?.code).toBe("PMOT");
    expect(card.standard).toMatchObject({
      dailyCallsTarget: 30,
      productiveCallTargetPct: 85,
      productiveCallRule: "truck_seller",
    });
    expect(card.total).toEqual({
      calls: 4,
      productiveCalls: 3,
      productivePct: 75,
      callsTargetMet: false,
      productiveTargetMet: false,
    });
    expect(card.routes).toEqual([
      {
        routeId: r1,
        calls: 3,
        productiveCalls: 2,
        productivePct: 66,
        callsTargetMet: false,
        productiveTargetMet: false,
      },
      {
        routeId: r2,
        calls: 1,
        productiveCalls: 1,
        productivePct: 100,
        callsTargetMet: false,
        productiveTargetMet: true,
      },
    ]);
    expect(card.visits.map((v) => v.status)).toEqual([
      "productive",
      "nonproductive",
      "productive",
      "off_plan",
      "not_visited",
      "productive",
    ]);
  });

  it("counts a key account's Saturday collection as a productive working day", async () => {
    const { t, areaA, person } = await setup();
    const kas = await person("kas", "sales", areaA, "KAS");
    await visit(t, {
      assigneeProfileId: kas.profileId,
      orgUnitId: areaA,
      serviceDate: SATURDAY,
      collection: true,
    });
    const card = await kas.actor.query(api.sfa.standards.dailyScorecard, {
      assigneeProfileId: kas.profileId,
      serviceDate: SATURDAY,
    });
    expect(card.sellingDay).toBe(true);
    expect(card.total).toMatchObject({
      calls: 1,
      productiveCalls: 1,
      productivePct: 100,
      productiveTargetMet: true,
    });
    expect(card.visits[0]?.matchedCodes).toEqual(["collection"]);
  });

  it("does not hold Sunday work to the daily target and flags its per diem for review", async () => {
    const { t, areaA, person } = await setup();
    const kas = await person("kas", "sales", areaA, "KAS");
    await visit(t, {
      assigneeProfileId: kas.profileId,
      orgUnitId: areaA,
      serviceDate: SUNDAY,
      activities: ["order_intent"],
    });
    const card = await kas.actor.query(api.sfa.standards.dailyScorecard, {
      assigneeProfileId: kas.profileId,
      serviceDate: SUNDAY,
    });
    expect(card.sellingDay).toBe(false);
    expect(card.perDiemBasis).toBe("needs_review");
    expect(card.total.callsTargetMet).toBeNull();
    expect(card.total.productiveTargetMet).toBeNull();
  });

  it("keeps scorecards inside the caller's scope", async () => {
    const { t, areaA, areaB, person, root } = await setup();
    const seller = await person("seller", "sales", areaA, "RDS");
    const other = await person("other", "sales", areaA, "RDS");
    const managerA = await person("managerA", "manager", areaA);
    const managerB = await person("managerB", "manager", areaB);
    await visit(t, {
      assigneeProfileId: seller.profileId,
      orgUnitId: areaA,
      serviceDate: SATURDAY,
      activities: ["order_intent"],
    });
    const args = { assigneeProfileId: seller.profileId, serviceDate: SATURDAY };
    await expect(
      other.actor.query(api.sfa.standards.dailyScorecard, args),
    ).rejects.toThrow(/own scorecard/);
    await expect(
      managerB.actor.query(api.sfa.standards.dailyScorecard, args),
    ).rejects.toThrow(/outside your organizational scope/);
    expect(
      (await managerA.actor.query(api.sfa.standards.dailyScorecard, args)).total
        .calls,
    ).toBe(1);
    expect(
      (await root.query(api.sfa.standards.dailyScorecard, args)).total.calls,
    ).toBe(1);
    await expect(
      root.query(api.sfa.standards.dailyScorecard, {
        ...args,
        serviceDate: "2026-02-30",
      }),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });
});
