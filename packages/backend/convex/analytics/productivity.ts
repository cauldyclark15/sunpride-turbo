import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { localDate } from "../coverage/validation";
import {
  countsAsSale,
  LATE_ORDER_WINDOW_MS,
  manilaDateOf,
  saleInstant,
  toMinor,
} from "../dsr/model";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { activeAt } from "../org/validation";
import {
  evaluateProductiveCall,
  productiveCodesFromVisitRecords,
} from "../sfa/productive_call";
import { DEFAULT_SELLING_WEEKDAYS, isSellingDay } from "../sfa/selling_days";
import { standardAt, standardsFor } from "../sfa/standards";
import {
  personDay,
  supervisorContext,
  teamMembers,
  visitEvidence,
  type SupervisorContext,
} from "../supervision/access";
import {
  channelOf,
  dayCloseAt,
  DONE_STATES,
  outOfSequence,
} from "../supervision/model";
import {
  datesBetween,
  periodError,
  PRODUCTIVITY_SOURCE,
  summarizePeriod,
  type DayFacts,
} from "./productivity_model";

/**
 * ANA-003 supervisor productivity dashboard. `roster` lists the field people a supervisor
 * may compare (by default the caller's direct reports, else everyone in the selected
 * scope); `person` returns one person's period figures. The web subscribes one `person`
 * query per row so each read stays bounded (≤ 31 days of one person's work).
 *
 * Access: supervision readers (`people.read` + `visit.read`) who also hold `report.read`,
 * inside their own organizational scope, never wider. Pure rules: `./productivity_model.ts`.
 */

/** A month of one salesman's orders, 30 calls a day for 31 days with headroom. */
const MAX_PERIOD_ORDERS = 2_000;
const MAX_VISIT_ROWS = 100;
const MAX_HISTORY = 50;

const nullableNumber = v.union(v.number(), v.null());

const figures = v.object({
  days: v.number(),
  sellingDays: v.number(),
  planned: v.number(),
  plannedDone: v.number(),
  calls: v.number(),
  productiveCalls: v.number(),
  convertedCalls: v.number(),
  missed: v.number(),
  pending: v.number(),
  visits: v.number(),
  unplanned: v.number(),
  exceptionVisits: v.number(),
  locationExceptions: v.number(),
  outOfSequence: v.number(),
  orders: v.number(),
  sales: v.number(),
  callsTarget: nullableNumber,
});

const dayFacts = v.object({
  serviceDate: v.string(),
  closed: v.boolean(),
  sellingDay: v.boolean(),
  planned: v.number(),
  plannedDone: v.number(),
  calls: v.number(),
  productiveCalls: v.number(),
  convertedCalls: v.number(),
  visits: v.number(),
  unplanned: v.number(),
  exceptionVisits: v.number(),
  locationExceptions: v.number(),
  outOfSequence: v.number(),
  orders: v.number(),
  sales: v.number(),
  callsTarget: nullableNumber,
});

const rosterPerson = v.object({
  profileId: v.id("profiles"),
  name: v.string(),
  employeeCode: v.union(v.string(), v.null()),
  positionLabel: v.union(v.string(), v.null()),
  channel: v.string(),
  direct: v.boolean(),
});

function checkPeriod(from: string, to: string) {
  localDate(from);
  localDate(to);
  const error = periodError(from, to);
  if (error) throw new ConvexError(error);
}

async function context(
  ctx: QueryCtx,
  filters: {
    serviceDate: string;
    orgUnitId?: Id<"orgUnits">;
    channel?: string;
    directOnly?: boolean;
  },
) {
  const sc = await supervisorContext(ctx, filters);
  await requireCapability(ctx, "report.read");
  return sc;
}

/**
 * Who the caller compares: field people whose current assignment is inside the selected
 * scope. `directOnly` keeps only the caller's direct reports (assignment supervisor).
 */
export const roster = query({
  args: {
    endDate: v.string(),
    orgUnitId: v.optional(v.id("orgUnits")),
    channel: v.optional(v.string()),
    directOnly: v.optional(v.boolean()),
  },
  returns: v.object({
    truncated: v.boolean(),
    directReports: v.number(),
    people: v.array(rosterPerson),
  }),
  handler: async (ctx, args) => {
    const filters = {
      serviceDate: args.endDate,
      ...(args.orgUnitId ? { orgUnitId: args.orgUnitId } : {}),
      ...(args.channel ? { channel: args.channel } : {}),
      ...(args.directOnly ? { directOnly: true } : {}),
    };
    const sc = await context(ctx, filters);
    const { members, truncated } = await teamMembers(ctx, sc, filters);
    return {
      truncated,
      directReports: members.filter((m) => m.direct).length,
      people: members.map((member) => ({
        profileId: member.profile._id,
        name: member.profile.name,
        employeeCode: member.profile.employeeCode ?? null,
        positionLabel: member.positionLabel,
        channel: member.channel,
        direct: member.direct,
      })),
    };
  },
});

