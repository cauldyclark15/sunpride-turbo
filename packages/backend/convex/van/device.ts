import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { manilaDate } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { hashPayload } from "../inventory/posting";
import { collectScopeUnitIds } from "../lib/scope";
import { activeAt } from "../org/validation";
import { resolveOutletScopeAt } from "../outlets/validation";
import { vanPricing } from "../pricing/wire";
import { type Caches, toBase, uom as cachedUom } from "../mobile/reference";
import type { AuthorizedDevice } from "../mobile/types";
import {
  loadLines,
  requireCurrentDeviceActor,
  requireDeviceTrip,
  tripLoad,
} from "./access";
import { photoFor, SHA256_HEX, tripDamageRecords } from "./damage";
import { postTruckDamage, truckBalances } from "./ledger";
import { creditFor } from "./credit";
import { finishLoad, productUnit } from "./loads";
import {
  actorValidator,
  boundedText,
  DAMAGE_REASONS,
  damageRules,
  VAN_DAMAGE_POLICY,
  LOAD_DISCREPANCY_REASONS,
  OPEN_TRIP_STATUSES,
  VAN_PAYMENT_METHODS,
  VAN_POLICY,
  type VanOperationKind,
  VOID_REASONS,
} from "./model";
import { cashReconciliationPolicy } from "./cash";
import { voidApprovalPolicy } from "./voids";

/**
 * VAN-003: the van device's view of its day and its signed operations. Reached only from
 * `van/http_handlers.ts` after `mobile/device_auth.authorize` proved a bound VAN_ANDROID
 * device. Wire integers that may exceed 2^53 (`*Base`, `quantityScale`) travel as decimal
 * strings; see `packages/domain-contracts/schemas/van-v1.schema.json`.
 */
export { actorValidator };

const TRIP_PRIORITY: Record<string, number> = {
  active: 0,
  loaded: 1,
  loading: 2,
  planned: 3,
  closing: 4,
  reconciling: 5,
  review_required: 6,
};

/** Barcode history read per product; overflow fails instead of silently dropping rows. */
const MAX_BARCODE_HISTORY = 50;
/** Active barcodes per product; the van-v1 contract caps `barcodes` at 20. */
const MAX_BARCODES = 20;

/**
 * VAN-009: the unit a scanned barcode stands for, and how many base units one scan is.
 * `baseQuantity` is null when no exact in-force conversion to the van's selling unit exists:
 * the handheld then names the unit but never guesses a quantity.
 */
async function barcodeUnit(
  ctx: QueryCtx,
  caches: Caches,
  product: Doc<"products">,
  row: Doc<"productBarcodes">,
  vanUomId: Id<"unitsOfMeasure"> | undefined,
  quantityScale: bigint,
  now: number,
) {
  const unit = await cachedUom(ctx, caches, row.uomId);
  // A barcode for a retired or unknown unit must not scan into that unit.
  if (!unit?.active) return null;
  let baseQuantity: string | null = null;
  if (row.uomId === vanUomId) baseQuantity = quantityScale.toString();
  else if (vanUomId && vanUomId === product.baseUomId) {
    const { conversion } = await toBase(ctx, caches, product, row.uomId, now);
    if (
      conversion &&
      conversion.numerator > 0n &&
      conversion.denominator > 0n
    ) {
      const scaled = quantityScale * conversion.numerator;
      if (scaled % conversion.denominator === 0n)
        baseQuantity = (scaled / conversion.denominator).toString();
    }
  }
  return { barcode: row.barcode, uomCode: unit.code, baseQuantity };
}

async function productView(
  ctx: QueryCtx,
  caches: Caches,
  productId: Id<"products">,
  now: number,
) {
  const product = await ctx.db.get(productId);
  if (!product) return null;
  const policy = await ctx.db
    .query("productInventoryPolicies")
    .withIndex("by_organizationId_and_productId", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("productId", product._id),
    )
    .unique();
  const uomId = policy?.baseUomId ?? product.baseUomId;
  const uom = uomId ? await ctx.db.get(uomId) : null;
  const quantityScale = policy?.quantityScale ?? product.quantityScale ?? 1n;
  // The whole barcode history is read, so an active row after retired ones is never
  // dropped; more rows than the bound fail loudly instead of truncating.
  const rows = await ctx.db
    .query("productBarcodes")
    .withIndex("by_organizationId_and_productId", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("productId", product._id),
    )
    .take(MAX_BARCODE_HISTORY + 1);
  if (rows.length > MAX_BARCODE_HISTORY)
    throw new ConvexError("reference_data_too_large");
  const barcodeUnits = [];
  for (const row of rows) {
    if (!row.active || row.barcode.length === 0 || row.barcode.length > 64)
      continue;
    const unit = await barcodeUnit(
      ctx,
      caches,
      product,
      row,
      uomId,
      quantityScale,
      now,
    );
    if (unit) barcodeUnits.push(unit);
  }
  if (barcodeUnits.length > MAX_BARCODES)
    throw new ConvexError("reference_data_too_large");
  return {
    productId: product._id,
    code: product.code,
    name: product.name,
    uomCode: uom?.code ?? product.uom,
    quantityScale: String(quantityScale),
    barcodes: barcodeUnits.map((row) => row.barcode),
    barcodeUnits,
  };
}

