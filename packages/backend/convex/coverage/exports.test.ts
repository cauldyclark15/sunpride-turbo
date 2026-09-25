import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";

const opts = (cursor: string | null = null, numItems = 20) => ({
  cursor,
  numItems,
});
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
    name: string,
    role: "sales" | "manager",
    unit: Id<"orgUnits">,
  ) {
    const email = `${name}@example.test`;
    await root.mutation(api.domains.profiles.invite, { email, role });
    const actor = t.withIdentity({ subject: name, email });
    await actor.mutation(api.domains.profiles.ensure, {});
    const id = (await actor.query(api.domains.profiles.current, {}))!._id;
    const assignmentId = await t.run(async (ctx) => {
      await ctx.db.patch(id, { name, orgUnitId: unit, role, updatedAt: now });
      for (const row of await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", id),
        )
        .collect())
        await ctx.db.delete(row._id);
      return ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId: unit,
        role,
        effectiveFrom: now,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: now,
      });
    });
    return { actor, id, assignmentId };
  }
  const seller = await person("seller", "sales", east);
  const manager = await person("manager", "manager", east);
  const foreign = await person("foreign", "sales", west);
  const { territory, owner, outlets } = await t.run(async (ctx) => {
    const territory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "T",
      name: "T",
      status: "active",
      effectiveFrom: now,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    const owner = await ctx.db.insert("territoryOwnerships", {
      territoryId: territory,
      orgUnitId: east,
      effectiveFrom: now,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    const outlets = [];
    for (let i = 0; i < 7; i++) {
      const id = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: `O${i}`,
        name: `Outlet ${i}`,
        status: "active",
        custodianOrgUnitId: east,
        createdAt: now,
        updatedAt: now,
        createdBy: "fixture",
      });
      const assignment = await ctx.db.insert("outletAssignments", {
        outletId: id,
        territoryId: territory,
        effectiveFrom: now,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: now,
      });
      outlets.push({ id, assignment });
    }
    await ctx.db.insert("outlets", {
      organizationId: "sunpride",
      code: "FOREIGN",
      name: "Foreign",
      status: "active",
      custodianOrgUnitId: west,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    return { territory, owner, outlets };
  });
  async function plan(
    version: number,
    status: "draft" | "active",
    assignee = seller,
    withRows = true,
  ) {
    return t.run(async (ctx) => {
      const id = await ctx.db.insert("coveragePlans", {
        organizationId: "sunpride",
        assigneeProfileId: assignee.id,
        localMonth: "2026-09",
        version,
        cycleType: "monthly",
        orgUnitId: assignee === foreign ? west : east,
        territoryIds: [territory],
        requestedFrom: now,
        requestedTo: now + 86400000,
        effectiveFrom: now,
        effectiveTo: now + 86400000,
        status,
        preparedBy: "fixture",
        preparedAt: now,
        contentRevision: 1,
        createdBy: "fixture",
        createdAt: now,
        updatedBy: "fixture",
        updatedAt: now,
      });
      if (!withRows) return id;
      for (let i = 0; i < 6; i++) {
        const outlet = outlets[i]!;
        await ctx.db.insert("coveragePlanOutlets", {
          planId: id,
          outletId: outlet.id,
          territoryId: territory,
          frequency: "weekly",
          preferredWeekdays: [],
          customLocalDates: [],
          priority: 1,
          expectedDurationMinutes: 20,
          requiredObjectives: [],
          contentRevision: 1,
          updatedBy: "fixture",
          updatedAt: now,
        });
        for (const date of ["2026-09-28", "2026-09-29", "2026-09-30"]) {
          const snapshot = {
            outletId: outlet.id,
            outletCode: `O${i}`,
            outletName: `Outlet ${i}`,
            territoryId: territory,
            territoryCode: "T",
            outletAssignmentId: outlet.assignment,
            territoryOwnershipId: owner,
            employeeAssignmentId: assignee.assignmentId,
            orgUnitId: east,
            activityKind: "outlet_visit",
            approvedAssigneeProfileId: assignee.id,
          };
          const slotId = await ctx.db.insert("coveragePlanSlots", {
            planId: id,
            assigneeProfileId: assignee.id,
            slotKey: `${date}-${i}`,
            serviceDate: date,
            kind: "outlet_visit",
            outletId: outlet.id,
            requiredObjectives: [],
            intents: [],
            sequence: i,
            expectedDurationMinutes: 20,
            approvedSnapshot: status === "active" ? snapshot : undefined,
            contentRevision: 1,
            updatedBy: "fixture",
            updatedAt: now,
          });
          if (status === "active")
            await ctx.db.insert("plannedVisits", {
              generationKey: `${id}-${slotId}`,
              planId: id,
              planVersion: version,
              planSlotId: slotId,
              assigneeProfileId: assignee.id,
              outletId: outlet.id,
              serviceDate: date,
              status: "planned",
              approvedSnapshot: snapshot,
              requiredObjectives: [],
              intents: [],
              expectedDurationMinutes: 20,
              generatedAt: now,
            });
        }
      }
      await ctx.db.insert("coveragePlanSlots", {
        planId: id,
        assigneeProfileId: assignee.id,
        slotKey: "admin",
        serviceDate: "2026-09-30",
        kind: "non_visit",
        activityKind: "Admin",
        requiredObjectives: [],
        intents: [],
        sequence: 7,
        expectedDurationMinutes: 60,
        contentRevision: 1,
        updatedBy: "fixture",
        updatedAt: now,
      });
      return id;
    });
  }
  return { t, seller, manager, foreign, west, territory, outlets, plan };
}

describe("coverage exports.schedule", () => {
  it("exports filtered draft rows as UNAPPROVED, including unlinked prospects and empty pages", async () => {
    const f = await fixture();
    const id = await f.plan(1, "draft");
    await f.t.run(async (ctx) => {
      const outlet = await ctx.db.get(f.outlets[0]!.id);
      await ctx.db.patch(outlet!._id, { status: "prospect" });
    });
    const first = await f.manager.actor.query(api.coverage.exports.schedule, {
      planId: id,
      paginationOpts: opts(null, 10),
    });
    expect(first.planHeader.status).toBe("UNAPPROVED");
    expect(first.planHeader.approvedByName).toBeUndefined();
    expect(first.page.some((x) => x.outletCode === "O0")).toBe(true);
    expect(first.isDone).toBe(false);
    const second = await f.manager.actor.query(api.coverage.exports.schedule, {
      planId: id,
      paginationOpts: opts(first.continueCursor, 10),
    });
    expect(second.page.length).toBe(9);
    const filtered = await f.manager.actor.query(
      api.coverage.exports.schedule,
      {
        planId: id,
        territoryId: f.territory,
        visitStatus: "cancelled",
        paginationOpts: opts(),
      },
    );
    expect(filtered.page).toEqual([]);
    expect(filtered.isDone).toBe(true);
    await expect(
      f.foreign.actor.query(api.coverage.exports.schedule, {
        planId: id,
        paginationOpts: opts(),
      }),
    ).rejects.toThrow();
  });
  it("uses immutable signed snapshot and visit lineage, resolves names, rejects malformed signatures", async () => {
    const f = await fixture();
    const id = await f.plan(2, "active");
    await f.t.run(async (ctx) => {
      const manager = await ctx.db.get(f.manager.id);
      const now = Date.now();
      await ctx.db.patch(id, {
        preparedBy: manager!.authSubject,
        submittedBy: manager!.authSubject,
        approvedBy: manager!.authSubject,
        submittedAt: now,
        approvedAt: now,
        contentHash: "abcdef0123456789",
        approvalSignature: `${id}:2:${manager!.authSubject}:${now}:abcdef0123456789`,
      });
      await ctx.db.patch(f.outlets[0]!.id, { name: "Changed live name" });
    });
    const page = await f.manager.actor.query(api.coverage.exports.schedule, {
      planId: id,
      visitStatus: "planned",
      paginationOpts: opts(),
    });
    expect(page.planHeader.signedHashPrefix).toBe("abcdef012345");
    expect(page.planHeader.approvedByName).toBe("manager");
    expect(page.page).toHaveLength(18);
    expect(page.page[0]!.name).toBe("Outlet 0");
    expect(page.page.every((x) => x.visitStatus === "planned")).toBe(true);
    await f.t.run(async (ctx) => {
      await ctx.db.patch(id, { approvalSignature: "tampered" });
    });
    await expect(
      f.manager.actor.query(api.coverage.exports.schedule, {
        planId: id,
        paginationOpts: opts(),
      }),
    ).rejects.toThrow("Invalid signed plan metadata");
  });
  it("fails closed on a cross-unit outlet, including when filtered out", async () => {
    const f = await fixture();
    const id = await f.plan(1, "draft");
    const foreignOutlet = await f.t.run(async (ctx) =>
      ctx.db
        .query("outlets")
        .withIndex("by_organizationId_and_code", (q) =>
          q.eq("organizationId", "sunpride").eq("code", "FOREIGN"),
        )
        .unique(),
    );
    await f.t.run(async (ctx) => {
      await ctx.db.insert("coveragePlanOutlets", {
        planId: id,
        outletId: foreignOutlet!._id,
        territoryId: f.territory,
        frequency: "weekly",
        preferredWeekdays: [],
        customLocalDates: [],
        priority: 1,
        expectedDurationMinutes: 20,
        requiredObjectives: [],
        contentRevision: 1,
        updatedBy: "fixture",
        updatedAt: Date.now(),
      });
    });
    await expect(
      f.manager.actor.query(api.coverage.exports.schedule, {
        planId: id,
        visitStatus: "cancelled",
        paginationOpts: opts(),
      }),
    ).rejects.toThrow();
  });
});
