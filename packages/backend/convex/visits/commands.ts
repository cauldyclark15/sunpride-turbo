import { ConvexError, v } from "convex/values";
import type { Infer } from "convex/values";
import { query } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { employeeAt, localDate } from "../coverage/validation";
import { activeAt } from "../org/validation";
import type { AuthorizedDevice } from "../mobile/types";
import { append } from "./events";
import { locationValidator, recordLocation } from "./location";
import { VISIT_LOCATION_POLICY } from "./policy";
import { missingKinds, rulesAt, ruleVersionFor } from "./activity_rules";
import { callSheetActivityValidator } from "../callSheets/validators";
import {
  fieldOrderLineValidator,
  validateFieldOrderLines,
} from "../orders/field_order_validators";
import { validateFieldOrder } from "../orders/field_order";
import {
  accountFor,
  callSheetWeek,
  usableProduct,
  validateCaptureLines,
} from "../callSheets/model";
import {
  accessOwnedVisit,
  accessVisit,
  assertServiceDay,
  boundedText,
  isLate,
  validTime,
  visitTarget,
} from "./validation";

/** Visit states that hold the salesperson at the current store. */
export const OPEN_CALL_STATES = new Set([
  "arrived",
  "checked-in",
  "in-progress",
]);
/** Visit states that close a call (End recorded, or resolved by a supervisor). */
export const CLOSED_CALL_STATES = new Set([
  "checked-out",
  "completed",
  "skipped",
  "rescheduled",
  "missed",
]);
const MAX_DAY_CALLS = 200;
const MAX_VISIT_ACTIVITIES = 500;

/**
 * MCP order (client call 2 Oct 2026): a salesperson cannot start another store while a
 * call is open, and cannot start a planned store before every planned store with a
 * lower sequence that day is closed with its productivity recorded.
 */
async function assertCallOrder(
  ctx: MutationCtx,
  actor: AuthorizedDevice,
  serviceDate: string,
  planned?: { id: Id<"plannedVisits">; sequence: number },
) {
  const calls = await ctx.db
    .query("visitExecutions")
    .withIndex("by_organizationId_and_assigneeProfileId_and_serviceDate", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("assigneeProfileId", actor.profileId)
        .eq("serviceDate", serviceDate),
    )
    .take(MAX_DAY_CALLS + 1);
  if (calls.length > MAX_DAY_CALLS) throw new ConvexError("invalid_request");
  if (calls.some((call) => OPEN_CALL_STATES.has(call.state)))
    throw new ConvexError("call_open");
  if (!planned) return;
  const closed = new Set(
    calls.flatMap((call) =>
      CLOSED_CALL_STATES.has(call.state) && call.plannedVisitId
        ? [call.plannedVisitId]
        : [],
    ),
  );
  const stops = await ctx.db
    .query("plannedVisits")
    .withIndex("by_assigneeProfileId_and_serviceDate", (q) =>
      q.eq("assigneeProfileId", actor.profileId).eq("serviceDate", serviceDate),
    )
    .take(MAX_DAY_CALLS + 1);
  if (stops.length > MAX_DAY_CALLS) throw new ConvexError("invalid_request");
  for (const stop of stops) {
    if (
      stop._id === planned.id ||
      stop.status !== "planned" ||
      stop.replacedByVisitId ||
      closed.has(stop._id)
    )
      continue;
    const slot = await ctx.db.get(stop.planSlotId);
    if (slot && slot.sequence < planned.sequence)
      throw new ConvexError("mcp_order");
  }
}

