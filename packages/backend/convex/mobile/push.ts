import { ConvexError, v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { devicePerson } from "./device_auth";
import type { AuthorizedDevice } from "./types";
import { findOrExecute } from "./idempotency";
import { applyVisitOperation, type VisitOperation } from "../visits/commands";
import { locationValidator } from "../visits/location";
import { accessOwnedVisit, visitTarget } from "../visits/validation";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const intent = v.union(
  ...(
    [
      "sell",
      "collect",
      "merchandise",
      "audit",
      "deliver",
      "promotion",
      "complaint",
      "follow-up",
    ] as const
  ).map(v.literal),
);
const activity = v.union(
  v.object({
    kind: v.literal("inventory_check"),
    productId: v.id("products"),
    icoFinding: v.union(
      v.literal("present"),
      v.literal("absent"),
      v.literal("unknown"),
    ),
    observedQuantity: v.optional(v.number()),
    uomId: v.optional(v.id("unitsOfMeasure")),
  }),
  v.object({
    kind: v.literal("merchandising"),
    displayCondition: v.union(
      v.literal("compliant"),
      v.literal("needs_action"),
      v.literal("not_present"),
    ),
    actionTaken: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("price_check"),
    productId: v.id("products"),
    observedPriceMinor: v.int64(),
    currency: v.string(),
    compliant: v.optional(v.boolean()),
  }),
  v.object({
    kind: v.literal("promotion"),
    programRef: v.string(),
    finding: v.union(
      v.literal("executed"),
      v.literal("not_executed"),
      v.literal("not_applicable"),
    ),
  }),
  v.object({
    kind: v.literal("order_intent"),
    clientOrderId: v.string(),
    note: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("note"), text: v.string() }),
);
const operation = v.union(
  v.object({
    kind: v.literal("visit.checkIn"),
    clientRequestId: v.string(),
    clientVisitId: v.optional(v.string()),
    dependsOn: v.optional(v.array(v.string())),
    payload: v.object({
      clientVisitId: v.string(),
      plannedVisitId: v.union(v.id("plannedVisits"), v.null()),
      outletId: v.id("outlets"),
      serviceDate: v.string(),
      deviceTime: v.number(),
      location: locationValidator,
      intents: v.array(intent),
      unplannedReason: v.optional(v.string()),
    }),
  }),
  v.object({
    kind: v.literal("visit.activity"),
    clientRequestId: v.string(),
    clientVisitId: v.optional(v.string()),
    dependsOn: v.optional(v.array(v.string())),
    payload: v.object({
      visitId: v.id("visitExecutions"),
      activity,
      deviceTime: v.number(),
    }),
  }),
  v.object({
    kind: v.literal("visit.checkOut"),
    clientRequestId: v.string(),
    clientVisitId: v.optional(v.string()),
    dependsOn: v.optional(v.array(v.string())),
    payload: v.object({
      visitId: v.id("visitExecutions"),
      outcome: v.union(v.literal("completed"), v.literal("nonproductive")),
      reasonCode: v.union(v.string(), v.null()),
      deviceTime: v.number(),
      location: locationValidator,
    }),
  }),
  v.object({
    kind: v.literal("task.complete"),
    clientRequestId: v.string(),
    clientVisitId: v.optional(v.string()),
    dependsOn: v.optional(v.array(v.string())),
    payload: v.any(),
  }),
  v.object({
    kind: v.literal("collection.record"),
    clientRequestId: v.string(),
    clientVisitId: v.optional(v.string()),
    dependsOn: v.optional(v.array(v.string())),
    payload: v.any(),
  }),
);
const actorValidator = v.object({
  deviceId: v.id("registeredDevices"),
  profileId: v.id("profiles"),
  subject: v.string(),
  orgUnitId: v.id("orgUnits"),
  role: v.union(
    ...(
      [
        "super_admin",
        "admin",
        "operations",
        "manager",
        "approver",
        "sales",
        "analyst",
        "viewer",
      ] as const
    ).map(v.literal),
  ),
  scopeFingerprint: v.string(),
});
const resultValidator = v.union(
  v.object({
    status: v.literal("accepted"),
    ack: v.object({
      entityId: v.string(),
      eventIds: v.array(v.id("executionEvents")),
      serverTime: v.number(),
    }),
  }),
  v.object({ status: v.literal("rejected"), code: v.string() }),
  v.object({ status: v.literal("conflict"), code: v.literal("conflict") }),
);

/** Recheck persisted person/device and visit scope before consulting the registry. */
async function reauthorize(
  ctx: MutationCtx,
  actor: AuthorizedDevice,
  op: typeof operation.type,
): Promise<void> {
  const { device, profile, assignment, subject } = await devicePerson(
    ctx,
    actor.deviceId,
  );
  if (
    profile._id !== actor.profileId ||
    subject !== actor.subject ||
    assignment.orgUnitId !== actor.orgUnitId ||
    profile.role !== actor.role ||
    device.allowedApp === "VAN_ANDROID" ||
    !device.publicKey ||
    !device.credentialId ||
    !device.boundSubject ||
    !actor.scopeFingerprint
  )
    throw new ConvexError("unauthorized");
  await requireCapability(ctx, "visit.record", actor.orgUnitId);
  if (op.kind === "visit.checkIn") {
    await visitTarget(ctx, actor, op.payload.outletId, op.payload.serviceDate);
    if (op.payload.plannedVisitId) {
      const planned = await ctx.db.get(op.payload.plannedVisitId);
      if (
        !planned ||
        planned.status !== "planned" ||
        planned.replacedByVisitId ||
        planned.assigneeProfileId !== actor.profileId ||
        planned.outletId !== op.payload.outletId ||
        planned.serviceDate !== op.payload.serviceDate
      )
        throw new ConvexError("invalid_plan");
    }
  } else if (op.kind === "visit.activity" || op.kind === "visit.checkOut") {
    await accessOwnedVisit(ctx, actor, op.payload.visitId);
  }
}

export const applyOne = internalMutation({
  args: {
    actor: actorValidator,
    deviceId: v.id("registeredDevices"),
    operation,
  },
  returns: resultValidator,
  handler: async (ctx, { actor, deviceId, operation: op }) => {
    if (deviceId !== actor.deviceId) throw new ConvexError("unauthorized");
    await reauthorize(ctx, actor, op);
    if (
      !uuid.test(op.clientRequestId) ||
      (op.clientVisitId !== undefined &&
        (!uuid.test(op.clientVisitId) ||
          (op.kind === "visit.checkIn" &&
            op.clientVisitId !== op.payload.clientVisitId)))
    )
      return { status: "rejected" as const, code: "invalid_request" };
    if (op.kind === "task.complete" || op.kind === "collection.record")
      return { status: "rejected" as const, code: "unsupported_operation" };
    const dependencies = op.dependsOn ?? [];
    if (
      dependencies.length > 20 ||
      new Set(dependencies).size !== dependencies.length ||
      dependencies.some((key) => !uuid.test(key) || key === op.clientRequestId)
    )
      return { status: "rejected" as const, code: "invalid_request" };
    for (const key of dependencies) {
      let acknowledged = 0;
      for (const kind of [
        "visit.checkIn",
        "visit.activity",
        "visit.checkOut",
        "task.complete",
        "collection.record",
      ] as const) {
        const rows = await ctx.db
          .query("processedMobileOperations")
          .withIndex("by_organizationId_and_kind_and_clientRequestId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("kind", kind)
              .eq("clientRequestId", key),
          )
          .take(2);
        if (rows.length > 1) throw new ConvexError("conflict");
        if (
          rows[0]?.deviceId === actor.deviceId &&
          rows[0]?.profileId === actor.profileId &&
          rows[0].serverAt <= Date.now()
        )
          acknowledged++;
      }
      if (acknowledged !== 1)
        return { status: "rejected" as const, code: "dependency_missing" };
    }
    return findOrExecute(ctx, {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      kind: op.kind,
      key: op.clientRequestId,
      actor,
      canonicalPayload: { payload: op.payload, dependsOn: dependencies },
      execute: () =>
        applyVisitOperation(ctx, actor, {
          kind: op.kind,
          clientRequestId: op.clientRequestId,
          payload: op.payload,
        } as VisitOperation),
    });
  },
});
