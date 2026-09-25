import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
} from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import { requireCapability } from "../lib/capabilities";
import { requireActiveProfile } from "../lib/auth";
import { auditPlan, planState } from "./audit";
import {
  approvedSlots,
  bounded,
  employeeAt,
  localDate,
  manilaDate,
  MAX_PLAN_ROWS,
  monthBounds,
  planAccess,
} from "./validation";

const result = v.object({
  planId: v.id("coveragePlans"),
  visitIds: v.array(v.id("plannedVisits")),
  count: v.number(),
});
const SYSTEM_ACTOR = "system:coverage-due";

async function reconcile(
  ctx: MutationCtx,
  plan: Doc<"coveragePlans">,
  actor: string,
) {
  const now = Date.now();
  if (plan.status !== "approved" && plan.status !== "active")
    throw new ConvexError("Only approved or active plans can activate");
  if (plan.effectiveFrom > now)
    throw new ConvexError("Coverage plan not yet effective");
  const isNew = plan.status === "approved";
  const predecessor = plan.basedOnPlanId
    ? await ctx.db.get(plan.basedOnPlanId)
    : null;
  if (
    isNew &&
    plan.basedOnPlanId &&
    (!predecessor ||
      (predecessor.status !== "active" && predecessor.status !== "approved"))
  )
    throw new ConvexError("Successor predecessor is not approved or active");
  const slots = await approvedSlots(ctx, plan);
  const today = manilaDate(now);
  const eligible = slots.filter(
    (s) =>
      s.serviceDate >= today &&
      s.serviceDate >= manilaDate(plan.effectiveFrom) &&
      s.serviceDate < manilaDate(plan.effectiveTo),
  );
  const visitIds: Id<"plannedVisits">[] = [];
  const newBySlot = new Map<string, Id<"plannedVisits">>();
  const newByOutlet = new Map<string, Id<"plannedVisits">>();
  for (const slot of eligible) {
    const snapshot = slot.approvedSnapshot!;
    const generationKey = [
      plan.organizationId,
      plan._id,
      plan.version,
      slot._id,
      slot.serviceDate,
      plan.assigneeProfileId,
    ].join("|");
    const existing = await ctx.db
      .query("plannedVisits")
      .withIndex("by_generationKey", (q) =>
        q.eq("generationKey", generationKey),
      )
      .take(2);
    if (existing.length > 1)
      throw new ConvexError("Duplicate planned visit generation key");
    const id =
      existing[0]?._id ??
      (await ctx.db.insert("plannedVisits", {
        generationKey,
        planId: plan._id,
        planVersion: plan.version,
        planSlotId: slot._id,
        assigneeProfileId: plan.assigneeProfileId,
        outletId: snapshot.outletId,
        serviceDate: slot.serviceDate,
        status: "planned",
        approvedSnapshot: snapshot,
        requiredObjectives: slot.requiredObjectives,
        intents: slot.intents,
        expectedDurationMinutes: slot.expectedDurationMinutes,
        generatedAt: now,
      }));
    visitIds.push(id);
    newBySlot.set(`${slot.serviceDate}|${slot.slotKey}`, id);
    newByOutlet.set(`${slot.serviceDate}|${snapshot.outletId}`, id);
  }
  if (isNew && predecessor) {
    const prior = await bounded(
      ctx.db
        .query("plannedVisits")
        .withIndex("by_planId_and_serviceDate", (q) =>
          q.eq("planId", predecessor._id),
        )
        .take(MAX_PLAN_ROWS + 1),
      "Predecessor planned visits",
    );
    const priorSlots = await approvedSlots(ctx, predecessor);
    const keys = new Map(priorSlots.map((s) => [s._id, s.slotKey]));
    let displaced = 0;
    const linked = new Set<Id<"plannedVisits">>();
    for (const old of prior) {
      if (
        old.status !== "planned" ||
        old.serviceDate < today ||
        localDate(old.serviceDate) < plan.effectiveFrom
      )
        continue;
      // Future execution tables must be checked here before adding an actual-visit writer (group 07).
      const candidate =
        newBySlot.get(`${old.serviceDate}|${keys.get(old.planSlotId)}`) ??
        newByOutlet.get(`${old.serviceDate}|${old.outletId}`);
      const replacement =
        candidate && !linked.has(candidate) ? candidate : undefined;
      if (replacement) linked.add(replacement);
      await ctx.db.patch(old._id, {
        status: replacement ? "replaced" : "cancelled",
        ...(replacement ? { replacedByVisitId: replacement } : {}),
        cancellationReason: `Superseded by coverage plan ${plan._id}`,
        cancelledAt: now,
      });
      if (replacement)
        await ctx.db.patch(replacement, { replacementOfVisitId: old._id });
      await auditPlan(
        ctx,
        predecessor,
        actor,
        replacement ? "visit.replaced" : "visit.cancelled",
        { status: old.status },
        { status: replacement ? "replaced" : "cancelled" },
        {
          affectedEntity: "plannedVisit",
          affectedRowId: old._id,
          approvalSignatureRef: predecessor.approvalSignature,
        },
      );
      displaced++;
    }
    await ctx.db.patch(predecessor._id, {
      status: "superseded",
      supersededAt: now,
      activeThrough: plan.effectiveFrom,
      updatedBy: actor,
      updatedAt: now,
    });
    await auditPlan(
      ctx,
      predecessor,
      actor,
      "plan.superseded",
      planState(predecessor),
      {
        ...planState(predecessor),
        status: "superseded",
        activeThrough: plan.effectiveFrom,
        displaced,
      },
      {
        affectedEntity: "coveragePlan",
        approvalSignatureRef: predecessor.approvalSignature,
      },
    );
  }
  if (isNew) {
    await ctx.db.patch(plan._id, {
      status: "active",
      activatedAt: now,
      updatedBy: actor,
      updatedAt: now,
    });
    await auditPlan(
      ctx,
      plan,
      actor,
      "plan.activated",
      planState(plan),
      { ...planState(plan), status: "active", activatedAt: now },
      { approvalSignatureRef: plan.approvalSignature },
    );
    await auditPlan(
      ctx,
      plan,
      actor,
      "visits.generated",
      { count: 0 },
      { count: visitIds.length },
      {
        affectedEntity: "plannedVisits",
        approvalSignatureRef: plan.approvalSignature,
      },
    );
  }
  if (!isNew) {
    // A reconciliation after the calendar advances still returns the original stable set.
    const persisted = await bounded(
      ctx.db
        .query("plannedVisits")
        .withIndex("by_planId_and_serviceDate", (q) => q.eq("planId", plan._id))
        .take(MAX_PLAN_ROWS + 1),
      "Activated planned visits",
    );
    const bySlot = new Map(
      persisted.map((visit) => [visit.planSlotId, visit._id]),
    );
    const ordered = slots.flatMap((slot) => {
      const id = bySlot.get(slot._id);
      return id ? [id] : [];
    });
    return { planId: plan._id, visitIds: ordered, count: ordered.length };
  }
  return { planId: plan._id, visitIds, count: visitIds.length };
}

