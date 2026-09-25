import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { AppRole } from "../lib/roles";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { ConvexError } from "convex/values";

/** Explicit redacted event fields only. Never forward arbitrary client payloads here. */
export type EventInput = {
  orgUnitId: Id<"orgUnits">;
  entityType:
    | "visit"
    | "activity"
    | "task"
    | "collection"
    | "device"
    | "order"
    | "inventory";
  entityId: string;
  kind: string;
  actorSubject: string;
  actorRole: AppRole;
  actorOrgUnitId: Id<"orgUnits">;
  deviceId?: Id<"registeredDevices">;
  source: "mobile" | "web" | "system";
  operationKey?: string;
  correlationId?: string;
  occurredAt: number;
  serverAt: number;
  summary: { before?: string; after?: string; reasonCode?: string };
  ownerProfileId?: Id<"profiles">;
  policyVersion?: string;
};
const SAFE_SUMMARY = /^[a-zA-Z0-9_.-]{1,80}$/;
/** Append event and monotonic sync sequence inside the caller's transaction. */
export async function append(ctx: MutationCtx, input: EventInput) {
  if (
    !input.actorSubject.includes("|") ||
    ![
      input.summary.before,
      input.summary.after,
      input.summary.reasonCode,
    ].every((x) => x === undefined || SAFE_SUMMARY.test(x))
  )
    throw new ConvexError("invalid_event_summary");
  const { ownerProfileId, ...event } = input;
  const eventId = await ctx.db.insert("executionEvents", {
    ...event,
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    schemaVersion: 1,
  });
  const latest = await ctx.db
    .query("mobileChanges")
    .withIndex("by_organizationId_and_sequence", (q) =>
      q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
    )
    .order("desc")
    .first();
  const sequence = (latest?.sequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence))
    throw new ConvexError("change_sequence_exhausted");
  await ctx.db.insert("mobileChanges", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    orgUnitId: input.orgUnitId,
    sequence,
    entity: input.entityType,
    entityId: input.entityId,
    revision: sequence,
    op: "upsert",
    ownerProfileId,
    serverAt: input.serverAt,
    payloadVersion: 1,
  });
  return eventId;
}