/** Work for a day reaching the server after its 10 PM close is kept and held for review. */
async function flagLateWork(
  ctx: MutationCtx,
  visit: Doc<"visitExecutions">,
  now: number,
) {
  if (!isLate(visit.serviceDate, now)) return false;
  if (visit.lateReviewStatus !== "pending_review")
    await ctx.db.patch(visit._id, {
      lateSyncAt: visit.lateSyncAt ?? now,
      lateReviewStatus: "pending_review",
    });
  return true;
}

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
    lines: v.optional(v.array(fieldOrderLineValidator)),
  }),
  v.object({ kind: v.literal("note"), text: v.string() }),
  callSheetActivityValidator,
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
  if (a.kind === "call_sheet") validateCaptureLines(a.lines);
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
    if (a.lines !== undefined) validateFieldOrderLines(a.lines);
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
    validTime(p.deviceTime, now);
    assertServiceDay(p.serviceDate, p.deviceTime, now);
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
    let unplannedReason: string | undefined;
    let plannedOrder: { id: Id<"plannedVisits">; sequence: number } | undefined;
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
      plannedOrder = { id: planned._id, sequence: slot.sequence };
    } else {
      unplannedReason = boundedText(p.unplannedReason ?? "", 500);
    }
    await assertCallOrder(ctx, actor, p.serviceDate, plannedOrder);
    const late = isLate(p.serviceDate, now);
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
      unplannedReason,
      productivity: "pending",
      ruleVersion: VISIT_LOCATION_POLICY.version,
      createdAt: now,
      lastServerTime: now,
      checkedInAt: now,
      startedAt: p.deviceTime,
      ...(late
        ? { lateSyncAt: now, lateReviewStatus: "pending_review" as const }
        : {}),
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
      summary: {
        after: "checked-in",
        ...(late ? { reasonCode: "late_sync" } : {}),
      },
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
    // Annex C needs an office-maintained account sheet. Products are not restricted to its
    // current rows so an office edit during the day never strands a queued phone capture.
    const account =
      p.activity.kind === "call_sheet"
        ? await accountFor(ctx, visit.outletId)
        : null;
    if (p.activity.kind === "call_sheet") {
      if (!account) throw new ConvexError("invalid_request");
      for (const line of p.activity.lines)
        if (!usableProduct(await ctx.db.get(line.productId)))
          throw new ConvexError("invalid_request");
    }
    if (p.activity.kind === "order_intent" && p.activity.lines !== undefined)
      await validateFieldOrder(
        ctx,
        visit._id,
        visit.outletId,
        p.activity.clientOrderId,
        p.activity.lines,
      );
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
    if (p.activity.kind === "call_sheet" && account) {
      const { localMonth, week } = callSheetWeek(visit.serviceDate);
      for (const line of p.activity.lines)
        await ctx.db.insert("callSheetEntries", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          orgUnitId: visit.orgUnitId,
          outletId: visit.outletId,
          visitId: visit._id,
          activityId,
          assigneeProfileId: actor.profileId,
          serviceDate: visit.serviceDate,
          localMonth,
          week,
          templateRevision: account.revision,
          ...line,
          serverTime: now,
        });
    }
    await ctx.db.patch(visit._id, {
      state: "in-progress",
      lastServerTime: now,
    });
    const late = await flagLateWork(ctx, visit, now);
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
      summary: {
        after: p.activity.kind,
        ...(late ? { reasonCode: "late_sync" } : {}),
      },
    });
    return { entityId: activityId, eventIds: [eventId], serverTime: now };
  }
  const p = operation.payload;
  if (visit.state !== "checked-in" && visit.state !== "in-progress")
    throw new ConvexError("invalid_transition");
  if (p.outcome === "nonproductive") boundedText(p.reasonCode ?? "");
  else if (p.reasonCode) boundedText(p.reasonCode);
  await recordLocation(ctx, visit, "check_out", p.location, p.deviceTime, now);
  // No automatic certification or per-diem here; productive-call evaluation is separate.
  // End = phone time after the call; time per account is End - Start on the phone clock.
  const startedAt = visit.startedAt ?? visit.checkedInAt ?? p.deviceTime;
  // AND-013: never refuse a queued End; record which required forms are missing under the
  // rules in effect when the call started (the phone downloaded those with its day).
  const recorded = await ctx.db
    .query("visitActivities")
    .withIndex("by_visitId_and_serverTime", (q) => q.eq("visitId", visit._id))
    .take(MAX_VISIT_ACTIVITIES + 1);
  if (recorded.length > MAX_VISIT_ACTIVITIES)
    throw new ConvexError("invalid_request");
  const rules = await rulesAt(ctx, startedAt);
  const missingActivities =
    p.outcome === "completed"
      ? missingKinds(
          rules,
          visit.intents,
          recorded.map((row) => row.activity.kind),
        )
      : [];
  await ctx.db.patch(visit._id, {
    activityRuleVersion: ruleVersionFor(rules, visit.intents),
    missingActivities,
    state: "checked-out",
    outcome: p.outcome,
    ...(p.reasonCode != null ? { reasonCode: p.reasonCode } : {}),
    checkedOutAt: now,
    lastServerTime: now,
    endedAt: p.deviceTime,
    callDurationMs: Math.max(0, p.deviceTime - startedAt),
    productivity: p.outcome === "nonproductive" ? "nonproductive" : "pending",
  });
  const late = await flagLateWork(ctx, visit, now);
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
    summary: {
      before: visit.state,
      after: "checked-out",
      ...(late ? { reasonCode: "late_sync" } : {}),
    },
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
  unplannedReason: v.union(v.string(), v.null()),
  plannedVisitId: v.union(v.id("plannedVisits"), v.null()),
  /** The visit's objectives and, after End, required activity forms not recorded. */
  intents: v.array(v.string()),
  missingActivities: v.union(v.array(v.string()), v.null()),
  checkedInAt: v.union(v.number(), v.null()),
  checkedOutAt: v.union(v.number(), v.null()),
  /** Start (arrival) and End (after the call), phone clock; time per account. */
  startedAt: v.union(v.number(), v.null()),
  endedAt: v.union(v.number(), v.null()),
  callDurationMs: v.union(v.number(), v.null()),
  /** Set when the day's work reached the server after its 10 PM close. */
  lateReviewStatus: v.union(
    v.literal("pending_review"),
    v.literal("accepted"),
    v.literal("rejected"),
    v.null(),
  ),
});
function dto(row: Doc<"visitExecutions">) {
  return {
    id: row._id,
    outletId: row.outletId,
    serviceDate: row.serviceDate,
    state: row.state,
    source: row.source,
    productivity: row.productivity,
    unplannedReason: row.unplannedReason ?? null,
    plannedVisitId: row.plannedVisitId ?? null,
    intents: row.intents,
    missingActivities: row.missingActivities ?? null,
    checkedInAt: row.checkedInAt ?? null,
    checkedOutAt: row.checkedOutAt ?? null,
    startedAt: row.startedAt ?? null,
    endedAt: row.endedAt ?? null,
    callDurationMs: row.callDurationMs ?? null,
    lateReviewStatus: row.lateReviewStatus ?? null,
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
