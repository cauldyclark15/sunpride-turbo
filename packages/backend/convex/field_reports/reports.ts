import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireActiveProfile } from "../lib/auth";
import { requireCapability } from "../lib/capabilities";
import { activeAt } from "../org/validation";
import {
  evaluateProductiveCall,
  productiveCodesFromVisitRecords,
  summarizeCalls,
  type CallEvaluation,
} from "../sfa/productive_call";
import { DEFAULT_SELLING_WEEKDAYS, isSellingDay } from "../sfa/selling_days";
import { standardAt, standardsFor } from "../sfa/standards";
import {
  supervisorContext,
  type SupervisorContext,
} from "../supervision/access";
import { DONE_STATES, MAX_DAY_ROWS, MAX_PEOPLE } from "../supervision/model";
import {
  completenessOf,
  completenessStatus,
  datesEndingAt,
  FIELD_REPORT_SOURCE,
  fieldMinutes,
  fieldReportKind,
  fieldReportSummary,
  isServiceDate,
  MAX_COMPLETENESS_DAYS,
  MAX_REMARKS,
  MAX_REVISIONS,
  orderStops,
  reportDueAt,
  reportKindFor,
  submitWindowError,
  type FieldReportKind,
  type FieldReportSummary,
} from "./model";

/**
 * SOP-009 DAR / ROAR. A filer (a DAR or ROAR position) reads their generated report for a
 * Manila service date and submits it with remarks; supervisors (`people.read` +
 * `visit.read`, inside their scope) read any filer's report and the per-person, per-day
 * submission completeness. See `docs/architecture/FIELD_ACTIVITY_REPORTS.md`.
 */

type Ctx = QueryCtx | MutationCtx;
const MAX_VISIT_ROWS = 100;
const MAX_NOTES = 3;
const MAX_NOTE_CHARS = 200;
const MAX_WORK_WITH = 20;

const nullableNumber = v.union(v.number(), v.null());
const nullableString = v.union(v.string(), v.null());

const stopValidator = v.object({
  key: v.string(),
  outletCode: v.string(),
  outletName: v.string(),
  routeCode: nullableString,
  sequence: nullableNumber,
  source: v.union(
    v.literal("planned"),
    v.literal("unplanned"),
    v.literal("not_visited"),
  ),
  state: v.string(),
  callStatus: v.string(),
  matchedCodes: v.array(v.string()),
  activityKinds: v.array(v.string()),
  collections: v.number(),
  reasonCode: nullableString,
  notes: v.array(v.string()),
  checkedInAt: nullableNumber,
  checkedOutAt: nullableNumber,
  callMinutes: nullableNumber,
});
type Stop = typeof stopValidator.type;

const submissionValidator = v.object({
  revision: v.number(),
  remarks: v.string(),
  summary: fieldReportSummary,
  submittedAt: v.number(),
  firstSubmittedAt: v.number(),
  submittedByName: v.string(),
});

const reportValidator = v.object({
  kind: fieldReportKind,
  serviceDate: v.string(),
  sellingDay: v.boolean(),
  dueAt: v.number(),
  canSubmit: v.boolean(),
  submitBlockedReason: nullableString,
  status: completenessStatus,
  sourceRef: v.string(),
  person: v.object({
    profileId: v.id("profiles"),
    name: v.string(),
    employeeCode: nullableString,
    positionCode: v.string(),
    positionLabel: v.string(),
    unitName: nullableString,
  }),
  standard: v.union(
    v.object({
      dailyCallsTarget: nullableNumber,
      productiveCallTargetPct: nullableNumber,
      sourceRef: v.string(),
    }),
    v.null(),
  ),
  summary: fieldReportSummary,
  callsTargetMet: v.union(v.boolean(), v.null()),
  productiveTargetMet: v.union(v.boolean(), v.null()),
  routes: v.array(
    v.object({
      routeCode: nullableString,
      routeName: nullableString,
      calls: v.number(),
      productiveCalls: v.number(),
      productivePct: nullableNumber,
    }),
  ),
  stops: v.array(stopValidator),
  workWith: v.array(
    v.object({
      sessionId: v.id("workWithSessions"),
      traineeName: v.string(),
      objective: v.string(),
      mode: v.string(),
      status: v.string(),
      mcpPlanned: nullableNumber,
      mcpDone: nullableNumber,
    }),
  ),
  submission: v.union(submissionValidator, v.null()),
  revisions: v.number(),
});
type Report = typeof reportValidator.type;

