import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { copyTrialRow } from "../../../packages/db/seed/trial-wiring.js";
import {
  applyKickoffVan,
  manilaDate,
} from "../../../packages/db/seed/kickoff-van.js";
import { domainInstallers } from "../src/domains/index.js";
import { actorFor } from "../src/core/context.js";
import { fiscalBundle } from "../src/domains/fiscal/transactions.js";
import { issueDocument } from "../src/domains/fiscal/series.js";
import { tx } from "@sunpride/db/client";
import { resolvePrice } from "../src/domains/orders/pricing.js";
import { expectedStock } from "../src/domains/van/facts.js";
import { routePolicy } from "../src/domains/van/route-policy.js";
import { lotBundle } from "../src/domains/van/lots.js";
import { stockCountCode } from "../src/domains/van/approvals.js";
import { ingestMaster } from "../src/domains/integration/replicas.js";
import { configuration } from "../src/domains/callflow/engine.js";
import { sampleMaster } from "../../sap-mock/src/sample.js";
import { ensurePresellSamples } from "../../../packages/db/seed/presell.js";
import { processHandoff } from "../src/domains/presell/service.js";
import {
  bind,
  deviceKey,
  nativeSignIn,
  signedPost,
  startHarness,
} from "./harness.js";

/**
 * Trip-manifest completeness for call-flow and delivery operations (disposable harness DB, SP_LANE=seed).
 * The phone's `trip.close` manifest lists EVERY accepted trip operation (TripCloseStore). The server's known set must
 * therefore contain every applied trip operation, including a repeated call step that is a semantic no-op, while a
 * manifest that omits an accepted op, adds a rejected/foreign op, or replays is still refused or idempotent.
 */
/** @type {import('./harness.js').Harness} */ let h;
const PASSWORD = "manifest-audit-proof-password";
const now = Date.now();
const today = manilaDate(now);
/** @type {any} */ let seller;
/** @type {any} */ let phone;
/** @type {any} */ let device;
/** @type {any} */ let applied;
const SELLER = "van@sunpride.test";

beforeAll(async () => {
  h = await startHarness({ installers: domainInstallers });
  await seedDemo(h.db, {
    anchorDate: manilaDate(now - 90 * 86_400_000),
    days: 7,
  });
  await ensurePresellSamples(h.db, now - 86_400_000);
  [seller] =
    await h.db`select id,user_id,email,org_unit_id from profiles where email=${SELLER}`;
  // Dedicated EMPTY marked truck for this seller (what trial-wiring does for trial vans), plus the seeded busy truck.
  const [vehicle] =
    await h.db`select * from vehicles where org_unit_id=${seller.org_unit_id} and vehicle_code='SMP-VAN-1'`;
  const [loc] =
    await h.db`select * from inventory_locations where id=${vehicle.truck_location_id}`;
  const truck = await copyTrialRow(h.db, "inventory_locations", loc, "kvtest", {
    code: "SMP-TRIAL-KVTEST",
    name: "Sample trial truck kvtest",
    org_unit_id: seller.org_unit_id,
  });
  await copyTrialRow(h.db, "vehicles", vehicle, "kvtest", {
    vehicle_code: "SMP-TRIAL-KVTEST",
    plate_number: "TRIAL-KVTEST",
    name: "Sample trial truck kvtest",
    truck_location_id: truck.id,
    org_unit_id: seller.org_unit_id,
  });
  // Governed selling prices come from SAP conditions. The plain sample seed has none (the live showcase has them from
  // the full --spec seed), so give the three first depot products one, exactly as the existing route proof does.
  const stocked =
    await h.db`select p.code from inventory_balances b join products p on p.id=b.product_id join vehicles v on v.home_location_id=b.location_id where v.id=${vehicle.id} and b.physical_base>=24 order by p.code limit 3`;
  for (const [i, p] of stocked.entries())
    await ingestMaster(
      h.db,
      sampleMaster("condition", `KV-PRICE-${i}`, {
        productCode: p.code,
        uom: "PC",
        customerCode: null,
        channelKey: null,
        unitPriceCentavos: 1000 + i * 100,
        currency: "PHP",
        taxCode: "SAMPLE-VAT",
        taxBasisPoints: 1200,
        taxInclusive: true,
        priceListCode: "KV-SAP-CONTROL",
        precedence: 1,
      }),
    );
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
  await h.db`update users set password_hash=${hash} where email in (${SELLER},'admin@sunpride.test')`;
  phone = await deviceKey();
  const signIn = await nativeSignIn(h, SELLER, PASSWORD, "van-android", {
    keyId: phone.keyId,
    publicKeySpki: phone.publicKeySpki,
  });
  expect(signIn.res.status).toBe(200);
  const [row] =
    await h.db`select id from registered_devices where profile_id=${seller.id} and app='van-android'`;
  const bound = await bind(h, signIn.body.accessToken, row.id, phone);
  expect(bound.body.bindingStatus).toBe("bound");
  device = {
    access: signIn.body.accessToken,
    deviceId: row.id,
    key: phone,
    app: "van-android",
    userId: seller.user_id,
  };
  // The plain sample seed leaves this seller a stale `active` trip from months ago. The fixture now refuses ANY open trip of
  // the seller on ANY date, so this DISPOSABLE database retires the stale seed trip first (a live operator must settle it
  // through the product instead; the helper never edits it).
  await h.db`update van_trips set status='closed' where salesperson_profile_id=${seller.id} and status in ('planned','loading','loaded','active','closing','reconciling','review_required')`;
}, 240_000);
afterAll(async () => {
  await h?.close();
});

