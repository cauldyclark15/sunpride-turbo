import { tx } from "@sunpride/db/client";
import { tenderPolicy } from "../fiscal/tenders.js";
import { fiscalBundle } from "../fiscal/transactions.js";
import { ApiError } from "../../core/errors.js";
import { resolvePrice, creditCheck } from "../orders/pricing.js";
import { currentDeviceActor, tripFor, outletFor } from "./access.js";
import { productFor } from "./facts.js";
import { approvalKey } from "./approvals.js";
import {
  date,
  today,
  dayString,
  PAYMENT_METHODS,
  DAMAGE_POLICY,
  CLOSE_POLICY,
  LOAD_REASONS,
  DAMAGE_REASONS,
  VOID_REASONS,
  CASH_VARIANCE_REASONS,
  STOCK_VARIANCE_REASONS,
} from "./model.js";

/** @param {any} env @param {string|null} tripId */
export function policy(env, tripId) {
  const key = (/** @type {string} */ kind) => {
    try {
      return tripId ? approvalKey(env, tripId, kind) : null;
    } catch {
      return null;
    }
  };
  return {
    allowNegativeStock: false,
    loadDiscrepancyRequiresApproval: true,
    walkInAllowed: false,
    loadDiscrepancyReasons: LOAD_REASONS,
    damageReasons: DAMAGE_REASONS,
    paymentMethods: PAYMENT_METHODS,
    damagePolicy: DAMAGE_POLICY,
    voidReasons: VOID_REASONS,
    voidApproval: { required: true, thresholdMinor: "0", key: key("void") },
    cashReconciliation: {
      approvalRequired: true,
      toleranceMinor: "5000",
      reasons: CASH_VARIANCE_REASONS,
      key: key("cash"),
    },
    stockReconciliation: {
      approvalRequired: true,
      reasons: STOCK_VARIANCE_REASONS,
      key: key("stock"),
    },
    tripClose: CLOSE_POLICY,
  };
}
/** @param {any[]} rows @param {number} bound */
function complete(rows, bound) {
  if (rows.length > bound)
    throw new ApiError(
      "projection_too_large",
      422,
      "Van reference data exceeds the supported bound; narrow the trip catalog",
    );
  return rows;
}
/** @param {any} env @returns {import('../../core/sync.js').Projection} */
export function vanProjection(env) {
  const snapshot = async (/** @type {any} */ ctx) => ({
    data: await bundle(ctx, env),
    next: null,
  });
  return {
    params: (p) => ({ serviceDate: date(p.serviceDate) }),
    snapshot,
    // CORE currently cannot emit snapshot mode for a since-cursor cycle. Refuse rather
    // than mislabel a full replacement as a delta or renew authority over stale data.
    scopeKeys: () => {
      throw new ApiError(
        "cursor_invalid",
        409,
        "Van stock requires a fresh full snapshot",
        false,
        { action: "rebootstrap" },
      );
    },
  };
}
/** Complete seller/trip DTO; never serializes a raw database document. @param {any} ctx @param {any} env */
export async function bundle(ctx, env) {
  return tx(ctx.db, async (db) => {
    const { actor, device } = await currentDeviceActor(
      db,
      ctx.actor,
      ctx.device.id,
    );
    const serviceDate = date(ctx.params.serviceDate);
    if (serviceDate !== today())
      throw new ApiError(
        "wrong_date",
        422,
        "Only today's trip can be downloaded",
      );
    let trips =
      await db`select id from van_trips where salesperson_profile_id=${actor.profileId} and service_date=${serviceDate} and status not in ('cancelled','closed') and deleted_at is null order by created_at desc limit 2`;
    // Sequential trips are allowed after settlement; only multiple OPEN trips are ambiguous.
    // Keep the latest closed trip visible when the office has not planned the next one yet.
    if (!trips.length)
      trips =
        await db`select id from van_trips where salesperson_profile_id=${actor.profileId} and service_date=${serviceDate} and status='closed' and deleted_at is null order by created_at desc limit 1`;
    if (trips.length > 1)
      throw new ApiError(
        "trip_conflict",
        409,
        "More than one trip needs office reconciliation",
      );
    const empty = {
      serviceDate,
      seller: { profileId: actor.profileId, name: actor.name },
      policy: policy(env, null),
      trip: null,
      load: null,
      truckStock: [],
      products: [],
      customers: [],
      priceLines: [],
      damageRecords: [],
      promotions: [],
    };
    if (!trips.length) return empty;
    const trip = await tripFor(db, actor, trips[0].id, "van.operate");
    if (trip.started_device_id && trip.started_device_id !== device.id)
      throw new ApiError(
        "out_of_scope",
        403,
        "Trip is bound to another handheld",
      );
    const [vehicle] =
      await db`select * from vehicles where id=${trip.vehicle_id}`;
    const [route] = trip.route_id
      ? await db`select * from routes where id=${trip.route_id}`
      : [];
    const [load] =
      await db`select * from van_trip_loads where trip_id=${trip.id} and status<>'cancelled' and deleted_at is null`;
    /** @type {any[]} */ const lines = load
      ? await db`select l.*,p.name from van_trip_load_lines l join products p on p.id=l.product_id where l.load_id=${load.id} and l.deleted_at is null order by l.line_number`
      : [];
    /** @type {any[]} */ const balances = complete(
      await db`select * from inventory_balances where location_id=${trip.truck_location_id} and deleted_at is null order by product_id limit 501`,
      500,
    );
    const productIds = [
      ...new Set(
        [
          ...lines.map((l) => l.product_id),
          ...balances.map((b) => b.product_id),
        ].filter(Boolean),
      ),
    ];
    if (productIds.length > 500)
      throw new ApiError(
        "projection_too_large",
        422,
        "Trip has more than 500 products",
      );
    const products = [];
    for (const id of productIds) {
      const p = await productFor(db, id);
      /** @type {any[]} */ const codes = complete(
        await db`select b.barcode,u.code from product_barcodes b join units_of_measure u on u.id=b.uom_id where b.product_id=${id} and b.active and b.deleted_at is null limit 501`,
        500,
      );
      products.push({
        productId: id,
        code: p.code,
        name: p.name,
        uomCode: p.base_code,
        quantityScale: String(p.quantityScale),
        barcodes: codes.map((c) => c.barcode),
        barcodeUnits: codes
          .filter((c) => p.factors.has(c.code))
          .map((c) => ({
            barcode: c.barcode,
            uomCode: c.code,
            baseQuantity: String(p.factors.get(c.code)),
          })),
      });
    }
    // Current persisted ownership, not a historical customer link, is the authorization key.
    /** @type {any[]} */ const candidates = complete(
      await db`select o.id,a.sequence from outlets o left join outlet_assignments a on a.outlet_id=o.id and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) and a.deleted_at is null where o.status='active' and o.deleted_at is null and (a.route_id=${trip.route_id} or (a.route_id is null and o.custodian_org_unit_id=${trip.org_unit_id})) order by a.sequence nulls last,o.code limit 601`,
      600,
    );
    const customers = [],
      priceLines = [];
    const priceKeys = new Set();
    for (const candidate of candidates) {
      let o;
      try {
        o = await outletFor(db, actor, candidate.id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) continue;
        throw e;
      }
      const [terms] =
        await db`select * from outlet_credit_terms where outlet_id=${o.id} and effective_from<=now() and (effective_to is null or effective_to>now()) and deleted_at is null`;
      let credit = null;
      if (terms && o.customerCode) {
        const c = await creditCheck(db, {
          customerCode: o.customerCode,
          addCentavos: 0,
        });
        if (c.status === "within" && c.limit !== null && c.exposure !== null)
          credit = {
            termsDays: terms.terms_days,
            availableMinor: String(
              Math.max(
                0,
                Math.min(
                  c.limit - c.exposure,
                  Number(terms.credit_limit_minor),
                ),
              ),
            ),
          };
      }
      let priceListId = null;
      for (const p of products) {
        const price = await resolvePrice(db, {
          organizationId: trip.organization_id,
          productId: p.productId,
          uom: p.uomCode,
          channelKey: o.channel,
          customerCode: o.customerCode,
          at: Date.now(),
        });
        if (price.unitPriceCentavos === null || !price.priceListId) continue;
        if (priceListId && priceListId !== price.priceListId)
          throw new ApiError(
            "pricing_conflict",
            409,
            "Customer prices span incompatible price lists",
          );
        priceListId = price.priceListId;
        const key = `${price.priceListId}:${p.productId}:${p.uomCode}`;
        if (!priceKeys.has(key)) {
          const live =
            await db`select l.effective_from,l.effective_to,pl.code,pl.currency from price_list_lines l join price_lists pl on pl.id=l.price_list_id where l.price_list_id=${price.priceListId} and l.product_id=${p.productId} and l.uom=${p.uomCode} and l.unit_price_minor=${String(price.unitPriceCentavos)} and l.effective_from<=now() and (l.effective_to is null or l.effective_to>now()) and l.deleted_at is null and pl.deleted_at is null`;
          if (live.length !== 1)
            throw new ApiError(
              "pricing_conflict",
              409,
              "Resolved price has no unique effective source line",
            );
          const line = live[0];
          priceKeys.add(key);
          priceLines.push({
            priceListId: price.priceListId,
            productId: p.productId,
            uomCode: p.uomCode,
            unitPriceMinor: String(price.unitPriceCentavos),
            currency: line.currency,
            effectiveFrom: new Date(line.effective_from).getTime(),
            effectiveTo: line.effective_to
              ? new Date(line.effective_to).getTime()
              : null,
            priceListCode: line.code,
          });
          complete(priceLines, 600);
        }
      }
      customers.push({
        outletId: o.id,
        code: o.code,
        name: o.name,
        address: o.address,
        sequence: candidate.sequence ?? null,
        source: trip.route_id ? "route" : "scoped",
        credit,
        priceListId,
      });
    }
    /** @type {any[]} */ const damages = complete(
      await db`select * from van_damage_records where trip_id=${trip.id} and deleted_at is null order by recorded_at desc limit 501`,
      500,
    );
    return {
      serviceDate,
      seller: empty.seller,
      policy: {
        ...policy(env, trip.id),
        paymentMethods: await tenderPolicy(db, trip.org_unit_id),
        fiscal: await fiscalBundle(db, actor, trip, device.id),
      },
      trip: {
        tripId: trip.id,
        tripNumber: trip.trip_number,
        status: trip.status,
        serviceDate,
        vehicle: {
          vehicleId: vehicle.id,
          vehicleCode: vehicle.vehicle_code,
          plateNumber: vehicle.plate_number,
          name: vehicle.name,
        },
        route: route
          ? { routeId: route.id, code: route.code, name: route.name }
          : null,
        driverName: trip.driver_name,
        helperName: trip.helper_name,
        truckLocationId: trip.truck_location_id,
        routeSessionId: trip.route_session_id,
        startedAt: trip.started_at ? new Date(trip.started_at).getTime() : null,
      },
      load: load
        ? {
            loadId: load.id,
            status: load.status,
            lines: lines.map((l) => ({
              lineNumber: l.line_number,
              productId: l.product_id,
              productCode: l.product_code,
              productName: l.name,
              uomCode: l.uom_code,
              quantityScale: String(l.quantity_scale),
              lotNumber: l.lot_number,
              expectedBase: String(l.expected_base),
              actualBase: l.actual_base === null ? null : String(l.actual_base),
              discrepancyReason: l.discrepancy_reason,
            })),
          }
        : null,
      truckStock: balances.map((b) => ({
        productId: b.product_id,
        availableBase: String(b.available_base ?? 0),
        damagedBase: String(b.damaged_base ?? 0),
      })),
      products,
      customers,
      priceLines,
      damageRecords: damages.map((d) => ({
        damageId: d.id,
        clientRequestId: d.client_request_id,
        productId: d.product_id,
        uomCode: d.uom_code,
        quantityScale: String(d.quantity_scale),
        quantityBase: String(d.quantity_base),
        reason: d.reason,
        status: d.status,
        recordedAt: new Date(d.recorded_at).getTime(),
        decisionNote: d.decision_note,
      })),
      promotions: [],
    };
  });
}