/** The one employee assignment in force at the instant, if any. */
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
    .take(50);
  const current = rows.filter((row) =>
    activeAt(row.effectiveFrom, row.effectiveTo, instant),
  );
  return current.length === 1 ? current[0]! : null;
}

type Filer = {
  profile: Doc<"profiles">;
  assignment: Doc<"employeeAssignments"> | null;
  position: Doc<"positions">;
  kind: FieldReportKind;
  orgUnitId: Id<"orgUnits"> | null;
};

/** The person's current position decides whether they file a DAR, a ROAR or neither. */
async function filerOf(
  ctx: Ctx,
  profile: Doc<"profiles">,
): Promise<Filer | null> {
  const assignment = await assignmentAt(ctx, profile._id, Date.now());
  const positionId = assignment?.positionId ?? profile.positionId;
  const position = positionId ? await ctx.db.get(positionId) : null;
  const kind = reportKindFor(position?.code);
  if (!position || !kind) return null;
  return {
    profile,
    assignment,
    position,
    kind,
    orgUnitId: assignment?.orgUnitId ?? profile.orgUnitId ?? null,
  };
}

async function revisionsOf(
  ctx: Ctx,
  profileId: Id<"profiles">,
  serviceDate: string,
) {
  return await ctx.db
    .query("fieldDayReports")
    .withIndex("by_profileId_and_serviceDate_and_revision", (q) =>
      q.eq("profileId", profileId).eq("serviceDate", serviceDate),
    )
    .take(MAX_REVISIONS + 1);
}

async function standardFor(ctx: Ctx, filer: Filer, serviceDate: string) {
  const noon = Date.parse(`${serviceDate}T12:00:00+08:00`);
  return standardAt(await standardsFor(ctx, filer.position._id), noon);
}

/**
 * Generates the report from the day's records: planned stops (the signed MCP snapshot),
 * visits with their activities and collections judged by the productive-call rule, and,
 * for a DAR, the Work-With sessions the filer ran. `scope` limits visits to a supervisor's
 * scope; the filer's own read passes null.
 */
