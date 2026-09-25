import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";

async function fixture() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const now = Date.now() - 100000;
  const [east, west] = await t.run(
    async (ctx) =>
      [
        await ctx.db.insert("orgUnits", {
          organizationId: "sunpride",
          code: "E",
          name: "E",
          typeCode: "REGION",
          parentId: rootUnitId,
          status: "active",
          effectiveFrom: now,
          createdAt: now,
          updatedAt: now,
        }),
        await ctx.db.insert("orgUnits", {
          organizationId: "sunpride",
          code: "W",
          name: "W",
          typeCode: "REGION",
          parentId: rootUnitId,
          status: "active",
          effectiveFrom: now,
          createdAt: now,
          updatedAt: now,
        }),
      ] as const,
  );
  async function person(
    role: "sales" | "manager" | "operations" | "approver",
    unit: Id<"orgUnits">,
    name: string,
  ) {
    const email = `${name}@example.test`;
    await root.mutation(api.domains.profiles.invite, { email, role });
    const actor = t.withIdentity({ subject: name, email });
    await actor.mutation(api.domains.profiles.ensure, {});
    const id = (await actor.query(api.domains.profiles.current, {}))!._id;
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { name, orgUnitId: unit, role, updatedAt: now });
      for (const old of await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", id),
        )
        .collect())
        await ctx.db.delete(old._id);
      await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId: unit,
        role,
        effectiveFrom: now,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: now,
      });
    });
    return { actor, id };
  }
  const sales = await person("sales", east, "seller");
  const other = await person("sales", east, "other");
  const manager = await person("manager", east, "manager");
  const operations = await person("operations", east, "operations");
  const approver = await person("approver", east, "approver");
  const foreign = await person("sales", west, "foreign");
  const month = "2026-10";
  async function plan(
    assigneeProfileId: Id<"profiles">,
    status: "draft" | "submitted" = "draft",
    localMonth = month,
  ) {
    return t.run(async (ctx) => {
      const assignee = (await ctx.db.get(assigneeProfileId))!;
      return ctx.db.insert("coveragePlans", {
        organizationId: "sunpride",
        assigneeProfileId,
        localMonth,
        version: 1,
        cycleType: "monthly",
        orgUnitId: assignee.orgUnitId!,
        territoryIds: [],
        requestedFrom: now,
        requestedTo: now + 86400000,
        effectiveFrom: now,
        effectiveTo: now + 86400000,
        status,
        preparedBy: `issuer|${assignee.authSubject}`,
        preparedAt: now,
        submittedBy: status === "submitted" ? "issuer|missing" : undefined,
        submittedAt: status === "submitted" ? now : undefined,
        contentRevision: 1,
        createdBy: "issuer|missing",
        createdAt: now,
        updatedBy: "issuer|missing",
        updatedAt: now,
      });
    });
  }
  return {
    t,
    east,
    west,
    sales,
    other,
    manager,
    operations,
    approver,
    foreign,
    month,
    plan,
  };
}
const options = (cursor: string | null = null, numItems = 20) => ({
  numItems,
  cursor,
});

