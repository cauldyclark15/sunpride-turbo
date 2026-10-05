import { convexTest } from "convex-test";
import { expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";
import { localDate } from "../coverage/validation";

/* CVX-031 regression: planned-only days must get daily agent metric rows when a plan
 * activates, and a revision's supersession must refresh the displaced days. Fixture from
 * coverage/same_day_flow.test.ts. */
it("refreshes daily agent metrics on plan activation and supersession", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-26T02:09:00+08:00"));
  try {
    const now = Date.now();
    const t = convexTest(schema, modules);
    await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
    const root = t.withIdentity({
      subject: "root",
      email: "jcing.jc@gmail.com",
    });
    await root.mutation(api.domains.profiles.ensure, {});
    const { rootUnitId } = await t.mutation(
      internal.migrations.seedOrganizationFoundation,
      {},
    );
    const region = await t.run((ctx) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code: "SAME-DAY",
        name: "Same-day region",
        typeCode: "REGION",
        parentId: rootUnitId,
        status: "active",
        effectiveFrom: now,
        createdAt: now,
        updatedAt: now,
      }),
    );
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
    async function person(role: "sales" | "manager", subject: string) {
      const email = `${subject}@example.test`;
      await root.mutation(api.domains.profiles.invite, { email, role });
      const actor = t.withIdentity({ subject, email });
      await actor.mutation(api.domains.profiles.ensure, {});
      const id = (await actor.query(api.domains.profiles.current, {}))!._id;
      await t.run(async (ctx) => {
        await ctx.db.patch(id, { orgUnitId: region, role, updatedAt: now });
        for (const prior of await ctx.db
          .query("employeeAssignments")
          .withIndex("by_profileId_and_effectiveFrom", (q) =>
            q.eq("profileId", id),
          )
          .collect())
          await ctx.db.delete(prior._id);
        await ctx.db.insert("employeeAssignments", {
          profileId: id,
          orgUnitId: region,
          role,
          positionId: position,
          effectiveFrom: now,
          actorSubject: "fixture",
          reason: "Joined today",
          createdAt: now,
        });
      });
      return { actor, id };
    }
    const sales = await person("sales", "same-day-sales");
    const manager = await person("manager", "same-day-manager");
    const { territory, route, outlets } = await t.run(async (ctx) => {
      const territory = await ctx.db.insert("territories", {
        organizationId: "sunpride",
        code: "SAME-DAY-T",
        name: "Same-day territory",
        status: "active",
        effectiveFrom: now,
        createdAt: now,
        updatedAt: now,
        createdBy: "fixture",
      });
      await ctx.db.insert("territoryOwnerships", {
        territoryId: territory,
        orgUnitId: region,
        effectiveFrom: now,
        actorSubject: "fixture",
        reason: "Created today",
        createdAt: now,
      });
      await ctx.db.insert("territorySalespeople", {
        territoryId: territory,
        profileId: sales.id,
        kind: "primary",
        effectiveFrom: now,
        actorSubject: "fixture",
        reason: "Assigned today",
        createdAt: now,
      });
      const route = await ctx.db.insert("routes", {
        organizationId: "sunpride",
        code: "SAME-DAY-R",
        name: "Same-day route",
        status: "active",
        effectiveFrom: now,
        createdAt: now,
        updatedAt: now,
        createdBy: "fixture",
      });
      await ctx.db.insert("routeTerritories", {
        routeId: route,
        territoryId: territory,
        effectiveFrom: now,
        actorSubject: "fixture",
        reason: "Created today",
        createdAt: now,
      });
      await ctx.db.insert("routeSalespeople", {
        routeId: route,
        profileId: sales.id,
        primary: true,
        effectiveFrom: now,
        actorSubject: "fixture",
        reason: "Assigned today",
        createdAt: now,
      });
      const outlets = [];
      for (let index = 1; index <= 6; index++) {
        const outlet = await ctx.db.insert("outlets", {
          organizationId: "sunpride",
          code: `SAME-DAY-${index}`,
          name: `Store ${index}`,
          status: "active",
          custodianOrgUnitId: region,
          createdAt: now,
          updatedAt: now,
          createdBy: "fixture",
        });
        await ctx.db.insert("outletAssignments", {
          outletId: outlet,
          territoryId: territory,
          routeId: route,
          sequence: index,
          effectiveFrom: now,
          actorSubject: "fixture",
          reason: "Assigned today",
          createdAt: now,
        });
        outlets.push(outlet);
      }
      return { territory, route, outlets };
    });
    await t.mutation(internal.coverage.routines.seedProvisional, {});
    // Newly enabled position routines, like the assignments, begin after midnight.
    await t.run(async (ctx) => {
      for (const row of await ctx.db
        .query("positionRoutineTemplates")
        .withIndex("by_positionId_and_effectiveFrom", (q) =>
          q.eq("positionId", position),
        )
        .collect())
        await ctx.db.patch(row._id, { effectiveFrom: now });
    });
    const create = () =>
      sales.actor.mutation(api.coverage.plans.create, {
        assigneeProfileId: sales.id,
        localMonth: "2026-09",
      });
    const plan = await create();
    expect(plan.effectiveFrom).toBe(localDate("2026-09-26"));
    expect(
      (
        await sales.actor.query(api.coverage.plans.list, {
          assigneeProfileId: sales.id,
          localMonth: "2026-09",
        })
      ).map((row) => row._id),
    ).toEqual([plan._id]);
    expect(
      (
        await sales.actor.mutation(api.coverage.plans.setAssignment, {
          planId: plan._id,
          effectiveFrom: localDate("2026-09-26"),
          effectiveTo: plan.effectiveTo,
          reason: "Confirm today's assignment",
        })
      ).effectiveFrom,
    ).toBe(plan.effectiveFrom);
    const planOutlets = outlets.map((outletId, index) => ({
      outletId,
      territoryId: territory,
      routeId: route,
      frequency: "custom" as const,
      preferredWeekdays: [],
      customLocalDates: [`2026-09-${27 + (index % 4)}`],
      sequence: index + 1,
      priority: 1,
      expectedDurationMinutes: 30,
      requiredObjectives: ["sell"],
    }));
    expect(
      await sales.actor.mutation(api.coverage.plans.saveOutlets, {
        planId: plan._id,
        outlets: planOutlets,
      }),
    ).toHaveLength(6);
    const routine = await sales.actor.query(
      api.coverage.routines.listForPosition,
      { planId: plan._id },
    );
    expect(routine.templates).toHaveLength(7);
    const applied = await sales.actor.mutation(
      api.coverage.routines.applyToDraft,
      { planId: plan._id },
    );
    expect(applied.created).toBeGreaterThan(0);
    const detail = await sales.actor.query(api.coverage.plans.detail, {
      planId: plan._id,
    });
    expect(detail.outlets).toHaveLength(6);
    const slots = [
      ...detail.slots
        .filter((slot) => slot.serviceDate > "2026-09-26")
        .map((slot) => ({
          slotKey: slot.slotKey,
          serviceDate: slot.serviceDate,
          kind: slot.kind,
          activityKind: slot.activityKind,
          requiredObjectives: slot.requiredObjectives,
          intents: slot.intents,
          sequence: slot.sequence,
          expectedDurationMinutes: slot.expectedDurationMinutes,
        })),
      ...outlets.map((outletId, index) => ({
        slotKey: `visit-${index + 1}`,
        serviceDate: `2026-09-${27 + (index % 4)}`,
        kind: "outlet_visit" as const,
        outletId,
        routeId: route,
        activityKind: "sell",
        requiredObjectives: ["sell"],
        intents: ["sell"],
        sequence: index + 10,
        expectedDurationMinutes: 30,
      })),
    ];
    await sales.actor.mutation(api.coverage.plans.saveSlots, {
      planId: plan._id,
      slots,
    });
    expect(
      (
        await sales.actor.mutation(api.coverage.plans.submit, {
          planId: plan._id,
        })
      ).status,
    ).toBe("submitted");

    expect(
      (
        await manager.actor.mutation(api.coverage.plans.approve, {
          planId: plan._id,
        })
      ).status,
    ).toBe("approved");
    const activation = await manager.actor.mutation(
      api.coverage.activation.activate,
      {
        planId: plan._id,
      },
    );
    expect(activation.count).toBe(6);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const daily = () =>
      t.run(async (ctx) =>
        Object.fromEntries(
          (
            await ctx.db
              .query("agentDailyMetrics")
              .withIndex("by_profileId_and_serviceDate", (q) =>
                q.eq("profileId", sales.id),
              )
              .collect()
          ).map((row) => [row.serviceDate, row.plannedCalls]),
        ),
      );
    // No visit or order yet: the plan alone must produce each planned day's row.
    expect(await daily()).toEqual({
      "2026-09-27": 2,
      "2026-09-28": 2,
      "2026-09-29": 1,
      "2026-09-30": 1,
    });
    expect(
      await t.run(
        async (ctx) =>
          (await ctx.db.query("agentMetricRefreshes").collect()).length,
      ),
    ).toBe(0);
    const visits = await sales.actor.query(
      api.coverage.activation.plannedForMonth,
      {
        assigneeProfileId: sales.id,
        localMonth: "2026-09",
      },
    );
    expect(visits.map((visit) => visit.serviceDate).sort()).toEqual([
      "2026-09-27",
      "2026-09-27",
      "2026-09-28",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
    ]);
    expect(new Set(visits.map((visit) => visit.outletId))).toEqual(
      new Set(outlets),
    );
    const history = await sales.actor.query(api.coverage.history.list, {
      planId: plan._id,
      paginationOpts: { numItems: 30, cursor: null },
    });
    expect(history.page.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "plan.created",
        "outlets.saved",
        "slots.saved",
        "plan.submitted",
        "plan.approved",
        "plan.activated",
        "visits.generated",
      ]),
    );

    // A revision from 2026-09-28 keeps only store 2 on the 28th: store 6's visit that day
    // is cancelled, the 29th and 30th lose their stops; the 27th is already in the past.
    const revision = await sales.actor.mutation(
      api.coverage.plans.createRevision,
      {
        planId: plan._id,
        effectiveFromDate: "2026-09-28",
        reason: "Shorter itinerary",
      },
    );
    await sales.actor.mutation(api.coverage.plans.saveOutlets, {
      planId: revision._id,
      outlets: [{ ...planOutlets[1]!, sequence: 1 }],
    });
    const revisionDetail = await sales.actor.query(api.coverage.plans.detail, {
      planId: revision._id,
    });
    await sales.actor.mutation(api.coverage.plans.saveSlots, {
      planId: revision._id,
      slots: revisionDetail.slots
        .filter(
          (slot) =>
            slot.serviceDate >= "2026-09-28" &&
            (slot.kind !== "outlet_visit" || slot.slotKey === "visit-2"),
        )
        .map((slot) => ({
          slotKey: slot.slotKey,
          serviceDate: slot.serviceDate,
          kind: slot.kind,
          ...(slot.outletId ? { outletId: slot.outletId } : {}),
          ...(slot.routeId ? { routeId: slot.routeId } : {}),
          activityKind: slot.activityKind,
          requiredObjectives: slot.requiredObjectives,
          intents: slot.intents,
          sequence: slot.sequence,
          expectedDurationMinutes: slot.expectedDurationMinutes,
        })),
    });
    await sales.actor.mutation(api.coverage.plans.submit, {
      planId: revision._id,
    });
    await manager.actor.mutation(api.coverage.plans.approve, {
      planId: revision._id,
    });
    vi.setSystemTime(new Date("2026-09-28T00:30:00+08:00"));
    expect(
      (
        await manager.actor.mutation(api.coverage.activation.activate, {
          planId: revision._id,
        })
      ).count,
    ).toBe(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await daily()).toEqual({
      "2026-09-27": 2,
      "2026-09-28": 1,
      "2026-09-29": 0,
      "2026-09-30": 0,
    });
  } finally {
    vi.useRealTimers();
  }
});