async function customersFor(
  ctx: QueryCtx,
  trip: Doc<"vanTrips">,
  actor: AuthorizedDevice,
  now: number,
) {
  const scope = new Set(await collectScopeUnitIds(ctx, actor.orgUnitId));
  const customers: {
    outletId: Id<"outlets">;
    code: string;
    name: string;
    address: string | null;
    sequence: number | null;
    source: "route" | "unplanned";
    credit: { termsDays: number; availableMinor: string } | null;
  }[] = [];
  const seen = new Set<string>();
  const consider = async (
    row: Doc<"outletAssignments">,
    source: "route" | "unplanned",
  ) => {
    if (
      seen.has(row.outletId) ||
      !activeAt(row.effectiveFrom, row.effectiveTo, now)
    )
      return;
    const current = await resolveOutletScopeAt(ctx, row.outletId, now);
    // Only the outlet's CURRENT assignment counts, and only inside the device's scope.
    if (current.assignment?._id !== row._id || !scope.has(current.orgUnitId))
      return;
    if (current.outlet.status !== "active") return;
    seen.add(row.outletId);
    customers.push({
      outletId: row.outletId,
      code: current.outlet.code,
      name: current.outlet.name,
      address: current.outlet.address ?? null,
      sequence: source === "route" ? (row.sequence ?? null) : null,
      source,
      credit: await creditFor(ctx, row.outletId, now),
    });
  };
  if (trip.routeId) {
    const rows = await ctx.db
      .query("outletAssignments")
      .withIndex("by_routeId_and_effectiveFrom", (q) =>
        q.eq("routeId", trip.routeId).lte("effectiveFrom", now),
      )
      .order("desc")
      .take(VAN_POLICY.maxRouteCustomers * 2);
    for (const row of rows) {
      if (customers.length >= VAN_POLICY.maxRouteCustomers) break;
      await consider(row, "route");
    }
  }
  // VAN-007 governed unplanned selection: outlets of territories the seller covers today.
  const territories = await ctx.db
    .query("territorySalespeople")
    .withIndex("by_profileId_and_effectiveFrom", (q) =>
      q.eq("profileId", actor.profileId).lte("effectiveFrom", now),
    )
    .take(50);
  let unplanned = 0;
  for (const territory of territories) {
    if (!activeAt(territory.effectiveFrom, territory.effectiveTo, now))
      continue;
    const rows = await ctx.db
      .query("outletAssignments")
      .withIndex("by_territoryId_and_effectiveFrom", (q) =>
        q.eq("territoryId", territory.territoryId).lte("effectiveFrom", now),
      )
      .order("desc")
      .take(VAN_POLICY.maxUnplannedCustomers);
    for (const row of rows) {
      if (unplanned >= VAN_POLICY.maxUnplannedCustomers) break;
      const before = customers.length;
      await consider(row, "unplanned");
      if (customers.length > before) unplanned += 1;
    }
  }
  return customers.sort(
    (a, b) =>
      (a.source === b.source ? 0 : a.source === "route" ? -1 : 1) ||
      (a.sequence ?? 1e9) - (b.sequence ?? 1e9) ||
      a.name.localeCompare(b.name),
  );
}

