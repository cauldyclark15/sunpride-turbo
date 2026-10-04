/* Sales targets (CVX-017): set, end and read effective-dated targets for an employee, a
 * team or a territory. Access follows the subject's CURRENT organizational unit (ADR-005):
 * an employee's current assignment, a team's unit, or a territory's current owner.
 * Period and value rules live in ./model.ts.
 */
import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import schema from "../schema";
import { requireCapability, type Capability } from "../lib/capabilities";
import { rootOrgUnitId } from "../lib/scope";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { activeAt, audit } from "../org/validation";
import { requireTerritoryCapability } from "../territories/validation";
import {
  assertPeriodBoundary,
  assertTargetValue,
  boundedText,
  inEffect,
  manilaPeriodStart,
  MAX_NOTES,
  MAX_SOURCE_REF,
  targetAt,
  targetMetricValidator,
  targetPeriodValidator,
  targetSubjectValidator,
  type TargetMetric,
  type TargetPeriod,
  type TargetSubject,
} from "./model";

type Ctx = QueryCtx | MutationCtx;
type Target = Doc<"salesTargets">;

export const MAX_TARGET_HISTORY = 200;
const MAX_ASSIGNMENT_HISTORY = 50;

function subjectOf(row: Target): TargetSubject {
  if (row.subjectKind === "employee" && row.profileId)
    return { kind: "employee", profileId: row.profileId };
  if (row.subjectKind === "team" && row.teamId)
    return { kind: "team", teamId: row.teamId };
  if (row.subjectKind === "territory" && row.territoryId)
    return { kind: "territory", territoryId: row.territoryId };
  throw new ConvexError("Target has no subject");
}

function subjectFields(subject: TargetSubject) {
  switch (subject.kind) {
    case "employee":
      return { subjectKind: "employee" as const, profileId: subject.profileId };
    case "team":
      return { subjectKind: "team" as const, teamId: subject.teamId };
    case "territory":
      return {
        subjectKind: "territory" as const,
        territoryId: subject.territoryId,
      };
  }
}

async function employeeUnit(ctx: Ctx, profile: Doc<"profiles">) {
  const now = Date.now();
  const assignments = await ctx.db
    .query("employeeAssignments")
    .withIndex("by_profileId_and_effectiveFrom", (q) =>
      q.eq("profileId", profile._id).lte("effectiveFrom", now),
    )
    .order("desc")
    .take(MAX_ASSIGNMENT_HISTORY);
  const current = assignments.find((row) =>
    activeAt(row.effectiveFrom, row.effectiveTo, now),
  );
  return current?.orgUnitId ?? profile.orgUnitId ?? null;
}

/**
 * Gates `capability` at the subject's current unit. An employee with no unit falls back to
 * the national root, so only national callers may touch an unassigned person's targets.
 */
async function requireSubjectAccess(
  ctx: Ctx,
  subject: TargetSubject,
  capability: Capability,
) {
  switch (subject.kind) {
    case "employee": {
      const person = await ctx.db.get(subject.profileId);
      if (!person) throw new ConvexError("Employee not found");
      const unit =
        (await employeeUnit(ctx, person)) ?? (await rootOrgUnitId(ctx));
      if (!unit) throw new ConvexError("Employee has no organizational scope");
      return {
        ...(await requireCapability(ctx, capability, unit)),
        subjectActiveAt: () => person.status === "active",
      };
    }
    case "team": {
      const team = await ctx.db.get(subject.teamId);
      if (!team) throw new ConvexError("Team not found");
      return {
        ...(await requireCapability(ctx, capability, team.orgUnitId)),
        subjectActiveAt: (at: number) =>
          team.status === "active" &&
          activeAt(team.effectiveFrom, team.effectiveTo, at),
      };
    }
    case "territory": {
      const { identity, profile, territory } = await requireTerritoryCapability(
        ctx,
        capability,
        subject.territoryId,
      );
      return {
        identity,
        profile,
        subjectActiveAt: (at: number) =>
          territory.status === "active" &&
          activeAt(territory.effectiveFrom, territory.effectiveTo, at),
      };
    }
  }
}

/** A person never sets or ends their own target; super admin is the bootstrap exception. */
function assertNotSelf(subject: TargetSubject, caller: Doc<"profiles">) {
  if (
    subject.kind === "employee" &&
    subject.profileId === caller._id &&
    caller.role !== "super_admin"
  )
    throw new ConvexError("You cannot set your own target");
}

async function bounded(rows: Promise<Target[]>) {
  const list = await rows;
  if (list.length > MAX_TARGET_HISTORY)
    throw new ConvexError("Target history exceeds limit");
  return list;
}

