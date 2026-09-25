import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import { requireCapability } from "../lib/capabilities";
import { requireActiveProfile } from "../lib/auth";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { resolveOutletScopeAt } from "../outlets/validation";
import { at } from "../territories/route_validation";
import { frequency, slotKind, weekday } from "./validators";
import { auditPlan, planState } from "./audit";
import { assertNoBlockingExceptions } from "./exceptions";
import {
  MAX_PLAN_ROWS,
  assertOutletsScoped,
  bounded,
  employeeAt,
  localDate,
  manilaDate,
  monthBounds,
  monthDates,
  overlaps,
  planAccess,
  planRows,
  planWindow,
  positive,
  required,
  snapshotSlot,
} from "./validation";

const planDoc = schema.doc("coveragePlans");
const outletDoc = schema.doc("coveragePlanOutlets");
const slotDoc = schema.doc("coveragePlanSlots");
const assignmentDoc = schema.doc("coverageAssignments");
const outletInput = v.object({
  outletId: v.id("outlets"),
  routeId: v.optional(v.id("routes")),
  territoryId: v.id("territories"),
  frequency,
  anchorLocalDate: v.optional(v.string()),
  weekOrdinal: v.optional(v.number()),
  preferredWeekdays: v.array(weekday),
  customLocalDates: v.array(v.string()),
  sequence: v.optional(v.number()),
  priority: v.number(),
  expectedDurationMinutes: v.number(),
  requiredObjectives: v.array(v.string()),
  visitWindow: v.optional(v.string()),
});
const slotInput = v.object({
  slotKey: v.string(),
  serviceDate: v.string(),
  kind: slotKind,
  outletId: v.optional(v.id("outlets")),
  routeId: v.optional(v.id("routes")),
  activityKind: v.optional(v.string()),
  namedTruckRef: v.optional(v.string()),
  requiredObjectives: v.array(v.string()),
  intents: v.array(v.string()),
  sequence: v.number(),
  expectedDurationMinutes: v.number(),
});
async function existingPlans(
  ctx: MutationCtx,
  person: Id<"profiles">,
  month: string,
) {
  return bounded(
    ctx.db
      .query("coveragePlans")
      .withIndex("by_org_assignee_month_version", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("assigneeProfileId", person)
          .eq("localMonth", month),
      )
      .take(MAX_PLAN_ROWS + 1),
    "Plan version history",
  );
}
async function draft(ctx: MutationCtx, id: Id<"coveragePlans">) {
  const plan = await ctx.db.get(id);
  if (!plan) throw new ConvexError("Plan not found");
  const access = await planAccess(ctx, plan, "mcp.plan");
  if (plan.status !== "draft")
    throw new ConvexError("Only draft plans can change");
  return { plan, actor: access.identity.tokenIdentifier };
}
async function bump(
  ctx: MutationCtx,
  plan: Doc<"coveragePlans">,
  actor: string,
  action: string,
  after: Record<string, string | number | boolean | null>,
  reason?: string,
) {
  const now = Date.now();
  await ctx.db.patch(plan._id, {
    contentRevision: plan.contentRevision + 1,
    updatedBy: actor,
    updatedAt: now,
  });
  await auditPlan(
    ctx,
    plan,
    actor,
    action,
    { ...planState(plan) },
    { ...planState(plan), contentRevision: plan.contentRevision + 1, ...after },
    { reason },
  );
}
async function make(
  ctx: MutationCtx,
  person: Id<"profiles">,
  month: string,
  from: number,
  to: number,
  basedOn?: Doc<"coveragePlans">,
  reason?: string,
) {
  planWindow(month, from, to);
  // A Manila day boundary can precede a mid-day employee assignment.
  const assignment = await employeeAt(ctx, person, Math.max(from, Date.now()));
  const current = await employeeAt(ctx, person, Date.now());
  const access = await requireCapability(
    ctx,
    "mcp.plan",
    assignment.orgUnitId!,
  );
  await requireCapability(ctx, "mcp.plan", current.orgUnitId!);
  if (access.profile.role === "sales" && access.profile._id !== person)
    throw new ConvexError("Sales may create only own plan");
  const versions = await existingPlans(ctx, person, month);
  const version = Math.max(0, ...versions.map((p) => p.version)) + 1;
  const now = Date.now(),
    actor = access.identity.tokenIdentifier;
  const id = await ctx.db.insert("coveragePlans", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    assigneeProfileId: person,
    localMonth: month,
    version,
    cycleType: "monthly",
    orgUnitId: assignment.orgUnitId!,
    territoryIds: basedOn?.territoryIds ?? [],
    requestedFrom: from,
    requestedTo: to,
    effectiveFrom: from,
    effectiveTo: to,
    status: "draft",
    basedOnPlanId: basedOn?._id,
    revisionReason: reason,
    preparedBy: actor,
    preparedAt: now,
    contentRevision: 1,
    createdBy: actor,
    createdAt: now,
    updatedBy: actor,
    updatedAt: now,
  });
  const plan = (await ctx.db.get(id))!;
  await ctx.db.insert("coverageAssignments", {
    planId: id,
    assigneeProfileId: person,
    orgUnitId: plan.orgUnitId,
    primary: true,
    effectiveFrom: from,
    effectiveTo: to,
    actorSubject: actor,
    reason: reason ?? "Initial coverage",
    createdAt: now,
  });
  await auditPlan(
    ctx,
    plan,
    actor,
    basedOn ? "revision.created" : "plan.created",
    {},
    planState(plan),
    { reason },
  );
  return plan;
}
export const list = query({
  args: { assigneeProfileId: v.id("profiles"), localMonth: v.string() },
  returns: v.array(planDoc),
  handler: async (ctx, args) => {
    monthBounds(args.localMonth);
    const { profile } = await requireActiveProfile(ctx);
    // Role checked even for an empty list; the supplied assignee is never scope authority.
    if (profile.role === "sales" && profile._id !== args.assigneeProfileId)
      throw new ConvexError("Sales may access only own plan");
    const rows = await bounded(
      ctx.db
        .query("coveragePlans")
        .withIndex("by_org_assignee_month_version", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("assigneeProfileId", args.assigneeProfileId)
            .eq("localMonth", args.localMonth),
        )
        .take(MAX_PLAN_ROWS + 1),
      "Plan list",
    );
    if (!rows.length) {
      const assigned = await employeeAt(
        ctx,
        args.assigneeProfileId,
        Date.now(),
      );
      await requireCapability(ctx, "mcp.read", assigned.orgUnitId!);
    }
    for (const row of rows) await planAccess(ctx, row, "mcp.read");
    return rows;
  },
});
export const detail = query({
  args: { planId: v.id("coveragePlans") },
  returns: v.object({
    plan: planDoc,
    outlets: v.array(outletDoc),
    slots: v.array(slotDoc),
    assignments: v.array(assignmentDoc),
    warnings: v.array(v.string()),
  }),
  handler: async (ctx, { planId }) => {
    const plan = await ctx.db.get(planId);
    if (!plan) throw new ConvexError("Plan not found");
    await planAccess(ctx, plan, "mcp.read");
    const rows = await planRows(ctx, planId);
    await assertOutletsScoped(
      ctx,
      [
        ...rows.outlets.map((row) => row.outletId),
        ...rows.slots.flatMap((row) => (row.outletId ? [row.outletId] : [])),
      ],
      "mcp.read",
    );
    const warnings: string[] = [];
    const effectiveInstant = Math.max(plan.effectiveFrom, Date.now());
    const employee = await employeeAt(
      ctx,
      plan.assigneeProfileId,
      effectiveInstant,
    );
    if (!employee.positionId)
      warnings.push("No position assigned; weekly routine unavailable");
    else {
      const routines = await bounded(
        ctx.db
          .query("positionRoutineTemplates")
          .withIndex("by_positionId_and_effectiveFrom", (q) =>
            q.eq("positionId", employee.positionId!),
          )
          .take(MAX_PLAN_ROWS + 1),
        "Position routines",
      );
      if (
        !routines.some(
          (r) =>
            r.effectiveFrom <= effectiveInstant &&
            (r.effectiveTo === undefined || r.effectiveTo > effectiveInstant),
        )
      )
        warnings.push("No weekly routine for position; no routine inferred");
      const standards = await bounded(
        ctx.db
          .query("positionStandards")
          .withIndex("by_positionId_and_effectiveFrom", (q) =>
            q.eq("positionId", employee.positionId!),
          )
          .take(MAX_PLAN_ROWS + 1),
        "Position standards",
      );
      const standard = at(standards, effectiveInstant);
      if (standard?.dailyCallsTarget)
        for (const date of monthDates(plan.localMonth)) {
          if (
            localDate(date) < plan.effectiveFrom ||
            localDate(date) >= plan.effectiveTo
          )
            continue;
          const visits = rows.slots.filter(
            (s) => s.serviceDate === date && s.kind === "outlet_visit",
          ).length;
          if (visits && visits < standard.dailyCallsTarget)
            warnings.push(
              `${date}: ${visits} planned stores; position standard ${standard.dailyCallsTarget}/day (${standard.sourceRef})`,
            );
        }
    }
    return { plan, ...rows, warnings };
  },
});
export const create = mutation({
  args: { assigneeProfileId: v.id("profiles"), localMonth: v.string() },
  returns: planDoc,
  handler: async (ctx, args) => {
    const { from, to } = monthBounds(args.localMonth);
    const now = Date.now();
    if (to <= now) throw new ConvexError("Cannot create a past-month plan");
    // Keep the plan on Manila day boundaries; today's early hours may not yet
    // be covered by a mid-day hire and are checked per slot at approval.
    const start = from <= now ? localDate(manilaDate(now)) : from;
    return make(ctx, args.assigneeProfileId, args.localMonth, start, to);
  },
});
export const createRevision = mutation({
  args: {
    planId: v.id("coveragePlans"),
    effectiveFromDate: v.string(),
    reason: v.string(),
  },
  returns: planDoc,
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.planId);
    if (!source) throw new ConvexError("Plan not found");
    await planAccess(ctx, source, "mcp.plan");
    if (source.status !== "approved" && source.status !== "active")
      throw new ConvexError("Revision requires approved or active plan");
    const reason = required(args.reason, "Revision reason");
    const from = localDate(args.effectiveFromDate);
    if (from < localDate(manilaDate(Date.now())))
      throw new ConvexError("Revision cannot be backdated");
    const plan = await make(
      ctx,
      source.assigneeProfileId,
      source.localMonth,
      from,
      source.effectiveTo,
      source,
      reason,
    );
    const rows = await planRows(ctx, source._id);
    await assertOutletsScoped(
      ctx,
      rows.outlets.map((row) => row.outletId),
      "mcp.plan",
    );
    for (const row of rows.outlets) {
      const { _id, _creationTime, ...data } = row;
      void _id;
      void _creationTime;
      await ctx.db.insert("coveragePlanOutlets", {
        ...data,
        planId: plan._id,
        contentRevision: 1,
        updatedBy: plan.preparedBy,
        updatedAt: Date.now(),
      });
    }
    for (const row of rows.slots.filter(
      (s) => localDate(s.serviceDate) >= from,
    )) {
      const { _id, _creationTime, approvedSnapshot, ...data } = row;
      void _id;
      void _creationTime;
      void approvedSnapshot;
      await ctx.db.insert("coveragePlanSlots", {
        ...data,
        planId: plan._id,
        contentRevision: 1,
        updatedBy: plan.preparedBy,
        updatedAt: Date.now(),
      });
    }
    return plan;
  },
});
export const saveOutlets = mutation({
  args: { planId: v.id("coveragePlans"), outlets: v.array(outletInput) },
  returns: v.array(outletDoc),
  handler: async (ctx, args) => {
    const { plan, actor } = await draft(ctx, args.planId);
    if (
      args.outlets.length > MAX_PLAN_ROWS ||
      new Set(args.outlets.map((o) => o.outletId)).size !== args.outlets.length
    )
      throw new ConvexError("Too many or duplicate plan outlets");
    const previous = (await planRows(ctx, plan._id)).outlets;
    await assertOutletsScoped(
      ctx,
      [
        ...previous.map((o) => o.outletId),
        ...args.outlets.map((o) => o.outletId),
      ],
      "mcp.plan",
    );
    for (const o of args.outlets) {
      positive(o.expectedDurationMinutes, "Duration");
      if (!Number.isSafeInteger(o.priority) || o.priority < 0)
        throw new ConvexError("Invalid priority");
      if (o.sequence !== undefined) positive(o.sequence, "Sequence");
      if (
        o.weekOrdinal !== undefined &&
        (!Number.isInteger(o.weekOrdinal) ||
          o.weekOrdinal < 1 ||
          o.weekOrdinal > 5)
      )
        throw new ConvexError("Invalid week ordinal");
      if (new Set(o.preferredWeekdays).size !== o.preferredWeekdays.length)
        throw new ConvexError("Duplicate weekday");
      for (const date of [
        ...o.customLocalDates,
        ...(o.anchorLocalDate ? [o.anchorLocalDate] : []),
      ])
        if (
          !date.startsWith(plan.localMonth) ||
          localDate(date) < plan.requestedFrom ||
          localDate(date) >= plan.requestedTo
        )
          throw new ConvexError("Outlet date outside month");
      for (const objective of o.requiredObjectives)
        required(objective, "Objective");
      const scope = await ctx.db.get(o.outletId);
      if (!scope || scope.status !== "active")
        throw new ConvexError("Inactive outlet");
      const territory = await ctx.db.get(o.territoryId);
      if (!territory || territory.organizationId !== plan.organizationId)
        throw new ConvexError("Invalid territory");
    }
    for (const row of previous) await ctx.db.delete(row._id);
    const result = [];
    for (const o of args.outlets) {
      // Today's plan boundary can precede a mid-day outlet assignment.
      const source = await resolveOutletScopeAt(
        ctx,
        o.outletId,
        Math.max(plan.effectiveFrom, Date.now()),
      );
      if (source.assignment?.territoryId !== o.territoryId)
        throw new ConvexError(
          "Plan outlet territory differs from effective assignment",
        );
      await requireCapability(ctx, "mcp.plan", source.orgUnitId);
      const id = await ctx.db.insert("coveragePlanOutlets", {
        ...o,
        routeId: o.routeId ?? source.assignment.routeId,
        sequence: o.sequence ?? source.assignment.sequence,
        preferredWeekdays: o.preferredWeekdays.length
          ? o.preferredWeekdays
          : source.outlet.preferredWeekday === undefined
            ? []
            : [source.outlet.preferredWeekday as 0 | 1 | 2 | 3 | 4 | 5 | 6],
        planId: plan._id,
        contentRevision: plan.contentRevision + 1,
        updatedBy: actor,
        updatedAt: Date.now(),
      });
      result.push((await ctx.db.get(id))!);
    }
    await ctx.db.patch(plan._id, {
      territoryIds: [...new Set(args.outlets.map((o) => o.territoryId))],
    });
    await bump(ctx, plan, actor, "outlets.saved", {
      outletCount: result.length,
      previousCount: previous.length,
    });
    return result;
  },
});
export const saveSlots = mutation({
  args: { planId: v.id("coveragePlans"), slots: v.array(slotInput) },
  returns: v.array(slotDoc),
  handler: async (ctx, args) => {
    const { plan, actor } = await draft(ctx, args.planId);
    if (
      args.slots.length > MAX_PLAN_ROWS ||
      new Set(args.slots.map((s) => s.slotKey)).size !== args.slots.length
    )
      throw new ConvexError("Too many or duplicate slot keys");
    const previous = (await planRows(ctx, plan._id)).slots;
    await assertOutletsScoped(
      ctx,
      [
        ...previous.flatMap((s) => (s.outletId ? [s.outletId] : [])),
        ...args.slots.flatMap((s) => (s.outletId ? [s.outletId] : [])),
      ],
      "mcp.plan",
    );
    for (const s of args.slots) {
      required(s.slotKey, "Slot key");
      positive(s.sequence, "Sequence");
      if (
        !Number.isSafeInteger(s.expectedDurationMinutes) ||
        s.expectedDurationMinutes < 0
      )
        throw new ConvexError("Invalid duration");
      const instant = localDate(s.serviceDate);
      if (instant < plan.effectiveFrom || instant >= plan.effectiveTo)
        throw new ConvexError("Slot outside plan period");
      if (s.kind === "outlet_visit" ? !s.outletId : !!s.outletId || !!s.routeId)
        throw new ConvexError("Invalid slot kind/outlet combination");
      for (const value of [...s.requiredObjectives, ...s.intents])
        required(value, "Objective/intent");
      if (s.activityKind !== undefined) required(s.activityKind, "Activity");
      if (s.namedTruckRef !== undefined)
        required(s.namedTruckRef, "Truck reference");
    }
    const retained = new Set(args.slots.map((s) => s.slotKey));
    for (const old of previous.filter((s) => !retained.has(s.slotKey)))
      await ctx.db.delete(old._id);
    const result = [];
    for (const s of args.slots) {
      const old = previous.find((row) => row.slotKey === s.slotKey);
      const data = {
        ...s,
        contentRevision: plan.contentRevision + 1,
        updatedBy: actor,
        updatedAt: Date.now(),
      };
      if (old) await ctx.db.patch(old._id, data);
      else
        await ctx.db.insert("coveragePlanSlots", {
          ...data,
          planId: plan._id,
          assigneeProfileId: plan.assigneeProfileId,
        });
    }
    const rows = (await planRows(ctx, plan._id)).slots;
    result.push(...rows);
    await bump(ctx, plan, actor, "slots.saved", {
      slotCount: result.length,
      previousCount: previous.length,
    });
    return result;
  },
});
export const setAssignment = mutation({
  args: {
    planId: v.id("coveragePlans"),
    effectiveFrom: v.number(),
    effectiveTo: v.number(),
    reason: v.string(),
  },
  returns: assignmentDoc,
  handler: async (ctx, args) => {
    const { plan, actor } = await draft(ctx, args.planId);
    const reason = required(args.reason, "Assignment reason");
    planWindow(plan.localMonth, args.effectiveFrom, args.effectiveTo);
    if (args.effectiveFrom < localDate(manilaDate(Date.now())))
      throw new ConvexError("Coverage assignment cannot be backdated");
    if (
      localDate(manilaDate(args.effectiveFrom)) !== args.effectiveFrom ||
      localDate(manilaDate(args.effectiveTo)) !== args.effectiveTo
    )
      throw new ConvexError(
        "Coverage assignment must use Manila day boundaries",
      );
    const employee = await employeeAt(
      ctx,
      plan.assigneeProfileId,
      Math.max(args.effectiveFrom, Date.now()),
    );
    await requireCapability(ctx, "mcp.plan", employee.orgUnitId!);
    if (employee.orgUnitId !== plan.orgUnitId)
      throw new ConvexError("Assignee unit changed; create a new scoped plan");
    const rows = (await planRows(ctx, plan._id)).assignments;
    for (const old of rows) await ctx.db.delete(old._id);
    const id = await ctx.db.insert("coverageAssignments", {
      planId: plan._id,
      assigneeProfileId: plan.assigneeProfileId,
      orgUnitId: plan.orgUnitId,
      primary: true,
      effectiveFrom: args.effectiveFrom,
      effectiveTo: args.effectiveTo,
      reason,
      actorSubject: actor,
      createdAt: Date.now(),
    });
    await ctx.db.patch(plan._id, {
      effectiveFrom: args.effectiveFrom,
      effectiveTo: args.effectiveTo,
      requestedFrom: args.effectiveFrom,
      requestedTo: args.effectiveTo,
    });
    await bump(
      ctx,
      plan,
      actor,
      "assignment.changed",
      { effectiveFrom: args.effectiveFrom, effectiveTo: args.effectiveTo },
      reason,
    );
    return (await ctx.db.get(id))!;
  },
});
export const submit = mutation({
  args: { planId: v.id("coveragePlans") },
  returns: planDoc,
  handler: async (ctx, { planId }) => {
    const { plan, actor } = await draft(ctx, planId);
    const rows = await planRows(ctx, planId);
    if (rows.assignments.length !== 1 || !rows.assignments[0]?.primary)
      throw new ConvexError("Primary coverage assignment required");
    await assertOutletsScoped(
      ctx,
      [
        ...rows.outlets.map((o) => o.outletId),
        ...rows.slots.flatMap((s) => (s.outletId ? [s.outletId] : [])),
      ],
      "mcp.plan",
    );
    await ctx.db.patch(planId, {
      status: "submitted",
      submittedBy: actor,
      submittedAt: Date.now(),
      updatedBy: actor,
      updatedAt: Date.now(),
    });
    await auditPlan(ctx, plan, actor, "plan.submitted", planState(plan), {
      ...planState(plan),
      status: "submitted",
    });
    return (await ctx.db.get(planId))!;
  },
});
export const returnPlan = mutation({
  args: { planId: v.id("coveragePlans"), reason: v.string() },
  returns: planDoc,
  handler: async (ctx, { planId, reason }) => {
    const plan = await ctx.db.get(planId);
    if (!plan) throw new ConvexError("Plan not found");
    const access = await planAccess(ctx, plan, "mcp.approve");
    if (access.profile._id === plan.assigneeProfileId)
      throw new ConvexError("Independent approver required");
    if (plan.status !== "submitted")
      throw new ConvexError("Only submitted plans can be returned");
    const message = required(reason, "Return reason");
    await ctx.db.patch(planId, {
      status: "draft",
      updatedBy: access.identity.tokenIdentifier,
      updatedAt: Date.now(),
    });
    await auditPlan(
      ctx,
      plan,
      access.identity.tokenIdentifier,
      "plan.returned",
      planState(plan),
      { ...planState(plan), status: "draft" },
      { reason: message },
    );
    return (await ctx.db.get(planId))!;
  },
});
export const approve = mutation({
  args: { planId: v.id("coveragePlans") },
  returns: planDoc,
  handler: async (ctx, { planId }) => {
    const plan = await ctx.db.get(planId);
    if (!plan) throw new ConvexError("Plan not found");
    const access = await planAccess(ctx, plan, "mcp.approve");
    if (access.profile._id === plan.assigneeProfileId)
      throw new ConvexError("Independent approver required");
    const actor = access.identity.tokenIdentifier;
    if (plan.status !== "submitted")
      throw new ConvexError("Only submitted plans can be approved");
    if (plan.preparedBy === actor || plan.submittedBy === actor)
      throw new ConvexError("Independent approver required");
    planWindow(plan.localMonth, plan.effectiveFrom, plan.effectiveTo);
    const rows = await planRows(ctx, planId);
    if (!rows.slots.length)
      throw new ConvexError("Plan needs dated slots before approval");
    const assignment = rows.assignments[0];
    if (
      rows.assignments.length !== 1 ||
      !assignment?.primary ||
      assignment.assigneeProfileId !== plan.assigneeProfileId ||
      assignment.orgUnitId !== plan.orgUnitId ||
      assignment.effectiveFrom !== plan.effectiveFrom ||
      assignment.effectiveTo !== plan.effectiveTo
    )
      throw new ConvexError("Invalid primary plan assignment");
    await assertOutletsScoped(
      ctx,
      [
        ...rows.outlets.map((o) => o.outletId),
        ...rows.slots.flatMap((s) => (s.outletId ? [s.outletId] : [])),
      ],
      "mcp.approve",
    );
    const versions = await existingPlans(
      ctx,
      plan.assigneeProfileId,
      plan.localMonth,
    );
    for (const prior of versions.filter(
      (p) =>
        p._id !== planId && (p.status === "approved" || p.status === "active"),
    )) {
      if (overlaps(prior, plan) && plan.basedOnPlanId !== prior._id)
        throw new ConvexError(
          "Overlapping approved coverage requires named successor",
        );
      if (overlaps(prior, plan) && plan.effectiveFrom <= prior.effectiveFrom)
        throw new ConvexError("Successor must start after predecessor");
    }
    const sequences = new Set<string>();
    const snapshots: {
      slot: Doc<"coveragePlanSlots">;
      snapshot: Awaited<ReturnType<typeof snapshotSlot>>;
    }[] = [];
    for (const slot of rows.slots) {
      if (slot.assigneeProfileId !== plan.assigneeProfileId)
        throw new ConvexError("Slot assignee mismatch");
      const instant = localDate(slot.serviceDate);
      if (instant < localDate(manilaDate(Date.now())))
        throw new ConvexError("Cannot approve elapsed service date");
      if (instant < plan.effectiveFrom || instant >= plan.effectiveTo)
        throw new ConvexError("Slot outside plan period");
      const staff = await employeeAt(
        ctx,
        plan.assigneeProfileId,
        instant,
        `Assignee not assigned on ${slot.serviceDate}`,
      );
      await requireCapability(ctx, "mcp.approve", staff.orgUnitId!);
      if (staff.orgUnitId !== plan.orgUnitId)
        throw new ConvexError("Assignee unit changed on service date");
      if (slot.kind === "non_visit" && staff.positionId) {
        const position = await ctx.db.get(staff.positionId);
        if (
          position?.code === "DS" &&
          /work[ -]?with/i.test(slot.activityKind ?? "") &&
          !slot.namedTruckRef?.trim()
        )
          throw new ConvexError(
            "Distributor Specialist Work-With requires named truck",
          );
      }
      if (slot.kind !== "outlet_visit") continue;
      const key = `${slot.serviceDate}:${slot.sequence}`;
      if (sequences.has(key))
        throw new ConvexError("Duplicate sequence on service date");
      sequences.add(key);
      snapshots.push({ slot, snapshot: await snapshotSlot(ctx, plan, slot) });
    }
    await assertNoBlockingExceptions(ctx, planId);
    // Web Crypto is available in Convex's V8 runtime; hash the exact signed sorted payload.
    const signedContent = JSON.stringify({
      plan: {
        id: planId,
        version: plan.version,
        assignee: plan.assigneeProfileId,
        organization: plan.organizationId,
        month: plan.localMonth,
        cycle: plan.cycleType,
        unit: plan.orgUnitId,
        requestedFrom: plan.requestedFrom,
        requestedTo: plan.requestedTo,
        effectiveFrom: plan.effectiveFrom,
        effectiveTo: plan.effectiveTo,
        territoryIds: plan.territoryIds,
        basedOnPlanId: plan.basedOnPlanId,
        revisionReason: plan.revisionReason,
        preparedBy: plan.preparedBy,
      },
      assignment,
      outlets: [...rows.outlets].sort((a, b) =>
        a.outletId.localeCompare(b.outletId),
      ),
      slots: [...rows.slots]
        .sort((a, b) => a.slotKey.localeCompare(b.slotKey))
        .map((slot) => ({
          ...slot,
          approvedSnapshot: snapshots.find((x) => x.slot._id === slot._id)
            ?.snapshot,
        })),
    });
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(signedContent),
    );
    const contentHash = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const approvedAt = Date.now();
    const approvalSignature = `${planId}:${plan.version}:${actor}:${approvedAt}:${contentHash}`;
    for (const { slot, snapshot } of snapshots)
      await ctx.db.patch(slot._id, { approvedSnapshot: snapshot });
    await ctx.db.patch(planId, {
      status: "approved",
      approvedBy: actor,
      approvedAt,
      approvalSignature,
      contentHash,
      updatedBy: actor,
      updatedAt: approvedAt,
    });
    await auditPlan(
      ctx,
      plan,
      actor,
      "plan.approved",
      planState(plan),
      { ...planState(plan), status: "approved", contentHash },
      { approvalSignatureRef: approvalSignature },
    );
    return (await ctx.db.get(planId))!;
  },
});
