import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { localDate } from "../coverage/validation";
import { activeAt } from "../org/validation";
import { outletRows } from "../outlets/validation";
import {
  personDay,
  supervisionArgs,
  supervisorContext,
  teamMembers,
  visitEvidence,
} from "./access";

const nullableNumber = v.union(v.number(), v.null());
const point = v.union(
  v.object({ latitude: v.number(), longitude: v.number() }),
  v.null(),
);
const stop = v.object({
  id: v.string(),
  visitId: v.union(v.id("visitExecutions"), v.null()),
  outletCode: v.string(),
  outletName: v.string(),
  territoryCode: v.union(v.string(), v.null()),
  sequence: nullableNumber,
  state: v.string(),
  productivity: v.union(v.string(), v.null()),
  source: v.union(
    v.literal("planned"),
    v.literal("unplanned"),
    v.literal("not_visited"),
  ),
  checkedInAt: nullableNumber,
  checkedOutAt: nullableNumber,
  /** The outlet's verified pin: business-activity evidence, not employee tracking. */
  point,
  /** Raw check-in fix, only for callers who review geofence exceptions. */
  fix: v.union(
    v.object({
      latitude: v.number(),
      longitude: v.number(),
      accuracyMeters: v.union(v.number(), v.null()),
      result: v.string(),
    }),
    v.null(),
  ),
});
type Stop = typeof stop.type;

/**
 * WEB-024 field activity map: each person's check-ins for a Manila service date, in
 * check-in order, followed by planned stops not yet visited. Points are verified outlet
 * pins, so the map shows business activity without second-by-second tracking (client
 * answer 13). Raw device fixes are returned only to `visit.locationException.approve`.
 */
export const map = query({
  args: { ...supervisionArgs, profileId: v.optional(v.id("profiles")) },
  returns: v.object({
    serviceDate: v.string(),
    truncated: v.boolean(),
    showsFixes: v.boolean(),
    people: v.array(
      v.object({
        profileId: v.id("profiles"),
        name: v.string(),
        channel: v.string(),
        stops: v.array(stop),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const sc = await supervisorContext(ctx, args);
    const { members, truncated } = await teamMembers(ctx, sc, args);
    const noon = localDate(args.serviceDate) + 12 * 3_600_000;
    const outlets = new Map<Id<"outlets">, Doc<"outlets"> | null>();
    const territories = new Map<Id<"territories">, string | null>();
    const pinAt = async (outletId: Id<"outlets">, instant: number) => {
      const pins = (await outletRows(ctx, "outletPins", outletId)).filter(
        (pin) =>
          pin.status === "verified" &&
          activeAt(pin.effectiveFrom, pin.effectiveTo, instant),
      );
      return pins.length === 1
        ? { latitude: pins[0]!.latitude, longitude: pins[0]!.longitude }
        : null;
    };
    const territoryAt = async (outletId: Id<"outlets">, instant: number) => {
      const rows = (
        await outletRows(ctx, "outletAssignments", outletId)
      ).filter((row) => activeAt(row.effectiveFrom, row.effectiveTo, instant));
      if (rows.length !== 1) return null;
      const id = rows[0]!.territoryId;
      if (!territories.has(id))
        territories.set(id, (await ctx.db.get(id))?.code ?? null);
      return territories.get(id) ?? null;
    };
    const people = [];
    for (const member of members) {
      if (args.profileId && member.profile._id !== args.profileId) continue;
      const { planned, visits } = await personDay(
        ctx,
        sc,
        member.profile._id,
        args.serviceDate,
      );
      const plannedById = new Map(planned.map((row) => [row._id, row]));
      const stops: Stop[] = [];
      const ordered = [...visits].sort(
        (a, b) =>
          (a.checkedInAt ?? a.createdAt) - (b.checkedInAt ?? b.createdAt),
      );
      for (const visit of ordered) {
        const instant = visit.checkedInAt ?? visit.createdAt;
        if (!outlets.has(visit.outletId))
          outlets.set(visit.outletId, await ctx.db.get(visit.outletId));
        const outlet = outlets.get(visit.outletId) ?? null;
        const snapshot = visit.plannedVisitId
          ? plannedById.get(visit.plannedVisitId)?.approvedSnapshot
          : undefined;
        let fix: Stop["fix"] = null;
        if (sc.canDecide) {
          const checkIn = (await visitEvidence(ctx, visit._id)).find(
            (row) => row.event === "check_in",
          );
          if (
            checkIn?.latitude !== undefined &&
            checkIn.longitude !== undefined
          )
            fix = {
              latitude: checkIn.latitude,
              longitude: checkIn.longitude,
              accuracyMeters: checkIn.accuracyMeters ?? null,
              result: checkIn.result,
            };
        }
        stops.push({
          id: visit._id,
          visitId: visit._id,
          outletCode: snapshot?.outletCode ?? outlet?.code ?? "—",
          outletName: snapshot?.outletName ?? outlet?.name ?? "Unknown outlet",
          territoryCode:
            snapshot?.territoryCode ??
            (await territoryAt(visit.outletId, instant)),
          sequence: snapshot?.sequence ?? null,
          state: visit.state,
          productivity: visit.productivity,
          source: visit.source,
          checkedInAt: visit.checkedInAt ?? null,
          checkedOutAt: visit.checkedOutAt ?? null,
          point: await pinAt(visit.outletId, instant),
          fix,
        });
      }
      const visited = new Set(visits.map((visit) => visit.plannedVisitId));
      for (const row of [...planned].sort(
        (a, b) =>
          (a.approvedSnapshot.sequence ?? 0) -
          (b.approvedSnapshot.sequence ?? 0),
      )) {
        if (row.status !== "planned" || visited.has(row._id)) continue;
        stops.push({
          id: row._id,
          visitId: null,
          outletCode: row.approvedSnapshot.outletCode,
          outletName: row.approvedSnapshot.outletName,
          territoryCode: row.approvedSnapshot.territoryCode,
          sequence: row.approvedSnapshot.sequence ?? null,
          state: "planned",
          productivity: null,
          source: "not_visited",
          checkedInAt: null,
          checkedOutAt: null,
          point: await pinAt(row.outletId, noon),
          fix: null,
        });
      }
      people.push({
        profileId: member.profile._id,
        name: member.profile.name,
        channel: member.channel,
        stops,
      });
    }
    return {
      serviceDate: args.serviceDate,
      truncated,
      showsFixes: sc.canDecide,
      people,
    };
  },
});
