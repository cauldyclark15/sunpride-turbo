/* SOP-012 admin report pack (memo §V "ADMIN- Reports"), the reports the system can build
 * today from what the field records:
 *   - Daily Productive Calls, UBA, OSA and Mandays, per person for a Manila service date;
 *   - Programs utilization (the "utilization" half of Promo Advice vs Allocation), from the
 *     promotion findings recorded on visits;
 *   - Collections, the field side of the KAS Account Receivables reckoning.
 * Allocation (Promo Advice), the Priorities pack, the ADP Claims Summary and AR balances have
 * no source in the system yet; docs/architecture/ADMIN_REPORT_PACK.md lists what Sunpride
 * must provide for each.
 *
 * Access mirrors the daily execution dashboard (analytics/execution.ts): supervision readers
 * (`people.read` + `visit.read`) who also hold `report.read`, inside their own scope.
 * Figures are computed live; people are read in pages of ADMIN_PACK_PAGE_SIZE and the web
 * adds the pages up.
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { localDate } from "../coverage/validation";
import { countsAsSale, LATE_ORDER_WINDOW_MS, saleInstant } from "../dsr/model";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import {
  evaluateProductiveCall,
  productiveCodesFromVisitRecords,
  summarizeCalls,
  type CallEvaluation,
} from "../sfa/productive_call";
import { DEFAULT_SELLING_WEEKDAYS, isSellingDay } from "../sfa/selling_days";
import { standardAt, standardsFor } from "../sfa/standards";
import {
  personDay,
  supervisionArgs,
  supervisorContext,
  teamMembers,
  type SupervisorContext,
  type TeamMember,
} from "../supervision/access";
import { DONE_STATES } from "../supervision/model";
import {
  ADMIN_PACK_PAGE_SIZE,
  adminPackPersonRow,
  collectionLine,
  MAX_COLLECTION_LINES,
  MAX_DAY_ORDERS,
  programTally,
  sortedPrograms,
  tallyProgram,
  type AdminPackPersonRow,
  type CollectionLine,
  type ProgramTally,
} from "./admin_reports_model";

const DAY_MS = 86_400_000;
const MAX_VISIT_ROWS = 100;

const unitOption = v.object({
  id: v.id("orgUnits"),
  code: v.string(),
  name: v.string(),
});

type Lookups = {
  customers: Map<Id<"customers">, Doc<"customers"> | null>;
  outlets: Map<Id<"outlets">, Doc<"outlets"> | null>;
};

async function cached<K extends Id<"customers"> | Id<"outlets">, D>(
  map: Map<K, D | null>,
  id: K,
  load: () => Promise<D | null>,
) {
  if (!map.has(id)) map.set(id, await load());
  return map.get(id) ?? null;
}

/**
 * Distinct customer codes with a positive counted sale written on the day (UBA). Reads at
 * most MAX_DAY_ORDERS orders; past that the figure is incomplete, so it reports `truncated`
 * and the web refuses to export a partial count.
 */
async function buyingAccounts(
  ctx: QueryCtx,
  authSubject: string,
  dayStart: number,
) {
  const dayEnd = dayStart + DAY_MS;
  const orders = await ctx.db
    .query("orders")
    .withIndex("by_salespersonSubject_and_createdAt", (q) =>
      q
        .eq("salespersonSubject", authSubject)
        .gte("createdAt", dayStart)
        .lt("createdAt", dayEnd + LATE_ORDER_WINDOW_MS),
    )
    .take(MAX_DAY_ORDERS + 1);
  const truncated = orders.length > MAX_DAY_ORDERS;
  const codes = new Set<string>();
  for (const order of orders.slice(0, MAX_DAY_ORDERS)) {
    if (
      order.organizationId !== undefined &&
      order.organizationId !== SUNPRIDE_ORGANIZATION_ID
    )
      continue;
    // A return posts as a negative order: it is a sale line, but not a buying account.
    if (!countsAsSale(order.status) || !(order.total > 0)) continue;
    const instant = saleInstant(order);
    if (instant >= dayStart && instant < dayEnd) codes.add(order.customerCode);
  }
  return { codes: [...codes].sort(), truncated };
}

