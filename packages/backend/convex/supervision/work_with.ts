import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import schema from "../schema";
import { localDate, manilaDate } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds } from "../lib/scope";
import { activeAt, topology } from "../org/validation";
import { standardAt, standardsFor } from "../sfa/standards";
import { supervisionArgs, supervisorContext } from "./access";
import { DONE_STATES, MAX_DAY_ROWS, MAX_PEOPLE } from "./model";
import {
  cadenceState,
  completionGaps,
  countIn,
  GAP_LABELS,
  MAX_OBSERVATIONS,
  MAX_SHORT_TEXT,
  MAX_TEXT,
  monthOf,
  weekOf,
  workWithMode,
  workWithObjective,
  workWithObservation,
  workWithPostCall,
  workWithPreCall,
  workWithTrainingLog,
  type McpDay,
  type WorkWithObservation,
} from "./work_with_model";

/**
 * SOP-005 Work-With sessions (memo §III). The trainer (any role holding `visit.record`)
 * starts, fills and completes a session with one person inside their scope; supervisors
 * (`people.read` + `visit.read`) see sessions and each trainer's cadence against the
 * weekly/monthly minimum of the trainer's position standard.
 */

type Ctx = QueryCtx | MutationCtx;
const DAY = 86_400_000;
/** How far back or ahead a session may be dated. */
const DATE_WINDOW_DAYS = 31;
const MAX_SESSIONS = 200;
const MAX_TRAINEES = 200;

function text(value: string, label: string, max = MAX_TEXT) {
  if (value.length > max) throw new ConvexError(`${label} is too long`);
  return value.trim();
}

