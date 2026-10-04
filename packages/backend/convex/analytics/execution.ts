/* ANA-002 daily execution dashboard: sales, target attainment, coverage, productive calls,
 * active field force and key exceptions for a selected scope (unit, channel, my team) and
 * Manila service date. Pure rules live in ./model.ts; KPI meanings in
 * docs/architecture/KPI_DEFINITIONS.md and docs/architecture/DAILY_EXECUTION_DASHBOARD.md.
 *
 * Access: supervision readers (`people.read` + `visit.read`, see supervision/access.ts) who
 * also hold `report.read`, inside their own organizational scope. Field `sales` read their
 * own figures in the Daily Sales Report and DAR/ROAR instead.
 *
 * Figures are computed live from the day's records (there are no daily rollups yet,
 * CVX-031). To stay inside per-query read limits the people of a scope are read in pages
 * of EXECUTION_PAGE_SIZE; each page returns its own totals and the web adds them up.
 */
import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "../_generated/server";
import { localDate, monthBounds } from "../coverage/validation";
import {
  countsAsSale,
  dailyTarget,
  LATE_ORDER_WINDOW_MS,
  monthOf,
  saleInstant,
  toMinor,
} from "../dsr/model";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import {
  evaluateProductiveCall,
  productiveCodesFromVisitRecords,
  summarizeCalls,
  type CallEvaluation,
} from "../sfa/productive_call";
import {
  DEFAULT_SELLING_WEEKDAYS,
  isSellingDay,
  sellingDatesInMonth,
} from "../sfa/selling_days";
import { standardAt, standardsFor } from "../sfa/standards";
import {
  personDay,
  supervisionArgs,
  supervisorContext,
  teamMembers,
  type SupervisorContext,
  type TeamMember,
} from "../supervision/access";
import { exceptionItems } from "../supervision/exceptions";
import { DONE_STATES, OPEN_STATES } from "../supervision/model";
import { subjectTargetAt } from "../targets/sales";
import {
  EXECUTION_PAGE_SIZE,
  executionPersonRow,
  executionTotals,
  MAX_KEY_EXCEPTIONS,
  outletCoverage,
  summarize,
  type ExecutionPersonRow,
} from "./model";

const DAY_MS = 86_400_000;
/** Orders read per person per day; route sellers top out at 30 calls. */
const MAX_DAY_ORDERS = 400;
const MAX_VISIT_ROWS = 100;

const unitOption = v.object({
  id: v.id("orgUnits"),
  code: v.string(),
  name: v.string(),
});

async function dashboardContext(
  ctx: QueryCtx,
  args: Parameters<typeof supervisorContext>[1],
) {
  const sc = await supervisorContext(ctx, args);
  await requireCapability(ctx, "report.read");
  return sc;
}

/** Calls and productive calls judged per visit, exactly as the DAR/ROAR and DSR do. */
async function judgeVisits(
  ctx: QueryCtx,
  visits: Awaited<ReturnType<typeof personDay>>["visits"],
  rule: "any_listed_activity" | "truck_seller",
) {
  const evaluations: CallEvaluation[] = [];
  for (const visit of visits) {
    const inRoutePlan = visit.source === "planned" && !!visit.plannedVisitId;
    // Only a closed route-plan visit can be a call; skip the activity reads otherwise.
    if (!inRoutePlan || !DONE_STATES.has(visit.state)) {
      evaluations.push(
        evaluateProductiveCall({
          rule,
          inRoutePlan,
          state: visit.state,
          codes: [],
        }),
      );
      continue;
    }
    const activities = await ctx.db
      .query("visitActivities")
      .withIndex("by_visitId_and_serverTime", (q) => q.eq("visitId", visit._id))
      .take(MAX_VISIT_ROWS);
    const collections = (
      await ctx.db
        .query("fieldCollections")
        .withIndex("by_visitId_and_serverTime", (q) =>
          q.eq("visitId", visit._id),
        )
        .take(MAX_VISIT_ROWS)
    ).filter((row) => row.status !== "rejected");
    const recorded = productiveCodesFromVisitRecords({
      activityKinds: activities.map((row) => row.activity.kind),
      collectionCount: collections.length,
      reasonCode: visit.reasonCode,
    });
    evaluations.push(
      evaluateProductiveCall({
        rule,
        inRoutePlan,
        state: visit.state,
        codes: recorded.codes,
        noSalesDueToInventory: recorded.noSalesDueToInventory,
      }),
    );
  }
  return summarizeCalls(evaluations);
}

