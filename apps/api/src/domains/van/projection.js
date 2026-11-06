import { modeAt, modeBundle } from "../storepos/model.js";
import { callSnapshot } from "../availability/calls.js";
import { tx } from "@sunpride/db/client";
import { deliveryBundle } from "../presell/driver.js";
import {
  configurationsForApp,
  hasConfiguredFlowsForApp,
} from "../callflow/engine.js";
import { tenderPolicy } from "../fiscal/tenders.js";
import { fiscalBundle } from "../fiscal/transactions.js";
import { routeBundle } from "./route-read.js";
import { ApiError } from "../../core/errors.js";
import { resolvePrice } from "../orders/pricing.js";
import { schemeFeed } from "./schemes.js";
import { cachedCreditView, creditTerms } from "../integration/credit-view.js";
import { creditRequestsForTrip } from "../integration/credit-exceptions.js";
import { nativeSchemeContext } from "../tpm/native-context.js";
import { masterId } from "../integration/replicas.js";
import { currentDeviceActor, tripFor, outletFor } from "./access.js";
import { productFor, stockBearing } from "./facts.js";
import { catalogueMetadata } from "../masters/catalogue.js";
import { approvalKey } from "./approvals.js";
import { vanDayBundle } from "./dayboard.js";
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
/**
 * IP-INT3: the van sale takes cash plus one other tender (`payment.parts` / `payments[]`). `policy.splitTender` is a new
 * key in the frozen v1 `policy` object (additionalProperties:false in beta.26/27), so it goes only to a phone that proves
 * it is the new build. beta.26/27 already send `handheld:true`; only the hh2 build also sends `vanDay:true`.
 * @param {any} ctx
 */
export function splitTenderFlag(ctx) {
  return ctx.params.handheld === true && ctx.params.vanDay === true
    ? { splitTender: true }
    : {};
}

/**
 * IP-P0 (SPEC 5.3): who this handheld is for, so "No trip for today" can name the van and the supervisor.
 * The van is today's trip, else the last trip this handheld or seller drove. The supervisor is the seller's current
 * employee-assignment supervisor, else the profile's supervisor. Unknown parts are null. `supervisorPhone` is the
 * number the office keeps on that supervisor's profile (null until it is filled in).
 * @param {any} db @param {any} actor @param {any} device @param {any} [trip]
 */