async function generate(
  ctx: Ctx,
  filer: Filer,
  serviceDate: string,
  scope: ReadonlySet<Id<"orgUnits">> | null,
) {
  const standard = await standardFor(ctx, filer, serviceDate);
  const rule = standard?.productiveCallRule ?? "any_listed_activity";
  const sellingDay = isSellingDay(
    serviceDate,
    standard?.sellingWeekdays ?? DEFAULT_SELLING_WEEKDAYS,
  );
  const inScope = (unit: Id<"orgUnits">) => !scope || scope.has(unit);
  const planned = (
    await ctx.db
      .query("plannedVisits")
      .withIndex("by_assigneeProfileId_and_serviceDate", (q) =>
        q
          .eq("assigneeProfileId", filer.profile._id)
          .eq("serviceDate", serviceDate),
      )
      .take(MAX_DAY_ROWS)
  ).filter(
    (row) =>
      row.status === "planned" && inScope(row.approvedSnapshot.orgUnitId),
  );
  const plannedById = new Map(planned.map((row) => [row._id as string, row]));
  const visits = (
    await ctx.db
      .query("visitExecutions")
      .withIndex(
        "by_organizationId_and_assigneeProfileId_and_serviceDate",
        (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("assigneeProfileId", filer.profile._id)
            .eq("serviceDate", serviceDate),
      )
      .take(MAX_DAY_ROWS)
  ).filter((visit) => inScope(visit.orgUnitId));

  const routes = new Map<string, { code: string; name: string } | null>();
  const routeOf = async (routeId: Id<"routes"> | undefined) => {
    if (!routeId) return null;
    if (!routes.has(routeId)) {
      const route = await ctx.db.get(routeId);
      routes.set(
        routeId,
        route ? { code: route.code, name: route.name } : null,
      );
    }
    return routes.get(routeId) ?? null;
  };

  const stops: Stop[] = [];
  const scored: { routeId: string | null; evaluation: CallEvaluation }[] = [];
  const visitedPlans = new Set<string>();
  for (const visit of visits) {
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
    const snapshot = visit.plannedVisitId
      ? plannedById.get(visit.plannedVisitId)?.approvedSnapshot
      : undefined;
    const evaluation = evaluateProductiveCall({
      rule,
      inRoutePlan: visit.source === "planned" && !!visit.plannedVisitId,
      state: visit.state,
      codes: recorded.codes,
      noSalesDueToInventory: recorded.noSalesDueToInventory,
    });
    if (visit.plannedVisitId) visitedPlans.add(visit.plannedVisitId);
    scored.push({ routeId: visit.routeId ?? null, evaluation });
    const outlet = snapshot ? null : await ctx.db.get(visit.outletId);
    const route = await routeOf(visit.routeId);
    const notes = activities.flatMap((row) =>
      row.activity.kind === "note"
        ? [row.activity.text.trim().slice(0, MAX_NOTE_CHARS)]
        : [],
    );
    const start = visit.startedAt ?? visit.checkedInAt;
    const end = visit.endedAt ?? visit.checkedOutAt;
    stops.push({
      key: visit._id,
      outletCode: snapshot?.outletCode ?? outlet?.code ?? "—",
      outletName: snapshot?.outletName ?? outlet?.name ?? "Unknown outlet",
      routeCode: route?.code ?? null,
      sequence: snapshot?.sequence ?? null,
      source: visit.source,
      state: visit.state,
      callStatus: evaluation.status,
      matchedCodes: evaluation.matchedCodes,
      activityKinds: [...new Set(activities.map((row) => row.activity.kind))],
      collections: collections.length,
      reasonCode: visit.reasonCode ?? null,
      notes: notes.filter(Boolean).slice(0, MAX_NOTES),
      checkedInAt: visit.checkedInAt ?? null,
      checkedOutAt: visit.checkedOutAt ?? null,
      callMinutes:
        visit.callDurationMs !== undefined
          ? Math.round(visit.callDurationMs / 60_000)
          : start !== undefined && end !== undefined && end >= start
            ? Math.round((end - start) / 60_000)
            : null,
    });
  }
  for (const row of planned) {
    if (visitedPlans.has(row._id)) continue;
    stops.push({
      key: row._id,
      outletCode: row.approvedSnapshot.outletCode,
      outletName: row.approvedSnapshot.outletName,
      routeCode: null,
      sequence: row.approvedSnapshot.sequence ?? null,
      source: "not_visited",
      state: "planned",
      callStatus: "not_visited",
      matchedCodes: [],
      activityKinds: [],
      collections: 0,
      reasonCode: null,
      notes: [],
      checkedInAt: null,
      checkedOutAt: null,
      callMinutes: null,
    });
  }

  const workWith: Report["workWith"] = [];
  if (filer.kind === "dar") {
    const sessions = (
      await ctx.db
        .query("workWithSessions")
        .withIndex("by_trainerProfileId_and_serviceDate", (q) =>
          q
            .eq("trainerProfileId", filer.profile._id)
            .eq("serviceDate", serviceDate),
        )
        .take(MAX_WORK_WITH)
    ).filter((row) => row.status !== "cancelled" && inScope(row.orgUnitId));
    for (const session of sessions) {
      const trainee = await ctx.db.get(session.traineeProfileId);
      workWith.push({
        sessionId: session._id,
        traineeName: trainee?.name ?? "Former user",
        objective: session.objective,
        mode: session.mode,
        status: session.status,
        mcpPlanned: session.mcpPlanned ?? null,
        mcpDone: session.mcpDone ?? null,
      });
    }
  }

  const calls = summarizeCalls(scored.map((row) => row.evaluation));
  const checkIns = visits.flatMap((v) =>
    v.checkedInAt === undefined ? [] : [v.checkedInAt],
  );
  const checkOuts = visits.flatMap((v) =>
    v.checkedOutAt === undefined ? [] : [v.checkedOutAt],
  );
  const firstCheckInAt = checkIns.length ? Math.min(...checkIns) : null;
  const lastCheckOutAt = checkOuts.length ? Math.max(...checkOuts) : null;
  const plannedIds = new Set(planned.map((row) => row._id as string));
  const summary: FieldReportSummary = {
    planned: planned.length,
    plannedDone: new Set(
      visits
        .filter(
          (v) =>
            DONE_STATES.has(v.state) &&
            v.plannedVisitId !== undefined &&
            plannedIds.has(v.plannedVisitId),
        )
        .map((v) => v.plannedVisitId as string),
    ).size,
    notVisited: planned.filter((row) => !visitedPlans.has(row._id)).length,
    unplanned: visits.filter((v) => v.source === "unplanned").length,
    calls: calls.calls,
    productiveCalls: calls.productiveCalls,
    productivePct: calls.productivePct,
    workWithSessions: workWith.length,
    workWithCompleted: workWith.filter((row) => row.status === "completed")
      .length,
    firstCheckInAt,
    lastCheckOutAt,
    fieldMinutes: fieldMinutes(firstCheckInAt, lastCheckOutAt),
  };

  const dailyCallsTarget = standard?.dailyCallsTarget ?? null;
  const productiveCallTargetPct = standard?.productiveCallTargetPct ?? null;
  const routeIds = [...new Set(scored.map((row) => row.routeId))];
  const routeRows = [];
  for (const routeId of routeIds) {
    const route = routeId ? await routeOf(routeId as Id<"routes">) : null;
    const judged = summarizeCalls(
      scored
        .filter((row) => row.routeId === routeId)
        .map((row) => row.evaluation),
    );
    routeRows.push({
      routeCode: route?.code ?? null,
      routeName: route?.name ?? null,
      ...judged,
    });
  }
  return {
    sellingDay,
    standard:
      standard &&
      (dailyCallsTarget !== null || productiveCallTargetPct !== null)
        ? {
            dailyCallsTarget,
            productiveCallTargetPct,
            sourceRef: standard.sourceRef,
          }
        : null,
    summary,
    callsTargetMet:
      sellingDay && dailyCallsTarget !== null
        ? calls.calls >= dailyCallsTarget
        : null,
    productiveTargetMet:
      sellingDay &&
      productiveCallTargetPct !== null &&
      calls.productivePct !== null
        ? calls.productivePct >= productiveCallTargetPct
        : null,
    routes: routeRows,
    stops: orderStops(stops),
    workWith,
  };
}

async function nameOf(ctx: Ctx, subject: string) {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_subject", (q) => q.eq("authSubject", subject))
    .first();
  return profile?.name ?? "Former user";
}

async function buildReport(
  ctx: Ctx,
  filer: Filer,
  serviceDate: string,
  scope: ReadonlySet<Id<"orgUnits">> | null,
  self: boolean,
): Promise<Report> {
  const generated = await generate(ctx, filer, serviceDate, scope);
  const rows = await revisionsOf(ctx, filer.profile._id, serviceDate);
  const latest = rows.at(-1) ?? null;
  const first = rows[0] ?? null;
  const now = Date.now();
  const windowError = submitWindowError(serviceDate, now);
  const submitBlockedReason = !self
    ? "Only the filer submits their report"
    : (windowError ??
      (rows.length >= MAX_REVISIONS
        ? "This report has reached its correction limit"
        : null));
  const unit = filer.orgUnitId ? await ctx.db.get(filer.orgUnitId) : null;
  return {
    kind: filer.kind,
    serviceDate,
    dueAt: reportDueAt(serviceDate),
    canSubmit: submitBlockedReason === null,
    submitBlockedReason,
    status: completenessOf({
      serviceDate,
      sellingDay: generated.sellingDay,
      firstSubmittedAt: first?.submittedAt ?? null,
      now,
    }),
    sourceRef: FIELD_REPORT_SOURCE,
    person: {
      profileId: filer.profile._id,
      name: filer.profile.name,
      employeeCode: filer.profile.employeeCode ?? null,
      positionCode: filer.position.code,
      positionLabel: filer.position.label,
      unitName: unit?.name ?? null,
    },
    ...generated,
    submission:
      latest && first
        ? {
            revision: latest.revision,
            remarks: latest.remarks,
            summary: latest.summary,
            submittedAt: latest.submittedAt,
            firstSubmittedAt: first.submittedAt,
            submittedByName: await nameOf(ctx, latest.submittedBy),
          }
        : null,
    revisions: rows.length,
  };
}

/**
 * A filer's report for a Manila date. Without `profileId` (or with the caller's own id) it
 * is the caller's own report, and null when the caller's position files neither report.
 * Another person's report needs supervisor access and is limited to the caller's scope.
 */
export const day = query({
  args: { serviceDate: v.string(), profileId: v.optional(v.id("profiles")) },
  returns: v.union(reportValidator, v.null()),
  handler: async (ctx, args) => {
    if (!isServiceDate(args.serviceDate))
      throw new ConvexError("Service date must be a YYYY-MM-DD date");
    const { profile: caller } = await requireCapability(ctx, "visit.read");
    if (!args.profileId || args.profileId === caller._id) {
      const filer = await filerOf(ctx, caller);
      return filer
        ? await buildReport(ctx, filer, args.serviceDate, null, true)
        : null;
    }
    const sc = await supervisorContext(ctx, { serviceDate: args.serviceDate });
    const person = await ctx.db.get(args.profileId);
    if (!person) throw new ConvexError("Person not found");
    const filer = await filerOf(ctx, person);
    if (!filer) return null;
    if (!filer.orgUnitId || !sc.scope.has(filer.orgUnitId))
      throw new ConvexError(
        "Requested person is outside your organizational scope",
      );
    return await buildReport(ctx, filer, args.serviceDate, sc.scope, false);
  },
});

/**
 * Files the caller's DAR or ROAR for a Manila date with remarks. Each call keeps a new
 * revision with the generated figures frozen; the first revision's time decides on time
 * (by 10 PM Manila) or late. Recording roles only: analysts and viewers never file.
 */
export const submit = mutation({
  args: { serviceDate: v.string(), remarks: v.string() },
  returns: v.object({
    revision: v.number(),
    late: v.boolean(),
    summary: fieldReportSummary,
  }),
  handler: async (ctx, args) => {
    const { identity, profile } = await requireCapability(ctx, "visit.record");
    const now = Date.now();
    const windowError = submitWindowError(args.serviceDate, now);
    if (windowError) throw new ConvexError(windowError);
    if (args.remarks.length > MAX_REMARKS)
      throw new ConvexError(`Remarks are limited to ${MAX_REMARKS} characters`);
    const filer = await filerOf(ctx, profile);
    if (!filer)
      throw new ConvexError("Your position does not file a DAR or ROAR");
    if (!filer.orgUnitId)
      throw new ConvexError("Your access has no organizational scope");
    const rows = await revisionsOf(ctx, profile._id, args.serviceDate);
    if (rows.length >= MAX_REVISIONS)
      throw new ConvexError("This report has reached its correction limit");
    const { summary } = await generate(ctx, filer, args.serviceDate, null);
    const revision = (rows.at(-1)?.revision ?? 0) + 1;
    await ctx.db.insert("fieldDayReports", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      profileId: profile._id,
      orgUnitId: filer.orgUnitId,
      serviceDate: args.serviceDate,
      kind: filer.kind,
      revision,
      remarks: args.remarks.trim(),
      summary,
      submittedBy: identity.tokenIdentifier,
      submittedAt: now,
    });
    const firstAt = rows[0]?.submittedAt ?? now;
    return { revision, late: firstAt > reportDueAt(args.serviceDate), summary };
  },
});

