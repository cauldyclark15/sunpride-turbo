import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "../lib/capabilities";
import schema from "../schema";
import { modules } from "../test.setup";

const organizationId = "sunpride";
const from = Date.UTC(2026, 9, 1) - 8 * 60 * 60 * 1000;
const to = Date.UTC(2026, 10, 1) - 8 * 60 * 60 * 1000;
const serviceDate = "2026-10-05";

/** Each query exercises a named physical index (not an unindexed table scan). */
describe("group-05 coverage schema", () => {
  it("inserts and reads all seven tables through every declared index", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const now = from;
      const profileId = await ctx.db.insert("profiles", {
        authSubject: "rep",
        name: "Rep",
        email: "rep@test.local",
        role: "sales",
        status: "active",
        updatedAt: now,
      });
      const orgUnitId = await ctx.db.insert("orgUnits", {
        organizationId,
        code: "NCR",
        name: "NCR",
        typeCode: "AREA",
        status: "active",
        effectiveFrom: from,
        createdAt: now,
        updatedAt: now,
      });
      const territoryId = await ctx.db.insert("territories", {
        organizationId,
        code: "T1",
        name: "Territory",
        status: "active",
        effectiveFrom: from,
        createdAt: now,
        updatedAt: now,
        createdBy: "admin",
      });
      const routeId = await ctx.db.insert("routes", {
        organizationId,
        code: "R1",
        name: "Route",
        status: "active",
        effectiveFrom: from,
        createdAt: now,
        updatedAt: now,
        createdBy: "admin",
      });
      const outletId = await ctx.db.insert("outlets", {
        organizationId,
        code: "O1",
        name: "Outlet",
        status: "active",
        custodianOrgUnitId: orgUnitId,
        createdAt: now,
        updatedAt: now,
        createdBy: "admin",
      });
      const customerId = await ctx.db.insert("customers", {
        code: "C1",
        name: "Customer",
        channel: "general",
        territory: "T1",
        creditLimit: 0,
        active: true,
        updatedAt: now,
      });
      const outletCustomerLinkId = await ctx.db.insert("outletCustomerLinks", {
        outletId,
        customerId,
        source: "test",
        effectiveFrom: from,
        actorSubject: "admin",
        reason: "link",
        createdAt: now,
      });
      const outletAssignmentId = await ctx.db.insert("outletAssignments", {
        outletId,
        territoryId,
        routeId,
        sequence: 1,
        effectiveFrom: from,
        actorSubject: "admin",
        reason: "assign",
        createdAt: now,
      });
      const territoryOwnershipId = await ctx.db.insert("territoryOwnerships", {
        territoryId,
        orgUnitId,
        effectiveFrom: from,
        actorSubject: "admin",
        reason: "own",
        createdAt: now,
      });
      const routeTerritoryId = await ctx.db.insert("routeTerritories", {
        routeId,
        territoryId,
        effectiveFrom: from,
        actorSubject: "admin",
        reason: "route",
        createdAt: now,
      });
      const territorySalespersonId = await ctx.db.insert(
        "territorySalespeople",
        {
          territoryId,
          profileId,
          kind: "primary",
          effectiveFrom: from,
          actorSubject: "admin",
          reason: "staff",
          createdAt: now,
        },
      );
      const routeSalespersonId = await ctx.db.insert("routeSalespeople", {
        routeId,
        profileId,
        primary: true,
        effectiveFrom: from,
        actorSubject: "admin",
        reason: "route",
        createdAt: now,
      });
      const employeeAssignmentId = await ctx.db.insert("employeeAssignments", {
        profileId,
        orgUnitId,
        role: "sales",
        effectiveFrom: from,
        actorSubject: "admin",
        reason: "staff",
        createdAt: now,
      });
      const positionId = await ctx.db.insert("positions", {
        organizationId,
        code: "KAS",
        label: "KAS",
        category: "field",
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      const planId = await ctx.db.insert("coveragePlans", {
        organizationId,
        assigneeProfileId: profileId,
        localMonth: "2026-10",
        version: 1,
        cycleType: "monthly",
        orgUnitId,
        territoryIds: [territoryId],
        requestedFrom: from,
        requestedTo: to,
        effectiveFrom: from,
        effectiveTo: to,
        status: "draft",
        preparedBy: "admin",
        preparedAt: now,
        contentRevision: 1,
        createdBy: "admin",
        createdAt: now,
        updatedBy: "admin",
        updatedAt: now,
      });
      const assignmentId = await ctx.db.insert("coverageAssignments", {
        planId,
        assigneeProfileId: profileId,
        orgUnitId,
        primary: true,
        effectiveFrom: from,
        effectiveTo: to,
        actorSubject: "admin",
        reason: "month",
        createdAt: now,
      });
      const planOutletId = await ctx.db.insert("coveragePlanOutlets", {
        planId,
        outletId,
        routeId,
        territoryId,
        frequency: "weekly",
        anchorLocalDate: serviceDate,
        preferredWeekdays: [1],
        customLocalDates: [],
        sequence: 1,
        priority: 1,
        expectedDurationMinutes: 30,
        requiredObjectives: ["sell"],
        visitWindow: "morning",
        contentRevision: 1,
        updatedBy: "admin",
        updatedAt: now,
      });
      const approvedSnapshot = {
        outletId,
        outletCode: "O1",
        outletName: "Outlet",
        customerId,
        outletCustomerLinkId,
        territoryId,
        territoryCode: "T1",
        routeId,
        routeCode: "R1",
        sequence: 1,
        outletAssignmentId,
        territoryOwnershipId,
        territorySalespersonId,
        routeTerritoryId,
        routeSalespersonId,
        employeeAssignmentId,
        orgUnitId,
        activityKind: "sell",
        approvedAssigneeProfileId: profileId,
      };
      const slotId = await ctx.db.insert("coveragePlanSlots", {
        slotKey: "oct-05-o1",
        planId,
        assigneeProfileId: profileId,
        serviceDate,
        kind: "outlet_visit",
        outletId,
        routeId,
        activityKind: "sell",
        requiredObjectives: ["sell"],
        intents: ["sell"],
        sequence: 1,
        expectedDurationMinutes: 30,
        approvedSnapshot,
        contentRevision: 1,
        updatedBy: "admin",
        updatedAt: now,
      });
      const routineId = await ctx.db.insert("positionRoutineTemplates", {
        organizationId,
        positionId,
        effectiveFrom: from,
        weekday: 1,
        dayKind: "selling",
        activities: [{ sequence: 1, name: "Stores", kind: "outlet_visit" }],
        sourceRef: "memo §5",
        provisional: true,
        actorSubject: "admin",
        createdAt: now,
        updatedAt: now,
      });
      const visitId = await ctx.db.insert("plannedVisits", {
        generationKey: "sunpride:plan:slot:day:rep",
        planId,
        planVersion: 1,
        planSlotId: slotId,
        assigneeProfileId: profileId,
        outletId,
        serviceDate,
        status: "planned",
        approvedSnapshot,
        requiredObjectives: ["sell"],
        intents: ["sell"],
        expectedDurationMinutes: 30,
        generatedAt: now,
      });
      const auditId = await ctx.db.insert("coverageAuditEvents", {
        planId,
        assigneeProfileId: profileId,
        orgUnitId,
        localMonth: "2026-10",
        createdAt: now,
        actorSubject: "admin",
        action: "create",
        affectedEntity: "coveragePlans",
        affectedRowId: planId,
        after: { status: "draft" },
        diff: { version: 1 },
        planVersion: 1,
      });
      const checks = [
        [
          "coveragePlans",
          "by_org_assignee_month_version",
          planId,
          ctx.db
            .query("coveragePlans")
            .withIndex("by_org_assignee_month_version", (q) =>
              q
                .eq("organizationId", organizationId)
                .eq("assigneeProfileId", profileId)
                .eq("localMonth", "2026-10")
                .eq("version", 1),
            )
            .unique(),
        ],
        [
          "coveragePlans",
          "by_assigneeProfileId_and_localMonth_and_status",
          planId,
          ctx.db
            .query("coveragePlans")
            .withIndex("by_assigneeProfileId_and_localMonth_and_status", (q) =>
              q
                .eq("assigneeProfileId", profileId)
                .eq("localMonth", "2026-10")
                .eq("status", "draft"),
            )
            .unique(),
        ],
        [
          "coveragePlans",
          "by_orgUnitId_and_localMonth_and_status",
          planId,
          ctx.db
            .query("coveragePlans")
            .withIndex("by_orgUnitId_and_localMonth_and_status", (q) =>
              q
                .eq("orgUnitId", orgUnitId)
                .eq("localMonth", "2026-10")
                .eq("status", "draft"),
            )
            .unique(),
        ],
        [
          "coveragePlans",
          "by_status_and_effectiveFrom",
          planId,
          ctx.db
            .query("coveragePlans")
            .withIndex("by_status_and_effectiveFrom", (q) =>
              q.eq("status", "draft").eq("effectiveFrom", from),
            )
            .unique(),
        ],
        [
          "coverageAssignments",
          "by_planId_and_effectiveFrom",
          assignmentId,
          ctx.db
            .query("coverageAssignments")
            .withIndex("by_planId_and_effectiveFrom", (q) =>
              q.eq("planId", planId).eq("effectiveFrom", from),
            )
            .unique(),
        ],
        [
          "coverageAssignments",
          "by_assigneeProfileId_and_effectiveFrom",
          assignmentId,
          ctx.db
            .query("coverageAssignments")
            .withIndex("by_assigneeProfileId_and_effectiveFrom", (q) =>
              q.eq("assigneeProfileId", profileId).eq("effectiveFrom", from),
            )
            .unique(),
        ],
        [
          "coveragePlanOutlets",
          "by_planId_and_outletId",
          planOutletId,
          ctx.db
            .query("coveragePlanOutlets")
            .withIndex("by_planId_and_outletId", (q) =>
              q.eq("planId", planId).eq("outletId", outletId),
            )
            .unique(),
        ],
        [
          "coveragePlanOutlets",
          "by_outletId_and_planId",
          planOutletId,
          ctx.db
            .query("coveragePlanOutlets")
            .withIndex("by_outletId_and_planId", (q) =>
              q.eq("outletId", outletId).eq("planId", planId),
            )
            .unique(),
        ],
        [
          "coveragePlanSlots",
          "by_planId_and_serviceDate",
          slotId,
          ctx.db
            .query("coveragePlanSlots")
            .withIndex("by_planId_and_serviceDate", (q) =>
              q.eq("planId", planId).eq("serviceDate", serviceDate),
            )
            .unique(),
        ],
        [
          "coveragePlanSlots",
          "by_planId_and_serviceDate_and_slotKey",
          slotId,
          ctx.db
            .query("coveragePlanSlots")
            .withIndex("by_planId_and_serviceDate_and_slotKey", (q) =>
              q
                .eq("planId", planId)
                .eq("serviceDate", serviceDate)
                .eq("slotKey", "oct-05-o1"),
            )
            .unique(),
        ],
        [
          "coveragePlanSlots",
          "by_outletId_and_serviceDate",
          slotId,
          ctx.db
            .query("coveragePlanSlots")
            .withIndex("by_outletId_and_serviceDate", (q) =>
              q.eq("outletId", outletId).eq("serviceDate", serviceDate),
            )
            .unique(),
        ],
        [
          "coveragePlanSlots",
          "by_routeId_and_serviceDate",
          slotId,
          ctx.db
            .query("coveragePlanSlots")
            .withIndex("by_routeId_and_serviceDate", (q) =>
              q.eq("routeId", routeId).eq("serviceDate", serviceDate),
            )
            .unique(),
        ],
        [
          "positionRoutineTemplates",
          "by_positionId_and_effectiveFrom",
          routineId,
          ctx.db
            .query("positionRoutineTemplates")
            .withIndex("by_positionId_and_effectiveFrom", (q) =>
              q.eq("positionId", positionId).eq("effectiveFrom", from),
            )
            .unique(),
        ],
        [
          "positionRoutineTemplates",
          "by_positionId_and_weekday_and_effectiveFrom",
          routineId,
          ctx.db
            .query("positionRoutineTemplates")
            .withIndex("by_positionId_and_weekday_and_effectiveFrom", (q) =>
              q
                .eq("positionId", positionId)
                .eq("weekday", 1)
                .eq("effectiveFrom", from),
            )
            .unique(),
        ],
        [
          "plannedVisits",
          "by_generationKey",
          visitId,
          ctx.db
            .query("plannedVisits")
            .withIndex("by_generationKey", (q) =>
              q.eq("generationKey", "sunpride:plan:slot:day:rep"),
            )
            .unique(),
        ],
        [
          "plannedVisits",
          "by_planId_and_serviceDate",
          visitId,
          ctx.db
            .query("plannedVisits")
            .withIndex("by_planId_and_serviceDate", (q) =>
              q.eq("planId", planId).eq("serviceDate", serviceDate),
            )
            .unique(),
        ],
        [
          "plannedVisits",
          "by_assigneeProfileId_and_serviceDate",
          visitId,
          ctx.db
            .query("plannedVisits")
            .withIndex("by_assigneeProfileId_and_serviceDate", (q) =>
              q
                .eq("assigneeProfileId", profileId)
                .eq("serviceDate", serviceDate),
            )
            .unique(),
        ],
        [
          "plannedVisits",
          "by_outletId_and_serviceDate",
          visitId,
          ctx.db
            .query("plannedVisits")
            .withIndex("by_outletId_and_serviceDate", (q) =>
              q.eq("outletId", outletId).eq("serviceDate", serviceDate),
            )
            .unique(),
        ],
        [
          "coverageAuditEvents",
          "by_planId_and_createdAt",
          auditId,
          ctx.db
            .query("coverageAuditEvents")
            .withIndex("by_planId_and_createdAt", (q) =>
              q.eq("planId", planId).eq("createdAt", now),
            )
            .unique(),
        ],
        [
          "coverageAuditEvents",
          "by_assigneeProfileId_and_createdAt",
          auditId,
          ctx.db
            .query("coverageAuditEvents")
            .withIndex("by_assigneeProfileId_and_createdAt", (q) =>
              q.eq("assigneeProfileId", profileId).eq("createdAt", now),
            )
            .unique(),
        ],
        [
          "coverageAuditEvents",
          "by_orgUnitId_and_createdAt",
          auditId,
          ctx.db
            .query("coverageAuditEvents")
            .withIndex("by_orgUnitId_and_createdAt", (q) =>
              q.eq("orgUnitId", orgUnitId).eq("createdAt", now),
            )
            .unique(),
        ],
      ] as const;
      for (const [table, index, id, result] of checks)
        expect((await result)?._id, `${table}.${index}`).toBe(id);
      expect((await ctx.db.get(visitId))?.approvedSnapshot).toEqual(
        approvedSnapshot,
      );
      expect((await ctx.db.get(planId))?.approvedBy).toBeUndefined();
    });
  });

  it("keeps MCP grants aligned with the RBAC matrix without synonyms", () => {
    expect(CAPABILITIES["mcp.read"]).toEqual([
      "super_admin",
      "admin",
      "operations",
      "manager",
      "approver",
      "sales",
      "analyst",
      "viewer",
    ]);
    expect(CAPABILITIES["mcp.plan"]).toEqual([
      "super_admin",
      "admin",
      "manager",
      "sales",
    ]);
    expect(CAPABILITIES["mcp.approve"]).toEqual(["super_admin", "manager"]);
    expect(
      Object.keys(CAPABILITIES).filter((k) => k.startsWith("mcp.")),
    ).toEqual(["mcp.read", "mcp.plan", "mcp.approve"]);
  });
});
