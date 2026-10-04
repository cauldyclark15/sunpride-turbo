/* Daily Sales Report (Annex B, SOP-007): one salesman's daily sheet, generated from the
 * orders and visits the field already records. Pure rules live in ./model.ts.
 *
 * Access: `report.read` at every unit the day's work belongs to (the salesman's assignment
 * on the day and each visit's unit). Field `sales` reads only their own sheet.
 */
import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { localDate, monthBounds } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { capabilityRoles, requireCapability } from "../lib/capabilities";
import { rootOrgUnitId } from "../lib/scope";
import { activeAt } from "../org/validation";
import {
  evaluateProductiveCall,
  PRODUCTIVE_CALL_RULE_VERSION,
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
import { subjectTargetAt } from "../targets/sales";
import { supervisorContext, teamMembers } from "../supervision/access";
import {
  balanceToSell,
  compareCategories,
  countsAsSale,
  dailyTarget,
  LATE_ORDER_WINDOW_MS,
  manilaDateOf,
  MEMO_CATEGORIES,
  memoCategory,
  monthOf,
  percentOf,
  saleInstant,
  toMinor,
} from "./model";

/** A month of one salesman's orders; 30 calls a day for 26 days with headroom. */
export const MAX_MONTH_ORDERS = 2_000;
const MAX_ORDER_LINES = 200;
const MAX_DAY_VISITS = 200;
const MAX_VISIT_ROWS = 100;
const MAX_HISTORY = 50;
const MAX_REMARK = 500;

const callStatus = v.union(
  v.literal("productive"),
  v.literal("nonproductive"),
  v.literal("open"),
  v.literal("not_visited"),
  v.literal("off_plan"),
);
const money = v.number(); // PHP centavos
const nullableMoney = v.union(v.number(), v.null());

const customerRow = v.object({
  key: v.string(),
  outletId: v.union(v.id("outlets"), v.null()),
  outletCode: v.union(v.string(), v.null()),
  customerCode: v.union(v.string(), v.null()),
  name: v.string(),
  sequence: v.union(v.number(), v.null()),
  inRoutePlan: v.boolean(),
  callStatus: v.union(callStatus, v.null()),
  matchedCodes: v.array(v.string()),
  todaySales: money,
  mtdSales: money,
  invoiceNumbers: v.array(v.string()),
  reasonCode: v.union(v.string(), v.null()),
  remarks: v.array(v.string()),
});

const reportValidator = v.object({
  serviceDate: v.string(),
  localMonth: v.string(),
  ruleVersion: v.string(),
  salesman: v.object({
    profileId: v.id("profiles"),
    name: v.string(),
    employeeCode: v.union(v.string(), v.null()),
    position: v.union(v.string(), v.null()),
  }),
  areaCovered: v.array(v.string()),
  invoiceNumbers: v.array(v.string()),
  sellingDay: v.boolean(),
  sellingDaysInMonth: v.number(),
  targets: v.object({
    daily: nullableMoney,
    dailySource: v.union(
      v.literal("set"),
      v.literal("derived_from_monthly"),
      v.null(),
    ),
    monthly: nullableMoney,
    sourceRef: v.union(v.string(), v.null()),
  }),
  totals: v.object({
    todaySales: money,
    todayPct: v.union(v.number(), v.null()),
    mtdSales: money,
    mtdPct: v.union(v.number(), v.null()),
    balanceToSell: nullableMoney,
  }),
  calls: v.object({
    planned: v.number(),
    calls: v.number(),
    productiveCalls: v.number(),
    productivePct: v.union(v.number(), v.null()),
    dailyCallsTarget: v.union(v.number(), v.null()),
    productiveCallTargetPct: v.union(v.number(), v.null()),
  }),
  customers: v.array(customerRow),
  categories: v.array(
    v.object({
      category: v.string(),
      todaySales: money,
      todayQuantity: v.number(),
      mtdSales: money,
      mtdQuantity: v.number(),
    }),
  ),
  programs: v.array(
    v.object({
      programRef: v.string(),
      executed: v.number(),
      notExecuted: v.number(),
      notApplicable: v.number(),
    }),
  ),
});

type Row = typeof customerRow.type;

/** Manila noon of a service date: the instant a day's assignment and targets are read at. */
function manilaNoon(serviceDate: string) {
  return Date.parse(`${serviceDate}T12:00:00+08:00`);
}

async function assignmentAt(
  ctx: QueryCtx,
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

function trimRemark(text: string) {
  const clean = text.trim();
  return clean.length > MAX_REMARK ? `${clean.slice(0, MAX_REMARK)}…` : clean;
}

/**
 * The Annex B sheet for one salesman and one Manila service date: today's sale vs target,
 * MTD performance, target and balance to sell, today's calls and productive calls, one row
 * per route-plan store or customer sold to (with remarks), category roll-ups and the
 * promotion programs checked today.
 */
export const day = query({
  args: { profileId: v.id("profiles"), serviceDate: v.string() },
  returns: reportValidator,
  handler: async (ctx, args) => {
    const dayStart = localDate(args.serviceDate);
    const localMonth = monthOf(args.serviceDate);
    const { from: monthStart } = monthBounds(localMonth);
    const dayEnd = dayStart + 86_400_000;

    const { profile: caller } = await requireCapability(ctx, "report.read");
    if (caller.role === "sales" && caller._id !== args.profileId)
      throw new ConvexError("Sales can only read their own daily sales report");
    const person = await ctx.db.get(args.profileId);
    if (!person) throw new ConvexError("Salesman not found");

    const noon = manilaNoon(args.serviceDate);
    const assignment = await assignmentAt(ctx, person._id, noon);

    const visits = await ctx.db
      .query("visitExecutions")
      .withIndex(
        "by_organizationId_and_assigneeProfileId_and_serviceDate",
        (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("assigneeProfileId", person._id)
            .eq("serviceDate", args.serviceDate),
      )
      .take(MAX_DAY_VISITS + 1);
    if (visits.length > MAX_DAY_VISITS)
      throw new ConvexError("Too many visits on this day for one report");
    const planned = (
      await ctx.db
        .query("plannedVisits")
        .withIndex("by_assigneeProfileId_and_serviceDate", (q) =>
          q
            .eq("assigneeProfileId", person._id)
            .eq("serviceDate", args.serviceDate),
        )
        .take(MAX_DAY_VISITS)
    ).filter((row) => row.status === "planned");

    // Scope: the caller must reach every unit the day's work belongs to.
    const units = new Set<Id<"orgUnits">>();
    const unit = assignment?.orgUnitId ?? person.orgUnitId;
    if (unit) units.add(unit);
    for (const visit of visits) units.add(visit.orgUnitId);
    for (const row of planned) units.add(row.approvedSnapshot.orgUnitId);
    if (!units.size && caller._id !== person._id) {
      const root = await rootOrgUnitId(ctx);
      if (!root) throw new ConvexError("Salesman has no organizational scope");
      units.add(root);
    }
    for (const id of units) await requireCapability(ctx, "report.read", id);

    // Position standard: calls targets, productive-call rule and selling week.
    const positionId = assignment?.positionId ?? person.positionId;
    const position = positionId ? await ctx.db.get(positionId) : null;
    const standard = position
      ? standardAt(await standardsFor(ctx, position._id), noon)
      : null;
    const rule = standard?.productiveCallRule ?? "any_listed_activity";
    const sellingWeekdays = standard?.sellingWeekdays ?? [
      ...DEFAULT_SELLING_WEEKDAYS,
    ];
    const sellingDay = isSellingDay(args.serviceDate, sellingWeekdays);
    const sellingDaysInMonth = sellingDatesInMonth(
      localMonth,
      sellingWeekdays,
    ).length;

    // Customers: one row per route-plan store, then per unplanned visit, then per order.
    const rows = new Map<string, Row>();
    const customerCodes = new Map<Id<"customers">, string | null>();
    const codeOf = async (customerId: Id<"customers"> | null | undefined) => {
      if (!customerId) return null;
      if (!customerCodes.has(customerId))
        customerCodes.set(
          customerId,
          (await ctx.db.get(customerId))?.code ?? null,
        );
      return customerCodes.get(customerId) ?? null;
    };
    const rowForOutlet = async (
      outletId: Id<"outlets">,
      fallback: {
        code?: string;
        name?: string;
        customerId?: Id<"customers">;
        sequence?: number;
      },
    ) => {
      const key = `outlet:${outletId}`;
      let row = rows.get(key);
      if (!row) {
        const outlet = await ctx.db.get(outletId);
        row = {
          key,
          outletId,
          outletCode: outlet?.code ?? fallback.code ?? null,
          customerCode: await codeOf(
            fallback.customerId ?? (await customerAt(ctx, outletId, noon)),
          ),
          name: outlet?.name ?? fallback.name ?? "Removed outlet",
          sequence: fallback.sequence ?? null,
          inRoutePlan: false,
          callStatus: null,
          matchedCodes: [],
          todaySales: 0,
          mtdSales: 0,
          invoiceNumbers: [],
          reasonCode: null,
          remarks: [],
        };
        rows.set(key, row);
      }
      return row;
    };
    const routeNames = new Map<Id<"routes">, string>();
    const territoryCodes = new Set<string>();
    for (const stop of [...planned].sort(
      (a, b) =>
        (a.approvedSnapshot.sequence ?? 0) - (b.approvedSnapshot.sequence ?? 0),
    )) {
      const snap = stop.approvedSnapshot;
      const row = await rowForOutlet(stop.outletId, {
        code: snap.outletCode,
        name: snap.outletName,
        customerId: snap.customerId,
        sequence: snap.sequence,
      });
      row.inRoutePlan = true;
      row.callStatus = "not_visited";
      if (snap.routeId && !routeNames.has(snap.routeId))
        routeNames.set(
          snap.routeId,
          (await ctx.db.get(snap.routeId))?.name ?? snap.routeCode ?? "Route",
        );
      territoryCodes.add(snap.territoryCode);
    }

    // Visits: productive-call evaluation, remarks and programs.
    const evaluations: CallEvaluation[] = [];
    const programs = new Map<
      string,
      { executed: number; notExecuted: number; notApplicable: number }
    >();
    for (const visit of visits) {
      const activities = await ctx.db
        .query("visitActivities")
        .withIndex("by_visitId_and_serverTime", (q) =>
          q.eq("visitId", visit._id),
        )
        .take(MAX_VISIT_ROWS);
      const collections = await ctx.db
        .query("fieldCollections")
        .withIndex("by_visitId_and_serverTime", (q) =>
          q.eq("visitId", visit._id),
        )
        .take(MAX_VISIT_ROWS);
      const recorded = productiveCodesFromVisitRecords({
        activityKinds: activities.map((row) => row.activity.kind),
        collectionCount: collections.filter((row) => row.status !== "rejected")
          .length,
        reasonCode: visit.reasonCode,
      });
      const evaluation = evaluateProductiveCall({
        rule,
        inRoutePlan: visit.source === "planned" && !!visit.plannedVisitId,
        state: visit.state,
        codes: recorded.codes,
        noSalesDueToInventory: recorded.noSalesDueToInventory,
      });
      evaluations.push(evaluation);
      const row = await rowForOutlet(visit.outletId, {
        customerId: visit.customerId,
      });
      // A planned store visited twice keeps its best call outcome.
      if (
        row.callStatus === null ||
        row.callStatus === "not_visited" ||
        row.callStatus === "off_plan" ||
        evaluation.status === "productive"
      ) {
        row.callStatus = evaluation.status;
        row.matchedCodes = evaluation.matchedCodes;
      }
      if (visit.reasonCode) row.reasonCode = visit.reasonCode;
      if (visit.routeId && !routeNames.has(visit.routeId))
        routeNames.set(
          visit.routeId,
          (await ctx.db.get(visit.routeId))?.name ?? "Route",
        );
      for (const { activity } of activities) {
        if (activity.kind === "note" && activity.text.trim())
          row.remarks.push(trimRemark(activity.text));
        if (activity.kind === "order_intent" && activity.note?.trim())
          row.remarks.push(trimRemark(activity.note));
        if (activity.kind === "merchandising" && activity.actionTaken?.trim())
          row.remarks.push(trimRemark(activity.actionTaken));
        if (activity.kind === "promotion") {
          const ref = activity.programRef.trim() || "Unnamed program";
          const tally = programs.get(ref) ?? {
            executed: 0,
            notExecuted: 0,
            notApplicable: 0,
          };
          if (activity.finding === "executed") tally.executed++;
          else if (activity.finding === "not_executed") tally.notExecuted++;
          else tally.notApplicable++;
          programs.set(ref, tally);
        }
      }
    }
    const callSummary = summarizeCalls(evaluations);

    // Orders: the month to date, attributed to the day the salesman wrote them.
    const orders = await ctx.db
      .query("orders")
      .withIndex("by_salespersonSubject_and_createdAt", (q) =>
        q
          .eq("salespersonSubject", person.authSubject)
          .gte("createdAt", monthStart)
          .lt("createdAt", dayEnd + LATE_ORDER_WINDOW_MS),
      )
      .take(MAX_MONTH_ORDERS + 1);
    if (orders.length > MAX_MONTH_ORDERS)
      throw new ConvexError("Too many orders this month for one report");
    const byCustomerCode = new Map<string, Row>();
    for (const row of rows.values())
      if (row.customerCode && !byCustomerCode.has(row.customerCode))
        byCustomerCode.set(row.customerCode, row);
    const products = new Map<string, Doc<"products"> | null>();
    const categories = new Map<
      string,
      {
        todaySales: number;
        todayQuantity: number;
        mtdSales: number;
        mtdQuantity: number;
      }
    >(
      MEMO_CATEGORIES.map((category) => [
        category,
        { todaySales: 0, todayQuantity: 0, mtdSales: 0, mtdQuantity: 0 },
      ]),
    );
    const invoiceNumbers: string[] = [];
    let todaySales = 0,
      mtdSales = 0;
    const sales = orders
      .filter(
        (order) =>
          (order.organizationId === undefined ||
            order.organizationId === SUNPRIDE_ORGANIZATION_ID) &&
          countsAsSale(order.status),
      )
      .map((order) => ({ order, instant: saleInstant(order) }))
      .filter(({ instant }) => instant >= monthStart && instant < dayEnd)
      .map(({ order, instant }) => ({
        order,
        isToday: manilaDateOf(instant) === args.serviceDate,
      }));
    // A customer sold to today without a route-plan or visited store gets its own row.
    for (const { order, isToday } of sales) {
      if (!isToday || byCustomerCode.has(order.customerCode)) continue;
      const customer = await ctx.db
        .query("customers")
        .withIndex("by_code", (q) => q.eq("code", order.customerCode))
        .first();
      const row: Row = {
        key: `customer:${order.customerCode}`,
        outletId: null,
        outletCode: null,
        customerCode: order.customerCode,
        name: customer?.name ?? order.customerCode,
        sequence: null,
        inRoutePlan: false,
        callStatus: null,
        matchedCodes: [],
        todaySales: 0,
        mtdSales: 0,
        invoiceNumbers: [],
        reasonCode: null,
        remarks: [],
      };
      rows.set(row.key, row);
      byCustomerCode.set(order.customerCode, row);
    }
    // Customers sold to earlier in the month but not covered today count in the totals
    // only: the sheet's rows are today's coverage.
    for (const { order, isToday } of sales) {
      const amount = toMinor(order.total);
      mtdSales += amount;
      if (isToday) {
        todaySales += amount;
        invoiceNumbers.push(order.orderNumber);
      }
      const row = byCustomerCode.get(order.customerCode);
      if (row) {
        row.mtdSales += amount;
        if (isToday) {
          row.todaySales += amount;
          row.invoiceNumbers.push(order.orderNumber);
        }
      }
      const lines = await ctx.db
        .query("orderLines")
        .withIndex("by_order", (q) => q.eq("orderId", order._id))
        .take(MAX_ORDER_LINES);
      for (const line of lines) {
        if (!products.has(line.productCode))
          products.set(
            line.productCode,
            await ctx.db
              .query("products")
              .withIndex("by_code", (q) => q.eq("code", line.productCode))
              .first(),
          );
        const category = memoCategory(products.get(line.productCode)?.category);
        const tally = categories.get(category) ?? {
          todaySales: 0,
          todayQuantity: 0,
          mtdSales: 0,
          mtdQuantity: 0,
        };
        // Return lines already carry negative quantity and total.
        const lineAmount = toMinor(line.lineTotal);
        tally.mtdSales += lineAmount;
        tally.mtdQuantity += line.quantity;
        if (isToday) {
          tally.todaySales += lineAmount;
          tally.todayQuantity += line.quantity;
        }
        categories.set(category, tally);
      }
    }

    // Targets: the salesman's own employee targets in effect on the day.
    const subject = { kind: "employee" as const, profileId: person._id };
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
    const today = dailyTarget({
      daily: dailyRow?.value ?? null,
      monthly: monthlyRow?.value ?? null,
      sellingDay,
      sellingDaysInMonth,
    });
    const monthly = monthlyRow?.value ?? null;

    const areaCovered = routeNames.size
      ? [...routeNames.values()].sort()
      : territoryCodes.size
        ? [...territoryCodes].sort()
        : unit
          ? [(await ctx.db.get(unit))?.name ?? "—"]
          : [];

    const customers = [...rows.values()].sort(
      (a, b) =>
        Number(b.inRoutePlan) - Number(a.inRoutePlan) ||
        (a.sequence ?? Number.MAX_SAFE_INTEGER) -
          (b.sequence ?? Number.MAX_SAFE_INTEGER) ||
        Number(b.outletId !== null) - Number(a.outletId !== null) ||
        a.name.localeCompare(b.name),
    );

    return {
      serviceDate: args.serviceDate,
      localMonth,
      ruleVersion: PRODUCTIVE_CALL_RULE_VERSION,
      salesman: {
        profileId: person._id,
        name: person.name,
        employeeCode: person.employeeCode ?? null,
        position: position?.label ?? null,
      },
      areaCovered,
      invoiceNumbers,
      sellingDay,
      sellingDaysInMonth,
      targets: {
        daily: today.value,
        dailySource: today.source,
        monthly,
        sourceRef: (dailyRow ?? monthlyRow)?.sourceRef ?? null,
      },
      totals: {
        todaySales,
        todayPct: percentOf(todaySales, today.value),
        mtdSales,
        mtdPct: percentOf(mtdSales, monthly),
        balanceToSell: balanceToSell(mtdSales, monthly),
      },
      calls: {
        planned: planned.length,
        ...callSummary,
        dailyCallsTarget: standard?.dailyCallsTarget ?? null,
        productiveCallTargetPct: standard?.productiveCallTargetPct ?? null,
      },
      customers,
      categories: [...categories.entries()]
        .sort(([a], [b]) => compareCategories(a, b))
        .map(([category, tally]) => ({ category, ...tally })),
      programs: [...programs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([programRef, tally]) => ({ programRef, ...tally })),
    };
  },
});

const salesmanOption = v.object({
  profileId: v.id("profiles"),
  name: v.string(),
  employeeCode: v.union(v.string(), v.null()),
  position: v.union(v.string(), v.null()),
});

/**
 * Who the caller may open a DSR for: field `sales` get themselves; supervisors (people.read)
 * get the field people in their scope. Other report readers have no people list and see none.
 */
export const salesmen = query({
  args: { serviceDate: v.string() },
  returns: v.object({
    self: v.boolean(),
    truncated: v.boolean(),
    people: v.array(salesmanOption),
  }),
  handler: async (ctx, args) => {
    localDate(args.serviceDate);
    const { profile } = await requireCapability(ctx, "report.read");
    const positionLabel = async (id: Id<"positions"> | undefined) =>
      id ? ((await ctx.db.get(id))?.label ?? null) : null;
    if (profile.role === "sales")
      return {
        self: true,
        truncated: false,
        people: [
          {
            profileId: profile._id,
            name: profile.name,
            employeeCode: profile.employeeCode ?? null,
            position: await positionLabel(profile.positionId),
          },
        ],
      };
    const canListPeople =
      profile.role === "super_admin" ||
      (capabilityRoles("people.read") as readonly string[]).includes(
        profile.role,
      );
    if (!canListPeople) return { self: false, truncated: false, people: [] };
    const sc = await supervisorContext(ctx, { serviceDate: args.serviceDate });
    const { members, truncated } = await teamMembers(ctx, sc, {
      serviceDate: args.serviceDate,
    });
    return {
      self: false,
      truncated,
      people: members.map((member) => ({
        profileId: member.profile._id,
        name: member.profile.name,
        employeeCode: member.profile.employeeCode ?? null,
        position: member.positionLabel,
      })),
    };
  },
});