export async function handheldInfo(db, actor, device, trip) {
  const [vehicle] = trip
    ? await db`select vehicle_code,plate_number from vehicles where id=${trip.vehicle_id}`
    : await db`select v.vehicle_code,v.plate_number from van_trips t join vehicles v on v.id=t.vehicle_id
        where t.deleted_at is null and t.status<>'cancelled' and (t.started_device_id=${device.id} or t.salesperson_profile_id=${actor.profileId})
        order by t.service_date desc,t.created_at desc limit 1`;
  const [assigned] =
    await db`select p.name,p.phone from employee_assignments a join profiles p on p.id=a.supervisor_id
    where a.profile_id=${actor.profileId} and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())
      and p.deleted_at is null and p.status='active' limit 1`;
  const [named] = assigned
    ? []
    : await db`select s.name,s.phone from profiles p join profiles s on s.auth_subject=p.supervisor_subject
        where p.id=${actor.profileId} and s.deleted_at is null and s.status='active' limit 1`;
  return {
    vehicleCode: vehicle?.vehicle_code ?? null,
    plateNumber: vehicle?.plate_number ?? null,
    supervisorName: (assigned ?? named)?.name ?? null,
    supervisorPhone: (assigned ?? named)?.phone ?? null,
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
    params: (p) => {
      if (p.schemeEngine !== undefined && p.schemeEngine !== 1)
        throw new ApiError(
          "version_unsupported",
          426,
          "Update the native promotion engine",
          false,
          { action: "update" },
        );
      return {
        serviceDate: date(p.serviceDate),
        ...(p.catalogue === true ? { catalogue: true } : {}),
        ...(p.schemeEngine === 1 ? { schemeEngine: 1 } : {}),
        ...(p.posMode === true ? { posMode: true } : {}),
        // IP-P0: the van app that can read the handheld card, the trip float and the recount note says so.
        // Older apps validate the frozen v1 trip/load/policy strictly and never ask.
        ...(p.handheld === true ? { handheld: true } : {}),
        // IP-VANDAY: roster, crew on this phone and the suggested/dispatched load; older apps never ask.
        ...(p.vanDay === true ? { vanDay: true } : {}),
      };
    },
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
    const { actor, device, partner } = await currentDeviceActor(
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
    const posMode = await modeAt(db, device.id);
    if (posMode?.mode === "store" && ctx.params.posMode !== true)
      throw new ApiError(
        "update_required",
        422,
        "Update this POS to use Store mode",
      );
    const storePos =
      ctx.params.posMode === true
        ? await modeBundle(db, actor, device, posMode, {
            taxFacts: ctx.params.handheld === true,
          })
        : null;
    let trips =
      storePos?.mode === "store"
        ? []
        : await db`select id from van_trips where salesperson_profile_id=${actor.profileId} and service_date=${serviceDate} and status not in ('cancelled','closed') and deleted_at is null order by created_at desc limit 2`;
    // Sequential trips are allowed after settlement; only multiple OPEN trips are ambiguous.
    // Keep the latest closed trip visible when the office has not planned the next one yet.
    if (!trips.length && storePos?.mode !== "store")
      trips =
        await db`select id from van_trips where salesperson_profile_id=${actor.profileId} and service_date=${serviceDate} and status='closed' and deleted_at is null order by created_at desc limit 1`;
    if (trips.length > 1)
      throw new ApiError(
        "trip_conflict",
        409,
        "More than one trip needs office reconciliation",
      );
    const handheld = ctx.params.handheld === true;
    const empty = {
      serviceDate,
      seller: { profileId: actor.profileId, name: actor.name },
      policy: {
        ...policy(env, null),
        ...(storePos ? { storePos } : {}),
        ...(handheld
          ? {
              handheld: await handheldInfo(db, actor, device, null),
              ...splitTenderFlag(ctx),
            }
          : {}),
      },
      trip: null,
      load: null,
      truckStock: [],
      products: [],
      customers: [],
      priceLines: [],
      damageRecords: [],
      promotions: [],
      callFlowCalls: [],
      availability: [],
      deliveryDrops: [],
    };
    if (storePos?.mode === "store" || !trips.length) {
      if (ctx.params.vanDay === true && storePos?.mode !== "store")
        return {
          ...empty,
          vanDay: await vanDayBundle(db, actor, device, null, serviceDate),
        };
      return empty;
    }
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
    // Only truck rows holding stock in some status, or for a planned load line, reference a product. A historical
    // all-zero row owes the phone nothing; counting it would multiply every outlet by dead products (still bounded below).
    const loadProductIds = new Set(lines.map((l) => l.product_id));
    /** @type {any[]} */ const balances = complete(
      await db`select * from inventory_balances where location_id=${trip.truck_location_id} and deleted_at is null
        and (${stockBearing(db)} ${loadProductIds.size ? db`or product_id in ${db([...loadProductIds])}` : db``}) order by product_id limit 501`,
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
      // F-616 is opt-in: older APKs validate frozen v1 product keys strictly.
      const catalogue =
        ctx.params.catalogue === true
          ? await catalogueMetadata(db, id, ctx.now)
          : null;
      products.push({
        ...(catalogue ? { catalogue } : {}),
        // IP-HH2: the office's category for the phone's chips. Opt-in (`params.categories`): the frozen v1 product
        // schema of older APKs rejects unknown keys, so nothing changes unless the phone asks.
        ...(ctx.params.categories === true && p.category
          ? { category: String(p.category).slice(0, 60) }
          : {}),
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
    const configured = await hasConfiguredFlowsForApp(db, ctx.app, ctx.now);
    /** @type {any[]} */ const candidates = complete(
      partner
        ? await db`select o.id,a.sequence,a.route_id from distributor_outlets g join outlets o on o.id=g.outlet_id
        left join outlet_assignments a on a.outlet_id=o.id and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) and a.deleted_at is null
        where g.distributor_id=${partner.distributor_id} and g.effective_from<=now() and (g.effective_to is null or g.effective_to>now()) and o.status='active' and o.deleted_at is null order by a.sequence nulls last,o.code limit 601`
        : await db`select o.id,a.sequence,a.route_id from outlets o
        left join outlet_assignments a on a.outlet_id=o.id and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) and a.deleted_at is null
        left join territory_ownerships own on own.territory_id=a.territory_id and own.effective_from<=now() and (own.effective_to is null or own.effective_to>now()) and own.deleted_at is null
        where o.status='active' and o.deleted_at is null and
        (a.route_id=${trip.route_id} or (a.route_id is null and o.custodian_org_unit_id=${trip.org_unit_id}) or
          (${configured} and (case when a.id is null then o.custodian_org_unit_id else own.org_unit_id end)=${trip.org_unit_id}))
        order by case when a.route_id=${trip.route_id} then 0 else 1 end,a.sequence nulls last,o.code limit 601`,
      600,
    );
    /** @type {any[]} */ const customers = [],
      priceLines = [],
      taxQuotes = [],
      schemeContexts = [];
    const priceKeys = new Set();
    /** @type {Record<string,any>} */ const creditSnapshots = {};
    /** @type {Map<string,Map<string,string|null>>} */ const sourceLists =
      new Map();
    for (const candidate of candidates) {
      let o;
      try {
        o = await outletFor(db, actor, candidate.id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) continue;
        throw e;
      }
      // F-112: one cached SAP read, never hundreds of synchronous provider checks during bootstrap.
      const creditSnapshot = await cachedCreditView(
        db,
        o.customerCode,
        await creditTerms(db, o.id, ctx.now),
        ctx.now,
      );
      creditSnapshots[o.id] = creditSnapshot;
      const credit =
        creditSnapshot.availableMinor === null ||
        creditSnapshot.termsDays === null
          ? null
          : {
              termsDays: creditSnapshot.termsDays,
              availableMinor: creditSnapshot.availableMinor,
            };
      let priceListId = null;
      const sourceList = new Map();
      sourceLists.set(o.id, sourceList);
      const nativePrices = [];
      for (const p of products) {
        const price = await resolvePrice(db, {
          organizationId: trip.organization_id,
          productId: p.productId,
          uom: p.uomCode,
          channelKey: o.channel,
          customerCode: o.customerCode,
          outletId: o.id,
          at: Date.now(),
        });
        if (price.unitPriceCentavos === null || !price.priceListId) continue;
        sourceList.set(p.productId, price.priceListId);
        nativePrices.push({ productId: p.productId, uom: p.uomCode, ...price });
        // F-016 a customer quote may combine base, channel and customer conditions.
        // The offline grouping is a quote identity, not a second authoritative price list.
        priceListId = masterId("van.priceQuote", o.id);
        const key = `${priceListId}:${p.productId}:${p.uomCode}`;
        if (!priceKeys.has(key)) {
          priceKeys.add(key);
          priceLines.push({
            priceListId,
            productId: p.productId,
            uomCode: p.uomCode,
            unitPriceMinor: String(price.unitPriceCentavos),
            currency: "PHP",
            effectiveFrom: price.effectiveFrom ?? Date.now(),
            effectiveTo: price.effectiveTo ?? null,
            priceListCode: "SAP replicated conditions",
          });
          complete(priceLines, 600);
          taxQuotes.push({
            priceListId,
            productId: p.productId,
            uomCode: p.uomCode,
            sourcePriceListId: price.priceListId,
            treatment: price.taxTreatment ?? null,
            taxCode: price.taxCode ?? null,
            taxBasisPoints: price.taxBasisPoints ?? null,
            sourceTaxInclusive: price.sourceTaxInclusive ?? null,
            sourceNetUnitMinor:
              price.sourceUnitPriceCentavos == null
                ? null
                : String(price.sourceUnitPriceCentavos),
            sourceSellingUnitMinor: String(price.unitPriceCentavos),
            sourceKey: price.sapKey ?? null,
            sourceVersion: price.sapVersion ?? null,
            effectiveFrom: price.effectiveFrom ?? ctx.now,
            effectiveTo: price.effectiveTo ?? null,
          });
        }
      }
      if (ctx.params.schemeEngine === 1)
        schemeContexts.push(
          await nativeSchemeContext(
            { ...ctx, db, actor },
            {
              outletId: o.id,
              channelKey: o.channel,
              orgUnitId: trip.org_unit_id,
              products: products.map((p) => ({
                productId: p.productId,
                uom: p.uomCode,
                name: p.name,
                code: p.code,
              })),
              prices: nativePrices,
            },
          ),
        );
      customers.push({
        outletId: o.id,
        code: o.code,
        name: o.name,
        address: o.address,
        sequence: candidate.sequence ?? null,
        source:
          trip.route_id && candidate.route_id === trip.route_id
            ? "route"
            : "unplanned",
        credit,
        priceListId,
      });
    }
    const flowOutlets = customers.length
      ? await db`select id,classification,channel from outlets where id in ${db(customers.map((c) => c.outletId))}`
      : [];
    const flowConfigs = await configurationsForApp(
      db,
      ctx.app,
      flowOutlets,
      ctx.now,
      { profileId: actor.profileId, deviceId: device.id },
    );
    for (const customer of customers)
      if (flowConfigs.has(customer.outletId))
        customer.callFlow = flowConfigs.get(customer.outletId);
    const availability = [];
    const retailEnabled =
      (
        await db`select 1 from availability_releases where kind='msl' and status='published' and effective_from<=now() and (effective_to is null or effective_to>now()) limit 1`
      ).length > 0;
    const retailContext = {
      ...ctx,
      db,
      actor,
      device,
      app: "van-android",
      availabilityHistory: new Map(),
      availabilityOutletIds: customers.map((c) => c.outletId),
    };
    for (const customer of customers)
      if (trip.status !== "closed" && retailEnabled)
        availability.push(
          await callSnapshot(retailContext, customer.outletId, serviceDate),
        );
    /** @type {any[]} */ const damages = complete(
      await db`select * from van_damage_records where trip_id=${trip.id} and deleted_at is null order by recorded_at desc limit 501`,
      500,
    );
    const routeOps = await routeBundle(db, trip);
    const tripPolicy = policy(env, trip.id);
    const schemes = await schemeFeed(
      db,
      actor,
      customers,
      products,
      sourceLists,
      ctx.now,
    );
    const customerChannels = customers.length
      ? await db`select id,channel from outlets where id in ${db(customers.map((c) => c.outletId))}`
      : [];
    if (routeOps) {
      tripPolicy.tripClose = {
        ...tripPolicy.tripClose,
        requireUploadsSent: false,
      };
      tripPolicy.cashReconciliation.approvalRequired = false;
      tripPolicy.stockReconciliation.approvalRequired = false;
    }
    return {
      serviceDate,
      seller: empty.seller,
      policy: {
        ...tripPolicy,
        ...(storePos ? { storePos } : {}),
        ...(handheld
          ? {
              handheld: await handheldInfo(db, actor, device, trip),
              ...splitTenderFlag(ctx),
            }
          : {}),
        paymentMethods: await tenderPolicy(db, trip.org_unit_id),
        fiscal: {
          ...(await fiscalBundle(db, actor, trip, device.id, env)),
          customerChannels: Object.fromEntries(
            customerChannels.map((/** @type {any} */ c) => [c.id, c.channel]),
          ),
          taxVersion: 1,
          taxQuotes,
          schemeHolds: schemes.holds,
          creditSnapshots,
          sapCreditRequests: await creditRequestsForTrip(db, actor, trip),
        },
        ...(ctx.params.schemeEngine === 1
          ? { schemes: { engineVersion: 1, outlets: schemeContexts } }
          : {}),
        ...(routeOps ? { operationsVersion: 1 } : {}),
      },
      ...(routeOps ? { vanOps: routeOps } : {}),
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
        ...(handheld
          ? { openingFloatCentavos: Number(trip.opening_float_centavos ?? 0) }
          : {}),
      },
      load: load
        ? {
            loadId: load.id,
            status: load.status,
            // The count the office saw last and, when it sent that count back, why: the phone recounts.
            ...(handheld
              ? {
                  confirmRequestId: load.confirm_request_id ?? null,
                  rejectionNote:
                    load.status === "planned" && load.confirm_request_id
                      ? (load.approval_note ?? null)
                      : null,
                }
              : {}),
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
      availability,
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
      callFlowCalls: complete(
        await db`select client_call_id as "clientCallId",outlet_id as "outletId",state
        from call_executions where trip_id=${trip.id} and profile_id=${actor.profileId} and device_id=${device.id} order by started_at,id limit 501`,
        500,
      ),
      deliveryDrops: await deliveryBundle(db, actor, trip),
      promotions: schemes.promotions,
      ...(ctx.params.vanDay === true
        ? { vanDay: await vanDayBundle(db, actor, device, trip, serviceDate) }
        : {}),
    };
  });
}