async function personPack(
  ctx: QueryCtx,
  sc: SupervisorContext,
  member: TeamMember,
  serviceDate: string,
  programs: Map<string, ProgramTally>,
  lines: CollectionLine[],
  lookups: Lookups,
): Promise<{
  row: AdminPackPersonRow;
  linesTruncated: boolean;
  ordersTruncated: boolean;
}> {
  const dayStart = localDate(serviceDate);
  const noon = dayStart + DAY_MS / 2;
  const positionId = member.assignment.positionId ?? member.profile.positionId;
  const standard = positionId
    ? standardAt(await standardsFor(ctx, positionId), noon)
    : null;
  const sellingDay = isSellingDay(
    serviceDate,
    standard?.sellingWeekdays ?? DEFAULT_SELLING_WEEKDAYS,
  );
  const rule = standard?.productiveCallRule ?? "any_listed_activity";

  // personDay keeps the caller's whole scope; the pack counts only the selected units, so a
  // person's visits in another unit of the caller's area never reach a unit's totals.
  const visits = (
    await personDay(ctx, sc, member.profile._id, serviceDate)
  ).visits.filter((visit) => sc.units.has(visit.orgUnitId));
  const evaluations: CallEvaluation[] = [];
  let osaAudits = 0;
  let osaRequired = 0;
  let osaAvailable = 0;
  let collections = 0;
  let collectedMinor = 0;
  let linesTruncated = false;
  for (const visit of visits) {
    const inRoutePlan = visit.source === "planned" && !!visit.plannedVisitId;
    if (!DONE_STATES.has(visit.state)) {
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
    const visitCollections = (
      await ctx.db
        .query("fieldCollections")
        .withIndex("by_visitId_and_serverTime", (q) =>
          q.eq("visitId", visit._id),
        )
        .take(MAX_VISIT_ROWS)
    ).filter((row) => row.status !== "rejected");
    const recorded = productiveCodesFromVisitRecords({
      activityKinds: activities.map((row) => row.activity.kind),
      collectionCount: visitCollections.length,
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
    for (const row of activities)
      if (row.activity.kind === "promotion")
        tallyProgram(programs, row.activity.programRef, row.activity.finding);

    const audit = await ctx.db
      .query("merchandisingAudits")
      .withIndex("by_visitId", (q) => q.eq("visitId", visit._id))
      .first();
    if (audit) {
      osaAudits++;
      osaRequired += audit.requiredCount;
      osaAvailable += audit.requiredAvailableCount;
    }

    for (const collection of visitCollections) {
      const amount = Number(collection.amountMinor);
      collections++;
      collectedMinor += amount;
      if (lines.length >= MAX_COLLECTION_LINES) {
        linesTruncated = true;
        continue;
      }
      const customer = await cached(
        lookups.customers,
        collection.customerId,
        () => ctx.db.get(collection.customerId),
      );
      const outlet = await cached(lookups.outlets, collection.outletId, () =>
        ctx.db.get(collection.outletId),
      );
      lines.push({
        id: collection._id,
        profileId: member.profile._id,
        personName: member.profile.name,
        customerCode: customer?.code ?? "",
        customerName: customer?.name ?? "Unknown customer",
        outletCode: outlet?.code ?? "",
        amountMinor: amount,
        currency: collection.currency,
        method: collection.method,
        reference: collection.reference,
        status:
          collection.status === "recorded" ? "recorded" : "pending_review",
        at: collection.deviceTime,
      });
    }
  }
  const calls = summarizeCalls(evaluations);
  const uba = await buyingAccounts(ctx, member.profile.authSubject, dayStart);
  return {
    linesTruncated,
    ordersTruncated: uba.truncated,
    row: {
      profileId: member.profile._id,
      name: member.profile.name,
      employeeCode: member.profile.employeeCode ?? null,
      positionLabel: member.positionLabel,
      channel: member.channel,
      orgUnitId: member.assignment.orgUnitId!,
      sellingDay,
      manday: visits.some((visit) => visit.checkedInAt !== undefined),
      calls: calls.calls,
      productiveCalls: calls.productiveCalls,
      callsTarget: sellingDay ? (standard?.dailyCallsTarget ?? null) : null,
      productiveTargetPct: sellingDay
        ? (standard?.productiveCallTargetPct ?? null)
        : null,
      buyingAccounts: uba.codes,
      osaAudits,
      osaRequired,
      osaAvailable,
      collections,
      collectedMinor,
    },
  };
}

/**
 * One page of the admin report pack for a Manila service date: a row per field person in
 * the selected scope, plus that page's programme findings and collection lines.
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
    rows: v.array(adminPackPersonRow),
    programs: v.array(programTally),
    collectionLines: v.array(collectionLine),
    collectionLinesTruncated: v.boolean(),
    /** Some person had more than MAX_DAY_ORDERS orders: UBA is incomplete, no export. */
    buyingAccountsTruncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = args.page ?? 0;
    if (!Number.isInteger(page) || page < 0)
      throw new ConvexError("Page must be a whole number from 0");
    const sc = await supervisorContext(ctx, args);
    await requireCapability(ctx, "report.read");
    const { members, truncated, channels } = await teamMembers(ctx, sc, args);
    const pageCount = Math.max(
      1,
      Math.ceil(members.length / ADMIN_PACK_PAGE_SIZE),
    );
    if (page >= pageCount) throw new ConvexError("Page is out of range");
    const programs = new Map<string, ProgramTally>();
    const lines: CollectionLine[] = [];
    const lookups: Lookups = { customers: new Map(), outlets: new Map() };
    const rows: AdminPackPersonRow[] = [];
    let collectionLinesTruncated = false;
    let buyingAccountsTruncated = false;
    for (const member of members.slice(
      page * ADMIN_PACK_PAGE_SIZE,
      (page + 1) * ADMIN_PACK_PAGE_SIZE,
    )) {
      const result = await personPack(
        ctx,
        sc,
        member,
        args.serviceDate,
        programs,
        lines,
        lookups,
      );
      rows.push(result.row);
      if (result.linesTruncated) collectionLinesTruncated = true;
      if (result.ordersTruncated) buyingAccountsTruncated = true;
    }
    return {
      serviceDate: args.serviceDate,
      page,
      pageCount,
      pageSize: ADMIN_PACK_PAGE_SIZE,
      peopleInScope: members.length,
      truncated,
      units: sc.unitOptions,
      channels,
      rows,
      programs: sortedPrograms(programs),
      collectionLines: lines,
      collectionLinesTruncated,
      buyingAccountsTruncated,
    };
  },
});
