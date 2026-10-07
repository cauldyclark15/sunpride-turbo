/* SOP-012 monthly admin report pack (memo §V "ADMIN- Reports"): Programs utilization vs
 * allocation (Promo Advice), Priorities (D.A. contract, Promo Advice, COA, SASR, BR
 * template), Claims Summary (ADP) and Account Receivables reckoning (KAS), for one Manila
 * month. Office inputs come from `adminPackRecords` (sample rows until Sunpride's real data
 * replaces them, see admin_pack_model.ts); utilization and collections come from the field.
 *
 * Access mirrors the daily pack (admin_reports.ts): supervision readers who also hold
 * `report.read`, limited to the selected units of their own scope.
 */
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { localDate, monthBounds } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { topology } from "../org/validation";
import {
  supervisorContext,
  type SupervisorContext,
} from "../supervision/access";
import { DONE_STATES } from "../supervision/model";
import {
  allocationRow,
  claimStatus,
  claimType,
  MAX_ACCOUNT_COLLECTIONS,
  MAX_MONTH_VISITS,
  MAX_PACK_RECORDS,
  pickSource,
  priorityDocType,
  priorityStatus,
  receivableRow,
  recordSource,
  type AllocationRow,
  type PackKind,
  type ReceivableRow,
  type RecordSource,
} from "./admin_pack_model";

const MAX_VISIT_ACTIVITIES = 100;
/** Visits whose late sync was rejected do not count, as in every other SFA report. */
const COUNTED_LATE_STATUSES = [
  undefined,
  "pending_review",
  "accepted",
] as const;

const unitOption = v.object({
  id: v.id("orgUnits"),
  code: v.string(),
  name: v.string(),
});

type PackRow<K extends PackKind> = Extract<
  Doc<"adminPackRecords">,
  { kind: K }
>;

/** One kind's rows for a month, source-picked, then limited to the selected units. */
async function records<K extends PackKind>(
  ctx: QueryCtx,
  sc: SupervisorContext,
  kind: K,
  period: string,
): Promise<{ rows: PackRow<K>[]; source: RecordSource; truncated: boolean }> {
  const all = await ctx.db
    .query("adminPackRecords")
    .withIndex("by_organizationId_and_kind_and_period", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("kind", kind)
        .eq("period", period),
    )
    .take(MAX_PACK_RECORDS + 1);
  const truncated = all.length > MAX_PACK_RECORDS;
  // The source switch is organization-wide: once the office loads a kind for the month, no
  // reader anywhere sees that kind's sample rows.
  const picked = pickSource(all.slice(0, MAX_PACK_RECORDS) as PackRow<K>[]);
  return {
    rows: picked.rows.filter((row) => sc.units.has(row.orgUnitId)),
    source: picked.source,
    truncated,
  };
}

type UnitUse = {
  stores: Set<Id<"outlets">>;
  executed: number;
  notExecuted: number;
};

/**
 * Promotion checks per allocated programme over the month, in the selected units, kept per
 * visit unit so each allocation counts only its own unit's subtree.
 */
async function programUse(
  ctx: QueryCtx,
  sc: SupervisorContext,
  month: string,
  refs: Set<string>,
) {
  const use = new Map<string, Map<Id<"orgUnits">, UnitUse>>();
  if (!refs.size) return { use, truncated: false };
  const first = `${month}-01`;
  const last = `${month}-31`;
  let budget = MAX_MONTH_VISITS;
  let truncated = false;
  for (const unitId of sc.units) {
    for (const status of COUNTED_LATE_STATUSES) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const visits = await ctx.db
        .query("visitExecutions")
        .withIndex("by_orgUnitId_and_lateReviewStatus_and_serviceDate", (q) =>
          q
            .eq("orgUnitId", unitId)
            .eq("lateReviewStatus", status)
            .gte("serviceDate", first)
            .lte("serviceDate", last),
        )
        .take(budget + 1);
      if (visits.length > budget) truncated = true;
      const counted = visits.slice(0, budget);
      budget -= counted.length;
      for (const visit of counted) {
        if (!DONE_STATES.has(visit.state)) continue;
        const activities = await ctx.db
          .query("visitActivities")
          .withIndex("by_visitId_and_serverTime", (q) =>
            q.eq("visitId", visit._id),
          )
          .take(MAX_VISIT_ACTIVITIES);
        for (const row of activities) {
          if (row.activity.kind !== "promotion") continue;
          const ref = row.activity.programRef.trim();
          if (!refs.has(ref)) continue;
          const byUnit = use.get(ref) ?? new Map<Id<"orgUnits">, UnitUse>();
          use.set(ref, byUnit);
          const tally = byUnit.get(unitId) ?? {
            stores: new Set(),
            executed: 0,
            notExecuted: 0,
          };
          byUnit.set(unitId, tally);
          if (row.activity.finding === "executed") {
            tally.executed++;
            tally.stores.add(visit.outletId);
          } else if (row.activity.finding === "not_executed")
            tally.notExecuted++;
        }
      }
    }
  }
  return { use, truncated };
}

