/* Daily agent metric rollups (CVX-031). Precomputes, per field person and Manila service
 * date, the planned/actual/productive calls, orders, sales value, collections and visit
 * figures the dashboards read, so a team view never re-scans a month of visits and orders.
 *
 * Freshness: every visit event (visits/events.ts `append`), every order write and every
 * plan activation/supersession that creates or displaces planned visits
 * (coverage/activation.ts) calls
 * `queueAgentDay*`, which records one pending refresh per person and day and schedules
 * `refreshDay` after REFRESH_DELAY_MS, so a burst of phone operations costs one
 * recompute. `backfillDay` recomputes a whole date for everyone (CLI / later cron).
 *
 * Counting rules are pure and shared with the DSR: ./agent_metrics_model.ts.
 */
import { ConvexError, v } from "convex/values";
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import schema from "../schema";
import { localDate } from "../coverage/validation";
import {
  LATE_ORDER_WINDOW_MS,
  manilaDateOf,
  monthOf,
  saleInstant,
} from "../dsr/model";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds, rootOrgUnitId } from "../lib/scope";
import { activeAt } from "../org/validation";
import { PRODUCTIVE_CALL_RULE_VERSION } from "../sfa/productive_call";
import { standardAt, standardsFor } from "../sfa/standards";
import {
  AGENT_METRICS_VERSION,
  sameMetrics,
  summarizeAgentDay,
} from "./agent_metrics_model";

/** Debounce: a burst of phone operations for one person/day becomes one recompute. */
export const REFRESH_DELAY_MS = 10_000;
const MAX_DAY_VISITS = 200;
const MAX_VISIT_ROWS = 100;
const MAX_DAY_ORDERS = 1_000;
const MAX_HISTORY = 50;
const BACKFILL_PAGE = 25;
/** A person's history window readable in one call (two months). */
export const MAX_RANGE_DAYS = 62;
const CROSS_SCOPE_ROLES = new Set(["super_admin", "analyst"]);

type Ctx = QueryCtx | MutationCtx;

function manilaNoon(serviceDate: string) {
  return localDate(serviceDate) + 12 * 3_600_000;
}

async function assignmentAt(
  ctx: Ctx,
  profileId: Id<"profiles">,
  instant: number,
) {
  const rows = await ctx.db
    .query("employeeAssignments")
    .withIndex("by_profileId_and_effectiveFrom", (q) =>
      q.eq("profileId", profileId).lte("effectiveFrom", instant),
    )
    .order("desc")
    .take(MAX_HISTORY);
  return (
    rows.find((row) => activeAt(row.effectiveFrom, row.effectiveTo, instant)) ??
    null
  );
}

