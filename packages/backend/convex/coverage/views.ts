import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { resolveOutletScopeAt } from "../outlets/validation";
import { at } from "../territories/route_validation";
import { scopedPlanPage } from "./discovery";
import {
  bounded,
  employeeAt,
  MAX_PLAN_ROWS,
  monthBounds,
  outletAccess,
  planAccess,
  planRows,
} from "./validation";

const planStatus = v.union(
  v.literal("draft"),
  v.literal("submitted"),
  v.literal("approved"),
  v.literal("active"),
  v.literal("superseded"),
);
const visitStatus = v.union(
  v.literal("planned"),
  v.literal("cancelled"),
  v.literal("replaced"),
);
const row = v.object({
  slotKey: v.string(),
  serviceDate: v.string(),
  kind: v.string(),
  outletCode: v.optional(v.string()),
  name: v.optional(v.string()),
  territoryId: v.optional(v.id("territories")),
  routeId: v.optional(v.id("routes")),
  routeCode: v.optional(v.string()),
  sequence: v.number(),
  planStatus,
  visitStatus: v.optional(visitStatus),
  durationMinutes: v.number(),
});
const routeRow = v.object({
  territoryId: v.optional(v.id("territories")),
  territoryCode: v.string(),
  routeId: v.optional(v.id("routes")),
  routeCode: v.string(),
  slotCount: v.number(),
  visitCount: v.number(),
  coveredCount: v.number(),
  uncoveredCount: v.number(),
  outlets: v.array(
    v.object({
      outletCode: v.string(),
      name: v.string(),
      frequency: v.optional(v.string()),
      covered: v.boolean(),
    }),
  ),
});
const workloadRow = v.object({
  assigneeProfileId: v.id("profiles"),
  assigneeName: v.string(),
  planId: v.id("coveragePlans"),
  version: v.number(),
  planStatus,
  selection: v.string(),
  routeCodes: v.array(v.string()),
  visitCount: v.number(),
  workingDays: v.array(v.string()),
  durationMinutes: v.number(),
  dailyCallsTarget: v.optional(v.number()),
  variance: v.optional(v.number()),
});
function pageSize(opts: { numItems: number; cursor: string | null }) {
  if (
    !Number.isSafeInteger(opts.numItems) ||
    opts.numItems < 1 ||
    opts.numItems > 20
  )
    throw new ConvexError("Page size must be 1–20");
  const offset = opts.cursor === null ? 0 : Number(opts.cursor);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (String(offset) !== opts.cursor && opts.cursor !== null)
  )
    throw new ConvexError("Invalid page cursor");
  return offset;
}
function page<T>(
  items: T[],
  opts: { numItems: number; cursor: string | null },
) {
  const start = pageSize(opts);
  return {
    page: items.slice(start, start + opts.numItems),
    isDone: start + opts.numItems >= items.length,
    continueCursor: String(start + opts.numItems),
  };
}
const signed = (plan: Doc<"coveragePlans">) =>
  ["approved", "active", "superseded"].includes(plan.status);
