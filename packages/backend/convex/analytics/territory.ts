import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { localDate, monthBounds } from "../coverage/validation";
import {
  countsAsSale,
  dailyTarget,
  LATE_ORDER_WINDOW_MS,
  saleInstant,
  toMinor,
} from "../dsr/model";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { activeAt } from "../org/validation";
import {
  evaluateProductiveCall,
  productiveCodesFromVisitRecords,
  type ProductiveCallRule,
} from "../sfa/productive_call";
import {
  DEFAULT_SELLING_WEEKDAYS,
  isSellingDay,
  sellingDatesInMonth,
} from "../sfa/selling_days";
import { standardAt, standardsFor } from "../sfa/standards";
import { supervisorContext } from "../supervision/access";
import { dayCloseAt, DONE_STATES } from "../supervision/model";
import { targetAt } from "../targets/model";
import { resolveTerritoryOwnerAt } from "../territories/validation";
import {
  datesBetween,
  periodError,
  TERRITORY_SOURCE,
  type TerritoryFigures,
} from "./territory_model";

/**
 * ANA-004 territory performance dashboard. `list` returns the territories the caller may
 * compare (current owner inside the caller's scope, optionally one unit's subtree and one
 * channel); `figures` returns one territory's period figures. The web subscribes one
 * `figures` query per row so each read stays bounded (one territory, at most 31 days).
 *
 * Access: supervision readers (`people.read` + `visit.read`) who also hold `report.read`,
 * inside their own organizational scope. Field `sales` never sees it.
 *
 * Computed live from the source tables: there are no stored territory rollups yet
 * (CVX-032). Pure rules: `./territory_model.ts`.
 */

const DAY = 86_400_000;
const MAX_TERRITORIES = 200;
/** Store assignment rows of one territory that overlap the period. */
const MAX_OUTLET_ROWS = 300;
/** Every assignment row of the territory up to the period end (history included). */
const MAX_ASSIGNMENT_HISTORY = 1_500;
/** Planned stops of one territory in one read (≈ one route salesman for a month). */
const MAX_PLANNED = 900;
const MAX_PER_OUTLET_DAY = 60;
const MAX_HISTORY = 50;
const MAX_VISIT_ROWS = 100;
const MAX_CUSTOMER_ORDERS = 1_000;
const MAX_TARGET_ROWS = 200;
const MAX_GAP_OUTLETS = 25;

const TOO_BIG =
  "This territory has too much activity for one read; pick a shorter period";

const nullableNumber = v.union(v.number(), v.null());

const figuresValidator = v.object({
  activeOutlets: v.number(),
  buyingOutlets: v.number(),
  planned: v.number(),
  plannedOutlets: v.number(),
  coveredOutlets: v.number(),
  calls: v.number(),
  productiveCalls: v.number(),
  missed: v.number(),
  pending: v.number(),
  orders: v.number(),
  sales: v.number(),
  salesTarget: nullableNumber,
});

const territoryRow = v.object({
  territoryId: v.id("territories"),
  code: v.string(),
  name: v.string(),
  channel: v.union(v.string(), v.null()),
  ownerUnitName: v.string(),
});

function checkPeriod(from: string, to: string) {
  localDate(from);
  localDate(to);
  const error = periodError(from, to);
  if (error) throw new ConvexError(error);
}

async function context(
  ctx: QueryCtx,
  filters: { serviceDate: string; orgUnitId?: Id<"orgUnits"> },
) {
  const sc = await supervisorContext(ctx, filters);
  await requireCapability(ctx, "report.read");
  return sc;
}

/** The unit that owns the territory now, or null (retired/unowned). */
async function currentOwner(ctx: QueryCtx, territory: Doc<"territories">) {
  try {
    return await resolveTerritoryOwnerAt(ctx, territory._id, Date.now());
  } catch {
    // Broken ownership history is an admin problem; it never widens access.
    return null;
  }
}