/** @type {any[]} */ const saved = [];
let requests = 0;
const phoneOps = () => {
  const tripId = applied.tripId;
  const push = async (
    /** @type {string} */ type,
    /** @type {any} */ facts,
    /** @type {any} */ keep = undefined,
  ) => {
    const at = Date.now(),
      op = keep ?? {
        clientOpId: crypto.randomUUID(),
        opType: type,
        clientTime: at,
        dependsOn: [],
        payload: {
          tripId,
          settlementVersion: 1,
          deviceTime: at,
          ...(typeof facts === "function" ? facts(at) : facts),
        },
      };
    // The production challenge budget (60 per 2 min per device) is far below this proof's request count: reset it in
    // this disposable database only, never in the code under test.
    if (++requests % 25 === 0) await h.db`update rate_limits set count=0`;
    const r = await signedPost(h, device, "/api/sync/push", {
      version: 2,
      app: "van-android",
      deviceId: device.deviceId,
      scopeId: seller.org_unit_id,
      operations: [op],
    });
    if (!r.body.results)
      throw new Error(
        `${type}: no results ${r.res?.status} ${JSON.stringify(r.body)}`,
      );
    return { op, res: r.body.results[0] };
  };
  const send = async (/** @type {string} */ type, /** @type {any} */ facts) => {
    const { op, res } = await push(type, facts);
    if (res?.status !== "applied")
      throw new Error(`${type}: ${JSON.stringify(res)}`);
    saved.push(op);
    return { ...op, ack: res.ack };
  };
  const reading = (
    /** @type {string} */ checkpoint,
    /** @type {string|null} */ outletId = null,
  ) => ({
    observationId: crypto.randomUUID(),
    checkpoint,
    deciC: -200,
    method: "manual",
    ...(outletId ? { outletId } : {}),
  });
  return { tripId, send, push, reading };
};
const auditCount = async (/** @type {string} */ clientOpId) =>
  (
    await h.db`select count(*)::int n from van_audit_events where details->>'clientOpId'=${clientOpId}`
  )[0].n;
const manifest = (/** @type {any[]} */ ops) =>
  ops.map((o) => ({ clientRequestId: o.clientOpId, kind: o.opType }));

