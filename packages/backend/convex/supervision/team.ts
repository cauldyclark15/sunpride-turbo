import { v } from "convex/values";
import { query, type QueryCtx } from "../_generated/server";
import {
  openEvidence,
  personDay,
  supervisionArgs,
  supervisorContext,
  teamMembers,
  visitEvidence,
  type SupervisionFilters,
  type SupervisorContext,
} from "./access";
import { dayCloseAt, isLateSync, outOfSequence, summarizeDay } from "./model";

const nullableTime = v.union(v.number(), v.null());
export const personRow = v.object({
  profileId: v.id("profiles"),
  name: v.string(),
  employeeCode: v.union(v.string(), v.null()),
  positionLabel: v.union(v.string(), v.null()),
  channel: v.string(),
  orgUnitId: v.id("orgUnits"),
  direct: v.boolean(),
  planned: v.number(),
  plannedDone: v.number(),
  done: v.number(),
  productive: v.number(),
  nonproductive: v.number(),
  unplanned: v.number(),
  inProgress: v.boolean(),
  outOfSequence: v.number(),
  openExceptions: v.number(),
  lateSync: v.number(),
  firstCheckInAt: nullableTime,
  lastCheckOutAt: nullableTime,
  lastActivityAt: nullableTime,
});

/** Filter choices for the supervision header: units and channels in the caller's scope. */
export const options = query({
  args: { serviceDate: v.string() },
  returns: v.object({
    canDecide: v.boolean(),
    units: v.array(
      v.object({ id: v.id("orgUnits"), code: v.string(), name: v.string() }),
    ),
    channels: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const sc = await supervisorContext(ctx, args);
    const { channels } = await teamMembers(ctx, sc, args);
    return { canDecide: sc.canDecide, units: sc.unitOptions, channels };
  },
});

/**
 * WEB-022 team execution: one row per field person for a Manila service date. Time-based
 * status (not started, idle) is derived on the client from these numbers and its own clock.
 */
export const day = query({
  args: supervisionArgs,
  returns: v.object({
    serviceDate: v.string(),
    dayCloseAt: v.number(),
    truncated: v.boolean(),
    canDecide: v.boolean(),
    units: v.array(
      v.object({ id: v.id("orgUnits"), code: v.string(), name: v.string() }),
    ),
    channels: v.array(v.string()),
    people: v.array(personRow),
  }),
  handler: async (ctx, args) => {
    const sc = await supervisorContext(ctx, args);
    const { closeAt, truncated, channels, people } = await teamDay(
      ctx,
      sc,
      args,
    );
    return {
      serviceDate: args.serviceDate,
      dayCloseAt: closeAt,
      truncated,
      canDecide: sc.canDecide,
      units: sc.unitOptions,
      channels,
      people,
    };
  },
});

/** One summary row per field person in scope (shared by the web day view and the phone). */
export async function teamDay(
  ctx: QueryCtx,
  sc: SupervisorContext,
  args: SupervisionFilters,
) {
  const { members, truncated, channels } = await teamMembers(ctx, sc, args);
  const closeAt = dayCloseAt(args.serviceDate);
  const people = [];
  for (const member of members) {
    const { planned, visits } = await personDay(
      ctx,
      sc,
      member.profile._id,
      args.serviceDate,
    );
    const active = planned.filter((row) => row.status === "planned");
    const sequence = new Map(
      planned.map((row) => [row._id as string, row.approvedSnapshot.sequence]),
    );
    let openExceptions = 0,
      lateSync = 0;
    for (const visit of visits) {
      const evidence = await visitEvidence(ctx, visit._id);
      openExceptions += (await openEvidence(ctx, evidence)).length;
      if (isLateSync(visit, evidence, closeAt)) lateSync++;
    }
    const broken = outOfSequence(visits, (visit) =>
      visit.plannedVisitId ? sequence.get(visit.plannedVisitId) : undefined,
    );
    people.push({
      profileId: member.profile._id,
      name: member.profile.name,
      employeeCode: member.profile.employeeCode ?? null,
      positionLabel: member.positionLabel,
      channel: member.channel,
      orgUnitId: member.assignment.orgUnitId!,
      direct: member.direct,
      ...summarizeDay({
        plannedActive: active.length,
        plannedIds: new Set(active.map((row) => row._id as string)),
        visits,
        outOfSequence: broken.size,
        openExceptions,
        lateSync,
      }),
    });
  }
  return { closeAt, truncated, channels, people };
}