/** Territories the caller may compare, by code. */
export const list = query({
  args: {
    endDate: v.string(),
    orgUnitId: v.optional(v.id("orgUnits")),
    channel: v.optional(v.string()),
  },
  returns: v.object({
    truncated: v.boolean(),
    channels: v.array(v.string()),
    units: v.array(
      v.object({ id: v.id("orgUnits"), code: v.string(), name: v.string() }),
    ),
    territories: v.array(territoryRow),
  }),
  handler: async (ctx, args) => {
    if (args.channel !== undefined && args.channel.length > 80)
      throw new ConvexError("invalid_request");
    const sc = await context(ctx, {
      serviceDate: args.endDate,
      ...(args.orgUnitId ? { orgUnitId: args.orgUnitId } : {}),
    });
    const rows = await ctx.db
      .query("territories")
      .withIndex("by_organizationId_and_status", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("status", "active"),
      )
      .take(MAX_TERRITORIES + 1);
    const unitNames = new Map(sc.unitOptions.map((u) => [u.id, u.name]));
    const channels = new Set<string>();
    const territories = [];
    for (const territory of rows.slice(0, MAX_TERRITORIES)) {
      const owner = await currentOwner(ctx, territory);
      if (!owner || !sc.units.has(owner.orgUnitId)) continue;
      if (territory.channel) channels.add(territory.channel);
      if (args.channel && territory.channel !== args.channel) continue;
      territories.push({
        territoryId: territory._id,
        code: territory.code,
        name: territory.name,
        channel: territory.channel ?? null,
        ownerUnitName: unitNames.get(owner.orgUnitId) ?? "—",
      });
    }
    territories.sort((a, b) => a.code.localeCompare(b.code));
    return {
      truncated: rows.length > MAX_TERRITORIES,
      channels: [...channels].sort(),
      units: sc.unitOptions,
      territories,
    };
  },
});

/** The territory's sales target summed over the period's days (DSR daily rule). */
async function periodSalesTarget(
  ctx: QueryCtx,
  territoryId: Id<"territories">,
  dates: string[],
) {
  const rows = async (period: "daily" | "monthly") => {
    const list = await ctx.db
      .query("salesTargets")
      .withIndex(
        "by_territoryId_and_period_and_metric_and_effectiveFrom",
        (q) =>
          q
            .eq("territoryId", territoryId)
            .eq("period", period)
            .eq("metric", "sales_value"),
      )
      .take(MAX_TARGET_ROWS + 1);
    if (list.length > MAX_TARGET_ROWS)
      throw new ConvexError("Target history exceeds limit");
    return list;
  };
  const daily = await rows("daily");
  const monthly = await rows("monthly");
  let total: number | null = null;
  for (const date of dates) {
    const month = date.slice(0, 7);
    const target = dailyTarget({
      daily: targetAt(daily, localDate(date))?.value ?? null,
      monthly: targetAt(monthly, monthBounds(month).from)?.value ?? null,
      sellingDay: isSellingDay(date, DEFAULT_SELLING_WEEKDAYS),
      sellingDaysInMonth: sellingDatesInMonth(month, DEFAULT_SELLING_WEEKDAYS)
        .length,
    });
    if (target.value !== null) total = (total ?? 0) + target.value;
  }
  return total;
}

/**
 * One territory's figures for a period of Manila dates (at most 31).
 *
 * - Calls, coverage and strike rate come from planned stops whose signed MCP snapshot names
 *   this territory (immutable attribution), judged with the client's productive-call rule.
 * - Sales are orders of the customers linked to the territory's stores, counted when the
 *   store belonged to the territory at the moment of sale (DSR sale rules).
 * - Distribution gaps are active stores assigned at the end of the period with no sale.
 */