async function scoped(ctx: QueryCtx, planId: Id<"coveragePlans">) {
  const plan = await ctx.db.get(planId);
  if (!plan) throw new ConvexError("Plan not found");
  await planAccess(ctx, plan, "mcp.read");
  const rows = await planRows(ctx, planId);
  for (const id of new Set([
    ...rows.outlets.map((o) => o.outletId),
    ...rows.slots.flatMap((s) => (s.outletId ? [s.outletId] : [])),
  ]))
    await outletAccess(ctx, id, "mcp.read");
  return { plan, ...rows };
}
async function visits(ctx: QueryCtx, planId: Id<"coveragePlans">) {
  const result = await bounded(
    ctx.db
      .query("plannedVisits")
      .withIndex("by_planId_and_serviceDate", (q) => q.eq("planId", planId))
      .take(MAX_PLAN_ROWS + 1),
    "Plan visits",
  );
  if (new Set(result.map((x) => x.planSlotId)).size !== result.length)
    throw new ConvexError("Duplicate generated visit");
  return new Map(result.map((x) => [x.planSlotId, x]));
}
async function projection(
  ctx: QueryCtx,
  plan: Doc<"coveragePlans">,
  slots: Doc<"coveragePlanSlots">[],
) {
  const generated = await visits(ctx, plan._id);
  const planOutlets = await bounded(
    ctx.db
      .query("coveragePlanOutlets")
      .withIndex("by_planId_and_outletId", (q) => q.eq("planId", plan._id))
      .take(MAX_PLAN_ROWS + 1),
    "Plan outlets",
  );
  const proposed = new Map(planOutlets.map((x) => [x.outletId, x]));
  const rows = [];
  for (const slot of slots) {
    const visit = generated.get(slot._id);
    const snapshot = visit?.approvedSnapshot ?? slot.approvedSnapshot;
    if (signed(plan) && slot.kind === "outlet_visit" && !snapshot)
      throw new ConvexError("Approved outlet snapshot missing");
    const outlet =
      !snapshot && slot.outletId ? await ctx.db.get(slot.outletId) : null;
    const proposedRoute = slot.outletId
      ? proposed.get(slot.outletId)?.routeId
      : undefined;
    const route =
      !snapshot && (slot.routeId ?? proposedRoute)
        ? await ctx.db.get((slot.routeId ?? proposedRoute)!)
        : null;
    rows.push({
      slotKey: slot.slotKey,
      serviceDate: slot.serviceDate,
      kind: slot.kind,
      outletCode: snapshot?.outletCode ?? outlet?.code,
      name: snapshot?.outletName ?? outlet?.name ?? slot.activityKind,
      territoryId:
        snapshot?.territoryId ??
        (slot.outletId ? proposed.get(slot.outletId)?.territoryId : undefined),
      routeId:
        snapshot?.routeId ??
        slot.routeId ??
        (slot.outletId ? proposed.get(slot.outletId)?.routeId : undefined),
      routeCode: snapshot?.routeCode ?? route?.code,
      sequence: slot.sequence,
      planStatus: plan.status,
      visitStatus: visit?.status,
      durationMinutes:
        visit?.expectedDurationMinutes ?? slot.expectedDurationMinutes,
      outletId: snapshot?.outletId ?? slot.outletId,
      generated: !!visit,
    });
  }
  return rows.sort(
    (a, b) =>
      a.serviceDate.localeCompare(b.serviceDate) ||
      a.sequence - b.sequence ||
      a.slotKey.localeCompare(b.slotKey),
  );
}
export const calendar = query({
  args: {
    planId: v.id("coveragePlans"),
    territoryId: v.optional(v.id("territories")),
    routeId: v.optional(v.id("routes")),
    visitStatus: v.optional(visitStatus),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(row),
  handler: async (ctx, args) => {
    pageSize(args.paginationOpts);
    const { plan, slots } = await scoped(ctx, args.planId);
    const projected = await projection(ctx, plan, slots);
    const filtered = projected.filter(
      (x) =>
        (!args.territoryId || x.territoryId === args.territoryId) &&
        (!args.routeId || x.routeId === args.routeId) &&
        (!args.visitStatus || x.visitStatus === args.visitStatus),
    );
    return page(
      filtered.map((x) => ({
        slotKey: x.slotKey,
        serviceDate: x.serviceDate,
        kind: x.kind,
        outletCode: x.outletCode,
        name: x.name,
        territoryId: x.territoryId,
        routeId: x.routeId,
        routeCode: x.routeCode,
        sequence: x.sequence,
        planStatus: x.planStatus,
        visitStatus: x.visitStatus,
        durationMinutes: x.durationMinutes,
      })),
      args.paginationOpts,
    );
  },
});

/** No route is a real bucket; the bounded organization roster is filtered by current ownership. */
export const byRoute = query({
  args: {
    planId: v.id("coveragePlans"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(routeRow),
  handler: async (ctx, { planId, paginationOpts }) => {
    pageSize(paginationOpts);
    const { plan, slots, outlets } = await scoped(ctx, planId);
    const projected = await projection(ctx, plan, slots);
    const roster = await bounded(
      ctx.db
        .query("outlets")
        .withIndex("by_organizationId_and_code", (q) =>
          q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
        )
        .take(MAX_PLAN_ROWS + 1),
      "Organization outlet roster",
    );
    const current = new Map<
      Id<"outlets">,
      {
        code: string;
        name: string;
        territoryId?: Id<"territories">;
        routeId?: Id<"routes">;
      }
    >();
    for (const outlet of roster) {
      if (outlet.status !== "active" && outlet.status !== "prospect") continue;
      const owner = await resolveOutletScopeAt(ctx, outlet._id, Date.now());
      try {
        await requireCapability(ctx, "mcp.read", owner.orgUnitId);
      } catch (error) {
        if (error instanceof ConvexError) continue;
        throw error;
      }
      if (owner.assignment)
        current.set(outlet._id, {
          code: outlet.code,
          name: outlet.name,
          territoryId: owner.assignment.territoryId,
          routeId: owner.assignment.routeId,
        });
    }
    const groups = new Map<
      string,
      {
        territoryId?: Id<"territories">;
        routeId?: Id<"routes">;
        territoryCode: string;
        routeCode: string;
        slotCount: number;
        visitCount: number;
        outlets: Map<
          string,
          {
            outletCode: string;
            name: string;
            frequency?: string;
            covered: boolean;
          }
        >;
      }
    >();
    async function group(
      territoryId?: Id<"territories">,
      routeId?: Id<"routes">,
    ) {
      const key = `${territoryId ?? "none"}|${routeId ?? "none"}`;
      if (!groups.has(key)) {
        const territory = territoryId ? await ctx.db.get(territoryId) : null;
        const route = routeId ? await ctx.db.get(routeId) : null;
        groups.set(key, {
          territoryId,
          routeId,
          territoryCode: territory?.code ?? "No territory",
          routeCode: route?.code ?? "No route",
          slotCount: 0,
          visitCount: 0,
          outlets: new Map(),
        });
      }
      return groups.get(key)!;
    }
    for (const item of current.values())
      await group(item.territoryId, item.routeId);
    for (const row of outlets) {
      const live = current.get(row.outletId);
      // Signed route is frozen; draft uses its proposed route, never a scope grant.
      const firstSigned = signed(plan)
        ? projected.find(
            (x) => x.outletId === row.outletId && x.kind === "outlet_visit",
          )
        : undefined;
      const territoryId = firstSigned?.territoryId ?? row.territoryId;
      const routeId = firstSigned?.routeId ?? row.routeId;
      const g = await group(territoryId, routeId);
      const outlet = await ctx.db.get(row.outletId);
      g.outlets.set(row.outletId, {
        outletCode: firstSigned?.outletCode ?? outlet?.code ?? "Unknown",
        name: firstSigned?.name ?? outlet?.name ?? "Unknown",
        frequency: row.frequency,
        covered: true,
      });
      // A moved outlet is still a plan member, but must not inflate the current roster's uncovered bucket.
      if (
        live &&
        (live.territoryId !== territoryId || live.routeId !== routeId)
      )
        await group(live.territoryId, live.routeId);
    }
    for (const [id, outlet] of current) {
      const g = await group(outlet.territoryId, outlet.routeId);
      if (!g.outlets.has(id) && !outlets.some((row) => row.outletId === id))
        g.outlets.set(id, {
          outletCode: outlet.code,
          name: outlet.name,
          covered: false,
        });
    }
    for (const item of projected.filter((x) => x.kind === "outlet_visit")) {
      const g = await group(
        item.territoryId ??
          outlets.find((o) => o.outletId === item.outletId)?.territoryId,
        item.routeId,
      );
      g.slotCount++;
      if (
        plan.status === "active" || plan.status === "superseded"
          ? item.visitStatus === "planned"
          : true
      )
        g.visitCount++;
    }
    const result = [...groups.values()]
      .filter((g) => g.outlets.size || g.slotCount)
      .map((g) => {
        const members = [...g.outlets.values()].sort((a, b) =>
          a.outletCode.localeCompare(b.outletCode),
        );
        return {
          territoryId: g.territoryId,
          territoryCode: g.territoryCode,
          routeId: g.routeId,
          routeCode: g.routeCode,
          slotCount: g.slotCount,
          visitCount: g.visitCount,
          coveredCount: members.filter((x) => x.covered).length,
          uncoveredCount: members.filter((x) => !x.covered).length,
          outlets: members,
        };
      })
      .sort(
        (a, b) =>
          a.territoryCode.localeCompare(b.territoryCode) ||
          a.routeCode.localeCompare(b.routeCode),
      );
    return page(result, paginationOpts);
  },
});

export const workload = query({
  args: {
    localMonth: v.string(),
    territoryId: v.optional(v.id("territories")),
    routeId: v.optional(v.id("routes")),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(workloadRow),
  handler: async (ctx, args) => {
    pageSize(args.paginationOpts);
    monthBounds(args.localMonth);
    const candidates = await bounded(
      ctx.db
        .query("coveragePlans")
        .withIndex("by_org_month_status", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("localMonth", args.localMonth),
        )
        .take(MAX_PLAN_ROWS + 1),
      "Monthly plan versions",
    );
    const visible = await scopedPlanPage(ctx, candidates);
    const selected = new Map<Id<"profiles">, (typeof visible)[number]>();
    const rank = (p: Doc<"coveragePlans">) =>
      p.status === "active"
        ? 5
        : p.status === "approved" && p.effectiveFrom <= Date.now()
          ? 4
          : p.status === "submitted"
            ? 3
            : p.status === "draft"
              ? 2
              : p.status === "approved"
                ? 1
                : 0;
    for (const entry of visible) {
      const prior = selected.get(entry.plan.assigneeProfileId)?.plan;
      if (
        !prior ||
        rank(entry.plan) > rank(prior) ||
        (rank(entry.plan) === rank(prior) && entry.plan.version > prior.version)
      )
        selected.set(entry.plan.assigneeProfileId, entry);
    }
    const output = [];
    for (const { plan, assigneeName } of selected.values()) {
      const { slots } = await scoped(ctx, plan._id);
      const projected = await projection(ctx, plan, slots);
      const filtered = projected.filter(
        (x) =>
          (!args.territoryId || x.territoryId === args.territoryId) &&
          (!args.routeId || x.routeId === args.routeId),
      );
      if ((args.territoryId || args.routeId) && !filtered.length) continue;
      const calls = filtered.filter(
        (x) =>
          x.kind === "outlet_visit" &&
          ((plan.status !== "active" && plan.status !== "superseded") ||
            x.generated) &&
          x.visitStatus !== "cancelled" &&
          x.visitStatus !== "replaced",
      );
      const workingDays = [
        ...new Set(filtered.map((x) => x.serviceDate)),
      ].sort();
      const routeCodes = [
        ...new Set(
          filtered.map((x) => x.routeCode).filter((x): x is string => !!x),
        ),
      ].sort();
      const assignment = await employeeAt(
        ctx,
        plan.assigneeProfileId,
        Date.now(),
      );
      const standards = assignment.positionId
        ? await bounded(
            ctx.db
              .query("positionStandards")
              .withIndex("by_positionId_and_effectiveFrom", (q) =>
                q.eq("positionId", assignment.positionId!),
              )
              .take(MAX_PLAN_ROWS + 1),
            "Position standards",
          )
        : [];
      const standard = at(standards, Date.now());
      const target = standard?.dailyCallsTarget;
      output.push({
        assigneeProfileId: plan.assigneeProfileId,
        assigneeName,
        planId: plan._id,
        version: plan.version,
        planStatus: plan.status,
        selection: `${plan.status} v${plan.version}`,
        routeCodes,
        visitCount: calls.length,
        workingDays,
        durationMinutes: filtered.reduce((n, x) => n + x.durationMinutes, 0),
        dailyCallsTarget: target,
        variance:
          target === undefined
            ? undefined
            : calls.length - target * workingDays.length,
      });
    }
    return page(
      output.sort(
        (a, b) =>
          a.assigneeName.localeCompare(b.assigneeName) ||
          a.assigneeProfileId.localeCompare(b.assigneeProfileId),
      ),
      args.paginationOpts,
    );
  },
});