export const bootstrap = internalQuery({
  args: { actor: actorValidator, now: v.number() },
  returns: v.any(),
  handler: async (ctx, { actor, now }) => {
    await requireCurrentDeviceActor(ctx, actor);
    const serviceDate = manilaDate(now);
    const profile = await ctx.db.get(actor.profileId);
    const candidates = await ctx.db
      .query("vanTrips")
      .withIndex("by_salespersonProfileId_and_serviceDate", (q) =>
        q
          .eq("salespersonProfileId", actor.profileId)
          .eq("serviceDate", serviceDate),
      )
      .take(20);
    const scope = new Set(await collectScopeUnitIds(ctx, actor.orgUnitId));
    const trip =
      candidates
        .filter(
          (row) =>
            OPEN_TRIP_STATUSES.includes(row.status) &&
            row.salespersonSubject === actor.subject &&
            scope.has(row.orgUnitId),
        )
        .sort(
          (a, b) =>
            (TRIP_PRIORITY[a.status] ?? 9) - (TRIP_PRIORITY[b.status] ?? 9),
        )[0] ?? null;
    const base = {
      type: "van.bootstrap.response" as const,
      contractVersion: 1 as const,
      serverTime: now,
      serviceDate,
      seller: { profileId: actor.profileId, name: profile?.name ?? "" },
    };
    if (!trip)
      return {
        ...base,
        policy: await policyView(false, null),
        trip: null,
        load: null,
        truckStock: [],
        products: [],
        customers: [],
        damageRecords: [],
      };
    const vehicle = await ctx.db.get(trip.vehicleId);
    const route = trip.routeId ? await ctx.db.get(trip.routeId) : null;
    const load = await tripLoad(ctx, trip._id);
    const lines = load ? await loadLines(ctx, load._id) : [];
    const balances = await truckBalances(ctx, trip.truckLocationId);
    const productIds = new Set<Id<"products">>([
      ...lines.map((line) => line.productId),
      ...balances.map((balance) => balance.productId),
    ]);
    const products = [];
    const caches: Caches = { uoms: new Map(), global: new Map() };
    for (const productId of productIds) {
      const view = await productView(ctx, caches, productId, now);
      if (view) products.push(view);
    }
    const names = new Map(products.map((p) => [p.productId, p]));
    const negative = await ctx.db
      .query("negativeStockAllowances")
      .withIndex("by_organizationId_and_locationId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("locationId", trip.truckLocationId),
      )
      .unique();
    return {
      ...base,
      policy: await policyView(
        Boolean(
          negative?.active && negative.movementTypes.includes("pos_sale"),
        ),
        trip._id,
      ),
      trip: {
        tripId: trip._id,
        tripNumber: trip.tripNumber,
        status: trip.status,
        serviceDate: trip.serviceDate,
        vehicle: vehicle
          ? {
              vehicleId: vehicle._id,
              vehicleCode: vehicle.vehicleCode,
              plateNumber: vehicle.plateNumber,
              name: vehicle.name ?? null,
            }
          : null,
        route: route
          ? { routeId: route._id, code: route.code, name: route.name }
          : null,
        driverName: trip.driverName ?? null,
        helperName: trip.helperName ?? null,
        truckLocationId: trip.truckLocationId,
        routeSessionId: trip.routeSessionId ?? null,
        startedAt: trip.startedAt ?? null,
      },
      load: load
        ? {
            loadId: load._id,
            status: load.status,
            lines: lines.map((line) => ({
              lineNumber: line.lineNumber,
              productId: line.productId,
              productCode: line.productCode,
              productName: names.get(line.productId)?.name ?? line.productCode,
              uomCode: line.uomCode,
              quantityScale: String(line.quantityScale),
              lotNumber: line.lotNumber ?? null,
              expectedBase: String(line.expectedBase),
              actualBase:
                line.actualBase === undefined ? null : String(line.actualBase),
              discrepancyReason: line.discrepancyReason ?? null,
            })),
          }
        : null,
      truckStock: balances.map((balance) => ({
        productId: balance.productId,
        availableBase: String(balance.availableBase),
        damagedBase: String(balance.damagedBase),
      })),
      products,
      customers: await customersFor(ctx, trip, actor, now),
      damageRecords: await tripDamageRecords(ctx, trip._id),
      // SP-0129 / ADR-008: governed Route Sales prices for the products on this truck;
      // omitted when nothing is priced (the handheld then shows "Priced by the office").
      ...(await vanPricing(ctx, products, now).then((pricing) =>
        pricing.priceLines.length > 0 || pricing.promotions.length > 0
          ? pricing
          : {},
      )),
    };
  },
});