export const figures = query({
  args: {
    territoryId: v.id("territories"),
    from: v.string(),
    to: v.string(),
  },
  returns: v.object({
    territoryId: v.id("territories"),
    code: v.string(),
    name: v.string(),
    from: v.string(),
    to: v.string(),
    sourceRef: v.string(),
    figures: figuresValidator,
    gapOutlets: v.array(
      v.object({
        outletId: v.id("outlets"),
        code: v.string(),
        name: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    checkPeriod(args.from, args.to);
    const sc = await context(ctx, { serviceDate: args.to });
    const territory = await ctx.db.get(args.territoryId);
    if (!territory || territory.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("Territory not found");
    const owner = await currentOwner(ctx, territory);
    if (!owner || !sc.scope.has(owner.orgUnitId))
      throw new ConvexError(
        "Requested territory is outside your organizational scope",
      );

    const now = Date.now();
    const start = localDate(args.from);
    const end = localDate(args.to) + DAY;
    const dates = datesBetween(args.from, args.to);

    // Store assignment rows of this territory that overlap the period.
    const history = await ctx.db
      .query("outletAssignments")
      .withIndex("by_territoryId_and_effectiveFrom", (q) =>
        q.eq("territoryId", territory._id).lt("effectiveFrom", end),
      )
      .take(MAX_ASSIGNMENT_HISTORY + 1);
    if (history.length > MAX_ASSIGNMENT_HISTORY) throw new ConvexError(TOO_BIG);
    const assignmentRows = history.filter(
      (row) =>
        (row.effectiveTo === undefined || row.effectiveTo > start) &&
        row.effectiveTo !== row.effectiveFrom,
    );
    const byOutlet = new Map<Id<"outlets">, Doc<"outletAssignments">[]>();
    for (const row of assignmentRows)
      byOutlet.set(row.outletId, [...(byOutlet.get(row.outletId) ?? []), row]);
    if (byOutlet.size > MAX_OUTLET_ROWS) throw new ConvexError(TOO_BIG);
    const inTerritoryAt = (outletId: Id<"outlets">, instant: number) =>
      (byOutlet.get(outletId) ?? []).some((row) =>
        activeAt(row.effectiveFrom, row.effectiveTo, instant),
      );

    // Planned stops, calls and coverage.
    const rules = new Map<string, ProductiveCallRule>();
    const ruleFor = async (profileId: Id<"profiles">, instant: number) => {
      const key = `${profileId}:${new Date(instant).toISOString().slice(0, 10)}`;
      const cached = rules.get(key);
      if (cached) return cached;
      const person = await ctx.db.get(profileId);
      const standards = person?.positionId
        ? await standardsFor(ctx, person.positionId)
        : [];
      const rule =
        standardAt(standards, instant)?.productiveCallRule ??
        "any_listed_activity";
      rules.set(key, rule);
      return rule;
    };
    let planned = 0,
      calls = 0,
      productiveCalls = 0,
      missed = 0,
      pending = 0;
    const plannedOutlets = new Set<Id<"outlets">>();
    const coveredOutlets = new Set<Id<"outlets">>();
    for (const outletId of byOutlet.keys()) {
      const stops = (
        await ctx.db
          .query("plannedVisits")
          .withIndex("by_outletId_and_serviceDate", (q) =>
            q
              .eq("outletId", outletId)
              .gte("serviceDate", args.from)
              .lte("serviceDate", args.to),
          )
          .take(MAX_PER_OUTLET_DAY * dates.length + 1)
      ).filter(
        (row) =>
          row.status === "planned" &&
          row.approvedSnapshot.territoryId === territory._id &&
          sc.scope.has(row.approvedSnapshot.orgUnitId),
      );
      for (const stop of stops) {
        if (++planned > MAX_PLANNED) throw new ConvexError(TOO_BIG);
        plannedOutlets.add(outletId);
        const visits = (
          await ctx.db
            .query("visitExecutions")
            .withIndex("by_plannedVisitId", (q) =>
              q.eq("plannedVisitId", stop._id),
            )
            .take(10)
        ).filter(
          (visit) =>
            visit.organizationId === SUNPRIDE_ORGANIZATION_ID &&
            DONE_STATES.has(visit.state),
        );
        if (!visits.length) {
          if (dayCloseAt(stop.serviceDate) < now) missed++;
          else pending++;
          continue;
        }
        // One call per planned stop; productive when any of its visits was.
        calls++;
        coveredOutlets.add(outletId);
        const noon = Date.parse(`${stop.serviceDate}T12:00:00+08:00`);
        const rule = await ruleFor(stop.assigneeProfileId, noon);
        let productive = false;
        for (const visit of visits) {
          const activities = await ctx.db
            .query("visitActivities")
            .withIndex("by_visitId_and_serverTime", (q) =>
              q.eq("visitId", visit._id),
            )
            .take(MAX_VISIT_ROWS);
          const judge = (collectionCount: number) => {
            const recorded = productiveCodesFromVisitRecords({
              activityKinds: activities.map((row) => row.activity.kind),
              collectionCount,
              reasonCode: visit.reasonCode,
            });
            return evaluateProductiveCall({
              rule,
              inRoutePlan: true,
              state: visit.state,
              codes: recorded.codes,
              noSalesDueToInventory: recorded.noSalesDueToInventory,
            });
          };
          if (judge(0).status === "productive") {
            productive = true;
            break;
          }
          const collections = (
            await ctx.db
              .query("fieldCollections")
              .withIndex("by_visitId_and_serverTime", (q) =>
                q.eq("visitId", visit._id),
              )
              .take(MAX_VISIT_ROWS)
          ).filter((row) => row.status !== "rejected");
          if (
            collections.length &&
            judge(collections.length).status === "productive"
          ) {
            productive = true;
            break;
          }
        }
        if (productive) productiveCalls++;
      }
    }

    // Sales: orders of each linked customer, in the territory at the moment of sale.
    const ordersByCode = new Map<string, Doc<"orders">[]>();
    const counted = new Set<Id<"orders">>();
    const buying = new Set<Id<"outlets">>();
    let orders = 0,
      sales = 0;
    for (const outletId of byOutlet.keys()) {
      const links = (
        await ctx.db
          .query("outletCustomerLinks")
          .withIndex("by_outletId_and_effectiveFrom", (q) =>
            q.eq("outletId", outletId).lt("effectiveFrom", end),
          )
          .order("desc")
          .take(MAX_HISTORY)
      ).filter(
        (link) =>
          (link.effectiveTo === undefined || link.effectiveTo > start) &&
          link.effectiveTo !== link.effectiveFrom,
      );
      for (const link of links) {
        const customer = await ctx.db.get(link.customerId);
        if (!customer) continue;
        let list = ordersByCode.get(customer.code);
        if (!list) {
          list = await ctx.db
            .query("orders")
            .withIndex("by_customer", (q) =>
              q
                .eq("customerCode", customer.code)
                .gte("_creationTime", start - DAY),
            )
            .take(MAX_CUSTOMER_ORDERS + 1);
          if (list.length > MAX_CUSTOMER_ORDERS)
            throw new ConvexError(
              "Too many orders for one customer since this period; pick a more recent period",
            );
          ordersByCode.set(customer.code, list);
        }
        for (const order of list) {
          if (
            (order.organizationId !== undefined &&
              order.organizationId !== SUNPRIDE_ORGANIZATION_ID) ||
            !countsAsSale(order.status) ||
            order.createdAt >= end + LATE_ORDER_WINDOW_MS
          )
            continue;
          const instant = saleInstant(order);
          if (
            instant < start ||
            instant >= end ||
            !activeAt(link.effectiveFrom, link.effectiveTo, instant) ||
            !inTerritoryAt(outletId, instant)
          )
            continue;
          if (order.total > 0) buying.add(outletId);
          // A customer shared by two stores of the territory is counted once.
          if (counted.has(order._id)) continue;
          counted.add(order._id);
          orders++;
          sales += toMinor(order.total);
        }
      }
    }

    // Distribution: active stores assigned at the end of the period.
    const asOf = Math.min(end - 1, now);
    let activeOutlets = 0,
      buyingOutlets = 0;
    const gaps: { outletId: Id<"outlets">; code: string; name: string }[] = [];
    for (const outletId of byOutlet.keys()) {
      if (!inTerritoryAt(outletId, asOf)) continue;
      const outlet = await ctx.db.get(outletId);
      if (!outlet || outlet.status !== "active") continue;
      activeOutlets++;
      if (buying.has(outletId)) buyingOutlets++;
      else gaps.push({ outletId, code: outlet.code, name: outlet.name });
    }
    gaps.sort((a, b) => a.code.localeCompare(b.code));

    const result: TerritoryFigures = {
      activeOutlets,
      buyingOutlets,
      planned,
      plannedOutlets: plannedOutlets.size,
      coveredOutlets: coveredOutlets.size,
      calls,
      productiveCalls,
      missed,
      pending,
      orders,
      sales,
      salesTarget: await periodSalesTarget(ctx, territory._id, dates),
    };
    return {
      territoryId: territory._id,
      code: territory.code,
      name: territory.name,
      from: args.from,
      to: args.to,
      sourceRef: TERRITORY_SOURCE,
      figures: result,
      gapOutlets: gaps.slice(0, MAX_GAP_OUTLETS),
    };
  },
});