describe("scoped MCP discovery", () => {
  it("lists only in-scope plans for manager, operations and approver without people.read; sales sees own only", async () => {
    const f = await fixture();
    const own = await f.plan(f.sales.id, "submitted");
    await f.plan(f.other.id);
    await f.plan(f.foreign.id);
    for (const who of [f.manager, f.operations, f.approver]) {
      const grants = await who.actor.query(
        api.lib.capabilities.currentPermissions,
        {},
      );
      if (who !== f.manager)
        expect(grants.capabilities).not.toContain("people.read");
      const result = await who.actor.query(api.coverage.discovery.list, {
        localMonth: f.month,
        paginationOpts: options(),
      });
      expect(result.page.map((p) => p.assigneeName).sort()).toEqual([
        "other",
        "seller",
      ]);
      expect(JSON.stringify(result)).not.toContain("foreign");
    }
    const sale = await f.sales.actor.query(api.coverage.discovery.list, {
      localMonth: f.month,
      paginationOpts: options(),
    });
    expect(sale.page.map((p) => p.planId)).toEqual([own]);
  });

  it("filters status/month, paginates candidates, and hides reassigned or foreign-owned outlets", async () => {
    const f = await fixture();
    await f.plan(f.sales.id, "submitted");
    await f.plan(f.other.id);
    await f.plan(f.other.id, "submitted", "2026-11");
    const first = await f.manager.actor.query(api.coverage.discovery.list, {
      localMonth: f.month,
      paginationOpts: options(null, 1),
    });
    const second = await f.manager.actor.query(api.coverage.discovery.list, {
      localMonth: f.month,
      paginationOpts: options(first.continueCursor, 1),
    });
    expect([...first.page, ...second.page]).toHaveLength(2);
    expect(
      (
        await f.manager.actor.query(api.coverage.discovery.list, {
          localMonth: f.month,
          status: "submitted",
          paginationOpts: options(),
        })
      ).page,
    ).toHaveLength(1);
    await f.t.run(async (ctx) => {
      const assignment = await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", f.sales.id),
        )
        .first();
      await ctx.db.patch(assignment!._id, { orgUnitId: f.west });
    });
    expect(
      (
        await f.manager.actor.query(api.coverage.discovery.list, {
          localMonth: f.month,
          paginationOpts: options(),
        })
      ).page.map((p) => p.assigneeName),
    ).toEqual(["other"]);
    const foreignOutletPlan = await f.plan(f.other.id);
    await f.t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: "FOREIGN",
        name: "Foreign outlet",
        status: "active",
        custodianOrgUnitId: f.west,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "fixture",
      });
      await ctx.db.insert("coveragePlanSlots", {
        slotKey: "foreign",
        planId: foreignOutletPlan,
        assigneeProfileId: f.other.id,
        serviceDate: "2026-10-02",
        kind: "outlet_visit",
        outletId,
        requiredObjectives: [],
        intents: [],
        sequence: 1,
        expectedDurationMinutes: 20,
        contentRevision: 1,
        updatedBy: "fixture",
        updatedAt: Date.now(),
      });
    });
    const scoped = await f.manager.actor.query(api.coverage.discovery.list, {
      localMonth: f.month,
      paginationOpts: options(),
    });
    expect(scoped.page.every((p) => p.planId !== foreignOutletPlan)).toBe(true);
    await expect(
      f.manager.actor.query(api.coverage.discovery.attribution, {
        planId: foreignOutletPlan,
      }),
    ).rejects.toThrow();
    await expect(
      f.manager.actor.query(api.coverage.discovery.list, {
        localMonth: "bad",
        paginationOpts: options(),
      }),
    ).rejects.toThrow();
    await expect(
      f.manager.actor.query(api.coverage.discovery.list, {
        localMonth: f.month,
        paginationOpts: options(null, 21),
      }),
    ).rejects.toThrow();
  });

  it("resolves names, missing subjects and latest return reason without leaking auth IDs", async () => {
    const f = await fixture();
    const id = await f.plan(f.sales.id, "submitted");
    const managerSubject = (await f.manager.actor.query(
      api.domains.profiles.current,
      {},
    ))!.authSubject;
    await f.t.run(async (ctx) => {
      await ctx.db.insert("coverageAuditEvents", {
        planId: id,
        assigneeProfileId: f.sales.id,
        orgUnitId: f.east,
        localMonth: f.month,
        createdAt: Date.now(),
        actorSubject: `issuer|${managerSubject}`,
        action: "plan.returned",
        reason: "Fix route",
        affectedEntity: "coveragePlan",
        planVersion: 1,
      });
    });
    const value = await f.operations.actor.query(
      api.coverage.discovery.attribution,
      { planId: id },
    );
    expect(value.preparedByName).toBe("seller");
    expect(value.submittedByName).toBe("Former user");
    expect(value.latestReturnReason).toBe("Fix route");
    expect(Object.values(value.eventsActorNames)).toContain("manager");
    expect(JSON.stringify(value)).not.toMatch(/issuer\||missing/);
    await expect(
      f.foreign.actor.query(api.coverage.discovery.attribution, { planId: id }),
    ).rejects.toThrow();
  });
});
