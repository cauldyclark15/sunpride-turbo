import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { activeAt } from "../org/validation";
import { outletRows, resolveOutletScopeAt } from "../outlets/validation";
import { at } from "../territories/route_validation";
import { localDate, MAX_PLAN_ROWS, planAccess, planRows } from "./validation";
import {
  coordinateKey,
  severityFor,
  type ExceptionCode,
  type Severity,
} from "./exception_policy";

const codeValidator = v.union(
  v.literal("missing_gps"),
  v.literal("duplicate_location"),
  v.literal("territory_only"),
  v.literal("inactive_outlet"),
  v.literal("inactive_customer"),
  v.literal("conflicting_assignment"),
  v.literal("invalid_date"),
  v.literal("invalid_cadence"),
  v.literal("route_mismatch"),
);
const exception = v.object({
  code: codeValidator,
  severity: v.union(v.literal("blocking"), v.literal("advisory")),
  outletId: v.optional(v.id("outlets")),
  serviceDate: v.optional(v.string()),
  message: v.string(),
  remediation: v.string(),
  signedHistorical: v.boolean(),
});
export type ExceptionRow = {
  code: ExceptionCode;
  severity: Severity;
  outletId?: Id<"outlets">;
  serviceDate?: string;
  message: string;
  remediation: string;
  signedHistorical: boolean;
};
type Ctx = QueryCtx | MutationCtx;

/** Shared full preflight. It never truncates: a limit breach fails closed. */
export async function collectExceptions(
  ctx: Ctx,
  plan: Doc<"coveragePlans">,
  key: "mcp.read" | "mcp.approve",
): Promise<ExceptionRow[]> {
  await planAccess(ctx, plan, key);
  const { outlets, slots } = await planRows(ctx, plan._id);
  const ids = [
    ...new Set<Id<"outlets">>([
      ...outlets.map((o) => o.outletId),
      ...slots.flatMap((s) => (s.outletId ? [s.outletId] : [])),
    ]),
  ];
  // Authorize *all* plan content before producing a single row/count.
  for (const id of ids) {
    const current = await resolveOutletScopeAt(ctx, id, Date.now());
    await requireCapability(ctx, key, current.orgUnitId);
  }
  const signedHistorical = ["approved", "active", "superseded"].includes(
    plan.status,
  );
  // Signed plans are immutable historical evidence; do not infer exceptions from changed live master data.
  if (signedHistorical) return [];
  const result: ExceptionRow[] = [];
  const add = (
    code: ExceptionCode,
    message: string,
    remediation: string,
    outletId?: Id<"outlets">,
    serviceDate?: string,
  ) => {
    if (result.length >= MAX_PLAN_ROWS)
      throw new ConvexError("Plan exceptions exceed limit");
    result.push({
      code,
      severity: severityFor(code),
      message,
      remediation,
      outletId,
      serviceDate,
      signedHistorical,
    });
  };
  const points = new Map<string, Id<"outlets">>();
  for (const id of ids) {
    const outlet = await ctx.db.get(id);
    if (!outlet) throw new ConvexError("Plan outlet not found");
    const pins = await outletRows(ctx, "outletPins", id);
    const pin = at(
      pins.filter((p) => p.status === "verified"),
      Date.now(),
    );
    if (!pin)
      add(
        "missing_gps",
        `${outlet.code}: no current verified GPS pin`,
        "Request and verify an outlet pin",
        id,
      );
    else {
      const coordinate = coordinateKey(pin.latitude, pin.longitude);
      if (points.has(coordinate))
        add(
          "duplicate_location",
          `${outlet.code}: verified location duplicates another plan outlet`,
          "Review both verified pins",
          id,
        );
      else points.set(coordinate, id);
    }
  }
  for (const row of outlets) {
    if (row.frequency === "custom" && !row.customLocalDates.length)
      add(
        "invalid_cadence",
        "Custom cadence has no dates",
        "Edit the draft outlet cadence",
        row.outletId,
      );
    for (const date of row.customLocalDates) {
      try {
        const instant = localDate(date);
        if (instant < plan.effectiveFrom || instant >= plan.effectiveTo)
          throw new Error();
      } catch {
        add(
          "invalid_cadence",
          `Cadence date ${date} outside plan`,
          "Edit draft cadence dates",
          row.outletId,
        );
      }
    }
  }
  for (const slot of slots) {
    let instant: number;
    try {
      instant = localDate(slot.serviceDate);
    } catch {
      add(
        "invalid_date",
        `Invalid service date ${slot.serviceDate}`,
        "Choose a valid Manila date",
        slot.outletId,
        slot.serviceDate,
      );
      continue;
    }
    if (instant < plan.effectiveFrom || instant >= plan.effectiveTo)
      add(
        "invalid_date",
        `Slot outside plan period: ${slot.serviceDate}`,
        "Move slot into plan period",
        slot.outletId,
        slot.serviceDate,
      );
    if (slot.kind !== "outlet_visit") continue;
    if (!slot.outletId) {
      add(
        "invalid_date",
        "Visit has no outlet",
        "Select an outlet",
        undefined,
        slot.serviceDate,
      );
      continue;
    }
    const outlet = await ctx.db.get(slot.outletId);
    if (!outlet || outlet.status === "inactive")
      add(
        "inactive_outlet",
        "Outlet is inactive or missing",
        "Reactivate or remove the draft visit",
        slot.outletId,
        slot.serviceDate,
      );
    const assignments = await outletRows(
      ctx,
      "outletAssignments",
      slot.outletId,
    );
    const active = assignments.filter((a) =>
      activeAt(a.effectiveFrom, a.effectiveTo, instant),
    );
    if (active.length !== 1)
      add(
        "conflicting_assignment",
        "Outlet has no unique effective assignment",
        "Correct overlapping or missing territory assignment",
        slot.outletId,
        slot.serviceDate,
      );
    const assignment = active[0];
    if (assignment && !assignment.routeId && !slot.routeId)
      add(
        "territory_only",
        "Territory-only visit without route",
        "Optionally assign an ordered route",
        slot.outletId,
        slot.serviceDate,
      );
    if (assignment && slot.routeId !== assignment.routeId)
      add(
        "route_mismatch",
        "Slot route differs from effective outlet route",
        "Align draft route and outlet assignment",
        slot.outletId,
        slot.serviceDate,
      );
    const links = await outletRows(ctx, "outletCustomerLinks", slot.outletId);
    const link = at(links, instant);
    if (link) {
      const customer = await ctx.db.get(link.customerId);
      if (!customer?.active)
        add(
          "inactive_customer",
          "Linked local customer is inactive or missing",
          "Repair the local customer link or reactivate customer",
          slot.outletId,
          slot.serviceDate,
        );
    }
  }
  return result;
}