/** Recomputes one person's day from the source tables. Pure read. */
export async function computeAgentDay(
  ctx: Ctx,
  person: Doc<"profiles">,
  serviceDate: string,
) {
  const dayStart = localDate(serviceDate);
  const dayEnd = dayStart + 86_400_000;
  const noon = manilaNoon(serviceDate);
  const assignment = await assignmentAt(ctx, person._id, noon);
  const positionId = assignment?.positionId ?? person.positionId;
  const standard = positionId
    ? standardAt(await standardsFor(ctx, positionId), noon)
    : null;

  const visitRows = await ctx.db
    .query("visitExecutions")
    .withIndex("by_organizationId_and_assigneeProfileId_and_serviceDate", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("assigneeProfileId", person._id)
        .eq("serviceDate", serviceDate),
    )
    .take(MAX_DAY_VISITS + 1);
  let complete = visitRows.length <= MAX_DAY_VISITS;
  const visits = [];
  for (const visit of visitRows.slice(0, MAX_DAY_VISITS)) {
    const activities = await ctx.db
      .query("visitActivities")
      .withIndex("by_visitId_and_serverTime", (q) => q.eq("visitId", visit._id))
      .take(MAX_VISIT_ROWS + 1);
    const collections = await ctx.db
      .query("fieldCollections")
      .withIndex("by_visitId_and_serverTime", (q) => q.eq("visitId", visit._id))
      .take(MAX_VISIT_ROWS + 1);
    if (
      activities.length > MAX_VISIT_ROWS ||
      collections.length > MAX_VISIT_ROWS
    )
      complete = false;
    visits.push({
      state: visit.state,
      source: visit.source,
      plannedVisitId: visit.plannedVisitId,
      reasonCode: visit.reasonCode,
      activityKinds: activities
        .slice(0, MAX_VISIT_ROWS)
        .map((row) => row.activity.kind),
      collections: collections.slice(0, MAX_VISIT_ROWS),
      lateSyncAt: visit.lateSyncAt,
      missingActivities: visit.missingActivities,
      startedAt: visit.startedAt,
      endedAt: visit.endedAt,
      callDurationMs: visit.callDurationMs,
    });
  }

  const planned = await ctx.db
    .query("plannedVisits")
    .withIndex("by_assigneeProfileId_and_serviceDate", (q) =>
      q.eq("assigneeProfileId", person._id).eq("serviceDate", serviceDate),
    )
    .take(MAX_DAY_VISITS + 1);
  if (planned.length > MAX_DAY_VISITS) complete = false;

  // An order written offline belongs to the day the salesman wrote it, up to
  // LATE_ORDER_WINDOW_MS before it reached the server (dsr/model.ts).
  const orders = await ctx.db
    .query("orders")
    .withIndex("by_salespersonSubject_and_createdAt", (q) =>
      q
        .eq("salespersonSubject", person.authSubject)
        .gte("createdAt", dayStart)
        .lt("createdAt", dayEnd + LATE_ORDER_WINDOW_MS),
    )
    .take(MAX_DAY_ORDERS + 1);
  if (orders.length > MAX_DAY_ORDERS) complete = false;

  const metrics = summarizeAgentDay({
    serviceDate,
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    rule: standard?.productiveCallRule ?? "any_listed_activity",
    plannedVisitIds: planned
      .slice(0, MAX_DAY_VISITS)
      .filter((row) => row.status === "planned")
      .map((row) => row._id),
    visits,
    orders: orders.slice(0, MAX_DAY_ORDERS),
    dailyCallsTarget: standard?.dailyCallsTarget ?? null,
    productiveCallTargetPct: standard?.productiveCallTargetPct ?? null,
  });
  return {
    orgUnitId:
      assignment?.orgUnitId ?? person.orgUnitId ?? visitRows[0]?.orgUnitId,
    positionId,
    metrics,
    complete,
  };
}

async function existingRow(
  ctx: Ctx,
  profileId: Id<"profiles">,
  serviceDate: string,
) {
  return await ctx.db
    .query("agentDailyMetrics")
    .withIndex("by_profileId_and_serviceDate", (q) =>
      q.eq("profileId", profileId).eq("serviceDate", serviceDate),
    )
    .unique();
}

/** Writes the recomputed row; skips the write when nothing changed. Returns the row id. */
async function writeAgentDay(
  ctx: MutationCtx,
  person: Doc<"profiles">,
  serviceDate: string,
  options: { skipEmpty: boolean },
) {
  const day = await computeAgentDay(ctx, person, serviceDate);
  const row = await existingRow(ctx, person._id, serviceDate);
  const m = day.metrics;
  if (
    !row &&
    options.skipEmpty &&
    m.plannedCalls === 0 &&
    m.visits === 0 &&
    m.orders === 0 &&
    m.returnOrders === 0
  )
    return null;
  const doc = {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    profileId: person._id,
    serviceDate,
    localMonth: monthOf(serviceDate),
    orgUnitId: day.orgUnitId,
    positionId: day.positionId,
    ...m,
    complete: day.complete,
    ruleVersion: PRODUCTIVE_CALL_RULE_VERSION,
    metricsVersion: AGENT_METRICS_VERSION,
  };
  if (!row)
    return await ctx.db.insert("agentDailyMetrics", {
      ...doc,
      computedAt: Date.now(),
    });
  if (
    sameMetrics(row, m) &&
    row.complete === doc.complete &&
    row.orgUnitId === doc.orgUnitId &&
    row.positionId === doc.positionId &&
    row.ruleVersion === doc.ruleVersion &&
    row.metricsVersion === doc.metricsVersion
  )
    return row._id;
  await ctx.db.replace(row._id, { ...doc, computedAt: Date.now() });
  return row._id;
}

