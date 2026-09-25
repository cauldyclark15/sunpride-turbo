import { ConvexError, v } from "convex/values";
import type { Infer } from "convex/values";
import { query } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { paginationOptsValidator } from "convex/server";
import type { Id } from "../_generated/dataModel";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { employeeAt, localDate } from "../coverage/validation";
import { activeAt } from "../org/validation";
import type { AuthorizedDevice } from "../mobile/types";
import { append } from "./events";
import { locationValidator, recordLocation } from "./location";
import { VISIT_LOCATION_POLICY } from "./policy";
import {
  accessOwnedVisit,
  accessVisit,
  assertToday,
  boundedText,
  validTime,
  visitTarget,
} from "./validation";

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
export const visitOperationValidator = v.union(
  v.object({
    kind: v.literal("visit.checkIn"),
    clientRequestId: v.string(),
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
    payload: v.object({
      visitId: v.id("visitExecutions"),
      activity,
      deviceTime: v.number(),
    }),
  }),
  v.object({
    kind: v.literal("visit.checkOut"),
    clientRequestId: v.string(),
    payload: v.object({
      visitId: v.id("visitExecutions"),
      outcome: v.union(v.literal("completed"), v.literal("nonproductive")),
      reasonCode: v.union(v.string(), v.null()),
      deviceTime: v.number(),
      location: locationValidator,
    }),
  }),
  v.object({ kind: v.literal("task.complete"), clientRequestId: v.string() }),
  v.object({
    kind: v.literal("collection.record"),
    clientRequestId: v.string(),
  }),
);
export type VisitOperation = Infer<typeof visitOperationValidator>;
export type VisitAck = {
  entityId: string;
  eventIds: Id<"executionEvents">[];
  serverTime: number;
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function requireUuid(value: string) {
  if (!uuid.test(value)) throw new ConvexError("invalid_request");
}
function safeActivity(a: Infer<typeof activity>) {
  if (a.kind === "note") boundedText(a.text, 2000);
  if (
    a.kind === "merchandising" &&
    a.actionTaken !== undefined &&
    a.actionTaken.length > 500
  )
    throw new ConvexError("invalid_request");
  if (a.kind === "promotion") boundedText(a.programRef);
  if (a.kind === "order_intent") {
    requireUuid(a.clientOrderId);
    if (a.note !== undefined && a.note.length > 500)
      throw new ConvexError("invalid_request");
  }
  if (
    a.kind === "inventory_check" &&
    a.observedQuantity !== undefined &&
    (!Number.isFinite(a.observedQuantity) ||
      a.observedQuantity < 0 ||
      a.observedQuantity > 1e9)
  )
    throw new ConvexError("invalid_request");
  if (
    a.kind === "price_check" &&
    (a.observedPriceMinor < 0n || !/^[A-Z]{3}$/.test(a.currency))
  )
    throw new ConvexError("invalid_request");
}
/** Called only from a proof-authorized transactional mobile writer; no public endpoint. */
export async function applyVisitOperation(
  ctx: MutationCtx,
  actor: AuthorizedDevice,
  operation: VisitOperation,
): Promise<VisitAck> {
  const now = Date.now();
  requireUuid(operation.clientRequestId);
  if (
    operation.kind === "task.complete" ||
    operation.kind === "collection.record"
  )
    throw new ConvexError("unsupported_operation");
  if (operation.kind === "visit.checkIn") {
    const p = operation.payload;
    requireUuid(p.clientVisitId);
    assertToday(p.serviceDate, now);
    validTime(p.deviceTime, now);
    if (p.intents.length > 8 || new Set(p.intents).size !== p.intents.length)
      throw new ConvexError("invalid_request");
    const { current, customerId } = await visitTarget(
      ctx,
      actor,
      p.outletId,
      p.serviceDate,
    );
    const assignment = current.assignment!;
    if (assignment.routeId) {
      const route = await ctx.db.get(assignment.routeId);
      if (
        !route ||
        route.status !== "active" ||
        !activeAt(route.effectiveFrom, undefined, Date.now())
      )
        throw new ConvexError("out_of_scope");
    }
    const assigned = await ctx.db
      .query("territorySalespeople")
      .withIndex("by_territoryId_and_effectiveFrom", (q) =>
        q.eq("territoryId", assignment.territoryId),
      )
      .take(501);
    if (
      assigned.length > 500 ||
      !assigned.some(
        (r) =>
          r.profileId === actor.profileId &&
          activeAt(r.effectiveFrom, r.effectiveTo, now),
      )
    )
      throw new ConvexError("out_of_scope");
    const sameClient = await ctx.db
      .query("visitExecutions")
      .withIndex("by_organizationId_and_clientVisitId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("clientVisitId", p.clientVisitId),
      )
      .take(2);
    if (sameClient.length) throw new ConvexError("conflict");
    let planId: Id<"coveragePlans"> | undefined,
      slotId: Id<"coveragePlanSlots"> | undefined,
      planVersion: number | undefined;
    let intents = p.intents;
    if (p.plannedVisitId) {
      const planned = await ctx.db.get(p.plannedVisitId);
      if (
        !planned ||
        planned.status !== "planned" ||
        planned.replacedByVisitId ||
        planned.assigneeProfileId !== actor.profileId ||
        planned.outletId !== p.outletId ||
        planned.serviceDate !== p.serviceDate
      )
        throw new ConvexError("invalid_plan");
      const plan = await ctx.db.get(planned.planId),
        slot = await ctx.db.get(planned.planSlotId);
      if (
        !plan ||
        !slot ||
        !plan.approvalSignature ||
        plan.status !== "active" ||
        plan.version !== planned.planVersion ||
        slot.planId !== plan._id ||
        slot.serviceDate !== p.serviceDate ||
        slot.assigneeProfileId !== actor.profileId ||
        slot.approvedSnapshot?.outletId !== p.outletId ||
        slot.approvedSnapshot.orgUnitId !== actor.orgUnitId ||
        slot.approvedSnapshot.approvedAssigneeProfileId !== actor.profileId ||
        plan.assigneeProfileId !== actor.profileId ||
        plan.orgUnitId !== actor.orgUnitId ||
        (plan.activeThrough !== undefined && now >= plan.activeThrough) ||
        JSON.stringify(slot.approvedSnapshot) !==
          JSON.stringify(planned.approvedSnapshot)
      )
        throw new ConvexError("invalid_plan");
      const serviceEmployee = await employeeAt(
        ctx,
        actor.profileId,
        localDate(p.serviceDate),
      );
      if (serviceEmployee._id !== slot.approvedSnapshot.employeeAssignmentId)
        throw new ConvexError("invalid_plan");
      const existing = await ctx.db
        .query("visitExecutions")
        .withIndex("by_plannedVisitId", (q) =>
          q.eq("plannedVisitId", p.plannedVisitId!),
        )
        .take(2);
      if (existing.length) throw new ConvexError("conflict");
      planId = plan._id;
      slotId = slot._id;
      planVersion = plan.version;
      if (JSON.stringify(intents) !== JSON.stringify(planned.intents))
        throw new ConvexError("invalid_plan");
      intents = planned.intents as typeof intents;
    } else {
      boundedText(p.unplannedReason ?? "", 500);
    }
    const visitId = await ctx.db.insert("visitExecutions", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      clientVisitId: p.clientVisitId,
      plannedVisitId: p.plannedVisitId ?? undefined,
      planId,
      slotId,
      planVersion,
      assigneeProfileId: actor.profileId,
      outletId: p.outletId,
      orgUnitId: current.orgUnitId,
      routeId: current.assignment!.routeId,
      customerId,
      serviceDate: p.serviceDate,
      source: p.plannedVisitId ? "planned" : "unplanned",
      intents,
      state: "checked-in",
      reasonCode: p.unplannedReason?.trim(),
      productivity: "pending",
      ruleVersion: VISIT_LOCATION_POLICY.version,
      createdAt: now,
      lastServerTime: now,
      checkedInAt: now,
    });
    const visit = (await ctx.db.get(visitId))!;
    await recordLocation(ctx, visit, "check_in", p.location, p.deviceTime, now);
    const eventId = await append(ctx, {
      orgUnitId: visit.orgUnitId,
      entityType: "visit",
      entityId: visitId,
      kind: "visit.checked_in",
      actorSubject: actor.subject,
      actorRole: actor.role,
      actorOrgUnitId: actor.orgUnitId,
      deviceId: actor.deviceId,
      source: "mobile",
      operationKey: operation.clientRequestId,
      occurredAt: p.deviceTime,
      serverAt: now,
      ownerProfileId: actor.profileId,
      summary: { after: "checked-in" },
      policyVersion: VISIT_LOCATION_POLICY.version,
    });
    return { entityId: visitId, eventIds: [eventId], serverTime: now };
  }
  validTime(operation.payload.deviceTime, now);
  const visit = await accessOwnedVisit(ctx, actor, operation.payload.visitId);
  if (operation.kind === "visit.activity") {
    const p = operation.payload;
    if (visit.state !== "checked-in" && visit.state !== "in-progress")
      throw new ConvexError("invalid_transition");
    safeActivity(p.activity);
    if (
      p.activity.kind === "inventory_check" ||
      p.activity.kind === "price_check"
    ) {
      const product = await ctx.db.get(p.activity.productId);
      if (
        !product?.active ||
        (product.organizationId &&
          product.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      )
        throw new ConvexError("invalid_request");
    }
    if (
      p.activity.kind === "inventory_check" &&
      p.activity.uomId &&
      !(await ctx.db.get(p.activity.uomId))
    )
      throw new ConvexError("invalid_request");
    const activityId = await ctx.db.insert("visitActivities", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      orgUnitId: visit.orgUnitId,
      visitId: visit._id,
      assigneeProfileId: actor.profileId,
      outletId: visit.outletId,
      activity: p.activity,
      evidenceIds: [],
      deviceTime: p.deviceTime,
      serverTime: now,
    });
    await ctx.db.patch(visit._id, {
      state: "in-progress",
      lastServerTime: now,
    });
    const eventId = await append(ctx, {
      orgUnitId: visit.orgUnitId,
      entityType: "activity",
      entityId: activityId,
      kind: `activity.${p.activity.kind}`,
      actorSubject: actor.subject,
      actorRole: actor.role,
      actorOrgUnitId: actor.orgUnitId,
      deviceId: actor.deviceId,
      source: "mobile",
      operationKey: operation.clientRequestId,
      occurredAt: p.deviceTime,
      serverAt: now,
      ownerProfileId: actor.profileId,
      summary: { after: p.activity.kind },
    });
    return { entityId: activityId, eventIds: [eventId], serverTime: now };
  }
  const p = operation.payload;
  if (visit.state !== "checked-in" && visit.state !== "in-progress")
    throw new ConvexError("invalid_transition");
  if (p.outcome === "nonproductive") boundedText(p.reasonCode ?? "");
  else if (p.reasonCode) boundedText(p.reasonCode);
  await recordLocation(ctx, visit, "check_out", p.location, p.deviceTime, now);
  // No automatic certification, productivity or per-diem: a separate rule needs client sign-off.
  await ctx.db.patch(visit._id, {
    state: "checked-out",
    outcome: p.outcome,
    reasonCode: p.reasonCode ?? undefined,
    checkedOutAt: now,
    lastServerTime: now,
    productivity: p.outcome === "nonproductive" ? "nonproductive" : "pending",
  });
  const eventId = await append(ctx, {
    orgUnitId: visit.orgUnitId,
    entityType: "visit",
    entityId: visit._id,
    kind: "visit.checked_out",
    actorSubject: actor.subject,
    actorRole: actor.role,
    actorOrgUnitId: actor.orgUnitId,
    deviceId: actor.deviceId,
    source: "mobile",
    operationKey: operation.clientRequestId,
    occurredAt: p.deviceTime,
    serverAt: now,
    ownerProfileId: actor.profileId,
    summary: { before: visit.state, after: "checked-out" },
    policyVersion: VISIT_LOCATION_POLICY.version,
  });
  return { entityId: visit._id, eventIds: [eventId], serverTime: now };
}