/** Active filers whose current assignment sits inside the selected units. */
async function filersIn(
  ctx: QueryCtx,
  sc: SupervisorContext,
  kind?: FieldReportKind,
) {
  const filers: Filer[] = [];
  let truncated = false;
  for (const unitId of sc.units) {
    const profiles = await ctx.db
      .query("profiles")
      .withIndex("by_orgUnitId", (q) => q.eq("orgUnitId", unitId))
      .take(MAX_PEOPLE * 4);
    for (const profile of profiles) {
      if (profile.status !== "active") continue;
      const filer = await filerOf(ctx, profile);
      if (!filer?.orgUnitId || !sc.units.has(filer.orgUnitId)) continue;
      if (kind && filer.kind !== kind) continue;
      if (filers.length >= MAX_PEOPLE) {
        truncated = true;
        continue;
      }
      filers.push(filer);
    }
  }
  filers.sort((a, b) => a.profile.name.localeCompare(b.profile.name));
  return { filers, truncated };
}

const completenessPerson = v.object({
  profileId: v.id("profiles"),
  name: v.string(),
  employeeCode: nullableString,
  positionLabel: v.string(),
  kind: fieldReportKind,
  days: v.array(
    v.object({
      serviceDate: v.string(),
      status: completenessStatus,
      revisions: v.number(),
      submittedAt: nullableNumber,
    }),
  ),
});