export const activate = mutation({
  args: { planId: v.id("coveragePlans") },
  returns: result,
  handler: async (ctx, { planId }) => {
    const plan = await ctx.db.get(planId);
    if (!plan) throw new ConvexError("Plan not found");
    const { identity } = await planAccess(ctx, plan, "mcp.approve");
    return reconcile(ctx, plan, identity.tokenIdentifier);
  },
});

export const plannedForMonth = query({
  args: { assigneeProfileId: v.id("profiles"), localMonth: v.string() },
  returns: v.array(schema.doc("plannedVisits")),
  handler: async (ctx, args) => {
    const { from, to } = monthBounds(args.localMonth);
    const { profile } = await requireActiveProfile(ctx);
    if (profile.role === "sales" && profile._id !== args.assigneeProfileId)
      throw new ConvexError("Sales may access only own plan");
    const plans = await bounded(
      ctx.db
        .query("coveragePlans")
        .withIndex("by_assigneeProfileId_and_localMonth_and_status", (q) =>
          q
            .eq("assigneeProfileId", args.assigneeProfileId)
            .eq("localMonth", args.localMonth),
        )
        .take(MAX_PLAN_ROWS + 1),
      "Coverage plans",
    );
    if (!plans.length) {
      const assignment = await employeeAt(
        ctx,
        args.assigneeProfileId,
        Math.max(from, Date.now()),
      );
      await requireCapability(ctx, "mcp.read", assignment.orgUnitId!);
    }
    for (const plan of plans) await planAccess(ctx, plan, "mcp.read");
    const visits = await bounded(
      ctx.db
        .query("plannedVisits")
        .withIndex("by_assigneeProfileId_and_serviceDate", (q) =>
          q
            .eq("assigneeProfileId", args.assigneeProfileId)
            .gte("serviceDate", manilaDate(from))
            .lt("serviceDate", manilaDate(to)),
        )
        .take(MAX_PLAN_ROWS + 1),
      "Monthly planned visits",
    );
    // Every returned row must belong to a scope-checked persisted plan.
    const allowed = new Set(plans.map((p) => p._id));
    if (visits.some((row) => !allowed.has(row.planId)))
      throw new ConvexError("Plan scope mismatch");
    return visits;
  },
});

/** Called by cron. A bounded status/range index scan; the next hour handles the next batch. */
export const activateDue = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const due = await ctx.db
      .query("coveragePlans")
      .withIndex("by_status_and_effectiveFrom", (q) =>
        q.eq("status", "approved").lte("effectiveFrom", Date.now()),
      )
      .take(1);
    for (const plan of due) await reconcile(ctx, plan, SYSTEM_ACTOR);
    return due.length;
  },
});