/** The single employee assignment in force at the instant, if any. */
export async function assignmentAt(
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

/** The trainee's approved MCP for the day and how many of its stops are finished. */
export async function mcpDay(
  ctx: Ctx,
  traineeProfileId: Id<"profiles">,
  serviceDate: string,
): Promise<McpDay> {
  const planned = (
    await ctx.db
      .query("plannedVisits")
      .withIndex("by_assigneeProfileId_and_serviceDate", (q) =>
        q
          .eq("assigneeProfileId", traineeProfileId)
          .eq("serviceDate", serviceDate),
      )
      .take(MAX_DAY_ROWS)
  ).filter((row) => row.status === "planned");
  const ids = new Set<string>(planned.map((row) => row._id));
  const visits = await ctx.db
    .query("visitExecutions")
    .withIndex("by_organizationId_and_assigneeProfileId_and_serviceDate", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("assigneeProfileId", traineeProfileId)
        .eq("serviceDate", serviceDate),
    )
    .take(MAX_DAY_ROWS);
  const done = new Set(
    visits
      .filter(
        (visit) =>
          DONE_STATES.has(visit.state) &&
          visit.plannedVisitId !== undefined &&
          ids.has(visit.plannedVisitId),
      )
      .map((visit) => visit.plannedVisitId as string),
  );
  return { planned: planned.length, done: done.size };
}

async function ownOpenSession(
  ctx: MutationCtx,
  sessionId: Id<"workWithSessions">,
) {
  const { identity, profile } = await requireCapability(ctx, "visit.record");
  const session = await ctx.db.get(sessionId);
  if (!session || session.trainerProfileId !== profile._id)
    throw new ConvexError("Work-With session not found");
  if (session.status !== "open")
    throw new ConvexError("This Work-With session is already closed");
  // The trainee's unit must still be inside the trainer's scope.
  await requireCapability(ctx, "visit.record", session.orgUnitId);
  return { identity, profile, session };
}

function cleanObservations(rows: readonly WorkWithObservation[]) {
  if (rows.length > MAX_OBSERVATIONS)
    throw new ConvexError("Too many observations");
  return rows.map((row) => {
    const item = text(row.item, "Observation", MAX_SHORT_TEXT);
    if (!item) throw new ConvexError("Each observation needs a step");
    const remark = row.remark === undefined ? "" : text(row.remark, "Remark");
    return {
      area: row.area,
      item,
      rating: row.rating,
      ...(remark ? { remark } : {}),
    };
  });
}

/** Start a Work-With with one person in the caller's scope. */
export const start = mutation({
  args: {
    traineeProfileId: v.id("profiles"),
    serviceDate: v.string(),
    objective: workWithObjective,
    mode: workWithMode,
    truckReference: v.optional(v.string()),
  },
  returns: v.id("workWithSessions"),
  handler: async (ctx, args) => {
    const { identity, profile } = await requireCapability(ctx, "visit.record");
    const dayStart = localDate(args.serviceDate);
    const now = Date.now();
    const today = localDate(manilaDate(now));
    if (Math.abs(dayStart - today) > DATE_WINDOW_DAYS * DAY)
      throw new ConvexError(
        `A Work-With must be dated within ${DATE_WINDOW_DAYS} days of today`,
      );
    if (args.traineeProfileId === profile._id)
      throw new ConvexError("You cannot work with yourself");
    const trainee = await ctx.db.get(args.traineeProfileId);
    if (!trainee || trainee.status !== "active")
      throw new ConvexError("Trainee not found");
    const traineeAssignment = await assignmentAt(ctx, trainee._id, now);
    const orgUnitId = traineeAssignment?.orgUnitId ?? trainee.orgUnitId;
    if (!orgUnitId) throw new ConvexError("Trainee has no organizational unit");
    await requireCapability(ctx, "visit.record", orgUnitId);
    const truckReference =
      args.truckReference === undefined
        ? ""
        : text(args.truckReference, "Truck", MAX_SHORT_TEXT);
    if (args.mode === "truck" && !truckReference)
      throw new ConvexError("Name the truck for a truck work-with");
    const duplicate = (
      await ctx.db
        .query("workWithSessions")
        .withIndex("by_trainerProfileId_and_serviceDate", (q) =>
          q
            .eq("trainerProfileId", profile._id)
            .eq("serviceDate", args.serviceDate),
        )
        .take(20)
    ).some(
      (row) =>
        row.traineeProfileId === trainee._id && row.status !== "cancelled",
    );
    if (duplicate)
      throw new ConvexError(
        "You already have a Work-With with this person on that day",
      );
    const trainerAssignment = await assignmentAt(ctx, profile._id, now);
    const trainerPositionId =
      trainerAssignment?.positionId ?? profile.positionId;
    return await ctx.db.insert("workWithSessions", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      trainerProfileId: profile._id,
      ...(trainerPositionId ? { trainerPositionId } : {}),
      traineeProfileId: trainee._id,
      orgUnitId,
      serviceDate: args.serviceDate,
      objective: args.objective,
      mode: args.mode,
      ...(truckReference ? { truckReference } : {}),
      status: "open",
      observations: [],
      createdBy: identity.tokenIdentifier,
      createdAt: now,
      updatedBy: identity.tokenIdentifier,
      updatedAt: now,
    });
  },
});