/**
 * The same membership rule as `teamMembers`, for one person: an active field person whose
 * single current employee assignment sits inside the caller's scope.
 */
export async function memberOf(
  ctx: QueryCtx,
  sc: SupervisorContext,
  profileId: Id<"profiles">,
) {
  const profile = await ctx.db.get(profileId);
  if (!profile || profile.status !== "active" || profile.role !== "sales")
    throw new ConvexError("Person not found");
  const now = Date.now();
  const rows = await ctx.db
    .query("employeeAssignments")
    .withIndex("by_profileId_and_effectiveFrom", (q) =>
      q.eq("profileId", profile._id),
    )
    .take(100);
  const current = rows.filter((row) =>
    activeAt(row.effectiveFrom, row.effectiveTo, now),
  );
  const assignment = current.length === 1 ? current[0]! : null;
  if (!assignment?.orgUnitId || !sc.scope.has(assignment.orgUnitId))
    throw new ConvexError(
      "Requested person is outside your organizational scope",
    );
  const positionId = assignment.positionId ?? profile.positionId;
  const position = positionId ? await ctx.db.get(positionId) : null;
  return {
    profile,
    assignment,
    position,
    direct:
      assignment.supervisorId === sc.profile._id ||
      profile.supervisorSubject === sc.identity.tokenIdentifier,
  };
}

async function customerAt(
  ctx: QueryCtx,
  outletId: Id<"outlets">,
  instant: number,
) {
  const links = await ctx.db
    .query("outletCustomerLinks")
    .withIndex("by_outletId_and_effectiveFrom", (q) =>
      q.eq("outletId", outletId).lte("effectiveFrom", instant),
    )
    .order("desc")
    .take(MAX_HISTORY);
  return (
    links.find((row) => activeAt(row.effectiveFrom, row.effectiveTo, instant))
      ?.customerId ?? null
  );
}

type SaleDay = {
  orders: number;
  sales: number;
  customerCodes: Set<string>;
  clientRequestIds: Set<string>;
};

/** The person's sales in the period, by the Manila day the salesman wrote them (DSR rule). */
async function salesByDay(
  ctx: QueryCtx,
  person: Doc<"profiles">,
  from: string,
  to: string,
) {
  const start = localDate(from);
  const end = localDate(to) + 86_400_000;
  const orders = await ctx.db
    .query("orders")
    .withIndex("by_salespersonSubject_and_createdAt", (q) =>
      q
        .eq("salespersonSubject", person.authSubject)
        .gte("createdAt", start)
        .lt("createdAt", end + LATE_ORDER_WINDOW_MS),
    )
    .take(MAX_PERIOD_ORDERS + 1);
  if (orders.length > MAX_PERIOD_ORDERS)
    throw new ConvexError("Too many orders in this period; pick a shorter one");
  const days = new Map<string, SaleDay>();
  for (const order of orders) {
    if (
      (order.organizationId !== undefined &&
        order.organizationId !== SUNPRIDE_ORGANIZATION_ID) ||
      !countsAsSale(order.status)
    )
      continue;
    const instant = saleInstant(order);
    if (instant < start || instant >= end) continue;
    const date = manilaDateOf(instant);
    const day = days.get(date) ?? {
      orders: 0,
      sales: 0,
      customerCodes: new Set<string>(),
      clientRequestIds: new Set<string>(),
    };
    day.orders++;
    day.sales += toMinor(order.total);
    // A return (negative order) is a sale for the totals but never converts a call.
    if (order.total > 0) {
      day.customerCodes.add(order.customerCode);
      day.clientRequestIds.add(order.clientRequestId);
    }
    days.set(date, day);
  }
  return days;
}

/**
 * One person's figures for a period of Manila dates (at most 31). Each day reads that
 * day's planned stops and visits inside the caller's scope, judges every visit with the
 * client's productive-call rule, and matches calls to the day's orders.
 */