/** Order -> presell confirm -> run released on THIS trip -> the driver's real signed ops. @param {any} a */
async function deliveryOps({ trip, send, push, first }) {
  // The sample driver_delivery flow binds to channel `gt_presell` for the van app: deliver to the NEXT route store, which
  // this disposable database re-channels (the sale store keeps its van_selling flow).
  const [target] =
    await h.db`select o.id from outlets o join outlet_assignments a on a.outlet_id=o.id where a.route_id=${trip.route_id} and o.deleted_at is null and a.deleted_at is null order by a.sequence nulls last,o.code offset 1 limit 1`;
  await h.db`update outlets set channel='gt_presell' where id=${target.id}`;
  const [outlet] =
    await h.db`select id,channel,classification,organization_id from outlets where id=${target.id}`;
  // Office roles: the manager approves/confirms the order, the admin (van.manage) runs the delivery run.
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
  await h.db`update users set password_hash=${hash} where email in ('manager@sunpride.test','admin@sunpride.test')`;
  const signIn = async (/** @type {string} */ email) => {
    const login = await h.fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    return (login.headers.get("set-cookie") ?? "").split(";")[0];
  };
  const cookies = {
    confirm: await signIn("manager@sunpride.test"),
    other: await signIn("admin@sunpride.test"),
  };
  const cmd = async (/** @type {string} */ action, /** @type {any} */ body) => {
    const r = await h.fetch("/api/v1/presell/" + action, {
      method: "POST",
      headers: {
        cookie: action === "confirm" ? cookies.confirm : cookies.other,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...body }),
    });
    const json = await r.json();
    if (r.status !== 200)
      throw new Error(`${action}: ${r.status} ${JSON.stringify(json)}`);
    return json;
  };
  const [customer] =
    await h.db`insert into customers(code,name,channel,territory,credit_limit,active) values(${crypto.randomUUID()},'Manifest buyer','gt_presell','Cebu',0,true) returning *`;
  const [territory] =
    await h.db`select territory_id id from outlet_assignments where outlet_id=${outlet.id} and territory_id is not null limit 1`;
  const [order] =
    await h.db`insert into orders(organization_id,client_request_id,order_number,order_type,customer_code,salesperson_subject,salesperson_profile_id,created_by_subject,org_unit_id,outlet_id,territory_id,service_date,status,subtotal,total,amount_known) values('sunpride',${crypto.randomUUID()},${"MANIFEST-" + crypto.randomUUID().slice(0, 8)},'field_order',${customer.code},${seller.user_id},${seller.id},${seller.user_id},${trip.org_unit_id},${outlet.id},${territory?.id ?? null},${today},'approved',1,1,true) returning *`;
  await h.db`insert into order_lines(order_id,ordinal,product_id,product_code,description,uom,quantity,quantity_base,unit_price,line_total) values(${order.id},0,${first.id},'FOOD','Sample food','PC',10,10,1,10)`;
  const [policy] =
    await h.db`select * from presell_policies order by version desc limit 1`;
  await h.db`insert into presell_order_promises(order_id,requested_delivery_date,policy_id,policy_snapshot,captured_at) values(${order.id},${today},${policy.id},${policy},${new Date(now)})`;
  const confirmed = await cmd("confirm", {
    orderId: order.id,
    confirmedDeliveryDate: today,
    reason: "Sample buyer confirmation",
  });
  await processHandoff(h.db, confirmed.id);
  const [drop] =
    await h.db`select * from delivery_drops where handoff_id=${confirmed.id}`;
  const run = await cmd("createRun", {
    tripId: trip.id,
    label: "Manifest delivery",
  });
  await cmd("schedule", { dropId: drop.id, runId: run.id });
  await cmd("releaseRun", { runId: run.id });
  const config = await configuration(
    h.db,
    "driver_delivery",
    {
      id: outlet.id,
      channel: outlet.channel,
      classification: outlet.classification,
    },
    Date.now(),
  );
  expect(config?.definition).toBeTruthy();
  const fix = (/** @type {number} */ at) => ({
    latitude: Number(config.pin.latitude),
    longitude: Number(config.pin.longitude),
    accuracyMeters: 5,
    fixTime: at,
    provider: "gps",
    mockSignal: false,
  });
  const clientCallId = crypto.randomUUID();
  await send("call.start", (/** @type {number} */ at) => ({
    clientCallId,
    outletId: outlet.id,
    flowDefinitionId: config.definition.id,
    location: fix(at),
  }));
  const timing = (/** @type {string} */ stage) =>
    send("delivery.timing", { dropId: drop.id, clientCallId, stage });
  // order matters: a refused stage must not become a manifest entry
  const rejected = await push("delivery.timing", {
    dropId: drop.id,
    clientCallId,
    stage: "unloading",
  });
  expect(rejected.res.status).toBe("rejected");
  await timing("arrival");
  await timing("unloading");
  const [line] =
    await h.db`select * from delivery_drop_lines where drop_id=${drop.id}`;
  const digest = "e".repeat(64);
  await h.db`insert into files(owner_id,purpose,sha256,mime,size,device_id,created_by,status,path,stored_at) values(${trip.id},'truck-damage',${digest},'image/jpeg',100,${device.deviceId},${seller.user_id},'stored','fixture.jpg',now())`;
  const proofFacts = (/** @type {number} */ at) => ({
    dropId: drop.id,
    clientCallId,
    location: fix(at),
    receiverName: "Sample buyer",
    signature: [
      [0.1, 0.2],
      [0.8, 0.7],
    ],
    photoSha256: digest,
    watermark: {
      version: 1,
      outletId: outlet.id,
      profileId: seller.id,
      capturedAt: at,
      latitude: fix(at).latitude,
      longitude: fix(at).longitude,
    },
    lines: [
      {
        lineId: line.id,
        acceptedBase: Number(line.expected_base),
        shortBase: 0,
        rejectedBase: 0,
        damagedBase: 0,
      },
    ],
  });
  const at = Date.now();
  const proofPayload = { ...proofFacts(at), deviceTime: at };
  const mk = (/** @type {any} */ payload) => ({
    clientOpId: crypto.randomUUID(),
    opType: "delivery.confirm",
    clientTime: at,
    dependsOn: [],
    payload: { tripId: trip.id, settlementVersion: 1, ...payload },
  });
  const proof = mk(proofPayload);
  expect((await push("delivery.confirm", null, proof)).res.status).toBe(
    "applied",
  );
  saved.push(proof);
  // the same proof under a second op id: no second proof, but an applied receipt that the phone lists
  const again = mk(proofPayload);
  expect((await push("delivery.confirm", null, again)).res.status).toBe(
    "applied",
  );
  saved.push(again);
  await timing("departure");
  await send("call.close", (/** @type {number} */ t) => ({
    clientCallId,
    location: fix(t),
    zeroSaleReason: "delivery_only",
    shortCallReason: "Delivery drop, short dwell",
  }));
  return { dropId: drop.id, proof, again, rejected };
}