/** Every row of one subject+period+metric, newest first. */
async function keyRows(
  ctx: Ctx,
  subject: TargetSubject,
  period: TargetPeriod,
  metric: TargetMetric,
) {
  const take = MAX_TARGET_HISTORY + 1;
  switch (subject.kind) {
    case "employee":
      return bounded(
        ctx.db
          .query("salesTargets")
          .withIndex(
            "by_profileId_and_period_and_metric_and_effectiveFrom",
            (q) =>
              q
                .eq("profileId", subject.profileId)
                .eq("period", period)
                .eq("metric", metric),
          )
          .order("desc")
          .take(take),
      );
    case "team":
      return bounded(
        ctx.db
          .query("salesTargets")
          .withIndex("by_teamId_and_period_and_metric_and_effectiveFrom", (q) =>
            q
              .eq("teamId", subject.teamId)
              .eq("period", period)
              .eq("metric", metric),
          )
          .order("desc")
          .take(take),
      );
    case "territory":
      return bounded(
        ctx.db
          .query("salesTargets")
          .withIndex(
            "by_territoryId_and_period_and_metric_and_effectiveFrom",
            (q) =>
              q
                .eq("territoryId", subject.territoryId)
                .eq("period", period)
                .eq("metric", metric),
          )
          .order("desc")
          .take(take),
      );
  }
}

/** Every row of one subject (all periods and metrics). */
async function subjectRows(ctx: Ctx, subject: TargetSubject) {
  const take = MAX_TARGET_HISTORY + 1;
  switch (subject.kind) {
    case "employee":
      return bounded(
        ctx.db
          .query("salesTargets")
          .withIndex(
            "by_profileId_and_period_and_metric_and_effectiveFrom",
            (q) => q.eq("profileId", subject.profileId),
          )
          .take(take),
      );
    case "team":
      return bounded(
        ctx.db
          .query("salesTargets")
          .withIndex("by_teamId_and_period_and_metric_and_effectiveFrom", (q) =>
            q.eq("teamId", subject.teamId),
          )
          .take(take),
      );
    case "territory":
      return bounded(
        ctx.db
          .query("salesTargets")
          .withIndex(
            "by_territoryId_and_period_and_metric_and_effectiveFrom",
            (q) => q.eq("territoryId", subject.territoryId),
          )
          .take(take),
      );
  }
}

/** A cancelled (zero-length) row is history only; it never covers an instant. */
function cancelled(row: Target) {
  return row.effectiveTo === row.effectiveFrom;
}

/**
 * The target in effect for one subject, period and metric at `instant`, or null. For
 * report code: the caller must already have authorized the subject.
 */
export async function subjectTargetAt(
  ctx: Ctx,
  subject: TargetSubject,
  period: TargetPeriod,
  metric: TargetMetric,
  instant: number,
) {
  return targetAt(await keyRows(ctx, subject, period, metric), instant);
}

/**
 * Sets a target from `effectiveFrom` (a Manila midnight for daily, a Manila month start for
 * monthly) until `effectiveTo` or open-ended. A target already in effect at the new start is
 * closed there (history kept). Changes are future-effective; the one exception is the first
 * target of a key, which may start at the current day or month so go-live needs no wait.
 */