/** The day's sales in centavos: orders attributed to the day the salesman wrote them. */
async function daySales(ctx: QueryCtx, authSubject: string, dayStart: number) {
  const dayEnd = dayStart + DAY_MS;
  const orders = await ctx.db
    .query("orders")
    .withIndex("by_salespersonSubject_and_createdAt", (q) =>
      q
        .eq("salespersonSubject", authSubject)
        .gte("createdAt", dayStart)
        .lt("createdAt", dayEnd + LATE_ORDER_WINDOW_MS),
    )
    .take(MAX_DAY_ORDERS);
  let total = 0;
  for (const order of orders) {
    if (
      order.organizationId !== undefined &&
      order.organizationId !== SUNPRIDE_ORGANIZATION_ID
    )
      continue;
    if (!countsAsSale(order.status)) continue;
    const instant = saleInstant(order);
    if (instant >= dayStart && instant < dayEnd) total += toMinor(order.total);
  }
  return total;
}

async function personRow(
  ctx: QueryCtx,
  sc: SupervisorContext,
  member: TeamMember,
  serviceDate: string,
): Promise<ExecutionPersonRow> {
  const dayStart = localDate(serviceDate);
  const noon = dayStart + DAY_MS / 2;
  const localMonth = monthOf(serviceDate);
  const { from: monthStart } = monthBounds(localMonth);

  const positionId = member.assignment.positionId ?? member.profile.positionId;
  const standard = positionId
    ? standardAt(await standardsFor(ctx, positionId), noon)
    : null;
  const weekdays = standard?.sellingWeekdays ?? DEFAULT_SELLING_WEEKDAYS;
  const sellingDay = isSellingDay(serviceDate, weekdays);

  const { planned, visits } = await personDay(
    ctx,
    sc,
    member.profile._id,
    serviceDate,
  );
  const active = planned.filter((row) => row.status === "planned");
  const activeIds = new Set(active.map((row) => row._id as string));
  const done = visits.filter((visit) => DONE_STATES.has(visit.state));
  const coverage = outletCoverage(
    active.map((row) => row.outletId),
    new Set(done.map((visit) => visit.outletId as string)),
  );
  const calls = await judgeVisits(
    ctx,
    visits,
    standard?.productiveCallRule ?? "any_listed_activity",
  );

  const subject = { kind: "employee" as const, profileId: member.profile._id };
  const dailyRow = await subjectTargetAt(
    ctx,
    subject,
    "daily",
    "sales_value",
    dayStart,
  );
  const monthlyRow = await subjectTargetAt(
    ctx,
    subject,
    "monthly",
    "sales_value",
    monthStart,
  );
  const salesTarget = dailyTarget({
    daily: dailyRow?.value ?? null,
    monthly: monthlyRow?.value ?? null,
    sellingDay,
    sellingDaysInMonth: sellingDatesInMonth(localMonth, weekdays).length,
  }).value;

  const checkIns = visits.flatMap((visit) =>
    visit.checkedInAt === undefined ? [] : [visit.checkedInAt],
  );
  return {
    profileId: member.profile._id,
    name: member.profile.name,
    employeeCode: member.profile.employeeCode ?? null,
    positionLabel: member.positionLabel,
    channel: member.channel,
    orgUnitId: member.assignment.orgUnitId!,
    sellingDay,
    scheduled: active.length > 0,
    active: checkIns.length > 0,
    inField: visits.some((visit) => OPEN_STATES.has(visit.state)),
    planned: active.length,
    plannedDone: new Set(
      done
        .filter(
          (visit) =>
            visit.plannedVisitId !== undefined &&
            activeIds.has(visit.plannedVisitId),
        )
        .map((visit) => visit.plannedVisitId as string),
    ).size,
    ...coverage,
    calls: calls.calls,
    productiveCalls: calls.productiveCalls,
    unplanned: visits.filter((visit) => visit.source === "unplanned").length,
    callsTarget: sellingDay ? (standard?.dailyCallsTarget ?? null) : null,
    productiveTargetPct: sellingDay
      ? (standard?.productiveCallTargetPct ?? null)
      : null,
    sales: await daySales(ctx, member.profile.authSubject, dayStart),
    salesTarget,
    firstCheckInAt: checkIns.length ? Math.min(...checkIns) : null,
    lastActivityAt: visits.length
      ? Math.max(...visits.map((visit) => visit.lastServerTime))
      : null,
  };
}