test("kickoff trip is planned, loaded and started through the phone's own operations", async () => {
  applied = await applyKickoffVan(h.db, {
    sellerProfileId: seller.id,
    now,
    date: today,
    withFiscalSample: true,
  });
  const { tripId, send, reading } = phoneOps();
  await send("temperature.record", reading("load_out"));
  await send("load.confirm", {
    loadId: applied.loadId,
    lines: applied.verify.lines.map((/** @type {any} */ l) => ({
      lineNumber: l.line_number,
      actualBase: l.expected,
    })),
  });
  await send("trip.start", {
    vehicleConfirmed: true,
    routeConfirmed: true,
    odometerKm: 1000,
  });
  const [trip] = await h.db`select * from van_trips where id=${tripId}`;
  expect(trip.status).toBe("active");
});

test("repeated call steps leave an applied receipt AND a manifest entry: trip.close accepts the full manifest, stays strict, stays idempotent", async () => {
  const { tripId, send, push, reading } = phoneOps();
  const [trip] = await h.db`select * from van_trips where id=${tripId}`;
  const actor = await actorFor(h.db, seller.user_id);
  const bundle = await fiscalBundle(h.db, actor, trip, device.deviceId);
  /** @type {any} */ const range = bundle.ranges.find(
    (/** @type {any} */ r) => r.documentType === "sales_invoice",
  );
  const first = applied.products[0];
  const [outlet] =
    await h.db`select o.id,o.channel,o.classification,o.organization_id from outlets o join outlet_assignments a on a.outlet_id=o.id where a.route_id=${trip.route_id} and o.deleted_at is null and a.deleted_at is null order by a.sequence nulls last,o.code limit 1`;
  const stopId = crypto.randomUUID();
  await send("stop.record", {
    observationId: crypto.randomUUID(),
    stopId,
    phase: "arrival",
    outletId: outlet.id,
  });
  await send("temperature.record", reading("delivery", outlet.id));
  const flow = await configuration(
    h.db,
    "van_selling",
    {
      id: outlet.id,
      channel: outlet.channel,
      classification: outlet.classification,
    },
    Date.now(),
  );
  const adapters = flow.definition.steps.map(
    (/** @type {any} */ s) => s.adapter,
  );
  expect(adapters).toContain("stock_check");
  expect(adapters).toContain("evidence");
  const clientCallId = crypto.randomUUID();
  const fix = (/** @type {number} */ at) => ({
    latitude: Number(flow.pin.latitude),
    longitude: Number(flow.pin.longitude),
    accuracyMeters: 5,
    fixTime: at,
    provider: "gps",
    mockSignal: false,
  });
  await send("call.start", (/** @type {number} */ at) => ({
    clientCallId,
    outletId: outlet.id,
    flowDefinitionId: flow.definition.id,
    location: fix(at),
  }));
  // stock check twice: the engine's second adapter return is a semantic no-op, the receipt is still applied.
  const stock1 = await send("call.step", {
    clientCallId,
    adapter: "stock_check",
    observation: "Shelf has two facings",
  });
  const stock2 = await send("call.step", {
    clientCallId,
    adapter: "stock_check",
    observation: "Re-checked after restock",
  });
  const price = (
    await resolvePrice(h.db, {
      organizationId: outlet.organization_id,
      productId: first.id,
      uom: "PC",
      channelKey: outlet.channel,
      customerCode: null,
      outletId: outlet.id,
      at: Date.now(),
    })
  ).unitPriceCentavos;
  if (price === null) throw new Error("no governed price");
  const qty = 2,
    total = String(BigInt(price) * BigInt(qty));
  const lot = (
    await h.db`select l.id,l.lot_number,l.expires_at,l.quality_status from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id where b.location_id=${trip.truck_location_id} and b.product_id=${first.id} and b.physical_base>0 and b.stock_status='available' limit 1`
  )[0];
  const saleId = crypto.randomUUID();
  await send("sale.record", {
    saleId,
    clientCallId,
    receiptNumber: `${range.prefix}-${range.nextSerial.padStart(9, "0")}`,
    fiscal: { allocationId: range.allocationId, serial: range.nextSerial },
    customer: { outletId: outlet.id },
    currency: "PHP",
    totalMinor: total,
    lines: [
      {
        productId: first.id,
        quantityBase: String(qty),
        paidBase: String(qty),
        freeBase: "0",
        unitPriceMinor: String(price),
        grossMinor: total,
        discountMinor: "0",
        totalMinor: total,
        allocations: [
          {
            lotId: lot.id,
            batch: lot.lot_number,
            expiresAt: lot.expires_at
              ? new Date(lot.expires_at).getTime()
              : null,
            qualityStatus: lot.quality_status,
            quantityBase: String(qty),
          },
        ],
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
  // fiscal.print (ReceiptPrintStore) is a trip operation in the phone's outbox: the journal row alone leaves no trip-keyed
  // audit row, so the full manifest would be refused. The trip is DERIVED from the persisted van_sale, never the payload.
  const printFacts = (/** @type {any} */ extra) => ({
    kind: "print",
    reason: "Original print attempt",
    outcome: "printed",
    printId: crypto.randomUUID(),
    ...extra,
  });
  const print1 = await send("fiscal.print", printFacts({ saleId }));
  // a reprint, and a print whose payload names a FOREIGN trip id: both are accepted, both audit the sale's own trip
  const print2 = await send(
    "fiscal.print",
    printFacts({ saleId, kind: "reprint", reason: "Customer copy" }),
  );
  const print3 = await send(
    "fiscal.print",
    printFacts({ saleId, tripId: crypto.randomUUID(), reason: "Third copy" }),
  );
  // refused prints own nothing: an unknown sale has no fiscal document to journal (refused at request level, rolled back)
  const noDoc = {
    clientOpId: crypto.randomUUID(),
    opType: "fiscal.print",
    clientTime: Date.now(),
    dependsOn: [],
    payload: {
      tripId,
      settlementVersion: 1,
      deviceTime: Date.now(),
      ...printFacts({ saleId: crypto.randomUUID() }),
    },
  };
  await expect(push("fiscal.print", null, noDoc)).rejects.toThrow("422");
  expect(
    (
      await h.db`select count(*)::int n from op_receipts where client_op_id=${noDoc.clientOpId}`
    )[0].n,
  ).toBe(0);
  // A document of THIS seller whose persisted source sale sits on ANOTHER seller's trip: documentEvent still journals it
  // (document ownership is unchanged) but the print must never be filed under this trip.
  const [otherSeller] =
    await h.db`select id,user_id from profiles where email='manager@sunpride.test'`;
  const [foreignTrip] =
    await h.db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by) select organization_id,org_unit_id,${"FOREIGN-" + crypto.randomUUID().slice(0, 8)},vehicle_id,truck_location_id,source_location_id,service_date,${otherSeller.id},${otherSeller.user_id},'closed','fixture' from van_trips where id=${tripId} returning id`;
  const foreignSaleId = crypto.randomUUID();
  await h.db`insert into van_sales(id,trip_id,receipt_number,outlet_id,total_centavos,receipt,captured_request) values(${foreignSaleId},${foreignTrip.id},'SAMPLE-FOREIGN',${outlet.id},100,${{ payment: { kind: "cash", method: "cash" } }},${{}})`;
  const printActor = await actorFor(h.db, seller.user_id);
  await tx(h.db, (db) =>
    issueDocument(db, {
      actor: printActor,
      deviceId: device.deviceId,
      vehicleId: trip.vehicle_id,
      allocationId: range.allocationId,
      serial: String(BigInt(range.nextSerial) + 1n),
      documentType: "sales_invoice",
      sourceType: "van_sale",
      sourceId: foreignSaleId,
      at: Date.now(),
      snapshot: { totalMinor: "100" },
    }),
  );
  const foreignPrint = await push(
    "fiscal.print",
    printFacts({ saleId: foreignSaleId }),
  );
  // collection OR print: a credit sale on this trip (migrated-invoice style fixture row), collected in cash with an OR
  const creditSaleId = crypto.randomUUID();
  await h.db`insert into van_sales(id,trip_id,receipt_number,outlet_id,total_centavos,receipt,captured_request) values(${creditSaleId},${tripId},'SAMPLE-CREDIT',${outlet.id},500,${{ payment: { kind: "credit", method: "credit" } }},${{}})`;
  /** @type {any} */ const orRange = bundle.ranges.find(
    (/** @type {any} */ r) => r.documentType === "official_receipt",
  );
  await send("payment.record", {
    clientCallId,
    saleId: creditSaleId,
    method: "cash",
    amountMinor: "500",
    status: "paid",
    fiscal: { allocationId: orRange.allocationId, serial: orRange.nextSerial },
  });
  const [collection] =
    await h.db`select id from van_payments where trip_id=${tripId} and kind='collection'`;
  const printOr = await send(
    "fiscal.print",
    printFacts({ paymentId: collection.id }),
  );
  // evidence twice with the SAME valid stored photo (a real `files` row owned by this seller, device and trip).
  const digest = "c".repeat(64);
  await h.db`insert into files(owner_id,purpose,sha256,mime,size,device_id,created_by,status,path,stored_at) values(${tripId},'truck-damage',${digest},'image/jpeg',100,${device.deviceId},${seller.user_id},'stored','fixture.jpg',now())`;
  const evidence1 = await send("call.step", {
    clientCallId,
    adapter: "evidence",
    photoSha256: digest,
  });
  const evidence2 = await send("call.step", {
    clientCallId,
    adapter: "evidence",
    photoSha256: digest,
  });
  // a step the flow does not carry is REJECTED, writes nothing and must never become a legal manifest entry.
  const note = await push("call.step", {
    clientCallId,
    adapter: "note",
    note: "No note step in the van flow",
  });
  expect(note.res.status).toBe("rejected");
  await send("call.close", (/** @type {number} */ at) => ({
    clientCallId,
    location: fix(at),
    shortCallReason: "Demo drop-off, short dwell",
  }));
  // business effects are NOT duplicated by the repeated steps (2 = the cash sale + the fixture credit invoice)
  const [call] =
    await h.db`select id from call_executions where trip_id=${tripId}`;
  const adapterCounts =
    await h.db`select adapter,count(*)::int n from call_step_events where call_id=${call.id} group by 1 order by 1`;
  expect(
    Object.fromEntries(
      adapterCounts.map((/** @type {any} */ r) => [r.adapter, r.n]),
    ),
  ).toMatchObject({
    check_in: 1,
    stock_check: 1,
    evidence: 1,
    check_out: 1,
  });
  expect(
    (
      await h.db`select count(*)::int n from van_sales where trip_id=${tripId}`
    )[0].n,
  ).toBe(2);
  // A released delivery run on this trip: the driver's call, arrival/unloading/departure timing and the ePOD proof are
  // real trip operations in the phone's outbox, so they belong in the same manifest.
  const delivery = await deliveryOps({ trip, send, push, first });
  await send("stop.record", {
    observationId: crypto.randomUUID(),
    stopId,
    phase: "departure",
    outletId: outlet.id,
  });
  await send("cash.reconcile", {
    reconciliationId: crypto.randomUUID(),
    currency: "PHP",
    expectedMinor: String(BigInt(total) + 500n),
    declaredMinor: String(BigInt(total) + 500n),
    counts: [{ denominationMinor: "1", count: String(BigInt(total) + 500n) }],
    approval: { method: "none" },
  });
  const expected = await expectedStock(h.db, tripId);
  const batches = await lotBundle(h.db, {
    id: tripId,
    truck_location_id: trip.truck_location_id,
  });
  const countId = crypto.randomUUID();
  const lines = expected.map((/** @type {any} */ e) => ({
    productId: e.productId,
    status: e.status,
    expectedBase: String(e.expectedBase),
    countedBase: String(e.expectedBase),
    reasonCode: "",
  }));
  const countBatches = batches.lots.filter((/** @type {any} */ l) =>
    ["available", "damaged"].includes(l.status),
  );
  await send("stock.reconcile", {
    reconciliationId: countId,
    lines,
    lotLines: countBatches.map((/** @type {any} */ l) => ({
      ...l,
      expectedBase: l.quantityBase,
      countedBase: l.quantityBase,
    })),
    countCode: stockCountCode(tripId, countId, lines),
    varianceLines: 0,
    shortBase: "0",
    overBase: "0",
    approval: { method: "none" },
  });
  const unloadLines = expected.flatMap((/** @type {any} */ e) => {
    const own = countBatches.filter(
      (/** @type {any} */ l) =>
        l.productId === e.productId && l.status === e.status,
    );
    const template = {
      productId: e.productId,
      status: e.status,
      partition: e.status === "damaged" ? "customer_return" : "unsold",
      uomCode: "PC",
    };
    return own.length
      ? own.map((/** @type {any} */ l) => ({
          ...template,
          lotId: l.lotId,
          batch: l.batch,
          expiresAt: l.expiresAt,
          qualityStatus: l.qualityStatus,
          quantityBase: l.quantityBase,
        }))
      : [{ ...template, quantityBase: String(e.expectedBase) }];
  });
  await send("temperature.record", reading("interval"));
  const containerTypes = (
    await routePolicy(h.db, trip, "returnables", Date.now())
  ).facts.items;
  for (const item of containerTypes)
    await send("returnable.record", {
      observationId: crypto.randomUUID(),
      typeCode: item.code,
      action: "count",
      quantity: "0",
    });
  await send("unload.record", {
    observationId: crypto.randomUUID(),
    lines: unloadLines,
    empties: containerTypes.map((/** @type {any} */ i) => ({
      typeCode: i.code,
      quantity: "0",
    })),
  });
  const close = (
    /** @type {any[]} */ ops,
    /** @type {any} */ keep = undefined,
  ) =>
    push(
      "trip.close",
      {
        closeId: crypto.randomUUID(),
        endOdometerKm: 1010,
        exceptionsReviewed: true,
        operations: manifest(ops),
      },
      keep,
    );
  const status = async () =>
    (await h.db`select status from van_trips where id=${tripId}`)[0].status;
  const settlements = async () =>
    (
      await h.db`select count(*)::int n from van_settlements where trip_id=${tripId}`
    )[0].n;
  const refused = async (/** @type {any[]} */ ops) => {
    expect((await close(ops)).res).toMatchObject({
      status: "rejected",
      code: "dependency_missing",
    });
    expect(await status()).toBe("reconciling");
    expect(await settlements()).toBe(0);
  };
  // strict completeness: omitting a repeated step, a call op, or any accepted op is refused ...
  await refused(saved.filter((o) => o.clientOpId !== stock2.clientOpId));
  await refused(saved.filter((o) => o.clientOpId !== evidence2.clientOpId));
  await refused(saved.filter((o) => !o.opType.startsWith("call.")));
  await refused(saved.filter((o) => o.opType !== "delivery.timing"));
  await refused(
    saved.filter((o) => o.clientOpId !== delivery.proof.clientOpId),
  );
  await refused(
    saved.filter((o) => o.clientOpId !== delivery.again.clientOpId),
  );
  for (const o of [print1, print2, print3, printOr])
    await refused(saved.filter((x) => x.clientOpId !== o.clientOpId));
  await refused(saved.filter((o) => o.opType !== "fiscal.print"));
  await refused([...saved, noDoc]);
  await refused([...saved, foreignPrint.op]);
  await refused(
    saved.map((o) =>
      o.clientOpId === print1.clientOpId ? { ...o, opType: "call.step" } : o,
    ),
  );
  // ... a rejected op or a foreign/unknown id cannot be smuggled in ...
  await refused([...saved, note.op]);
  await refused([
    ...saved,
    { clientOpId: crypto.randomUUID(), opType: "call.step" },
  ]);
  // ... an applied op listed under the wrong kind is refused ...
  await refused(
    saved.map((o) =>
      o.clientOpId === stock2.clientOpId ? { ...o, opType: "note.record" } : o,
    ),
  );
  // ... and the phone's full manifest closes the trip exactly once.
  const closed = await close(saved);
  expect(closed.res).toMatchObject({ status: "applied" });
  saved.push(closed.op);
  expect(await status()).toBe("closing");
  expect(await settlements()).toBe(1);
  // fiscal prints: one audit row each, filed under the trip DERIVED from the persisted source (also for the foreign payload
  // trip id); refused/foreign-source prints own none, and the foreign trip has no audit row at all
  for (const o of [print1, print2, print3, printOr]) {
    expect(await auditCount(o.clientOpId)).toBe(1);
    expect(
      (
        await h.db`select count(*)::int n from van_audit_events where trip_id=${tripId} and kind='fiscal.print' and details->>'clientOpId'=${o.clientOpId}`
      )[0].n,
    ).toBe(1);
  }
  expect(await auditCount(noDoc.clientOpId)).toBe(0);
  expect(foreignPrint.res.status).toBe("applied");
  expect(await auditCount(foreignPrint.op.clientOpId)).toBe(0);
  expect(
    (
      await h.db`select count(*)::int n from van_audit_events where trip_id=${foreignTrip.id}`
    )[0].n,
  ).toBe(0);
  expect(
    (
      await h.db`select count(*)::int n from fiscal_document_events where request_key in (${print1.clientOpId},${print2.clientOpId},${print3.clientOpId},${printOr.clientOpId})`
    )[0].n,
  ).toBe(4);
  // every accepted call op owns exactly one operation-keyed audit row; the rejected note owns none
  for (const o of [stock1, stock2, evidence1, evidence2])
    expect(await auditCount(o.clientOpId)).toBe(1);
  expect(await auditCount(note.op.clientOpId)).toBe(0);
  expect(await auditCount(delivery.rejected.op.clientOpId)).toBe(0);
  for (const o of saved.filter((o) => o.opType.startsWith("delivery.")))
    expect(await auditCount(o.clientOpId)).toBe(1);
  expect(
    (
      await h.db`select count(*)::int n from delivery_proofs where drop_id=${delivery.dropId}`
    )[0].n,
  ).toBe(1);
  // replaying every signed operation changes nothing: duplicates, one audit row each, one sale, one settlement
  for (const o of saved)
    expect((await push(o.opType, null, o)).res.status).toBe("duplicate");
  for (const o of [stock1, stock2, evidence1, evidence2])
    expect(await auditCount(o.clientOpId)).toBe(1);
  for (const o of [print1, print2, print3, printOr])
    expect(await auditCount(o.clientOpId)).toBe(1);
  expect(await auditCount(foreignPrint.op.clientOpId)).toBe(0);
  expect(
    (
      await h.db`select count(*)::int n from fiscal_document_events where kind in ('print','reprint') and request_key in (${print1.clientOpId},${print2.clientOpId},${print3.clientOpId},${printOr.clientOpId},${foreignPrint.op.clientOpId})`
    )[0].n,
  ).toBe(5);
  expect(await settlements()).toBe(1);
  expect(
    (
      await h.db`select count(*)::int n from van_sales where trip_id=${tripId}`
    )[0].n,
  ).toBe(2);
});