/**
 * Records that one person's day changed and schedules its recompute, once per pending
 * person/day. Call inside the writing transaction; costs one indexed read when a refresh
 * is already pending.
 */
export async function queueAgentDay(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
  serviceDate: string,
) {
  const pending = await ctx.db
    .query("agentMetricRefreshes")
    .withIndex("by_profileId_and_serviceDate", (q) =>
      q.eq("profileId", profileId).eq("serviceDate", serviceDate),
    )
    .first();
  if (pending) return;
  await ctx.db.insert("agentMetricRefreshes", {
    profileId,
    serviceDate,
    requestedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(
    REFRESH_DELAY_MS,
    internal.analytics.agent_metrics.refreshDay,
    { profileId, serviceDate },
  );
}

/** Queues the day of the visit an execution event belongs to (visit, activity, collection). */
export async function queueAgentDayForEvent(
  ctx: MutationCtx,
  event: { entityType: string; entityId: string },
) {
  let visitId: Id<"visitExecutions"> | null = null;
  if (event.entityType === "visit")
    visitId = ctx.db.normalizeId("visitExecutions", event.entityId);
  else if (event.entityType === "activity") {
    const id = ctx.db.normalizeId("visitActivities", event.entityId);
    visitId = id ? ((await ctx.db.get(id))?.visitId ?? null) : null;
  } else if (event.entityType === "collection") {
    const id = ctx.db.normalizeId("fieldCollections", event.entityId);
    visitId = id ? ((await ctx.db.get(id))?.visitId ?? null) : null;
  }
  if (!visitId) return;
  const visit = await ctx.db.get(visitId);
  if (visit)
    await queueAgentDay(ctx, visit.assigneeProfileId, visit.serviceDate);
}

/** Queues the day an order counts on for the salesman who wrote it. */
export async function queueAgentDayForOrder(
  ctx: MutationCtx,
  orderId: Id<"orders">,
) {
  const order = await ctx.db.get(orderId);
  if (!order) return;
  const person = await ctx.db
    .query("profiles")
    .withIndex("by_subject", (q) =>
      q.eq("authSubject", order.salespersonSubject),
    )
    .first();
  if (person)
    await queueAgentDay(ctx, person._id, manilaDateOf(saleInstant(order)));
}

/** Scheduled recompute of one person's day; clears its pending marker. */
export const refreshDay = internalMutation({
  args: { profileId: v.id("profiles"), serviceDate: v.string() },
  returns: v.union(v.id("agentDailyMetrics"), v.null()),
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("agentMetricRefreshes")
      .withIndex("by_profileId_and_serviceDate", (q) =>
        q.eq("profileId", args.profileId).eq("serviceDate", args.serviceDate),
      )
      .take(10);
    for (const row of pending) await ctx.db.delete(row._id);
    const person = await ctx.db.get(args.profileId);
    if (!person) return null;
    return await writeAgentDay(ctx, person, args.serviceDate, {
      skipEmpty: false,
    });
  },
});

/**
 * Recomputes one date for every profile, a page at a time, scheduling the next page.
 * People with no plan, visit or order that day get no row. For backfill after deploy or a
 * metrics version change: `convex run analytics/agent_metrics:backfillDay '{"serviceDate":"…"}'`.
 */
export const backfillDay = internalMutation({
  args: {
    serviceDate: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({ processed: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    localDate(args.serviceDate);
    const page = await ctx.db
      .query("profiles")
      .paginate({ numItems: BACKFILL_PAGE, cursor: args.cursor ?? null });
    for (const person of page.page)
      await writeAgentDay(ctx, person, args.serviceDate, { skipEmpty: true });
    if (!page.isDone)
      await ctx.scheduler.runAfter(
        0,
        internal.analytics.agent_metrics.backfillDay,
        { serviceDate: args.serviceDate, cursor: page.continueCursor },
      );
    return { processed: page.page.length, isDone: page.isDone };
  },
});

const rowValidator = schema.doc("agentDailyMetrics");

/** The caller's readable units, or null for cross-scope roles. */
async function readableUnits(ctx: QueryCtx, profile: Doc<"profiles">) {
  if (CROSS_SCOPE_ROLES.has(profile.role)) return null;
  if (!profile.orgUnitId) return new Set<Id<"orgUnits">>();
  return new Set(await collectScopeUnitIds(ctx, profile.orgUnitId));
}

/**
 * The person's current units: the persisted profile unit and the currently effective
 * assignment's unit (they differ only while a transfer's projection is pending). A reader
 * must hold both, so a historical row never outlives the person's move to another unit.
 */
async function currentPersonUnits(ctx: QueryCtx, person: Doc<"profiles">) {
  const units = new Set<Id<"orgUnits">>();
  if (person.orgUnitId) units.add(person.orgUnitId);
  const assignment = await assignmentAt(ctx, person._id, Date.now());
  if (assignment?.orgUnitId) units.add(assignment.orgUnitId);
  return units;
}

/**
 * One person's daily rollups between two Manila dates (inclusive, at most MAX_RANGE_DAYS).
 * `report.read`; field `sales` read only their own. Others need scope over the person's
 * unit and over every row's unit.
 */
export const forPerson = query({
  args: {
    profileId: v.id("profiles"),
    fromDate: v.string(),
    toDate: v.string(),
  },
  returns: v.array(rowValidator),
  handler: async (ctx, args) => {
    const from = localDate(args.fromDate);
    const to = localDate(args.toDate);
    if (to < from) throw new ConvexError("End date is before start date");
    if ((to - from) / 86_400_000 + 1 > MAX_RANGE_DAYS)
      throw new ConvexError(`At most ${MAX_RANGE_DAYS} days at a time`);
    const { profile: caller } = await requireCapability(ctx, "report.read");
    const self = caller._id === args.profileId;
    if (caller.role === "sales" && !self)
      throw new ConvexError("Sales can only read their own metrics");
    const person = await ctx.db.get(args.profileId);
    if (!person) throw new ConvexError("Person not found");
    const rows = await ctx.db
      .query("agentDailyMetrics")
      .withIndex("by_profileId_and_serviceDate", (q) =>
        q
          .eq("profileId", args.profileId)
          .gte("serviceDate", args.fromDate)
          .lte("serviceDate", args.toDate),
      )
      .take(MAX_RANGE_DAYS);
    if (!self) {
      const units = await currentPersonUnits(ctx, person);
      for (const row of rows) if (row.orgUnitId) units.add(row.orgUnitId);
      if (!units.size) {
        const root = await rootOrgUnitId(ctx);
        if (!root) throw new ConvexError("Person has no organizational scope");
        units.add(root);
      }
      for (const unit of units)
        await requireCapability(ctx, "report.read", unit);
    }
    return rows;
  },
});

/**
 * Everyone's rollups for one Manila date, paged, limited to the caller's scope: both the
 * row's unit and the person's current unit (persisted and effective) must be readable, so
 * a transferred person's history leaves the old unit's view. Rows outside scope are
 * dropped from each page, so a page may come back short or empty while `isDone` is false:
 * keep paging. Field `sales` see only their own row.
 */
export const forDay = query({
  args: { serviceDate: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(rowValidator),
  handler: async (ctx, args) => {
    localDate(args.serviceDate);
    const { profile } = await requireCapability(ctx, "report.read");
    const units = await readableUnits(ctx, profile);
    const result = await ctx.db
      .query("agentDailyMetrics")
      .withIndex("by_organizationId_and_serviceDate", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("serviceDate", args.serviceDate),
      )
      .paginate(args.paginationOpts);
    const page: Doc<"agentDailyMetrics">[] = [];
    for (const row of result.page) {
      if (profile.role === "sales") {
        if (row.profileId === profile._id) page.push(row);
        continue;
      }
      if (units === null) {
        page.push(row);
        continue;
      }
      if (row.orgUnitId === undefined || !units.has(row.orgUnitId)) continue;
      const person = await ctx.db.get(row.profileId);
      if (!person) continue;
      const current = await currentPersonUnits(ctx, person);
      if (current.size && [...current].every((unit) => units.has(unit)))
        page.push(row);
    }
    return { ...result, page };
  },
});