export const set = mutation({
  args: {
    subject: targetSubjectValidator,
    period: targetPeriodValidator,
    metric: targetMetricValidator,
    value: v.number(),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    sourceRef: v.string(),
    notes: v.optional(v.string()),
    reason: v.string(),
  },
  returns: v.id("salesTargets"),
  handler: async (ctx, args) => {
    assertPeriodBoundary(args.period, args.effectiveFrom, "Start");
    if (args.effectiveTo !== undefined) {
      assertPeriodBoundary(args.period, args.effectiveTo, "End");
      if (args.effectiveTo <= args.effectiveFrom)
        throw new ConvexError("End must be after start");
    }
    assertTargetValue(args.value);
    const sourceRef = boundedText(
      args.sourceRef,
      "Source reference",
      MAX_SOURCE_REF,
      true,
    )!;
    const notes = boundedText(args.notes, "Notes", MAX_NOTES, false);
    const reason = boundedText(args.reason, "Reason", MAX_NOTES, true)!;

    const access = await requireSubjectAccess(
      ctx,
      args.subject,
      "target.manage",
    );
    assertNotSelf(args.subject, access.profile);
    if (!access.subjectActiveAt(args.effectiveFrom))
      throw new ConvexError("Target subject is not active at the start date");

    const now = Date.now();
    const rows = (
      await keyRows(ctx, args.subject, args.period, args.metric)
    ).filter((row) => !cancelled(row));
    const backfill = args.effectiveFrom < now;
    if (
      backfill &&
      (args.effectiveFrom !== manilaPeriodStart(args.period, now) ||
        rows.some(
          (row) =>
            row.effectiveTo === undefined ||
            row.effectiveTo > args.effectiveFrom,
        ))
    )
      throw new ConvexError("Changes must be future-effective");

    for (const row of rows) {
      if (
        row.effectiveFrom >= args.effectiveFrom &&
        (args.effectiveTo === undefined || row.effectiveFrom < args.effectiveTo)
      )
        throw new ConvexError(
          "A target is already scheduled in this period; end it first",
        );
    }
    for (const row of rows) {
      if (
        row.effectiveFrom < args.effectiveFrom &&
        (row.effectiveTo === undefined || row.effectiveTo > args.effectiveFrom)
      ) {
        await ctx.db.patch(row._id, {
          effectiveTo: args.effectiveFrom,
          updatedAt: now,
        });
        await audit(
          ctx,
          access.identity.tokenIdentifier,
          "salesTarget.superseded",
          "salesTarget",
          row._id,
          reason,
          now,
        );
      }
    }

    const targetId = await ctx.db.insert("salesTargets", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      ...subjectFields(args.subject),
      period: args.period,
      metric: args.metric,
      value: args.value,
      effectiveFrom: args.effectiveFrom,
      effectiveTo: args.effectiveTo,
      sourceRef,
      notes,
      createdBy: access.identity.tokenIdentifier,
      createdAt: now,
      updatedAt: now,
    });
    await audit(
      ctx,
      access.identity.tokenIdentifier,
      "salesTarget.set",
      "salesTarget",
      targetId,
      reason,
      now,
    );
    return targetId;
  },
});

/**
 * Ends a target at a future period boundary. Ending a not-yet-started target at its own start
 * cancels it: the row stays as a zero-length audited record.
 */
export const end = mutation({
  args: {
    targetId: v.id("salesTargets"),
    effectiveTo: v.number(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.targetId);
    if (!row || row.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("Target not found");
    const subject = subjectOf(row);
    const access = await requireSubjectAccess(ctx, subject, "target.manage");
    assertNotSelf(subject, access.profile);
    const reason = boundedText(args.reason, "Reason", MAX_NOTES, true)!;

    const now = Date.now();
    assertPeriodBoundary(row.period, args.effectiveTo, "End");
    if (args.effectiveTo < now)
      throw new ConvexError("Changes must be future-effective");
    if (row.effectiveTo !== undefined && row.effectiveTo <= now)
      throw new ConvexError("Target has already ended");
    if (args.effectiveTo < row.effectiveFrom)
      throw new ConvexError("End must not be before the target's start");
    if (row.effectiveTo !== undefined && args.effectiveTo >= row.effectiveTo)
      throw new ConvexError("End must be earlier than the current end");

    await ctx.db.patch(row._id, {
      effectiveTo: args.effectiveTo,
      updatedAt: now,
    });
    await audit(
      ctx,
      access.identity.tokenIdentifier,
      args.effectiveTo === row.effectiveFrom
        ? "salesTarget.cancelled"
        : "salesTarget.ended",
      "salesTarget",
      row._id,
      reason,
      now,
    );
    return null;
  },
});

/**
 * One subject's target history (newest start first) and the targets in effect at `asOf`.
 * Sales may read only their own employee targets.
 */
export const list = query({
  args: { subject: targetSubjectValidator, asOf: v.optional(v.number()) },
  returns: v.object({
    rows: v.array(schema.doc("salesTargets")),
    inEffect: v.array(schema.doc("salesTargets")),
  }),
  handler: async (ctx, args) => {
    const access = await requireSubjectAccess(ctx, args.subject, "report.read");
    if (
      access.profile.role === "sales" &&
      !(
        args.subject.kind === "employee" &&
        args.subject.profileId === access.profile._id
      )
    )
      throw new ConvexError("Sales can only read their own targets");
    const instant = args.asOf ?? Date.now();
    if (!Number.isSafeInteger(instant)) throw new ConvexError("Invalid date");
    const rows = (await subjectRows(ctx, args.subject)).sort(
      (a, b) =>
        b.effectiveFrom - a.effectiveFrom ||
        a.period.localeCompare(b.period) ||
        a.metric.localeCompare(b.metric),
    );
    return { rows, inEffect: rows.filter((row) => inEffect(row, instant)) };
  },
});