export async function assertNoBlockingExceptions(
  ctx: MutationCtx,
  planId: Id<"coveragePlans">,
): Promise<void> {
  const plan = await ctx.db.get(planId);
  if (!plan) throw new ConvexError("Plan not found");
  const first = (await collectExceptions(ctx, plan, "mcp.approve")).find(
    (row) => row.severity === "blocking",
  );
  if (first)
    throw new ConvexError(
      `Blocking coverage exception: ${first.code}: ${first.message}`,
    );
}

export const forPlan = query({
  args: {
    planId: v.id("coveragePlans"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(exception),
  handler: async (ctx, { planId, paginationOpts }) => {
    if (
      !Number.isSafeInteger(paginationOpts.numItems) ||
      paginationOpts.numItems < 1 ||
      paginationOpts.numItems > 20
    )
      throw new ConvexError("Page size must be 1–20");
    const plan = await ctx.db.get(planId);
    if (!plan) throw new ConvexError("Plan not found");
    const rows = await collectExceptions(ctx, plan, "mcp.read");
    const start =
      paginationOpts.cursor === null ? 0 : Number(paginationOpts.cursor);
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start > rows.length ||
      (paginationOpts.cursor !== null &&
        String(start) !== paginationOpts.cursor)
    )
      throw new ConvexError("Invalid exception cursor");
    const end = Math.min(rows.length, start + paginationOpts.numItems);
    return {
      page: rows.slice(start, end),
      isDone: end === rows.length,
      continueCursor: String(end),
    };
  },
});
