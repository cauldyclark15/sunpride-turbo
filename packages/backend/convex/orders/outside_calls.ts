/**
 * CALL-09 outside-call purchase orders (2 Oct 2026 call, 17:25–23:30).
 *
 * "If a store sends a PO when it is not in that day's MCP (an outside call), the sales admin
 * encodes the PO, and the salesperson records the activity."
 *
 * - The sales admin (`order.encode`: office roles) encodes the store's PO against the outlet
 *   and the salesperson who covers it. Encoding is refused when the store IS in that
 *   salesperson's plan for the day: a planned call's PO is entered at the visit.
 * - The credited salesperson (only them) then records the activity: how the store reached
 *   them and any other productive activity done for the store.
 * - An outside call is off plan, so it never counts toward the day's calls or productive-call
 *   percentage (`sfa/productive_call.ts`); reports show it separately.
 * - No SAP posting and no stock movement happen here. Encoding into SAP stays with the
 *   sales admin's existing process until the integration carries field POs.
 *
 * Phone apps call the same public functions with their Convex JWT.
 */
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { localDate, manilaDate } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds } from "../lib/scope";
import { activeAt, audit } from "../org/validation";
import {
  outletRows,
  required,
  requireOutletCapability,
} from "../outlets/validation";
import schema from "../schema";
import {
  isProductiveActivityCode,
  PRODUCTIVE_ACTIVITY_CODES,
} from "../sfa/productive_call";

type Ctx = QueryCtx | MutationCtx;

export const MAX_PO_LINES = 100;
export const MAX_BACKDATE_DAYS = 31;
const MAX_QUANTITY = 1_000_000;
const MAX_PAGE = 50;
const MAX_ROSTER = 500;
const DAY_MS = 86_400_000;

export const receivedViaValidator = v.union(
  v.literal("email"),
  v.literal("viber"),
  v.literal("phone"),
  v.literal("fax"),
  v.literal("other"),
);
export const activityContactValidator = v.union(
  v.literal("phone"),
  v.literal("message"),
  v.literal("in_person"),
  v.literal("other"),
);
const statusValidator = v.union(
  v.literal("awaiting_activity"),
  v.literal("activity_recorded"),
  v.literal("cancelled"),
);

/** A store PO date: a real Manila date, not in the future, at most a month back. */
export function assertPoDate(serviceDate: string, now: number) {
  localDate(serviceDate);
  const today = manilaDate(now);
  if (serviceDate > today)
    throw new ConvexError("PO date cannot be in the future");
  if (serviceDate < manilaDate(now - MAX_BACKDATE_DAYS * DAY_MS))
    throw new ConvexError(`PO date is more than ${MAX_BACKDATE_DAYS} days ago`);
}

/** The activity codes the salesperson recorded; the PO itself is always one of them. */
export function normalizeActivityCodes(codes: readonly string[]) {
  for (const code of codes)
    if (!isProductiveActivityCode(code))
      throw new ConvexError(`Unknown activity: ${code}`);
  const chosen = new Set<string>(["purchase_order", ...codes]);
  return PRODUCTIVE_ACTIVITY_CODES.filter((code) => chosen.has(code));
}

export function assertQuantity(quantity: number) {
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QUANTITY)
    throw new ConvexError("Quantity must be more than 0");
}

/** Salespeople actively covering the outlet's current territory. */
async function coveringSalespeople(
  ctx: Ctx,
  territoryId: Id<"territories">,
  now: number,
) {
  const rows = await ctx.db
    .query("territorySalespeople")
    .withIndex("by_territoryId_and_effectiveFrom", (q) =>
      q.eq("territoryId", territoryId).lte("effectiveFrom", now),
    )
    .take(MAX_ROSTER + 1);
  if (rows.length > MAX_ROSTER)
    throw new ConvexError("Territory salespeople exceed limit");
  const people: {
    profile: Doc<"profiles">;
    kind: "primary" | "secondary" | null;
  }[] = [];
  for (const row of rows) {
    if (!activeAt(row.effectiveFrom, row.effectiveTo, now)) continue;
    const profile = await ctx.db.get(row.profileId);
    if (!profile || profile.status !== "active") continue;
    if (people.some((p) => p.profile._id === profile._id)) continue;
    people.push({ profile, kind: row.kind ?? null });
  }
  return people;
}

