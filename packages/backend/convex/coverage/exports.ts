import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import {
  assertOrganization,
  bounded,
  MAX_PLAN_ROWS,
  outletAccess,
  planAccess,
  planRows,
} from "./validation";

const visitStatus = v.union(
  v.literal("planned"),
  v.literal("cancelled"),
  v.literal("replaced"),
);
const header = v.object({
  planId: v.id("coveragePlans"),
  localMonth: v.string(),
  version: v.number(),
  status: v.string(),
  assigneeName: v.string(),
  preparedByName: v.string(),
  preparedAt: v.number(),
  submittedByName: v.optional(v.string()),
  submittedAt: v.optional(v.number()),
  approvedByName: v.optional(v.string()),
  approvedAt: v.optional(v.number()),
  signedHashPrefix: v.optional(v.string()),
});
const exportRow = v.object({
  slotKey: v.string(),
  serviceDate: v.string(),
  kind: v.string(),
  outletCode: v.optional(v.string()),
  name: v.optional(v.string()),
  territoryId: v.optional(v.id("territories")),
  routeId: v.optional(v.id("routes")),
  territoryCode: v.optional(v.string()),
  routeCode: v.optional(v.string()),
  sequence: v.number(),
  visitStatus: v.optional(visitStatus),
  durationMinutes: v.number(),
});
async function actorName(
  ctx: QueryCtx,
  subject?: string,
): Promise<string | undefined> {
  if (!subject) return undefined;
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_subject", (q) => q.eq("authSubject", subject))
    .unique();
  return profile?.name || "Former user";
}

/** An authorized, complete projection; never accept a caller-supplied unit or data. */
export const schedule = query({
  args: {
    planId: v.id("coveragePlans"),
    territoryId: v.optional(v.id("territories")),
    routeId: v.optional(v.id("routes")),
    visitStatus: v.optional(visitStatus),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(exportRow),
    continueCursor: v.string(),
    isDone: v.boolean(),
    planHeader: header,
  }),
  handler: async (ctx, args) => {
    const { numItems, cursor } = args.paginationOpts;
    if (!Number.isSafeInteger(numItems) || numItems < 1 || numItems > 20)
      throw new ConvexError("Page size must be 1–20");
    const offset = cursor === null ? 0 : Number(cursor);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (cursor !== null && String(offset) !== cursor)
    )
      throw new ConvexError("Invalid page cursor");
    const plan = await ctx.db.get(args.planId);
    if (!plan) throw new ConvexError("Plan not found");
    assertOrganization(plan.organizationId);
    await planAccess(ctx, plan, "mcp.read");
    const { outlets, slots } = await planRows(ctx, plan._id);
    // Check the entire plan on every page, including rows outside the selected filter.
    for (const id of new Set<Id<"outlets">>([
      ...outlets.map((o) => o.outletId),
      ...slots.flatMap((s) => (s.outletId ? [s.outletId] : [])),
    ]))
      await outletAccess(ctx, id, "mcp.read");
    const visits = await bounded(
      ctx.db
        .query("plannedVisits")
        .withIndex("by_planId_and_serviceDate", (q) => q.eq("planId", plan._id))
        .take(MAX_PLAN_ROWS + 1),
      "Plan visits",
    );
    if (new Set(visits.map((x) => x.planSlotId)).size !== visits.length)
      throw new ConvexError("Duplicate generated visit");
    const bySlot = new Map(visits.map((x) => [x.planSlotId, x]));
    const byOutlet = new Map(outlets.map((x) => [x.outletId, x]));
    const signed = ["approved", "active", "superseded"].includes(plan.status);
    if (
      signed &&
      (!plan.contentHash ||
        !plan.approvalSignature ||
        !plan.approvedBy ||
        !plan.approvedAt ||
        plan.approvalSignature !==
          `${plan._id}:${plan.version}:${plan.approvedBy}:${plan.approvedAt}:${plan.contentHash}`)
    )
      throw new ConvexError("Invalid signed plan metadata");
    const rows = [];
    for (const slot of slots) {
      const visit = bySlot.get(slot._id);
      const snapshot = visit?.approvedSnapshot ?? slot.approvedSnapshot;
      if (signed && slot.kind === "outlet_visit" && !snapshot)
        throw new ConvexError("Approved outlet snapshot missing");
      const proposal = slot.outletId ? byOutlet.get(slot.outletId) : undefined;
      const outlet =
        !snapshot && slot.outletId ? await ctx.db.get(slot.outletId) : null;
      const territoryId = snapshot?.territoryId ?? proposal?.territoryId;
      const routeId = snapshot?.routeId ?? slot.routeId ?? proposal?.routeId;
      if (args.territoryId && territoryId !== args.territoryId) continue;
      if (args.routeId && routeId !== args.routeId) continue;
      if (args.visitStatus && visit?.status !== args.visitStatus) continue;
      const territory =
        !snapshot && territoryId ? await ctx.db.get(territoryId) : null;
      const route = !snapshot && routeId ? await ctx.db.get(routeId) : null;
      rows.push({
        slotKey: slot.slotKey,
        serviceDate: slot.serviceDate,
        kind: slot.kind,
        outletCode: snapshot?.outletCode ?? outlet?.code,
        name: snapshot?.outletName ?? outlet?.name ?? slot.activityKind,
        territoryId,
        routeId,
        territoryCode: snapshot?.territoryCode ?? territory?.code,
        routeCode: snapshot?.routeCode ?? route?.code,
        sequence: slot.sequence,
        visitStatus: visit?.status,
        durationMinutes:
          visit?.expectedDurationMinutes ?? slot.expectedDurationMinutes,
      });
    }
    rows.sort(
      (a, b) =>
        a.serviceDate.localeCompare(b.serviceDate) ||
        a.sequence - b.sequence ||
        a.slotKey.localeCompare(b.slotKey),
    );
    const assignee = await ctx.db.get(plan.assigneeProfileId);
    if (!assignee || assignee.status !== "active")
      throw new ConvexError("Assignee unavailable");
    const planHeader = {
      planId: plan._id,
      localMonth: plan.localMonth,
      version: plan.version,
      status: signed ? plan.status : "UNAPPROVED",
      assigneeName: assignee.name,
      preparedByName: (await actorName(ctx, plan.preparedBy))!,
      preparedAt: plan.preparedAt,
      submittedByName: await actorName(ctx, plan.submittedBy),
      submittedAt: plan.submittedAt,
      approvedByName: signed
        ? await actorName(ctx, plan.approvedBy)
        : undefined,
      approvedAt: signed ? plan.approvedAt : undefined,
      signedHashPrefix: signed ? plan.contentHash!.slice(0, 12) : undefined,
    };
    return {
      page: rows.slice(offset, offset + numItems),
      continueCursor: String(offset + numItems),
      isDone: offset + numItems >= rows.length,
      planHeader,
    };
  },
});