async function policyView(
  allowNegativeStock: boolean,
  tripId: Id<"vanTrips"> | null,
) {
  return {
    allowNegativeStock,
    loadDiscrepancyRequiresApproval: VAN_POLICY.loadDiscrepancyRequiresApproval,
    walkInAllowed: true,
    loadDiscrepancyReasons: [...LOAD_DISCREPANCY_REASONS],
    damageReasons: [...DAMAGE_REASONS],
    paymentMethods: VAN_PAYMENT_METHODS.map((method) => ({ ...method })),
    damagePolicy: {
      photoRequiredReasons: [...VAN_DAMAGE_POLICY.photoRequiredReasons],
      approvalFromUnits: VAN_DAMAGE_POLICY.approvalFromUnits,
      photoMaxBytes: VAN_DAMAGE_POLICY.photoMaxBytes,
    },
    // VAN-021: reasons for voiding a sale and the supervisor-approval rule + trip key.
    voidReasons: [...VOID_REASONS],
    voidApproval: await voidApprovalPolicy(tripId),
    // VAN-022: end-of-trip cash count — variance reasons, approval tolerance and trip key.
    cashReconciliation: await cashReconciliationPolicy(tripId),
  };
}

const bigintText = (value: unknown, label: string): bigint => {
  if (typeof value !== "string" || !/^\d{1,18}$/.test(value))
    throw new ConvexError("invalid_request");
  const parsed = BigInt(value);
  if (label === "positive" && parsed <= 0n)
    throw new ConvexError("invalid_request");
  return parsed;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const operationValidator = v.object({
  kind: v.union(
    v.literal("trip.start"),
    v.literal("load.confirm"),
    v.literal("truck.damage"),
  ),
  clientRequestId: v.string(),
  payload: v.any(),
});

type Result = {
  status: "accepted";
  ack: { entityId: string; movementId: string | null; serverTime: number };
};

/**
 * Idempotent per (profile, clientRequestId): a replay with the same payload returns the
 * original acknowledgement; another payload under the same id is a conflict (VAN-013).
 */
export const applyOne = internalMutation({
  args: { actor: actorValidator, operation: operationValidator },
  returns: v.object({
    status: v.literal("accepted"),
    ack: v.object({
      entityId: v.string(),
      movementId: v.union(v.string(), v.null()),
      serverTime: v.number(),
    }),
  }),
  handler: async (ctx, { actor, operation }): Promise<Result> => {
    // A replay still requires the current device/profile/assignment, ownership,
    // capability and organizational scope, all re-read inside this transaction.
    await requireCurrentDeviceActor(ctx, actor);
    if (!isRecord(operation.payload)) throw new ConvexError("invalid_request");
    const p = operation.payload;
    if (typeof p.tripId !== "string") throw new ConvexError("invalid_request");
    const tripId = ctx.db.normalizeId("vanTrips", p.tripId);
    if (!tripId) throw new ConvexError("invalid_request");
    const trip = await requireDeviceTrip(ctx, actor, tripId);
    const payloadHash = hashPayload({
      kind: operation.kind,
      payload: operation.payload,
    });
    const prior = await ctx.db
      .query("vanOperations")
      .withIndex("by_profileId_and_clientRequestId", (q) =>
        q
          .eq("profileId", actor.profileId)
          .eq("clientRequestId", operation.clientRequestId),
      )
      .unique();
    if (prior) {
      if (prior.payloadHash !== payloadHash || prior.kind !== operation.kind)
        throw new ConvexError("conflict");
      return {
        status: "accepted",
        ack: {
          entityId: prior.entityId,
          movementId: prior.movementId ?? null,
          serverTime: prior.serverAt,
        },
      };
    }
    const now = Date.now();
    const outcome =
      operation.kind === "trip.start"
        ? await startTrip(ctx, actor, trip, p, now)
        : operation.kind === "load.confirm"
          ? await confirmLoad(
              ctx,
              actor,
              trip,
              p,
              operation.clientRequestId,
              now,
            )
          : await recordDamage(
              ctx,
              actor,
              trip,
              p,
              operation.clientRequestId,
              now,
            );
    await ctx.db.insert("vanOperations", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      deviceId: actor.deviceId,
      profileId: actor.profileId,
      kind: operation.kind as VanOperationKind,
      clientRequestId: operation.clientRequestId,
      payloadHash,
      entityId: outcome.entityId,
      ...(outcome.movementId ? { movementId: outcome.movementId } : {}),
      serverAt: now,
    });
    await ctx.db.insert("auditLogs", {
      subject: actor.subject,
      action: `van.${operation.kind}`,
      entityType: "vanTrip",
      entityId: trip._id,
      details: operation.clientRequestId,
      createdAt: now,
    });
    return {
      status: "accepted",
      ack: {
        entityId: outcome.entityId,
        movementId: outcome.movementId ?? null,
        serverTime: now,
      },
    };
  },
});