/** Unit ids of `root`'s current subtree, from the current organization tree. */
async function subtrees(ctx: QueryCtx) {
  const tree = await topology(ctx, Date.now());
  const children = new Map<Id<"orgUnits">, Id<"orgUnits">[]>();
  for (const unit of tree)
    if (unit.parentId)
      children.set(unit.parentId, [
        ...(children.get(unit.parentId) ?? []),
        unit._id,
      ]);
  return (root: Id<"orgUnits">) => {
    const ids = [root];
    for (let i = 0; i < ids.length; i++)
      ids.push(...(children.get(ids[i]!) ?? []));
    return new Set(ids);
  };
}

/** Field collections against one account from its balance date to the month's end. */
async function accountCollections(
  ctx: QueryCtx,
  sc: SupervisorContext,
  customerId: Id<"customers">,
  from: number,
  to: number,
) {
  const rows = await ctx.db
    .query("fieldCollections")
    .withIndex("by_customerId_and_serverTime", (q) =>
      q
        .eq("customerId", customerId)
        .gte("serverTime", from)
        .lt("serverTime", to),
    )
    .take(MAX_ACCOUNT_COLLECTIONS + 1);
  let collectedMinor = 0;
  let pendingReviewMinor = 0;
  for (const row of rows.slice(0, MAX_ACCOUNT_COLLECTIONS)) {
    if (!sc.units.has(row.orgUnitId) || row.status === "rejected") continue;
    if (row.status === "recorded") collectedMinor += Number(row.amountMinor);
    else pendingReviewMinor += Number(row.amountMinor);
  }
  return {
    collectedMinor,
    pendingReviewMinor,
    truncated: rows.length > MAX_ACCOUNT_COLLECTIONS,
  };
}

