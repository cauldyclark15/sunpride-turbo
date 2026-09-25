import { ConvexError, v } from "convex/values";
import { internalQuery, type QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { manilaDate } from "../coverage/validation";
import { resolveOutletScopeAt } from "../outlets/validation";
import {
  actorValidator,
  CURSOR_TTL_MS,
  readCursor,
  signCursor,
} from "./cursor";
import { assertDevice, dayProjection } from "./projection";
import type { AuthorizedDevice } from "./types";

const changeDTO = v.object({
  seq: v.number(),
  entity: v.string(),
  id: v.string(),
  revision: v.number(),
  op: v.union(v.literal("upsert"), v.literal("tombstone")),
  value: v.optional(v.record(v.string(), v.any())),
});
type Change = typeof changeDTO.type;
async function project(
  ctx: QueryCtx,
  row: Doc<"mobileChanges">,
  actor: AuthorizedDevice,
  now: number,
): Promise<Change | null> {
  // A historical unit or a client cursor is never an access grant.
  if (
    row.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
    row.ownerProfileId !== actor.profileId ||
    (row.ownerSubject && row.ownerSubject !== actor.subject)
  )
    return null;
  const common = {
    seq: row.sequence,
    entity: row.entity,
    id: row.entityId,
    revision: row.revision,
  };
  if (row.op === "tombstone" || row.orgUnitId !== actor.orgUnitId)
    return { ...common, op: "tombstone" };
  if (row.entity === "visit") {
    const id = ctx.db.normalizeId("visitExecutions", row.entityId);
    if (!id) throw new ConvexError("rebootstrap_required");
    const visit = await ctx.db.get(id);
    if (
      !visit ||
      visit.assigneeProfileId !== actor.profileId ||
      visit.organizationId !== SUNPRIDE_ORGANIZATION_ID
    )
      return { ...common, op: "tombstone" };
    const scope = await resolveOutletScopeAt(ctx, visit.outletId, now);
    if (
      scope.orgUnitId !== actor.orgUnitId ||
      scope.outlet.status === "inactive"
    )
      return { ...common, op: "tombstone" };
    return {
      ...common,
      op: "upsert",
      value: {
        id: visit._id,
        outletId: visit.outletId,
        serviceDate: visit.serviceDate,
        state: visit.state,
        productivity: visit.productivity,
        plannedVisitId: visit.plannedVisitId ?? null,
      },
    };
  }
  if (row.entity === "activity") {
    const id = ctx.db.normalizeId("visitActivities", row.entityId);
    if (!id) throw new ConvexError("rebootstrap_required");
    const activity = await ctx.db.get(id);
    if (
      !activity ||
      activity.assigneeProfileId !== actor.profileId ||
      activity.organizationId !== SUNPRIDE_ORGANIZATION_ID
    )
      return { ...common, op: "tombstone" };
    const scope = await resolveOutletScopeAt(ctx, activity.outletId, now);
    if (
      scope.orgUnitId !== actor.orgUnitId ||
      scope.outlet.status === "inactive"
    )
      return { ...common, op: "tombstone" };
    return {
      ...common,
      op: "upsert",
      value: {
        id: activity._id,
        visitId: activity.visitId,
        kind: activity.activity.kind,
        serverTime: activity.serverTime,
      },
    };
  }
  // No audited mobile projection exists for other entity kinds; never return a stale success.
  throw new ConvexError("rebootstrap_required");
}

export const delta = internalQuery({
  args: {
    actor: actorValidator,
    cursor: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    type: v.literal("pull.response"),
    contractVersion: v.literal(1),
    serverTime: v.number(),
    changes: v.array(changeDTO),
    nextCursor: v.string(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, { actor, cursor: token, limit }) => {
    const now = Date.now();
    await assertDevice(ctx, actor, now);
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    )
      throw new ConvexError("invalid_request");
    const cursor = await readCursor(token, "pull", actor, now);
    const day = manilaDate(now);
    if (
      cursor.day !== day ||
      (await dayProjection(ctx, actor, day, now)).manifest !== cursor.manifest
    )
      throw new ConvexError("rebootstrap_required");
    // Close a finite window at the start of each new pull cycle. Continue that exact high-water
    // over filtered pages; a later write cannot move the end of this cycle.
    const latest =
      cursor.after === cursor.watermark
        ? await ctx.db
            .query("mobileChanges")
            .withIndex("by_organizationId_and_sequence", (q) =>
              q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
            )
            .order("desc")
            .first()
        : null;
    const high = latest?.sequence ?? cursor.watermark;
    if (high < cursor.after) throw new ConvexError("rebootstrap_required");
    const rows = await ctx.db
      .query("mobileChanges")
      .withIndex("by_organizationId_and_sequence", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .gt("sequence", cursor.after)
          .lte("sequence", high),
      )
      .take((limit ?? 50) + 1);
    const selected = rows.slice(0, limit ?? 50);
    let expected = cursor.after;
    for (const row of selected) {
      if (row.sequence !== expected + 1 || !Number.isSafeInteger(row.sequence))
        throw new ConvexError("rebootstrap_required");
      expected = row.sequence;
    }
    if (
      rows.length > selected.length &&
      rows[selected.length]?.sequence !== expected + 1
    )
      throw new ConvexError("rebootstrap_required");
    if (!rows.length && high > cursor.after)
      throw new ConvexError("rebootstrap_required");
    const changes: Change[] = [];
    for (const row of selected) {
      const change = await project(ctx, row, actor, now);
      if (change) changes.push(change);
    }
    const hasMore = rows.length > selected.length;
    const next = {
      ...cursor,
      watermark: high,
      after: hasMore ? expected : high,
      tie: selected.at(-1)?._id ?? cursor.tie,
      expires: now + CURSOR_TTL_MS,
    };
    return {
      type: "pull.response" as const,
      contractVersion: 1 as const,
      serverTime: now,
      changes,
      nextCursor: await signCursor(next),
      hasMore,
    };
  },
});
