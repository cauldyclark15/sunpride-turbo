import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { localDate } from "../coverage/validation";
import { requireCapability } from "../lib/capabilities";
import { personDay, supervisorContext } from "../supervision/access";
import { channelOf, dayCloseAt, DONE_STATES } from "../supervision/model";
import {
  COMPLIANCE_SOURCE,
  DEFAULT_WEEKS,
  emptyWeek,
  weeksError,
  weekWindows,
  type WeekFigures,
} from "./compliance_model";
import { memberOf } from "./productivity";
import { datesBetween } from "./productivity_model";

/**
 * ANA-008 route/coverage compliance. `person` compares one field person's approved MCP
 * stops with the visits they actually closed, week by week, broken down by the territory
 * and store each stop was signed for. The web reads the roster with
 * `analytics/productivity:roster` and subscribes one `person` query per row, then sums
 * people into territory and store views, so each read stays bounded (one person, at most
 * eight weeks). Pure rules: `./compliance_model.ts`.
 *
 * Access: supervision readers (`people.read` + `visit.read`) who also hold `report.read`,
 * inside their own organizational scope. Field `sales` never sees it.
 *
 * Attribution follows the signed MCP snapshot (territory, store, customer), never the
 * live projections, so a later reassignment does not rewrite history. A stop counts as
 * done when a visit for it was checked out or completed on its planned day.
 */

const MAX_OUTLETS = 400;
const MAX_TERRITORIES = 60;

const week = v.object({
  planned: v.number(),
  done: v.number(),
  missed: v.number(),
  pending: v.number(),
});

export const compliancePerson = v.object({
  profileId: v.id("profiles"),
  name: v.string(),
  employeeCode: v.union(v.string(), v.null()),
  positionLabel: v.union(v.string(), v.null()),
  channel: v.string(),
  endDate: v.string(),
  sourceRef: v.string(),
  windows: v.array(
    v.object({
      weekStart: v.string(),
      from: v.string(),
      to: v.string(),
      closed: v.boolean(),
    }),
  ),
  weeks: v.array(week),
  /** Visits outside the approved plan, per week (they never count as compliance). */
  offPlanVisits: v.array(v.number()),
  territories: v.array(
    v.object({
      territoryId: v.id("territories"),
      code: v.string(),
      name: v.string(),
      weeks: v.array(week),
    }),
  ),
  outlets: v.array(
    v.object({
      outletId: v.id("outlets"),
      code: v.string(),
      name: v.string(),
      territoryCode: v.string(),
      customerCode: v.union(v.string(), v.null()),
      customerName: v.union(v.string(), v.null()),
      weeks: v.array(week),
    }),
  ),
  /** Stores beyond the per-person cap are left out of `outlets` (still in the totals). */
  outletsTruncated: v.boolean(),
});

export const person = query({
  args: {
    profileId: v.id("profiles"),
    endDate: v.string(),
    weeks: v.optional(v.number()),
  },
  returns: compliancePerson,
  handler: async (ctx, args) => {
    localDate(args.endDate);
    const weeks = args.weeks ?? DEFAULT_WEEKS;
    const error = weeksError(weeks);
    if (error) throw new ConvexError(error);
    const sc = await supervisorContext(ctx, { serviceDate: args.endDate });
    await requireCapability(ctx, "report.read");
    const member = await memberOf(ctx, sc, args.profileId);

    const now = Date.now();
    const windows = weekWindows(
      args.endDate,
      weeks,
      (date) => dayCloseAt(date) < now,
    );
    const blank = () => windows.map(() => emptyWeek());
    const totals = blank();
    const offPlanVisits = windows.map(() => 0);
    const territories = new Map<
      Id<"territories">,
      { code: string; weeks: WeekFigures[] }
    >();
    const outlets = new Map<
      Id<"outlets">,
      {
        code: string;
        name: string;
        territoryCode: string;
        customerId: Id<"customers"> | null;
        weeks: WeekFigures[];
      }
    >();
    let outletsTruncated = false;

    for (const [index, window] of windows.entries()) {
      for (const date of datesBetween(window.from, window.to)) {
        const { planned, visits } = await personDay(
          ctx,
          sc,
          member.profile._id,
          date,
        );
        offPlanVisits[index] =
          (offPlanVisits[index] ?? 0) +
          visits.filter((visit) => visit.source === "unplanned").length;
        const doneIds = new Set(
          visits.flatMap((visit) =>
            DONE_STATES.has(visit.state) && visit.plannedVisitId
              ? [visit.plannedVisitId as string]
              : [],
          ),
        );
        const closed = dayCloseAt(date) < now;
        for (const stop of planned) {
          if (stop.status !== "planned") continue;
          const outcome: WeekFigures = {
            planned: 1,
            done: doneIds.has(stop._id) ? 1 : 0,
            missed: !doneIds.has(stop._id) && closed ? 1 : 0,
            pending: !doneIds.has(stop._id) && !closed ? 1 : 0,
          };
          const at = (series: WeekFigures[]) => {
            const row = series[index]!;
            row.planned += outcome.planned;
            row.done += outcome.done;
            row.missed += outcome.missed;
            row.pending += outcome.pending;
          };
          at(totals);
          const snap = stop.approvedSnapshot;
          let territory = territories.get(snap.territoryId);
          if (!territory) {
            if (territories.size >= MAX_TERRITORIES)
              throw new ConvexError(
                "This person has too many territories for one read",
              );
            territory = { code: snap.territoryCode, weeks: blank() };
            territories.set(snap.territoryId, territory);
          }
          at(territory.weeks);
          let outlet = outlets.get(snap.outletId);
          if (!outlet) {
            if (outlets.size >= MAX_OUTLETS) {
              outletsTruncated = true;
              continue;
            }
            outlet = {
              code: snap.outletCode,
              name: snap.outletName,
              territoryCode: snap.territoryCode,
              customerId: snap.customerId ?? null,
              weeks: blank(),
            };
            outlets.set(snap.outletId, outlet);
          }
          at(outlet.weeks);
        }
      }
    }

    const customers = new Map<
      Id<"customers">,
      { code: string; name: string } | null
    >();
    const customerOf = async (id: Id<"customers"> | null) => {
      if (!id) return null;
      if (!customers.has(id)) {
        const row = await ctx.db.get(id);
        customers.set(id, row ? { code: row.code, name: row.name } : null);
      }
      return customers.get(id) ?? null;
    };

    const territoryRows = [];
    for (const [territoryId, row] of territories) {
      const doc = await ctx.db.get(territoryId);
      territoryRows.push({
        territoryId,
        code: row.code,
        name: doc?.name ?? row.code,
        weeks: row.weeks,
      });
    }
    territoryRows.sort((a, b) => a.code.localeCompare(b.code));
    const outletRows = [];
    for (const [outletId, row] of outlets) {
      const customer = await customerOf(row.customerId);
      outletRows.push({
        outletId,
        code: row.code,
        name: row.name,
        territoryCode: row.territoryCode,
        customerCode: customer?.code ?? null,
        customerName: customer?.name ?? null,
        weeks: row.weeks,
      });
    }
    outletRows.sort((a, b) => a.code.localeCompare(b.code));

    return {
      profileId: member.profile._id,
      name: member.profile.name,
      employeeCode: member.profile.employeeCode ?? null,
      positionLabel: member.position?.label ?? null,
      channel: channelOf(member.profile.channelScope, member.position?.label),
      endDate: args.endDate,
      sourceRef: COMPLIANCE_SOURCE,
      windows,
      weeks: totals,
      offPlanVisits,
      territories: territoryRows,
      outlets: outletRows,
      outletsTruncated,
    };
  },
});