/**
 * One page of the dashboard: a row per field person in the selected scope with their
 * day's execution, and the page's totals. Page 0 also tells the web how many pages exist.
 */
export const day = query({
  args: { ...supervisionArgs, page: v.optional(v.number()) },
  returns: v.object({
    serviceDate: v.string(),
    page: v.number(),
    pageCount: v.number(),
    pageSize: v.number(),
    peopleInScope: v.number(),
    truncated: v.boolean(),
    units: v.array(unitOption),
    channels: v.array(v.string()),
    rows: v.array(executionPersonRow),
    totals: executionTotals,
  }),
  handler: async (ctx, args) => {
    const page = args.page ?? 0;
    if (!Number.isInteger(page) || page < 0)
      throw new ConvexError("Page must be a whole number from 0");
    const sc = await dashboardContext(ctx, args);
    const { members, truncated, channels } = await teamMembers(ctx, sc, args);
    const pageCount = Math.max(
      1,
      Math.ceil(members.length / EXECUTION_PAGE_SIZE),
    );
    if (page >= pageCount) throw new ConvexError("Page is out of range");
    const rows: ExecutionPersonRow[] = [];
    for (const member of members.slice(
      page * EXECUTION_PAGE_SIZE,
      (page + 1) * EXECUTION_PAGE_SIZE,
    ))
      rows.push(await personRow(ctx, sc, member, args.serviceDate));
    return {
      serviceDate: args.serviceDate,
      page,
      pageCount,
      pageSize: EXECUTION_PAGE_SIZE,
      peopleInScope: members.length,
      truncated,
      units: sc.unitOptions,
      channels,
      rows,
      totals: summarize(rows),
    };
  },
});

const exceptionKind = v.union(
  v.literal("location"),
  v.literal("out_of_sequence"),
  v.literal("unplanned"),
  v.literal("nonproductive"),
  v.literal("rescheduled"),
  v.literal("cancelled"),
  v.literal("not_visited"),
);

/**
 * Key exceptions for the same scope and date: counts per kind (open = still needs a
 * supervisor's decision) and the first few items, open first then newest. The full queue,
 * with decisions, is Supervision → Exceptions.
 */
export const exceptions = query({
  args: supervisionArgs,
  returns: v.object({
    serviceDate: v.string(),
    truncated: v.boolean(),
    total: v.number(),
    open: v.number(),
    kinds: v.array(
      v.object({ kind: exceptionKind, total: v.number(), open: v.number() }),
    ),
    items: v.array(
      v.object({
        id: v.string(),
        kind: exceptionKind,
        open: v.boolean(),
        profileId: v.id("profiles"),
        personName: v.string(),
        outletCode: v.string(),
        outletName: v.string(),
        at: v.union(v.number(), v.null()),
        reason: v.union(v.string(), v.null()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const sc = await dashboardContext(ctx, args);
    const { items, peopleTruncated } = await exceptionItems(ctx, sc, args);
    const kinds = new Map<
      (typeof items)[number]["kind"],
      { total: number; open: number }
    >();
    for (const item of items) {
      const tally = kinds.get(item.kind) ?? { total: 0, open: 0 };
      tally.total++;
      if (item.open) tally.open++;
      kinds.set(item.kind, tally);
    }
    return {
      serviceDate: args.serviceDate,
      truncated: peopleTruncated,
      total: items.length,
      open: items.filter((item) => item.open).length,
      kinds: [...kinds.entries()]
        .map(([kind, tally]) => ({ kind, ...tally }))
        .sort((a, b) => b.open - a.open || b.total - a.total),
      items: items.slice(0, MAX_KEY_EXCEPTIONS).map((item) => ({
        id: item.id,
        kind: item.kind,
        open: item.open,
        profileId: item.profileId,
        personName: item.personName,
        outletCode: item.outletCode,
        outletName: item.outletName,
        at: item.at,
        reason: item.reason,
      })),
    };
  },
});