export const person = query({
  args: { profileId: v.id("profiles"), from: v.string(), to: v.string() },
  returns: v.object({
    profileId: v.id("profiles"),
    name: v.string(),
    employeeCode: v.union(v.string(), v.null()),
    positionLabel: v.union(v.string(), v.null()),
    channel: v.string(),
    direct: v.boolean(),
    from: v.string(),
    to: v.string(),
    productiveCallTargetPct: nullableNumber,
    sourceRef: v.string(),
    figures,
    days: v.array(dayFacts),
  }),
  handler: async (ctx, args) => {
    checkPeriod(args.from, args.to);
    const sc = await context(ctx, { serviceDate: args.to });
    const member = await memberOf(ctx, sc, args.profileId);
    const standards = member.position
      ? await standardsFor(ctx, member.position._id)
      : [];
    const sales = await salesByDay(ctx, member.profile, args.from, args.to);
    const customerCodes = new Map<Id<"customers">, string | null>();
    const codeOf = async (id: Id<"customers"> | null) => {
      if (!id) return null;
      if (!customerCodes.has(id))
        customerCodes.set(id, (await ctx.db.get(id))?.code ?? null);
      return customerCodes.get(id) ?? null;
    };
    const now = Date.now();
    const days: DayFacts[] = [];
    let lastStandard: ReturnType<typeof standardAt> = null;
    for (const serviceDate of datesBetween(args.from, args.to)) {
      const noon = Date.parse(`${serviceDate}T12:00:00+08:00`);
      const standard = standardAt(standards, noon);
      if (standard) lastStandard = standard;
      const rule = standard?.productiveCallRule ?? "any_listed_activity";
      const sellingDay = isSellingDay(
        serviceDate,
        standard?.sellingWeekdays ?? DEFAULT_SELLING_WEEKDAYS,
      );
      const { planned, visits } = await personDay(
        ctx,
        sc,
        member.profile._id,
        serviceDate,
      );
      const active = planned.filter((row) => row.status === "planned");
      const activeIds = new Set(active.map((row) => row._id as string));
      const sequence = new Map(
        planned.map((row) => [
          row._id as string,
          row.approvedSnapshot.sequence,
        ]),
      );
      const broken = outOfSequence(visits, (visit) =>
        visit.plannedVisitId ? sequence.get(visit.plannedVisitId) : undefined,
      );
      const sale = sales.get(serviceDate);
      let calls = 0,
        productiveCalls = 0,
        convertedCalls = 0,
        exceptionVisits = 0,
        locationExceptions = 0;
      for (const visit of visits) {
        const activities = await ctx.db
          .query("visitActivities")
          .withIndex("by_visitId_and_serverTime", (q) =>
            q.eq("visitId", visit._id),
          )
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
        const evaluation = evaluateProductiveCall({
          rule,
          inRoutePlan: visit.source === "planned" && !!visit.plannedVisitId,
          state: visit.state,
          codes: recorded.codes,
          noSalesDueToInventory: recorded.noSalesDueToInventory,
        });
        if (evaluation.isCall) {
          calls++;
          if (evaluation.status === "productive") productiveCalls++;
          if (sale) {
            const intents = activities.flatMap((row) =>
              row.activity.kind === "order_intent"
                ? [row.activity.clientOrderId]
                : [],
            );
            const code = await codeOf(
              visit.customerId ?? (await customerAt(ctx, visit.outletId, noon)),
            );
            if (
              intents.some((id) => sale.clientRequestIds.has(id)) ||
              (code !== null && sale.customerCodes.has(code))
            )
              convertedCalls++;
          }
        }
        const outside = (await visitEvidence(ctx, visit._id)).filter(
          (row) => row.result !== "within_radius",
        ).length;
        locationExceptions += outside;
        if (
          outside > 0 ||
          broken.has(visit._id) ||
          visit.source === "unplanned"
        )
          exceptionVisits++;
      }
      days.push({
        serviceDate,
        closed: dayCloseAt(serviceDate) < now,
        sellingDay,
        planned: active.length,
        plannedDone: new Set(
          visits
            .filter(
              (visit) =>
                DONE_STATES.has(visit.state) &&
                visit.plannedVisitId !== undefined &&
                activeIds.has(visit.plannedVisitId),
            )
            .map((visit) => visit.plannedVisitId as string),
        ).size,
        calls,
        productiveCalls,
        convertedCalls,
        visits: visits.length,
        unplanned: visits.filter((visit) => visit.source === "unplanned")
          .length,
        exceptionVisits,
        locationExceptions,
        outOfSequence: broken.size,
        orders: sale?.orders ?? 0,
        sales: sale?.sales ?? 0,
        callsTarget: sellingDay ? (standard?.dailyCallsTarget ?? null) : null,
      });
    }
    return {
      profileId: member.profile._id,
      name: member.profile.name,
      employeeCode: member.profile.employeeCode ?? null,
      positionLabel: member.position?.label ?? null,
      channel: channelOf(member.profile.channelScope, member.position?.label),
      direct: member.direct,
      from: args.from,
      to: args.to,
      productiveCallTargetPct: lastStandard?.productiveCallTargetPct ?? null,
      sourceRef: PRODUCTIVITY_SOURCE,
      figures: summarizePeriod(days),
      days,
    };
  },
});