/** True when the store is in the salesperson's approved plan for that day. */
async function inPlan(
  ctx: Ctx,
  outletId: Id<"outlets">,
  salespersonProfileId: Id<"profiles">,
  serviceDate: string,
) {
  const planned = await ctx.db
    .query("plannedVisits")
    .withIndex("by_outletId_and_serviceDate", (q) =>
      q.eq("outletId", outletId).eq("serviceDate", serviceDate),
    )
    .take(MAX_ROSTER);
  return planned.some(
    (row) =>
      row.assigneeProfileId === salespersonProfileId &&
      row.status === "planned",
  );
}

async function currentCustomerId(
  ctx: Ctx,
  outletId: Id<"outlets">,
  now: number,
) {
  const links = (await outletRows(ctx, "outletCustomerLinks", outletId)).filter(
    (row) => activeAt(row.effectiveFrom, row.effectiveTo, now),
  );
  return links.length === 1 ? links[0]!.customerId : undefined;
}

/** Encoder's view of a store: who covers it and whether it is in their plan that day. */
export const candidates = query({
  args: { outletId: v.id("outlets"), serviceDate: v.string() },
  returns: v.object({
    outletName: v.string(),
    outletCode: v.string(),
    hasTerritory: v.boolean(),
    salespeople: v.array(
      v.object({
        profileId: v.id("profiles"),
        name: v.string(),
        kind: v.union(v.literal("primary"), v.literal("secondary"), v.null()),
        inPlan: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const scope = await requireOutletCapability(
      ctx,
      "order.encode",
      args.outletId,
    );
    localDate(args.serviceDate);
    const now = Date.now();
    const people = scope.assignment
      ? await coveringSalespeople(ctx, scope.assignment.territoryId, now)
      : [];
    const salespeople = [];
    for (const { profile, kind } of people)
      salespeople.push({
        profileId: profile._id,
        name: profile.name,
        kind,
        inPlan: await inPlan(ctx, args.outletId, profile._id, args.serviceDate),
      });
    return {
      outletName: scope.outlet.name,
      outletCode: scope.outlet.code,
      hasTerritory: !!scope.assignment,
      salespeople,
    };
  },
});

export const encode = mutation({
  args: {
    clientRequestId: v.string(),
    outletId: v.id("outlets"),
    salespersonProfileId: v.id("profiles"),
    serviceDate: v.string(),
    poNumber: v.string(),
    receivedVia: receivedViaValidator,
    lines: v.array(
      v.object({ productId: v.id("products"), quantity: v.number() }),
    ),
    note: v.optional(v.string()),
  },
  returns: v.object({
    orderId: v.id("outsideCallOrders"),
    replayed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // Scope first so a replay can never bypass it.
    const scope = await requireOutletCapability(
      ctx,
      "order.encode",
      args.outletId,
    );
    const { identity, profile, outlet } = scope;
    const clientRequestId = required(
      args.clientRequestId,
      "Client request id",
      100,
    );
    const poNumber = required(args.poNumber, "PO number", 60);
    const existing = await ctx.db
      .query("outsideCallOrders")
      .withIndex("by_encodedByProfileId_and_clientRequestId", (q) =>
        q
          .eq("encodedByProfileId", profile._id)
          .eq("clientRequestId", clientRequestId),
      )
      .unique();
    if (existing) {
      if (existing.outletId !== args.outletId || existing.poNumber !== poNumber)
        throw new ConvexError("Client request id reused for another PO");
      return { orderId: existing._id, replayed: true };
    }

    const now = Date.now();
    assertPoDate(args.serviceDate, now);
    if (outlet.status !== "active")
      throw new ConvexError("Store is not active");
    if (!scope.assignment)
      throw new ConvexError(
        "Store has no territory; assign it before encoding a PO",
      );
    const covering = await coveringSalespeople(
      ctx,
      scope.assignment.territoryId,
      now,
    );
    if (!covering.some((p) => p.profile._id === args.salespersonProfileId))
      throw new ConvexError("Salesperson does not cover this store");
    if (
      await inPlan(
        ctx,
        args.outletId,
        args.salespersonProfileId,
        args.serviceDate,
      )
    )
      throw new ConvexError(
        "Store is in the salesperson's plan that day; the PO is entered at the visit",
      );
    const duplicates = await ctx.db
      .query("outsideCallOrders")
      .withIndex("by_outletId_and_poNumber", (q) =>
        q.eq("outletId", args.outletId).eq("poNumber", poNumber),
      )
      .take(10);
    if (duplicates.some((row) => row.status !== "cancelled"))
      throw new ConvexError("This PO number is already encoded for the store");

    if (args.lines.length === 0)
      throw new ConvexError("Add at least one product line");
    if (args.lines.length > MAX_PO_LINES)
      throw new ConvexError(`At most ${MAX_PO_LINES} product lines`);
    const seen = new Set<Id<"products">>();
    const lines = [];
    for (const line of args.lines) {
      assertQuantity(line.quantity);
      if (seen.has(line.productId))
        throw new ConvexError("Each product may appear once");
      seen.add(line.productId);
      const product = await ctx.db.get(line.productId);
      if (
        !product?.active ||
        (product.organizationId &&
          product.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      )
        throw new ConvexError("Product not found or inactive");
      lines.push({
        productId: product._id,
        productCode: product.code,
        productName: product.name,
        quantity: line.quantity,
        uom: product.uom,
      });
    }
    const note = args.note?.trim() || undefined;
    if (note && note.length > 500) throw new ConvexError("Note too long");

    const orderId = await ctx.db.insert("outsideCallOrders", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      orgUnitId: scope.orgUnitId,
      outletId: args.outletId,
      territoryId: scope.assignment.territoryId,
      customerId: await currentCustomerId(ctx, args.outletId, now),
      salespersonProfileId: args.salespersonProfileId,
      serviceDate: args.serviceDate,
      poNumber,
      receivedVia: args.receivedVia,
      lines,
      note,
      status: "awaiting_activity",
      clientRequestId,
      encodedBy: identity.tokenIdentifier,
      encodedByProfileId: profile._id,
      encodedAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "order.outside_call_encoded",
      "outsideCallOrder",
      orderId,
      `Outside-call PO ${poNumber} encoded`,
      now,
    );
    return { orderId, replayed: false };
  },
});

/** The credited salesperson records what they did for the store's PO. */
export const recordActivity = mutation({
  args: {
    orderId: v.id("outsideCallOrders"),
    contact: activityContactValidator,
    codes: v.array(v.string()),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order || order.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("PO not found");
    const { identity, profile } = await requireCapability(
      ctx,
      "visit.record",
      order.orgUnitId,
    );
    if (profile._id !== order.salespersonProfileId)
      throw new ConvexError("Only the credited salesperson records this");
    if (order.status !== "awaiting_activity")
      throw new ConvexError(
        order.status === "cancelled"
          ? "PO was cancelled"
          : "Activity already recorded",
      );
    if (args.codes.length > PRODUCTIVE_ACTIVITY_CODES.length)
      throw new ConvexError("Too many activities");
    const codes = normalizeActivityCodes(args.codes);
    const note = args.note?.trim() || undefined;
    if (note && note.length > 500) throw new ConvexError("Note too long");
    if (args.contact === "other" && !note)
      throw new ConvexError("Say how the store was reached");
    const now = Date.now();
    await ctx.db.patch(order._id, {
      status: "activity_recorded",
      activity: { contact: args.contact, codes, note, recordedAt: now },
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "order.outside_call_activity",
      "outsideCallOrder",
      order._id,
      `Activity recorded: ${codes.join(", ")}`,
      now,
    );
    return null;
  },
});

export const cancel = mutation({
  args: { orderId: v.id("outsideCallOrders"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order || order.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("PO not found");
    const { identity, profile } = await requireCapability(
      ctx,
      "order.encode",
      order.orgUnitId,
    );
    if (order.status === "cancelled")
      throw new ConvexError("PO already cancelled");
    const reason = required(args.reason, "Reason", 500);
    const now = Date.now();
    await ctx.db.patch(order._id, {
      status: "cancelled",
      cancelledByProfileId: profile._id,
      cancelledAt: now,
      cancelReason: reason,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "order.outside_call_cancelled",
      "outsideCallOrder",
      order._id,
      reason,
      now,
    );
    return null;
  },
});

const orderView = v.object({
  order: schema.doc("outsideCallOrders"),
  outletName: v.string(),
  outletCode: v.string(),
  salespersonName: v.string(),
  encodedByName: v.string(),
});

async function view(ctx: QueryCtx, order: Doc<"outsideCallOrders">) {
  const outlet = await ctx.db.get(order.outletId);
  const salesperson = await ctx.db.get(order.salespersonProfileId);
  const encoder = await ctx.db.get(order.encodedByProfileId);
  return {
    order,
    outletName: outlet?.name ?? "Unknown store",
    outletCode: outlet?.code ?? "",
    salespersonName: salesperson?.name ?? "Former user",
    encodedByName: encoder?.name ?? "Former user",
  };
}

function pageSize(numItems: number) {
  if (!Number.isInteger(numItems) || numItems < 1 || numItems > MAX_PAGE)
    throw new ConvexError(`Page size must be 1–${MAX_PAGE}`);
}

/** Office and supervisor list, newest first, inside the caller's scope. */
export const list = query({
  args: { status: statusValidator, paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(orderView),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "visit.read");
    pageSize(args.paginationOpts.numItems);
    const allowed =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : new Set(
            profile.orgUnitId
              ? await collectScopeUnitIds(ctx, profile.orgUnitId)
              : [],
          );
    const result = await ctx.db
      .query("outsideCallOrders")
      .withIndex("by_organizationId_and_status_and_encodedAt", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("status", args.status),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const page = [];
    for (const order of result.page) {
      if (allowed && !allowed.has(order.orgUnitId)) continue;
      if (
        profile.role === "sales" &&
        order.salespersonProfileId !== profile._id
      )
        continue;
      page.push(await view(ctx, order));
    }
    return { ...result, page };
  },
});

/** The salesperson's own outside-call POs, newest first. */
export const mine = query({
  args: { status: statusValidator, paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(orderView),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "visit.record");
    pageSize(args.paginationOpts.numItems);
    const result = await ctx.db
      .query("outsideCallOrders")
      .withIndex("by_salespersonProfileId_and_status_and_encodedAt", (q) =>
        q.eq("salespersonProfileId", profile._id).eq("status", args.status),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const page = [];
    for (const order of result.page) page.push(await view(ctx, order));
    return { ...result, page };
  },
});

/**
 * One salesperson's outside calls for a day (for the day's activity record and reports).
 * Never counted as calls: a call is a planned store visited.
 */
export const forDay = query({
  args: { salespersonProfileId: v.id("profiles"), serviceDate: v.string() },
  returns: v.array(orderView),
  handler: async (ctx, args) => {
    localDate(args.serviceDate);
    const { profile } = await requireCapability(ctx, "visit.read");
    if (profile.role === "sales" && profile._id !== args.salespersonProfileId)
      throw new ConvexError("Sales can only read their own day");
    const rows = await ctx.db
      .query("outsideCallOrders")
      .withIndex("by_salespersonProfileId_and_serviceDate", (q) =>
        q
          .eq("salespersonProfileId", args.salespersonProfileId)
          .eq("serviceDate", args.serviceDate),
      )
      .take(MAX_PAGE + 1);
    if (rows.length > MAX_PAGE)
      throw new ConvexError("Too many outside-call POs on this day");
    const out = [];
    for (const order of rows) {
      await requireCapability(ctx, "visit.read", order.orgUnitId);
      if (order.status !== "cancelled") out.push(await view(ctx, order));
    }
    return out;
  },
});
