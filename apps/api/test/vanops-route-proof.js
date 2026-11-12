import { postMovement } from "../src/domains/inventory/posting.js";
import { explainStock, expectedStock } from "../src/domains/van/facts.js";
import { lotBundle } from "../src/domains/van/lots.js";
import { stockCountCode } from "../src/domains/van/approvals.js";
import { sha256Hex } from "../src/core/util.js";
import { today } from "../src/domains/van/model.js";
import { ingestMaster } from "../src/domains/integration/replicas.js";
import { sampleMaster } from "../../sap-mock/src/sample.js";
import { seedFiscal } from "../../../packages/db/seed/fiscal.js";
import { fiscalBundle } from "../src/domains/fiscal/transactions.js";
import { actorFor } from "../src/core/context.js";

/** F-103/F-104/F-113/F-114/F-115/F-116/F-117/F-123 public signed-push proof with REAL Postgres stock posting.
 * Fixture creation only is direct SQL; every route fact and office decision uses HTTP.
 * @param {any} h @param {any} who @param {any} boss @param {string} unit @param {string} vehicle @param {string} truck @param {string} depot @param {string} outlet @param {any} expect
 */
export async function exerciseRoute(
  h,
  who,
  boss,
  unit,
  vehicle,
  truck,
  depot,
  outlet,
  expect,
) {
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: boss.email,
      password: "correct horse battery",
    }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  expect(login.status).toBe(200);
  const product = crypto.randomUUID(),
    base = crypto.randomUUID(),
    lotA = crypto.randomUUID(),
    lotB = crypto.randomUUID(),
    tripId = crypto.randomUUID(),
    loadId = crypto.randomUUID(),
    priceList = crypto.randomUUID(),
    routeId = crypto.randomUUID(),
    territoryId = crypto.randomUUID();
  const expiresA = Date.now() + 7 * 86400000,
    expiresB = Date.now() + 21 * 86400000;
  await h.db`insert into units_of_measure(id,organization_id,code,name,dimension,decimal_places,active) values(${base},'sunpride','PC','Piece','count',0,true)`;
  await h.db`insert into products(id,organization_id,code,name,category,uom,unit_price,active,base_uom_id,quantity_scale) values(${product},'sunpride','SAMPLE-FROZEN','Sample frozen pack','Frozen','PC',0,true,${base},1)`;
  await h.db`insert into product_inventory_policies(organization_id,product_id,base_uom_id,quantity_scale,quantity_precision,tracking_mode,allocation_policy,allow_mixed_lots_per_line,allow_negative_stock,quality_release_required,shelf_life_days,expiry_date_required,manufacture_date_required,minimum_remaining_shelf_life_days,costing_method,version,active) values('sunpride',${product},${base},1,0,'lot','fefo',true,false,true,90,true,false,0,'weighted_average',1,true)`;
  await h.db`insert into price_lists(id,organization_id,code,name,currency,status,source,effective_from) values(${priceList},'sunpride','SAMPLE-ROUTE','Sample route prices','PHP','active','sample',now()-interval '1 day')`;
  await h.db`insert into price_list_lines(organization_id,price_list_id,product_id,uom,unit_price_minor,effective_from) values('sunpride',${priceList},${product},'PC',100,now()-interval '1 day')`;
  await h.db`insert into territories(id,organization_id,code,name,status,effective_from,created_by) values(${territoryId},'sunpride','SAMPLE-ROUTE','Sample territory','active',now()-interval '1 day',${boss.userId})`;
  await h.db`insert into routes(id,organization_id,code,name,status,effective_from,created_by) values(${routeId},'sunpride','SAMPLE-ROUTE','Sample beat','active',now()-interval '1 day',${boss.userId})`;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${territoryId},${unit},now()-interval '1 day',${boss.userId},'Sample route proof')`;
  await h.db`insert into route_territories(route_id,territory_id,effective_from,actor_subject,reason) values(${routeId},${territoryId},now()-interval '1 day',${boss.userId},'Sample route proof')`;
  await h.db`insert into outlet_assignments(outlet_id,territory_id,route_id,sequence,effective_from,actor_subject,reason) values(${outlet},${territoryId},${routeId},1,now()-interval '1 day',${boss.userId},'Sample route proof')`;
  await h.db`insert into van_trips(id,organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,route_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by,operations_version) values(${tripId},'sunpride',${unit},'SAMPLE-CLOSED-LOOP',${vehicle},${truck},${depot},${routeId},${today()},${who.profile.id},${who.userId},'loading',${boss.userId},1)`;
  await h.db`insert into van_trip_loads(id,organization_id,trip_id,load_number,status,created_by) values(${loadId},'sunpride',${tripId},1,'planned',${boss.userId})`;
  for (const [i, id, batch, quantity, expiry] of [
    [1, lotA, "BATCH-A", 3, expiresA],
    [2, lotB, "BATCH-B", 5, expiresB],
  ]) {
    await h.db`insert into inventory_lots(id,organization_id,product_id,lot_number,normalized_lot_number,source_type,received_at,expires_at,quality_status,unit_cost_minor) values(${id},'sunpride',${product},${batch},${batch},'sample',now(),${new Date(Number(expiry))},'released',50)`;
    await h.db.begin(async (/** @type {any} */ db) =>
      postMovement(db, {
        kind: "opening_balance",
        sourceType: "sample_fixture",
        sourceId: String(id),
        idempotencyKey: String(id),
        occurredAt: Date.now(),
        organizationId: "sunpride",
        actor: { profileId: boss.profile.id, userId: boss.userId },
        authorizedLocations: [depot],
        lines: [
          {
            productId: product,
            fromLocationId: null,
            toLocationId: depot,
            quantityBase: Number(quantity) + (id === lotA ? 12 : 0),
            uom: "PC",
            lotId: String(id),
            unitCostMinor: 50,
          },
        ],
      }),
    );
    await h.db`insert into van_trip_load_lines(organization_id,load_id,trip_id,line_number,product_id,product_code,uom_code,quantity_scale,lot_id,lot_number,expected_base) values('sunpride',${loadId},${tripId},${i},${product},'SAMPLE-FROZEN','PC',1,${id},${batch},${quantity})`;
  }
  // F-016 F-019: exercise the integrated owners, not a retired price-list or
  // uncontrolled handset number. These are explicitly marked fixture masters.
  for (const [table, id] of [
    ["org_units", unit],
    ["profiles", boss.profile.id],
    ["vehicles", vehicle],
  ])
    await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('sa2-route-fixture',${table},${id},${table + id}) on conflict do nothing`;
  await seedFiscal(h.db);
  const actor = await actorFor(h.db, who.userId);
  const [trip] = await h.db`select * from van_trips where id=${tripId}`;
  const bundle = await fiscalBundle(h.db, actor, trip, who.deviceId);
  const range = bundle.ranges.find(
    (/** @type {any} */ r) => r.documentType === "sales_invoice",
  );
  if (!range)
    throw new Error(
      "Sales-invoice allocation missing from integrated fiscal owner",
    );
  expect(range).toBeTruthy();
  const receiptNumber = `${range.prefix}-${range.nextSerial.padStart(9, "0")}`;
  await ingestMaster(
    h.db,
    sampleMaster("condition", "SA2-ROUTE-PRICE", {
      productCode: "SAMPLE-FROZEN",
      uom: "PC",
      customerCode: null,
      channelKey: null,
      unitPriceCentavos: 100,
      currency: "PHP",
      taxCode: "SAMPLE-VAT",
      taxBasisPoints: 1200,
      taxInclusive: true,
      priceListCode: "SA2-SAP-CONTROL",
      precedence: 1,
    }),
  );
  /** @type {any[]} */ const saved = [];
  async function send(/** @type {string} */ type, /** @type {any} */ facts) {
    const at = Date.now(),
      op = {
        clientOpId: crypto.randomUUID(),
        opType: type,
        clientTime: at,
        dependsOn: [],
        payload: { tripId, settlementVersion: 1, deviceTime: at, ...facts },
      };
    const r = await h.signed(who, op);
    if (r.body.results?.[0]?.status !== "applied")
      throw new Error(`${type}: ${JSON.stringify(r.body.results?.[0])}`);
    expect(r.res.status).toBe(200);
    expect(r.body.results[0].status).toBe("applied");
    saved.push(op);
    return op;
  }
  const reading = (
    /** @type {string} */ checkpoint,
    /** @type {string|null} */ store = null,
  ) => ({
    observationId: crypto.randomUUID(),
    checkpoint,
    deciC: -200,
    method: "manual",
    ...(store ? { outletId: store } : {}),
  });
  await send("temperature.record", reading("load_out"));
  await send("load.confirm", {
    loadId,
    lines: [
      { lineNumber: 1, actualBase: "3" },
      { lineNumber: 2, actualBase: "5" },
    ],
  });
  const noOdometer = await h.signed(who, {
    clientOpId: crypto.randomUUID(),
    opType: "trip.start",
    clientTime: Date.now(),
    dependsOn: [],
    payload: {
      tripId,
      settlementVersion: 1,
      deviceTime: Date.now(),
      vehicleConfirmed: true,
      routeConfirmed: true,
    },
  });
  expect(noOdometer.body.results[0].status).toBe("rejected");
  await send("trip.start", {
    vehicleConfirmed: true,
    routeConfirmed: true,
    odometerKm: 1000,
  });
  const stopId = crypto.randomUUID();
  await send("stop.record", {
    observationId: crypto.randomUUID(),
    stopId,
    phase: "arrival",
    outletId: outlet,
  });
  await send("temperature.record", reading("delivery", outlet));
  const saleId = crypto.randomUUID(),
    quantity = 4,
    price = 100,
    total = String(quantity * price);
  const allocations = [
    {
      lotId: lotA,
      batch: "BATCH-A",
      expiresAt: expiresA,
      qualityStatus: "released",
      quantityBase: "3",
    },
    {
      lotId: lotB,
      batch: "BATCH-B",
      expiresAt: expiresB,
      qualityStatus: "released",
      quantityBase: "1",
    },
  ];
  await send("sale.record", {
    saleId,
    receiptNumber,
    fiscal: { allocationId: range.allocationId, serial: range.nextSerial },
    customer: { outletId: outlet },
    currency: "PHP",
    totalMinor: total,
    lines: [
      {
        productId: product,
        quantityBase: String(quantity),
        paidBase: String(quantity),
        freeBase: "0",
        unitPriceMinor: String(price),
        grossMinor: total,
        discountMinor: "0",
        totalMinor: total,
        allocations,
      },
    ],
    payment: {
      method: "cash",
      kind: "cash",
      amountMinor: total,
      tenderedMinor: total,
      changeMinor: "0",
      status: "paid",
    },
  });
  expect(
    (
      await h.db`select physical_base::text as quantity from inventory_lot_balances where lot_id=${lotA} and location_id=${truck} and stock_status='available'`
    )[0].quantity,
  ).toBe("0");
  const jpeg = new Uint8Array(
    await Bun.file(
      new URL("./fixtures/sample-return.jpg", import.meta.url),
    ).arrayBuffer(),
  );
  const returned = await send("return.record", {
    returnId: crypto.randomUUID(),
    returnNumber: "SAMPLE-RETURN-AABBCCDD-0002",
    originalSale: { saleId, receiptNumber },
    customer: { outletId: outlet },
    lines: [
      {
        productId: product,
        quantityBase: "1",
        uomCode: "PC",
        reason: "damaged",
        disposition: "bad_stock",
        stockEffect: "damaged",
        lotNumber: "BATCH-A",
        allocations: [{ ...allocations[0], quantityBase: "1" }],
      },
    ],
    customerAcknowledgement: {
      name: "Sample customer",
      accepted: true,
      strokes: [
        [
          [10, 10],
          [1000, 3000],
          [9000, 9000],
        ],
      ],
    },
    photo: {
      base64: Buffer.from(jpeg).toString("base64"),
      sha256: sha256Hex(jpeg),
    },
  });
  expect(
    (
      await h.db`select physical_base::text as quantity from inventory_lot_balances where lot_id=${lotA} and location_id=${truck} and stock_status='damaged'`
    )[0].quantity,
  ).toBe("1");
  // VAN-061: the handheld's own payload for "Thrown away at the store · needs approval" on a linked receipt.
  // It must reach the office pickup review (custody only, nothing on the truck), not be refused on sync.
  const thrown = await send("return.record", {
    returnId: crypto.randomUUID(),
    returnNumber: "SAMPLE-RETURN-AABBCCDD-0003",
    status: "awaiting_approval",
    custodyOnly: true,
    approval: { required: true, reasons: ["disposed_at_outlet"] },
    originalSale: { saleId, receiptNumber },
    customer: { outletId: outlet },
    customerName: "Sample customer",
    lines: [
      {
        lineNumber: 1,
        productId: product,
        product: {
          code: "SAMPLE-FROZEN",
          name: "Sample frozen pack",
          uomCode: "PC",
          quantityScale: "1",
        },
        uomCode: "PC",
        uomBaseQuantity: "1",
        uomQuantity: "1",
        quantityBase: "1",
        reason: "expired",
        reasonLabel: "Expired",
        disposition: "disposed_at_outlet",
        stockEffect: "none",
        approvalRequired: true,
        allocations: [{ ...allocations[0], quantityBase: "1" }],
        lotNumber: "BATCH-A",
        expiryDate: "2026-10-31",
      },
    ],
    customerAcknowledgement: {
      name: "Sample customer",
      accepted: true,
      strokes: [
        [
          [10, 10],
          [9000, 9000],
        ],
      ],
    },
    photo: {
      base64: Buffer.from(jpeg).toString("base64"),
      sha256: sha256Hex(jpeg),
    },
  });
  const [held] =
    await h.db`select custody_only,sale_id,(select stock_status from van_return_lines where return_id=r.id) as status from van_returns r where id=${thrown.payload.returnId}`;
  expect(held).toEqual({ custody_only: true, sale_id: null, status: "none" });
  const queue = await h.fetch(`/api/v1/van/return-pickups?tripId=${tripId}`, {
    headers: { cookie },
  });
  expect(queue.status).toBe(200);
  expect(
    (await queue.json()).items.map((/** @type {any} */ x) => x.returnNumber),
  ).toContain("SAMPLE-RETURN-AABBCCDD-0003");
  // The office (not the seller) verifies the disposal on the trip review; sign-off below needs it.
  await office("pickups/decide", {
    returnId: thrown.payload.returnId,
    decision: "disposal_verified",
    reason: "Store photo and signature checked",
  });
  await send("returnable.record", {
    observationId: crypto.randomUUID(),
    action: "count",
    typeCode: "crate",
    quantity: "12",
  });
  await send("returnable.record", {
    observationId: crypto.randomUUID(),
    action: "issue",
    typeCode: "crate",
    quantity: "2",
    outletId: outlet,
  });
  await send("returnable.record", {
    observationId: crypto.randomUUID(),
    action: "receive",
    typeCode: "crate",
    quantity: "1",
    outletId: outlet,
  });
  await send("temperature.record", reading("interval"));
  const reload = await send("reload.request", {
    observationId: crypto.randomUUID(),
    lines: [{ productId: product, quantityBase: "12" }],
    note: "Sample fast mover",
  });
  await office("reloads/action", {
    requestId: reload.payload.observationId,
    action: "approved",
    note: "Sample reload approval",
  });
  await office("reloads/action", {
    requestId: reload.payload.observationId,
    action: "dispatched",
    note: "Sample physical dispatch",
  });
  expect(
    (
      await h.db`select physical_base::text as quantity from inventory_lot_balances where lot_id=${lotA} and stock_status='in_transit' and location_id<>${truck}`
    )[0].quantity,
  ).toBe("12");
  // In-transit stock sits in the depot's In transit place, never on the truck (SPEC 3.1).
  expect(
    (
      await h.db`select 1 from inventory_lot_balances where lot_id=${lotA} and location_id=${truck} and stock_status='in_transit' and physical_base<>0`
    ).length,
  ).toBe(0);
  const [dispatch] =
    await h.db`select facts from van_reload_events where request_id=${reload.payload.observationId} and kind='dispatched'`;
  // SPEC 5.6: the seller counts 10 good + 2 damaged. That is accepted as a variance on the reload document;
  // it does not block the trip (v1 refused anything but the exact dispatched batches).
  await send("reload.receive", {
    requestId: reload.payload.observationId,
    lines: dispatch.facts.lines.map(
      (/** @type {any} */ l, /** @type {number} */ i) => ({
        productId: l.productId,
        lotId: l.lotId,
        receivedGoodBase: String(Number(l.quantityBase) - (i === 0 ? 2 : 0)),
        receivedDamagedBase: String(i === 0 ? 2 : 0),
        reasonCode: "DMG-TRANSIT",
        photoCount: 1,
      }),
    ),
    note: "Two pieces crushed in the crate",
  });
  expect(
    (
      await h.db`select physical_base::text as quantity from inventory_lot_balances where lot_id=${lotA} and location_id=${truck} and stock_status='available'`
    )[0].quantity,
  ).toBe("10");
  expect(
    (
      await h.db`select physical_base::text as quantity from inventory_lot_balances where lot_id=${lotA} and location_id=${truck} and stock_status='damaged'`
    )[0].quantity,
  ).toBe("3"); // 1 damaged on the route + the 2 crushed in the reload
  expect(
    (
      await h.db`select type,status,variance_status from stock_transfers where source_ref=${`van_reload:${reload.payload.observationId}`}`
    )[0],
  ).toMatchObject({
    type: "van_reload",
    status: "closed",
    variance_status: "auto_accepted",
  });
  await send("stop.record", {
    observationId: crypto.randomUUID(),
    stopId,
    phase: "departure",
    outletId: outlet,
  });
  await send("cash.reconcile", {
    reconciliationId: crypto.randomUUID(),
    currency: "PHP",
    expectedMinor: total,
    declaredMinor: total,
    counts: [{ denominationMinor: String(price), count: String(quantity) }],
    approval: { method: "none" },
  });
  const expected = await expectedStock(h.db, tripId),
    batches = await lotBundle(h.db, { id: tripId, truck_location_id: truck });
  const countId = crypto.randomUUID(),
    lines = expected.map((e) => ({
      productId: e.productId,
      status: e.status,
      expectedBase: String(e.expectedBase),
      countedBase: String(e.expectedBase),
      reasonCode: "",
    }));
  const countBatches = batches.lots.filter((/** @type {any} */ l) =>
    ["available", "damaged"].includes(l.status),
  );
  const lotLines = countBatches.map((/** @type {any} */ l) => ({
    ...l,
    expectedBase: l.quantityBase,
    countedBase: l.quantityBase,
  }));
  await send("stock.reconcile", {
    reconciliationId: countId,
    lines,
    lotLines,
    countCode: stockCountCode(tripId, countId, lines),
    varianceLines: 0,
    shortBase: "0",
    overBase: "0",
    approval: { method: "none" },
  });
  const unloadLines = countBatches.map((/** @type {any} */ l) => ({
    ...l,
    partition: l.status === "damaged" ? "customer_return" : "unsold",
    uomCode: "PC",
  }));
  const unload = await send("unload.record", {
    observationId: crypto.randomUUID(),
    lines: unloadLines,
    empties: [{ typeCode: "crate", quantity: "11" }],
  });
  const manifest = saved.map((o) => ({
    clientRequestId: o.clientOpId,
    kind: o.opType,
  }));
  await send("trip.close", {
    closeId: crypto.randomUUID(),
    endOdometerKm: 1020,
    exceptionsReviewed: true,
    operations: manifest,
  });
  expect(
    (
      await h.db`select status,end_odometer_km from van_trips where id=${tripId}`
    )[0],
  ).toMatchObject({ status: "closing", end_odometer_km: 1020 });
  async function office(
    /** @type {string} */ path,
    /** @type {any} */ payload,
  ) {
    const response = await h.fetch("/api/v1/van/" + path, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ tripId, ...payload }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    return body;
  }
  // The clerk counts one piece MORE of the first available batch (over is allowed), and that batch was recalled
  // meanwhile: it is received into On hold instead of being refused.
  const overLine = unloadLines.find(
    (/** @type {any} */ l) => l.status === "available" && l.lotId,
  );
  await h.db`insert into inventory_lot_holds(lot_id,source_type,source_id,actor_subject) values(${overLine.lotId},'retail_recall',${crypto.randomUUID()},'test')`;
  await office("observations/decide", {
    observationId: unload.payload.observationId,
    decision: "received",
    lines: unloadLines.map((/** @type {any} */ l) => ({
      productId: l.productId,
      lotId: l.lotId,
      status: l.status,
      receivedBase:
        l === overLine ? String(Number(l.quantityBase) + 1) : l.quantityBase,
      ...(l === overLine ? { reason: "Clerk counted one more" } : {}),
    })),
    empties: [{ typeCode: "crate", quantity: "11" }],
    note: "Sample warehouse physical receipt",
  });
  expect(
    Number(
      (
        await h.db`select quality_hold_base::text as q from inventory_balances where location_id=${depot} and product_id=${overLine.productId}`
      )[0].q,
    ),
  ).toBe(Number(overLine.quantityBase));
  const [loadIn] =
    await h.db`select t.type,t.status,t.variance_status,t.transfer_number,(select sum(over_base) from stock_transfer_allocations where transfer_id=t.id)::int as over from stock_transfers t where t.source_ref like 'van_load_in:%' and t.source_location_id=${truck}`;
  expect(loadIn).toMatchObject({ type: "van_load_in", over: 1 });
  expect(loadIn.transfer_number).toMatch(/^LIN-/);
  await office("cash/remit", { amountMinor: total, reference: "SAMPLE-CASH" });
  const [settlement] =
    await h.db`select * from van_settlements where trip_id=${tripId}`;
  await office("settlements/decide", {
    settlementId: settlement.id,
    contentHash: settlement.content_hash,
    decision: "approved",
    note: "Sample supervisor sign-off",
  });
  expect(
    (await h.db`select status from van_trips where id=${tripId}`)[0].status,
  ).toBe("closed");
  expect(
    (
      await h.db`select count(*)::int as n from van_sap_requests where source_id=${settlement.id}`
    )[0].n,
  ).toBe(1);
  for (const op of saved)
    expect((await h.signed(who, op)).body.results[0].status).toBe("duplicate");
  expect(
    (
      await h.db`select count(*)::int as n from van_sales where trip_id=${tripId}`
    )[0].n,
  ).toBe(1);
  expect(
    (
      await h.db`select count(*)::int as n from van_returns where trip_id=${tripId}`
    )[0].n,
  ).toBe(2); // the linked damaged return + the VAN-061 held store disposal
  expect(
    (
      await h.db`select count(*)::int as n from van_settlements where trip_id=${tripId}`
    )[0].n,
  ).toBe(1);
  expect(
    (
      await h.db`select physical_base::text as quantity from inventory_balances where location_id=${truck} and product_id=${product}`
    )[0].quantity,
  ).toBe("0");
  const response = await h.fetch(`/api/v1/van/trip?tripId=${tripId}`, {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  const detail = await response.json();
  const ledger = detail.stock.find(
    (/** @type {any} */ row) => row.productId === product,
  );
  expect(ledger.reloaded.base).toBe("12");
  expect(ledger.remaining.base).toBe("0");
  expect(ledger.unloaded.base).toBe(ledger.counted.base);
  expect(detail.vanOps.scorecard).toMatchObject({
    calls: 1,
    plannedCalls: 1,
    productiveCalls: 1,
    strikeRateBasisPoints: 10000,
    returnDocuments: 2,
    salesCentavos: total,
    collectedCentavos: total,
  });
  expect(detail.vanOps.vanContainers[0].quantity).toBe("0");
  expect(detail.vanOps.containers[0].outstanding).toBe("1");
  expect(detail.vanOps.settlementState).toBe("approved_pending_sap");
  expect(detail.settlementStatus).toBe("approved_pending_sap");
  const stopFacts = detail.vanOps.observations.filter(
    (/** @type {any} */ o) => o.kind === "stop",
  );
  expect(
    stopFacts.map((/** @type {any} */ o) => o.facts.actualSequence),
  ).toEqual([1, 1]);
  expect(stopFacts[0].facts.plannedSequence).toBe(1);
  const tomorrow = new Date(today() + "T00:00:00Z");
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const next = await office("trips/plan", {
    vehicleId: vehicle,
    salespersonProfileId: who.profile.id,
    routeId,
    sourceLocationId: depot,
    serviceDate: tomorrow.toISOString().slice(0, 10),
    operationsVersion: 1,
  });
  const recommendation = await office("loads/suggest", { tripId: next.tripId });
  expect(recommendation.routeOutletCount).toBe(1);
  expect(recommendation.cycles).toHaveLength(1);
  expect(recommendation.recommendations[0]).toMatchObject({
    productId: product,
    forecastBase: String(quantity),
    recommendedBase: String(quantity),
  });
  const load = await office("loads/apply-suggestion", {
    tripId: next.tripId,
    suggestionId: recommendation.suggestionId,
    contentHash: recommendation.contentHash,
    capacityReviewed: true,
    note: "Sample reviewed capacity",
    lines: [{ productId: product, quantityBase: String(quantity) }],
  });
  expect(
    (
      await h.db`select expected_base::text as quantity,lot_id from van_trip_load_lines where load_id=${load.loadId}`
    )[0],
  ).toMatchObject({ quantity: String(quantity), lot_id: lotB }); // batch A was recalled above, so it is not suggested
  return {
    tripId,
    returnId: returned.payload.returnId,
    operationCount: saved.length,
    plannedTripId: next.tripId,
  };
}