/** Save the trainer's notes. Only the fields passed are replaced. */
export const update = mutation({
  args: {
    sessionId: v.id("workWithSessions"),
    truckReference: v.optional(v.string()),
    rodeWithTruck: v.optional(v.boolean()),
    trainingLog: v.optional(workWithTrainingLog),
    observations: v.optional(v.array(workWithObservation)),
    preCall: v.optional(workWithPreCall),
    postCall: v.optional(workWithPostCall),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity, session } = await ownOpenSession(ctx, args.sessionId);
    const patch: Partial<Doc<"workWithSessions">> = {};
    if (args.truckReference !== undefined) {
      const truck = text(args.truckReference, "Truck", MAX_SHORT_TEXT);
      if (session.mode === "truck" && !truck)
        throw new ConvexError("Name the truck for a truck work-with");
      patch.truckReference = truck || undefined;
    }
    if (args.rodeWithTruck !== undefined) {
      if (session.mode !== "truck" && args.rodeWithTruck)
        throw new ConvexError("Only a truck work-with rides a truck");
      patch.rodeWithTruck = args.rodeWithTruck;
    }
    if (args.trainingLog !== undefined)
      patch.trainingLog = {
        topics: text(args.trainingLog.topics, "Training log"),
        tradeDevelopment: text(
          args.trainingLog.tradeDevelopment,
          "Trade development",
        ),
        discussedWithTrainee: args.trainingLog.discussedWithTrainee,
      };
    if (args.observations !== undefined)
      patch.observations = cleanObservations(args.observations);
    if (args.preCall !== undefined)
      patch.preCall = {
        documents: [...new Set(args.preCall.documents)],
        remarks: text(args.preCall.remarks, "Pre-call remarks"),
      };
    if (args.postCall !== undefined)
      patch.postCall = {
        strengths: text(args.postCall.strengths, "Strengths"),
        weaknesses: text(args.postCall.weaknesses, "Weaknesses"),
        opportunities: text(args.postCall.opportunities, "Opportunities"),
        threats: text(args.postCall.threats, "Threats"),
      };
    await ctx.db.patch(session._id, {
      ...patch,
      updatedBy: identity.tokenIdentifier,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Close a session as done. Refused, listing what is missing, until every requirement for
 * its objective holds — including the end-to-end rule, checked against the trainee's MCP.
 */
export const complete = mutation({
  args: { sessionId: v.id("workWithSessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity, session } = await ownOpenSession(ctx, args.sessionId);
    const now = Date.now();
    if (session.serviceDate > manilaDate(now))
      throw new ConvexError("A Work-With cannot be completed before its day");
    const mcp = await mcpDay(
      ctx,
      session.traineeProfileId,
      session.serviceDate,
    );
    const gaps = completionGaps(session, mcp);
    if (gaps.length)
      throw new ConvexError(
        `Work-With is not complete: ${gaps.map((gap) => GAP_LABELS[gap]).join("; ")}`,
      );
    await ctx.db.patch(session._id, {
      status: "completed",
      mcpPlanned: mcp.planned,
      mcpDone: mcp.done,
      completedAt: now,
      updatedBy: identity.tokenIdentifier,
      updatedAt: now,
    });
    return null;
  },
});

export const cancel = mutation({
  args: { sessionId: v.id("workWithSessions"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity, session } = await ownOpenSession(ctx, args.sessionId);
    const reason = text(args.reason, "Reason");
    if (!reason) throw new ConvexError("Give a reason to cancel");
    const now = Date.now();
    await ctx.db.patch(session._id, {
      status: "cancelled",
      cancelReason: reason,
      cancelledAt: now,
      updatedBy: identity.tokenIdentifier,
      updatedAt: now,
    });
    return null;
  },
});

const gapRow = v.object({ code: v.string(), label: v.string() });

/**
 * One session with names, the trainee's live MCP progress and what is still missing. Read
 * by its trainer, its trainee, or a supervisor whose scope holds the session's unit.
 */
export const detail = query({
  args: { sessionId: v.id("workWithSessions") },
  returns: v.object({
    session: schema.doc("workWithSessions"),
    trainerName: v.string(),
    traineeName: v.string(),
    mcp: v.object({ planned: v.number(), done: v.number() }),
    gaps: v.array(gapRow),
    canEdit: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "visit.read");
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new ConvexError("Work-With session not found");
    const own =
      session.trainerProfileId === profile._id ||
      session.traineeProfileId === profile._id;
    if (!own) {
      await requireCapability(ctx, "people.read", session.orgUnitId);
      await requireCapability(ctx, "visit.read", session.orgUnitId);
    }
    const mcp =
      session.status === "completed"
        ? { planned: session.mcpPlanned ?? 0, done: session.mcpDone ?? 0 }
        : await mcpDay(ctx, session.traineeProfileId, session.serviceDate);
    const gaps = session.status === "open" ? completionGaps(session, mcp) : [];
    return {
      session,
      trainerName:
        (await ctx.db.get(session.trainerProfileId))?.name ?? "Former user",
      traineeName:
        (await ctx.db.get(session.traineeProfileId))?.name ?? "Former user",
      mcp,
      gaps: gaps.map((code) => ({ code, label: GAP_LABELS[code] })),
      canEdit:
        session.status === "open" && session.trainerProfileId === profile._id,
    };
  },
});

const sessionRow = v.object({
  sessionId: v.id("workWithSessions"),
  serviceDate: v.string(),
  trainerProfileId: v.id("profiles"),
  trainerName: v.string(),
  traineeProfileId: v.id("profiles"),
  traineeName: v.string(),
  objective: workWithObjective,
  mode: workWithMode,
  truckReference: v.union(v.string(), v.null()),
  status: v.string(),
});

async function sessionRows(ctx: QueryCtx, rows: Doc<"workWithSessions">[]) {
  const names = new Map<Id<"profiles">, string>();
  const name = async (id: Id<"profiles">) => {
    if (!names.has(id))
      names.set(id, (await ctx.db.get(id))?.name ?? "Former user");
    return names.get(id)!;
  };
  const out = [];
  for (const row of rows.sort(
    (a, b) =>
      b.serviceDate.localeCompare(a.serviceDate) || b.createdAt - a.createdAt,
  ))
    out.push({
      sessionId: row._id,
      serviceDate: row.serviceDate,
      trainerProfileId: row.trainerProfileId,
      trainerName: await name(row.trainerProfileId),
      traineeProfileId: row.traineeProfileId,
      traineeName: await name(row.traineeProfileId),
      objective: row.objective,
      mode: row.mode,
      truckReference: row.truckReference ?? null,
      status: row.status,
    });
  return out;
}

/** The caller's own sessions in the month of the date, and the people they may pick. */
export const mine = query({
  args: { serviceDate: v.string() },
  returns: v.object({
    sessions: v.array(sessionRow),
    trainees: v.array(
      v.object({
        profileId: v.id("profiles"),
        name: v.string(),
        employeeCode: v.union(v.string(), v.null()),
      }),
    ),
    traineesTruncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    localDate(args.serviceDate);
    const { profile } = await requireCapability(ctx, "visit.record");
    const month = monthOf(args.serviceDate);
    const sessions = await ctx.db
      .query("workWithSessions")
      .withIndex("by_trainerProfileId_and_serviceDate", (q) =>
        q
          .eq("trainerProfileId", profile._id)
          .gte("serviceDate", month.start)
          .lte("serviceDate", month.end),
      )
      .take(MAX_SESSIONS);
    const units =
      profile.role === "super_admin"
        ? (await topology(ctx, Date.now())).map((unit) => unit._id)
        : profile.orgUnitId
          ? await collectScopeUnitIds(ctx, profile.orgUnitId)
          : [];
    const trainees = [];
    let traineesTruncated = false;
    for (const unitId of units) {
      const rows = await ctx.db
        .query("profiles")
        .withIndex("by_orgUnitId", (q) => q.eq("orgUnitId", unitId))
        .take(MAX_TRAINEES);
      for (const row of rows) {
        if (row.status !== "active" || row._id === profile._id) continue;
        if (trainees.length >= MAX_TRAINEES) {
          traineesTruncated = true;
          break;
        }
        trainees.push({
          profileId: row._id,
          name: row.name,
          employeeCode: row.employeeCode ?? null,
        });
      }
    }
    trainees.sort((a, b) => a.name.localeCompare(b.name));
    return {
      sessions: await sessionRows(ctx, sessions),
      trainees,
      traineesTruncated,
    };
  },
});

const cadenceStateValidator = v.union(
  v.literal("met"),
  v.literal("on_track"),
  v.literal("behind"),
  v.literal("no_standard"),
);

/**
 * SOP-005 cadence for supervisors: every trainer in scope whose position carries a
 * Work-With minimum, with completed sessions this week (Mon–Sun) and this month against
 * it, plus the month's sessions in scope. Reference period = the selected date.
 */
export const cadence = query({
  args: supervisionArgs,
  returns: v.object({
    week: v.object({ start: v.string(), end: v.string() }),
    month: v.object({ start: v.string(), end: v.string() }),
    truncated: v.boolean(),
    trainers: v.array(
      v.object({
        profileId: v.id("profiles"),
        name: v.string(),
        employeeCode: v.union(v.string(), v.null()),
        positionLabel: v.string(),
        orgUnitId: v.id("orgUnits"),
        direct: v.boolean(),
        weeklyMin: v.union(v.number(), v.null()),
        monthlyMin: v.union(v.number(), v.null()),
        weekCount: v.number(),
        monthCount: v.number(),
        openCount: v.number(),
        weekState: cadenceStateValidator,
        monthState: cadenceStateValidator,
        sourceRef: v.string(),
      }),
    ),
    sessions: v.array(sessionRow),
  }),
  handler: async (ctx, args) => {
    const sc = await supervisorContext(ctx, args);
    const week = weekOf(args.serviceDate);
    const month = monthOf(args.serviceDate);
    const from = week.start < month.start ? week.start : month.start;
    const to = week.end > month.end ? week.end : month.end;
    const now = Date.now();
    const today = manilaDate(now);
    const instant = Date.parse(`${args.serviceDate}T12:00:00+08:00`);
    const trainers = [];
    let truncated = false;
    const positions = new Map<Id<"positions">, Doc<"positions"> | null>();
    for (const unitId of sc.units) {
      const profiles = await ctx.db
        .query("profiles")
        .withIndex("by_orgUnitId", (q) => q.eq("orgUnitId", unitId))
        .take(MAX_PEOPLE * 4);
      for (const profile of profiles) {
        if (profile.status !== "active") continue;
        const assignment = await assignmentAt(ctx, profile._id, now);
        const orgUnitId = assignment?.orgUnitId;
        if (!orgUnitId || !sc.units.has(orgUnitId)) continue;
        if (
          args.directOnly &&
          assignment.supervisorId !== sc.profile._id &&
          profile.supervisorSubject !== sc.identity.tokenIdentifier
        )
          continue;
        const positionId = assignment.positionId ?? profile.positionId;
        if (!positionId) continue;
        if (!positions.has(positionId))
          positions.set(positionId, await ctx.db.get(positionId));
        const position = positions.get(positionId);
        if (!position) continue;
        const standard = standardAt(
          await standardsFor(ctx, positionId),
          instant,
        );
        const weeklyMin = standard?.workWithWeeklyMin ?? null;
        const monthlyMin = standard?.workWithMonthlyMin ?? null;
        if (!standard || (weeklyMin === null && monthlyMin === null)) continue;
        if (trainers.length >= MAX_PEOPLE) {
          truncated = true;
          continue;
        }
        const sessions = await ctx.db
          .query("workWithSessions")
          .withIndex("by_trainerProfileId_and_serviceDate", (q) =>
            q
              .eq("trainerProfileId", profile._id)
              .gte("serviceDate", from)
              .lte("serviceDate", to),
          )
          .take(MAX_SESSIONS);
        const weekCount = countIn(sessions, week.start, week.end);
        const monthCount = countIn(sessions, month.start, month.end);
        trainers.push({
          profileId: profile._id,
          name: profile.name,
          employeeCode: profile.employeeCode ?? null,
          positionLabel: position.label,
          orgUnitId,
          direct:
            assignment.supervisorId === sc.profile._id ||
            profile.supervisorSubject === sc.identity.tokenIdentifier,
          weeklyMin,
          monthlyMin,
          weekCount,
          monthCount,
          openCount: sessions.filter(
            (row) =>
              row.status === "open" &&
              row.serviceDate >= month.start &&
              row.serviceDate <= month.end,
          ).length,
          weekState: cadenceState(weekCount, weeklyMin, week.end, today),
          monthState: cadenceState(monthCount, monthlyMin, month.end, today),
          sourceRef: standard.sourceRef,
        });
      }
    }
    trainers.sort((a, b) => a.name.localeCompare(b.name));
    const inScope: Doc<"workWithSessions">[] = [];
    for (const unitId of sc.units) {
      if (inScope.length >= MAX_SESSIONS) {
        truncated = true;
        break;
      }
      inScope.push(
        ...(await ctx.db
          .query("workWithSessions")
          .withIndex("by_orgUnitId_and_serviceDate", (q) =>
            q
              .eq("orgUnitId", unitId)
              .gte("serviceDate", month.start)
              .lte("serviceDate", month.end),
          )
          .take(MAX_SESSIONS - inScope.length)),
      );
    }
    return {
      week,
      month: { start: month.start, end: month.end },
      truncated,
      trainers,
      sessions: await sessionRows(ctx, inScope),
    };
  },
});