type Outcome = { entityId: string; movementId?: Id<"inventoryMovements"> };

/**
 * VAN-004: the salesman confirms vehicle, crew and route; the trip becomes active only
 * after its load is posted, on its service day, with no other open session on the truck.
 * Starting opens the POS route session the sale path (`inventory/pos.ts`) requires.
 */
async function startTrip(
  ctx: MutationCtx,
  actor: AuthorizedDevice,
  trip: Doc<"vanTrips">,
  p: Record<string, unknown>,
  now: number,
): Promise<Outcome> {
  if (trip.serviceDate !== manilaDate(now)) throw new ConvexError("wrong_date");
  if (trip.status === "active" && trip.startedDeviceId === actor.deviceId)
    return { entityId: trip._id };
  if (trip.status !== "loaded" && VAN_POLICY.startRequiresPostedLoad)
    throw new ConvexError("load_not_posted");
  if (p.vehicleConfirmed !== true || p.routeConfirmed !== true)
    throw new ConvexError("invalid_request");
  const driverName = boundedText(
    typeof p.driverName === "string" ? p.driverName : undefined,
    VAN_POLICY.maxCrewNameLength,
  );
  const helperName = boundedText(
    typeof p.helperName === "string" ? p.helperName : undefined,
    VAN_POLICY.maxCrewNameLength,
  );
  const note = boundedText(
    typeof p.note === "string" ? p.note : undefined,
    300,
  );
  const odometer = p.odometerKm;
  if (
    odometer !== undefined &&
    odometer !== null &&
    (typeof odometer !== "number" ||
      !Number.isFinite(odometer) ||
      odometer < 0 ||
      odometer > 10_000_000)
  )
    throw new ConvexError("invalid_request");
  const open = await ctx.db
    .query("truckRouteSessions")
    .withIndex("by_organizationId_and_truckLocationId_and_status", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("truckLocationId", trip.truckLocationId)
        .eq("status", "open"),
    )
    .first();
  if (open) throw new ConvexError("conflict");
  const route = trip.routeId ? await ctx.db.get(trip.routeId) : null;
  const routeSessionId = await ctx.db.insert("truckRouteSessions", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    routeCode: route?.code ?? trip.tripNumber,
    truckLocationId: trip.truckLocationId,
    salespersonSubject: trip.salespersonSubject,
    assignedDeviceId: actor.deviceId,
    status: "open",
    openedAt: now,
    lastAcknowledgedSequence: 0,
    leaseExpiresAt: now + 15 * 60_000,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(trip._id, {
    status: "active",
    startedAt: now,
    startedDeviceId: actor.deviceId,
    routeSessionId,
    ...(driverName ? { driverName } : {}),
    ...(helperName ? { helperName } : {}),
    ...(typeof odometer === "number" ? { startOdometerKm: odometer } : {}),
    ...(note ? { startNote: note } : {}),
    updatedAt: now,
  });
  return { entityId: trip._id };
}

/**
 * VAN-005: actual quantities per sheet line. All matching → posted at once to the truck.
 * Any difference → `discrepancy`, waiting for a supervisor (VAN_POLICY), each differing
 * line carrying a reason.
 */
async function confirmLoad(
  ctx: MutationCtx,
  actor: AuthorizedDevice,
  trip: Doc<"vanTrips">,
  p: Record<string, unknown>,
  clientRequestId: string,
  now: number,
): Promise<Outcome> {
  const load = await tripLoad(ctx, trip._id);
  if (
    !load ||
    typeof p.loadId !== "string" ||
    p.loadId !== load._id ||
    trip.status !== "loading" ||
    load.status !== "planned"
  )
    throw new ConvexError("conflict");
  const lines = await loadLines(ctx, load._id);
  if (!Array.isArray(p.lines) || p.lines.length !== lines.length)
    throw new ConvexError("invalid_request");
  const byNumber = new Map(lines.map((line) => [line.lineNumber, line]));
  const seen = new Set<number>();
  let differs = false;
  for (const input of p.lines as unknown[]) {
    if (!isRecord(input) || typeof input.lineNumber !== "number")
      throw new ConvexError("invalid_request");
    const line = byNumber.get(input.lineNumber);
    if (!line || seen.has(input.lineNumber))
      throw new ConvexError("invalid_request");
    seen.add(input.lineNumber);
    const actualBase = bigintText(input.actualBase, "nonnegative");
    const reason = input.reason;
    const changed = actualBase !== line.expectedBase;
    if (
      changed &&
      (typeof reason !== "string" ||
        !(LOAD_DISCREPANCY_REASONS as readonly string[]).includes(reason))
    )
      throw new ConvexError("invalid_request");
    differs ||= changed;
    await ctx.db.patch(line._id, {
      actualBase,
      ...(changed
        ? {
            discrepancyReason:
              reason as (typeof LOAD_DISCREPANCY_REASONS)[number],
          }
        : {}),
      updatedAt: now,
    });
  }
  await ctx.db.patch(load._id, {
    confirmedBy: actor.subject,
    confirmedAt: now,
    confirmedDeviceId: actor.deviceId,
    confirmRequestId: clientRequestId,
    updatedAt: now,
  });
  if (differs && VAN_POLICY.loadDiscrepancyRequiresApproval) {
    await ctx.db.patch(load._id, { status: "discrepancy", updatedAt: now });
    return { entityId: load._id };
  }
  const fresh = (await ctx.db.get(load._id))!;
  const movementId = await finishLoad(
    ctx,
    trip,
    fresh,
    actor.subject,
    actor.deviceId,
  );
  return { entityId: load._id, movementId };
}

/**
 * VAN-006 server half, VAN-020 evidence and approval: damaged stock found on the truck
 * during the trip moves available → damaged at once. A required photo must already be
 * uploaded through /van/v1/evidence by this seller; a record at or above the approval
 * threshold waits for a supervisor (van/damage.ts `decide`).
 */
async function recordDamage(
  ctx: MutationCtx,
  actor: AuthorizedDevice,
  trip: Doc<"vanTrips">,
  p: Record<string, unknown>,
  clientRequestId: string,
  now: number,
): Promise<Outcome> {
  if (trip.status !== "active") throw new ConvexError("conflict");
  if (
    typeof p.productId !== "string" ||
    typeof p.reason !== "string" ||
    !(DAMAGE_REASONS as readonly string[]).includes(p.reason) ||
    (p.photoSha256 !== undefined &&
      (typeof p.photoSha256 !== "string" || !SHA256_HEX.test(p.photoSha256)))
  )
    throw new ConvexError("invalid_request");
  const reason = p.reason as (typeof DAMAGE_REASONS)[number];
  const productId = ctx.db.normalizeId("products", p.productId);
  if (!productId) throw new ConvexError("invalid_request");
  const product = await ctx.db.get(productId);
  if (!product) throw new ConvexError("invalid_request");
  const note = boundedText(
    typeof p.note === "string" ? p.note : undefined,
    300,
  );
  const quantityBase = bigintText(p.quantityBase, "positive");
  const unit = await productUnit(ctx, product);
  const rules = damageRules(reason, quantityBase, unit.quantityScale);
  const photo =
    typeof p.photoSha256 === "string"
      ? await photoFor(ctx, actor.profileId, p.photoSha256)
      : null;
  // A named photo must have been uploaded by this seller and not used for another record.
  if ((rules.photoRequired || p.photoSha256 !== undefined) && !photo)
    throw new ConvexError("photo_required");
  if (photo?.damageRecordId) throw new ConvexError("invalid_request");
  const movement = await postTruckDamage(ctx, {
    trip,
    productId,
    quantityBase,
    reason,
    ...(note ? { note } : {}),
    actorSubject: actor.subject,
    deviceId: actor.deviceId,
    idempotencyKey: `van-damage:${actor.profileId}:${clientRequestId}`,
  });
  const damageId = await ctx.db.insert("vanDamageRecords", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    tripId: trip._id,
    orgUnitId: trip.orgUnitId,
    truckLocationId: trip.truckLocationId,
    productId,
    productCode: product.code,
    uomCode: unit.uomCode,
    quantityScale: unit.quantityScale,
    quantityBase,
    reason,
    ...(note ? { note } : {}),
    ...(photo ? { photoId: photo._id } : {}),
    needsApproval: rules.needsApproval,
    status: rules.needsApproval ? "pending_approval" : "recorded",
    recordedBy: actor.subject,
    recordedProfileId: actor.profileId,
    deviceId: actor.deviceId,
    clientRequestId,
    recordedAt: now,
    movementId: movement.movementId,
    updatedAt: now,
  });
  if (photo) await ctx.db.patch(photo._id, { damageRecordId: damageId });
  return { entityId: damageId, movementId: movement.movementId };
}