/**
 * Submission completeness per person per day: every DAR/ROAR filer in the caller's scope
 * (optionally one unit and one report kind) over up to 14 days ending at `endDate`.
 */
export const completeness = query({
  args: {
    endDate: v.string(),
    days: v.optional(v.number()),
    orgUnitId: v.optional(v.id("orgUnits")),
    kind: v.optional(fieldReportKind),
  },
  returns: v.object({
    dates: v.array(v.string()),
    truncated: v.boolean(),
    units: v.array(
      v.object({ id: v.id("orgUnits"), code: v.string(), name: v.string() }),
    ),
    people: v.array(completenessPerson),
    totals: v.array(
      v.object({
        serviceDate: v.string(),
        required: v.number(),
        submitted: v.number(),
        late: v.number(),
        missing: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const days = args.days ?? 7;
    if (!Number.isInteger(days) || days < 1 || days > MAX_COMPLETENESS_DAYS)
      throw new ConvexError(`Days must be 1 to ${MAX_COMPLETENESS_DAYS}`);
    const sc = await supervisorContext(ctx, {
      serviceDate: args.endDate,
      orgUnitId: args.orgUnitId,
    });
    const dates = datesEndingAt(args.endDate, days);
    const { filers, truncated } = await filersIn(ctx, sc, args.kind);
    const now = Date.now();
    const people: (typeof completenessPerson.type)[] = [];
    for (const filer of filers) {
      const standard = await standardFor(ctx, filer, args.endDate);
      const weekdays = standard?.sellingWeekdays ?? DEFAULT_SELLING_WEEKDAYS;
      const rows = await ctx.db
        .query("fieldDayReports")
        .withIndex("by_profileId_and_serviceDate_and_revision", (q) =>
          q
            .eq("profileId", filer.profile._id)
            .gte("serviceDate", dates[0]!)
            .lte("serviceDate", dates.at(-1)!),
        )
        .take(days * MAX_REVISIONS);
      people.push({
        profileId: filer.profile._id,
        name: filer.profile.name,
        employeeCode: filer.profile.employeeCode ?? null,
        positionLabel: filer.position.label,
        kind: filer.kind,
        days: dates.map((serviceDate) => {
          const forDay = rows.filter((row) => row.serviceDate === serviceDate);
          const first = forDay[0] ?? null;
          return {
            serviceDate,
            status: completenessOf({
              serviceDate,
              sellingDay: isSellingDay(serviceDate, weekdays),
              firstSubmittedAt: first?.submittedAt ?? null,
              now,
            }),
            revisions: forDay.length,
            submittedAt: forDay.at(-1)?.submittedAt ?? null,
          };
        }),
      });
    }
    const totals = dates.map((serviceDate, index) => {
      const statuses = people.map((person) => person.days[index]!.status);
      const count = (status: string) =>
        statuses.filter((s) => s === status).length;
      return {
        serviceDate,
        required: statuses.filter((s) => s !== "off_day" && s !== "upcoming")
          .length,
        submitted: count("submitted"),
        late: count("late"),
        missing: count("missing"),
      };
    });
    return { dates, truncated, units: sc.unitOptions, people, totals };
  },
});

/** Whether the signed-in person files a report, for the web to choose its first view. */
export const myKind = query({
  args: {},
  returns: v.union(fieldReportKind, v.null()),
  handler: async (ctx) => {
    const { profile } = await requireActiveProfile(ctx);
    return (await filerOf(ctx, profile))?.kind ?? null;
  },
});