export const month = query({
  args: {
    month: v.string(),
    orgUnitId: v.optional(v.id("orgUnits")),
  },
  returns: v.object({
    month: v.string(),
    units: v.array(unitOption),
    sources: v.object({
      allocations: recordSource,
      priorities: recordSource,
      claims: recordSource,
      receivables: recordSource,
    }),
    allocations: v.array(allocationRow),
    priorities: v.array(
      v.object({
        code: v.string(),
        source: v.union(v.literal("sample"), v.literal("office")),
        docType: priorityDocType,
        title: v.string(),
        accountName: v.string(),
        ownerName: v.string(),
        dueDate: v.string(),
        status: priorityStatus,
        submittedDate: v.union(v.string(), v.null()),
      }),
    ),
    claims: v.array(
      v.object({
        code: v.string(),
        source: v.union(v.literal("sample"), v.literal("office")),
        partnerCode: v.string(),
        partnerName: v.string(),
        claimType,
        claimRef: v.string(),
        filedDate: v.string(),
        claimedMinor: v.number(),
        approvedMinor: v.union(v.number(), v.null()),
        status: claimStatus,
      }),
    ),
    receivables: v.array(receivableRow),
    /** A source hit a read cap: the affected report is incomplete and must not be exported. */
    truncated: v.object({
      allocations: v.boolean(),
      priorities: v.boolean(),
      claims: v.boolean(),
      receivables: v.boolean(),
    }),
  }),
  handler: async (ctx, args) => {
    const { from, to } = monthBounds(args.month);
    const sc = await supervisorContext(ctx, {
      serviceDate: `${args.month}-01`,
      ...(args.orgUnitId ? { orgUnitId: args.orgUnitId } : {}),
    });
    await requireCapability(ctx, "report.read");

    const allocationRecords = await records(
      ctx,
      sc,
      "program_allocation",
      args.month,
    );
    const priorityRecords = await records(
      ctx,
      sc,
      "priority_document",
      args.month,
    );
    const claimRecords = await records(ctx, sc, "adp_claim", args.month);
    const balanceRecords = await records(ctx, sc, "ar_balance", args.month);

    const refs = new Set(
      allocationRecords.rows.map((row) => row.programRef.trim()),
    );
    const usage = await programUse(ctx, sc, args.month, refs);
    const subtree = await subtrees(ctx);
    // Each allocation counts the programme's use inside its own unit's subtree (and inside
    // the reader's selection), so two regions' allocations of one programme stay apart.
    const allocations: AllocationRow[] = allocationRecords.rows
      .map((row) => {
        const units = subtree(row.orgUnitId);
        const tally = {
          stores: new Set<Id<"outlets">>(),
          executed: 0,
          notExecuted: 0,
        };
        for (const [unitId, part] of usage.use.get(row.programRef.trim()) ?? [])
          if (units.has(unitId)) {
            for (const store of part.stores) tally.stores.add(store);
            tally.executed += part.executed;
            tally.notExecuted += part.notExecuted;
          }
        return {
          code: row.code,
          source: row.source,
          orgUnitId: row.orgUnitId,
          programRef: row.programRef.trim(),
          programName: row.programName,
          allocatedStores: row.allocatedStores,
          budgetMinor: row.budgetMinor,
          executedStores: tally.stores.size,
          executedChecks: tally.executed,
          notExecutedChecks: tally.notExecuted,
        };
      })
      .sort(
        (a, b) =>
          a.programRef.localeCompare(b.programRef) ||
          a.code.localeCompare(b.code),
      );

    const receivables: ReceivableRow[] = [];
    let receivablesTruncated = balanceRecords.truncated;
    for (const row of balanceRecords.rows) {
      const customer = await ctx.db
        .query("customers")
        .withIndex("by_code", (q) => q.eq("code", row.customerCode))
        .first();
      const since = Math.max(localDate(row.asOfDate), from);
      const field = customer
        ? await accountCollections(ctx, sc, customer._id, since, to)
        : { collectedMinor: 0, pendingReviewMinor: 0, truncated: false };
      if (field.truncated) receivablesTruncated = true;
      receivables.push({
        code: row.code,
        source: row.source,
        orgUnitId: row.orgUnitId,
        customerCode: row.customerCode,
        customerName: row.customerName,
        asOfDate: row.asOfDate,
        termsDays: row.termsDays,
        currentMinor: row.currentMinor,
        days1to30Minor: row.days1to30Minor,
        days31to60Minor: row.days31to60Minor,
        days61to90Minor: row.days61to90Minor,
        over90Minor: row.over90Minor,
        collectedMinor: field.collectedMinor,
        pendingReviewMinor: field.pendingReviewMinor,
        customerFound: customer !== null,
      });
    }
    receivables.sort((a, b) => a.customerCode.localeCompare(b.customerCode));

    return {
      month: args.month,
      units: sc.unitOptions,
      sources: {
        allocations: allocationRecords.source,
        priorities: priorityRecords.source,
        claims: claimRecords.source,
        receivables: balanceRecords.source,
      },
      allocations,
      priorities: priorityRecords.rows
        .map((row) => ({
          code: row.code,
          source: row.source,
          docType: row.docType,
          title: row.title,
          accountName: row.accountName,
          ownerName: row.ownerName,
          dueDate: row.dueDate,
          status: row.status,
          submittedDate: row.submittedDate,
        }))
        .sort(
          (a, b) =>
            a.dueDate.localeCompare(b.dueDate) || a.code.localeCompare(b.code),
        ),
      claims: claimRecords.rows
        .map((row) => ({
          code: row.code,
          source: row.source,
          partnerCode: row.partnerCode,
          partnerName: row.partnerName,
          claimType: row.claimType,
          claimRef: row.claimRef,
          filedDate: row.filedDate,
          claimedMinor: row.claimedMinor,
          approvedMinor: row.approvedMinor,
          status: row.status,
        }))
        .sort(
          (a, b) =>
            a.partnerCode.localeCompare(b.partnerCode) ||
            a.filedDate.localeCompare(b.filedDate),
        ),
      receivables,
      truncated: {
        allocations: allocationRecords.truncated || usage.truncated,
        priorities: priorityRecords.truncated,
        claims: claimRecords.truncated,
        receivables: receivablesTruncated,
      },
    };
  },
});