// Narrow, location-free DTOs. Raw evidence is not part of visit.read.
const visitDTO = v.object({
  id: v.id("visitExecutions"),
  outletId: v.id("outlets"),
  serviceDate: v.string(),
  state: v.string(),
  source: v.string(),
  productivity: v.string(),
  plannedVisitId: v.union(v.id("plannedVisits"), v.null()),
  checkedInAt: v.union(v.number(), v.null()),
  checkedOutAt: v.union(v.number(), v.null()),
});
function dto(row: {
  _id: Id<"visitExecutions">;
  outletId: Id<"outlets">;
  serviceDate: string;
  state: string;
  source: string;
  productivity: string;
  plannedVisitId?: Id<"plannedVisits">;
  checkedInAt?: number;
  checkedOutAt?: number;
}) {
  return {
    id: row._id,
    outletId: row.outletId,
    serviceDate: row.serviceDate,
    state: row.state,
    source: row.source,
    productivity: row.productivity,
    plannedVisitId: row.plannedVisitId ?? null,
    checkedInAt: row.checkedInAt ?? null,
    checkedOutAt: row.checkedOutAt ?? null,
  };
}
export const detail = query({
  args: { visitId: v.id("visitExecutions") },
  returns: visitDTO,
  handler: async (ctx, { visitId }) => {
    const row = await ctx.db.get(visitId);
    if (!row) throw new ConvexError("out_of_scope");
    await accessVisit(ctx, row, "visit.read");
    return dto(row);
  },
});
export const forDay = query({
  args: { serviceDate: v.string(), paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(visitDTO),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { serviceDate, paginationOpts }) => {
    localDate(serviceDate);
    if (paginationOpts.numItems < 1 || paginationOpts.numItems > 50)
      throw new ConvexError("invalid_request");
    const { profile } = await requireCapability(ctx, "visit.read");
    if (profile.role !== "sales") throw new ConvexError("out_of_scope");
    await employeeAt(ctx, profile._id, Date.now());
    const page = await ctx.db
      .query("visitExecutions")
      .withIndex(
        "by_organizationId_and_assigneeProfileId_and_serviceDate",
        (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("assigneeProfileId", profile._id)
            .eq("serviceDate", serviceDate),
      )
      .paginate(paginationOpts);
    for (const row of page.page) await accessVisit(ctx, row, "visit.read");
    return {
      page: page.page.map(dto),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
