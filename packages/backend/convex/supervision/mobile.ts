import { v } from "convex/values";
import { query } from "../_generated/server";
import { supervisorContext } from "./access";
import { exceptionItems } from "./exceptions";
import { personRow, teamDay } from "./team";

/** Exceptions a phone summary carries; the full queue (and decisions) stays on the web. */
export const MOBILE_EXCEPTION_LIMIT = 50;

const nullableNumber = v.union(v.number(), v.null());
const nullableString = v.union(v.string(), v.null());

const exceptionRow = v.object({
  id: v.string(),
  kind: v.string(),
  open: v.boolean(),
  profileId: v.id("profiles"),
  personName: v.string(),
  outletCode: v.string(),
  outletName: v.string(),
  at: nullableNumber,
  event: nullableString,
  result: nullableString,
  distanceMeters: nullableNumber,
  sequence: nullableNumber,
  after: nullableNumber,
  reason: nullableString,
  decisionStatus: nullableString,
});

/**
 * AND-020 supervisor summary for the Android field app: one compact read with each field
 * person's day (coverage) and the day's exceptions, for a Manila service date.
 *
 * Scope is the server's, exactly as the web supervision views: the caller needs both
 * `people.read` and `visit.read` (field `sales` is refused) and sees only their current
 * organizational subtree. `directOnly` defaults to true, so the phone shows the caller's
 * direct reports unless it explicitly asks for the whole subtree. No raw device fixes,
 * actor tokens or audit history leave the server here; decisions stay on the web.
 */
export const team = query({
  args: {
    serviceDate: v.string(),
    directOnly: v.optional(v.boolean()),
  },
  returns: v.object({
    serviceDate: v.string(),
    generatedAt: v.number(),
    dayCloseAt: v.number(),
    directOnly: v.boolean(),
    truncated: v.boolean(),
    people: v.array(personRow),
    openExceptions: v.number(),
    totalExceptions: v.number(),
    exceptions: v.array(exceptionRow),
  }),
  handler: async (ctx, args) => {
    const filters = {
      serviceDate: args.serviceDate,
      directOnly: args.directOnly ?? true,
    };
    const sc = await supervisorContext(ctx, filters);
    const day = await teamDay(ctx, sc, filters);
    const { items, peopleTruncated } = await exceptionItems(ctx, sc, filters);
    return {
      serviceDate: args.serviceDate,
      generatedAt: Date.now(),
      dayCloseAt: day.closeAt,
      directOnly: filters.directOnly,
      truncated:
        day.truncated ||
        peopleTruncated ||
        items.length > MOBILE_EXCEPTION_LIMIT,
      people: day.people,
      openExceptions: items.filter((item) => item.open).length,
      totalExceptions: items.length,
      exceptions: items.slice(0, MOBILE_EXCEPTION_LIMIT).map((item) => ({
        id: item.id,
        kind: item.kind,
        open: item.open,
        profileId: item.profileId,
        personName: item.personName,
        outletCode: item.outletCode,
        outletName: item.outletName,
        at: item.at,
        event: item.event,
        result: item.result,
        distanceMeters: item.distanceMeters,
        sequence: item.sequence,
        after: item.after,
        reason: item.reason,
        decisionStatus: item.decision?.status ?? null,
      })),
    };
  },
});
