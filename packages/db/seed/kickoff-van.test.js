import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedDemo } from "./index.js";
import { addTrialRow, copyTrialRow } from "./trial-wiring.js";
import {
  applyKickoffVan,
  KickoffVanConflict,
  manilaDate,
  parseArgs,
  planKickoffVan,
  verifiedSample,
} from "./kickoff-van.js";
import { domainInstallers } from "../../../apps/api/src/domains/index.js";
import { actorFor } from "../../../apps/api/src/core/context.js";
import { fiscalBundle } from "../../../apps/api/src/domains/fiscal/transactions.js";
import { resolvePrice } from "../../../apps/api/src/domains/orders/pricing.js";
import { expectedStock } from "../../../apps/api/src/domains/van/facts.js";
import { routePolicy } from "../../../apps/api/src/domains/van/route-policy.js";
import { lotBundle } from "../../../apps/api/src/domains/van/lots.js";
import { stockCountCode } from "../../../apps/api/src/domains/van/approvals.js";
import { ingestMaster } from "../../../apps/api/src/domains/integration/replicas.js";
import { configuration } from "../../../apps/api/src/domains/callflow/engine.js";
import { sampleMaster } from "../../../apps/sap-mock/src/sample.js";
import {
  bind,
  deviceKey,
  nativeSignIn,
  signedPost,
  startHarness,
} from "../../../apps/api/test/harness.js";

/**
 * Isolated-database proof for `kickoff-van.js` (throwaway DB from the API harness, sample seed only).
 * Covers: fail-closed guards, all-or-none + idempotent apply through the real van office commands, untouched existing
 * work, and readiness of the sale -> settlement chain driven by the REAL van device operations (signed push, real
 * Postgres stock posting) on the generated trip.
 */
/** @type {import('../../../apps/api/test/harness.js').Harness} */ let h;
const PASSWORD = "kickoff-van-proof-password";
const now = Date.now();
const today = manilaDate(now);
/** @type {any} */ let seller;
/** @type {any} */ let phone;
/** @type {any} */ let device;
/** @type {any} */ let applied;
/** @type {string[]} */ let baseTripIds = [];
/** @type {Record<string,string>} */ let baseline = {};
const SELLER = "van@sunpride.test";

async function fingerprint() {
  /** @type {Record<string,string>} */ const out = {};
  for (const [table, where] of /** @type {const} */ ([
    ["van_trips", "id::text = any($1::text[])"],
    ["inventory_balances", "true"],
    ["van_trip_loads", "trip_id::text = any($1::text[])"],
    ["profiles", "true"],
    ["registered_devices", "true"],
    ["outlets", "true"],
  ]))
    out[table] = (
      await h.db.unsafe(
        `select md5(coalesce(string_agg((to_jsonb(t)-'updated_at'-'change_seq')::text,'|' order by t.id::text),'')) as h from ${table} t where ${where}`,
        where.includes("$1") ? [`{${baseTripIds.join(",")}}`] : [],
      )
    )[0].h;
  return out;
}
/** Remove a sample marker, run `fn`, then restore it (disposable DB). @param {string} table @param {string} rowId @param {() => Promise<any>} fn */
async function withoutMarker(table, rowId, fn) {
  const rows =
    await h.db`select batch,table_name,row_id,key,id from sample_data_rows where table_name=${table} and row_id=${rowId}`;
  expect(rows.length).toBe(1);
  await h.db`delete from sample_data_rows where table_name=${table} and row_id=${rowId}`;
  try {
    return await fn();
  } finally {
    await h.db`insert into sample_data_rows(id,batch,table_name,row_id,key) values(${rows[0].id},${rows[0].batch},${rows[0].table_name},${rows[0].row_id},${rows[0].key})`;
  }
}
const codes = (/** @type {any} */ r) =>
  r.conflicts.map((/** @type {any} */ c) => c.code);
const opts = () => ({
  sellerProfileId: seller.id,
  now,
  date: today,
  withFiscalSample: true,
});

beforeAll(async () => {
  h = await startHarness({ installers: domainInstallers });
  await seedDemo(h.db, {
    anchorDate: manilaDate(now - 90 * 86_400_000),
    days: 7,
  });
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
  baseTripIds = (await h.db`select id::text id from van_trips`).map(
    (/** @type {any} */ r) => r.id,
  );
  baseline = await fingerprint();
}, 240_000);
afterAll(async () => {
  await h?.close();
});

test("CLI parsing: seller id is explicit, unknown options fail", () => {
  expect(
    parseArgs([
      "--seller-id",
      "x",
      "--apply",
      "--with-fiscal-sample",
      "--products",
      "A,B",
    ]),
  ).toMatchObject({
    sellerProfileId: "x",
    apply: true,
    withFiscalSample: true,
    products: ["A", "B"],
  });
  expect(() => parseArgs(["--reset"])).toThrow("Unknown option");
  expect(planKickoffVan(h.db, { now })).rejects.toThrow("sellerProfileId");
});

test("fails closed: no fiscal fixtures without the explicit flag; dry run writes nothing", async () => {
  const r = await planKickoffVan(h.db, { sellerProfileId: seller.id, now });
  expect(r.ok).toBe(false);
  expect(codes(r)).toEqual(["fiscal_sample_missing"]);
  expect(r.vehicle.code).toBe("SMP-TRIAL-KVTEST");
  expect(
    r.excludedVehicles.find((/** @type {any} */ v) => v.code === "SMP-VAN-1")
      .why,
  ).toContain("truck_holds_stock");
  expect(await fingerprint()).toEqual(baseline);
});

test("fails closed on every non-sample participant, foreign open work and device problems", async () => {
  const [veh] =
    await h.db`select id from vehicles where vehicle_code='SMP-TRIAL-KVTEST'`;
  const [route] =
    await h.db`select s.route_id from route_salespeople s where s.profile_id=${seller.id} and s.deleted_at is null`;
  const [office] =
    await h.db`select id from profiles where email='admin@sunpride.test'`;
  const [asg] =
    await h.db`select id from employee_assignments where profile_id=${seller.id} and deleted_at is null and effective_to is null`;
  const [prod] =
    await h.db`select id from products where code in (select code from products order by code limit 1)`;
  expect(prod).toBeTruthy();
  expect(
    codes(
      await withoutMarker("profiles", seller.id, () =>
        planKickoffVan(h.db, opts()),
      ),
    ),
  ).toContain("seller_not_sample");
  expect(
    codes(
      await withoutMarker("users", seller.user_id, () =>
        planKickoffVan(h.db, opts()),
      ),
    ),
  ).toContain("seller_not_sample");
  expect(
    codes(
      await withoutMarker("employee_assignments", asg.id, () =>
        planKickoffVan(h.db, opts()),
      ),
    ),
  ).toContain("seller_assignment_not_sample");
  expect(
    codes(
      await withoutMarker("profiles", office.id, () =>
        planKickoffVan(h.db, opts()),
      ),
    ),
  ).toContain("office_not_sample");
  expect(
    codes(
      await withoutMarker("vehicles", veh.id, () =>
        planKickoffVan(h.db, opts()),
      ),
    ),
  ).toContain("no_dedicated_empty_vehicle");
  expect(
    codes(
      await withoutMarker("routes", route.route_id, () =>
        planKickoffVan(h.db, opts()),
      ),
    ),
  ).toContain("route_not_sample");
  const [outlet] =
    await h.db`select o.id from outlets o join outlet_assignments a on a.outlet_id=o.id where a.route_id=${route.route_id} and o.deleted_at is null limit 1`;
  expect(
    codes(
      await withoutMarker("outlets", outlet.id, () =>
        planKickoffVan(h.db, opts()),
      ),
    ),
  ).toContain("route_has_non_sample_outlets");
  // forged marker (right table/row, wrong key) never verifies
  const forged =
    await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-demo-v2','profiles',${crypto.randomUUID()},'profiles:forged') returning row_id`;
  expect(
    (await verifiedSample(h.db, "profiles", [forged[0].row_id])).size,
  ).toBe(0);
  // foreign open trip for the seller today
  const [foreign] =
    await h.db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by)
    select organization_id,org_unit_id,'FOREIGN-OPEN-TRIP',${veh.id},truck_location_id,home_location_id,${today},${seller.id},${seller.user_id},'planned','someone-else' from vehicles where id=${veh.id} returning id`;
  expect(codes(await planKickoffVan(h.db, opts()))).toContain(
    "seller_has_open_trip",
  );
  await h.db`delete from van_trips where id=${foreign.id}`;
  // device problems
  await h.db`update registered_devices set status='suspended' where id=${device.deviceId}`;
  expect(codes(await planKickoffVan(h.db, opts()))).toContain(
    "no_active_van_device",
  );
  await h.db`update registered_devices set status='active' where id=${device.deviceId}`;
  // office actor without van.manage (a sample supervisor) and unknown seller
  expect(
    codes(
      await planKickoffVan(h.db, {
        ...opts(),
        officeEmail: "supervisor@sunpride.test",
      }),
    ),
  ).toContain("office_unavailable");
  expect(
    codes(
      await planKickoffVan(h.db, {
        ...opts(),
        sellerProfileId: crypto.randomUUID(),
      }),
    ),
  ).toEqual(["seller_unavailable"]);
  expect(
    codes(await planKickoffVan(h.db, { ...opts(), date: "2020-01-01" })),
  ).toContain("date_in_past");
  expect(await fingerprint()).toEqual(baseline);
  // apply on a refused state writes nothing and throws the machine-readable report
  await expect(
    applyKickoffVan(h.db, { sellerProfileId: seller.id, now }),
  ).rejects.toBeInstanceOf(KickoffVanConflict);
  expect(await fingerprint()).toEqual(baseline);
});

test("apply plans a real trip + load through the van commands; replay is a no-op; a changed set is refused and rolled back", async () => {
  applied = await applyKickoffVan(h.db, opts());
  expect(applied).toMatchObject({
    applied: true,
    replayed: false,
    commandsAdded: 2,
  });
  expect(applied.verify.trip).toMatchObject({
    status: "loading",
    d: today,
    salesperson_profile_id: seller.id,
  });
  expect(applied.verify.loads.map((/** @type {any} */ l) => l.status)).toEqual([
    "planned",
  ]);
  expect(applied.verify.lines).toHaveLength(3);
  expect(applied.verify.nothingPostedYet).toBe(true);
  // nothing moved: truck still empty, no inventory movement for the load
  expect(
    (
      await h.db`select count(*)::int n from inventory_balances where location_id=${applied.vehicle.truckLocationId} and physical_base<>0`
    )[0].n,
  ).toBe(0);
  // existing work and stock are byte-identical (only the new trip/load/fiscal fixtures were added)
  const after = await fingerprint();
  expect(after).toEqual(baseline);
  // Additive and minimal: only the SI and OR vehicle series the cash chain needs (never credit_memo/delivery_receipt).
  const fxTypes =
    await h.db`select r.document_type from fiscal_series s join fiscal_registrations r on r.id=s.registration_id where s.vehicle_id=${applied.vehicle.id} order by 1`;
  expect(fxTypes.map((/** @type {any} */ r) => r.document_type)).toEqual([
    "official_receipt",
    "sales_invoice",
  ]);
  expect(
    (
      await h.db`select count(*)::int n from fiscal_tender_rules where org_unit_id=${seller.org_unit_id} and method='cash'`
    )[0].n,
  ).toBe(1);
  const before = (await h.db`select count(*)::int n from van_trips`)[0].n;
  const replay = await applyKickoffVan(h.db, opts());
  expect(replay).toMatchObject({
    applied: true,
    replayed: true,
    commandsAdded: 0,
    tripId: applied.tripId,
    loadId: applied.loadId,
  });
  expect((await h.db`select count(*)::int n from van_trips`)[0].n).toBe(before);
  const loadsBefore = (
    await h.db`select count(*)::int n from van_trip_loads`
  )[0].n;
  // A changed quantity is refused by name BEFORE any command runs, and nothing is rewritten.
  await expect(
    applyKickoffVan(h.db, { ...opts(), quantity: 12 }),
  ).rejects.toThrow(/owned_load_differs/);
  expect((await h.db`select count(*)::int n from van_trip_loads`)[0].n).toBe(
    loadsBefore,
  );
  expect(codes(await planKickoffVan(h.db, opts()))).toEqual([]);
});

/** @type {any[]} */ const saved = [];
const phoneOps = () => {
  const tripId = applied.tripId;
  const push = async (/** @type {string} */ type, /** @type {any} */ facts) => {
    const at = Date.now(),
      op = {
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
    const r = await signedPost(h, device, "/api/sync/push", {
      version: 2,
      app: "van-android",
      deviceId: device.deviceId,
      scopeId: seller.org_unit_id,
      operations: [op],
    });
    return { op, res: r.body.results?.[0] };
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

test("the generated trip: the phone's own load.confirm posts the stock, trip.start works, fiscal range + cash tender + governed price are ready", async () => {
  const { tripId, send, reading } = phoneOps();
  await send("temperature.record", reading("load_out"));
  await send("load.confirm", {
    loadId: applied.loadId,
    lines: applied.verify.lines.map((/** @type {any} */ l) => ({
      lineNumber: l.line_number,
      actualBase: l.expected,
    })),
  });
  // The ONLY stock movement so far is the phone's own load confirmation: depot -> this truck.
  const loaded =
    await h.db`select p.code,b.physical_base::text q from inventory_balances b join products p on p.id=b.product_id where b.location_id=${applied.vehicle.truckLocationId} and b.physical_base>0 order by p.code`;
  expect(loaded.map((/** @type {any} */ r) => r.q)).toEqual(["24", "24", "24"]);
  expect(
    (await h.db`select status from van_trips where id=${tripId}`)[0].status,
  ).toBe("loaded");
  await send("trip.start", {
    vehicleConfirmed: true,
    routeConfirmed: true,
    odometerKm: 1000,
  });

  const [trip] = await h.db`select * from van_trips where id=${tripId}`;
  const actor = await actorFor(h.db, seller.user_id);
  const bundle = await fiscalBundle(h.db, actor, trip, device.deviceId);
  const range = bundle.ranges.find(
    (/** @type {any} */ r) => r.documentType === "sales_invoice",
  );
  expect(range).toBeTruthy();
  expect(
    bundle.ranges.find(
      (/** @type {any} */ r) => r.documentType === "official_receipt",
    ),
  ).toBeTruthy();
  expect(range.nextSerial).toBe("1");
  /** @type {any} */ (globalThis).__kv = { trip, range, bundle };
});

// sale.record is only accepted inside an open call (the sample publishes a van_selling call flow); every step below is the
// payload the Android composers send (VanCallStore.bindAdapter, RouteOpsStore.unload, TripCloseStore manifest).
test("sale -> cash/stock count -> unload -> trip.close through the real van operations", async () => {
  const { tripId, send, push, reading } = phoneOps();
  const { trip, range } = /** @type {any} */ (globalThis).__kv;
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
  // The seeded sample publishes a van_selling call flow, so (exactly like the Android VanCallStore.bindAdapter) a sale is
  // only accepted INSIDE an open call at that store: call.start -> sale.record{clientCallId} -> call.close.
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
  expect(flow?.pin).toBeTruthy();
  const clientCallId = crypto.randomUUID();
  const fix = (/** @type {number} */ at) => ({
    latitude: Number(flow.pin.latitude),
    longitude: Number(flow.pin.longitude),
    accuracyMeters: 5,
    fixTime: at,
    provider: "gps",
    mockSignal: false,
  });
  await send("call.start", (at) => ({
    clientCallId,
    outletId: outlet.id,
    flowDefinitionId: flow.definition.id,
    location: fix(at),
  }));
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
  const [sale] =
    await h.db`select total_centavos::text t from van_sales where id=${saleId}`;
  expect(sale.t).toBe(total);
  expect(
    (
      await h.db`select physical_base::text q from inventory_balances where location_id=${trip.truck_location_id} and product_id=${first.id}`
    )[0].q,
  ).toBe("22");
  await send("call.close", (at) => ({
    clientCallId,
    location: fix(at),
    shortCallReason: "Demo drop-off, short dwell",
  }));
  await send("stop.record", {
    observationId: crypto.randomUUID(),
    stopId,
    phase: "departure",
    outletId: outlet.id,
  });
  // cash, stock, unload, close: the settlement payloads the phone sends
  await send("cash.reconcile", {
    reconciliationId: crypto.randomUUID(),
    currency: "PHP",
    expectedMinor: total,
    declaredMinor: total,
    counts: [{ denominationMinor: "1", count: total }],
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
  // Same line shape as RouteOpsStore.unload(): per (product,status) one line per counted batch, or one plain line when untracked.
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
  // Physically count every configured crate/tray type (the sample truck was loaded with none, so the honest count is 0).
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
  const unload = await send("unload.record", {
    observationId: crypto.randomUUID(),
    lines: unloadLines,
    empties: containerTypes.map((/** @type {any} */ i) => ({
      typeCode: i.code,
      quantity: "0",
    })),
  });
  const manifest = (/** @type {any[]} */ ops) =>
    ops.map((o) => ({ clientRequestId: o.clientOpId, kind: o.opType }));
  const close = (/** @type {any[]} */ ops) =>
    push("trip.close", {
      closeId: crypto.randomUUID(),
      endOdometerKm: 1010,
      exceptionsReviewed: true,
      operations: manifest(ops),
    });
  // The office must receive EVERY accepted operation, call-flow ones included: an incomplete manifest stays refused ...
  expect(
    (await close(saved.filter((o) => !o.opType.startsWith("call.")))).res,
  ).toMatchObject({ status: "rejected", code: "dependency_missing" });
  expect(
    (await h.db`select status from van_trips where id=${tripId}`)[0].status,
  ).toBe("reconciling");
  // ... and the phone's full manifest (all trip outbox rows, as TripCloseStore sends it) closes the trip.
  const closed = await close(saved);
  expect(closed.res.status).toBe("applied");
  saved.push(closed.op);
  expect(
    (await h.db`select status from van_trips where id=${tripId}`)[0].status,
  ).toBe("closing");
  // settlement is now waiting for the OFFICE (receipt of goods, cash hand-in, independent sign-off): done below with real office commands
  const [settlement] =
    await h.db`select id,content_hash,submitted_by,facts from van_settlements where trip_id=${tripId}`;
  expect(settlement.submitted_by).toBe(seller.id);
  expect(unload.payload.observationId).toBeTruthy();
  /** @type {any} */ (globalThis).__kv = {
    .../** @type {any} */ (globalThis).__kv,
    settlement,
    unload,
    unloadLines,
    total,
    saleId,
    tripId,
    first,
  };
});

const OFFICE = "manager@sunpride.test";
async function webCookie(/** @type {string} */ email) {
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(login.status).toBe(200);
  return (login.headers.get("set-cookie") ?? "").split(";")[0];
}
const webPost = async (
  /** @type {string} */ cookie,
  /** @type {string} */ path,
  /** @type {any} */ body,
  /** @type {string} */ key = crypto.randomUUID(),
) => {
  const res = await h.fetch(`/api/v1/van/${path}`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), key };
};

test("office receipt, cash hand-in and independent settlement approval close the trip; every step replays exactly", async () => {
  const { settlement, unloadLines, total, tripId, saleId, first } =
    /** @type {any} */ (globalThis).__kv;
  const [officeProfile] =
    await h.db`select id,user_id,role from profiles where email=${OFFICE}`;
  expect(officeProfile.id).not.toBe(seller.id);
  await h.db`update users set password_hash=${await Bun.password.hash(PASSWORD, { algorithm: "argon2id" })} where email=${OFFICE}`;
  const office = await webCookie(OFFICE);
  const sellerWeb = await webCookie(SELLER);
  const [{ n: before }] =
    await h.db`select count(*)::int n from van_settlement_decisions where settlement_id=${settlement.id}`;
  expect(before).toBe(0);
  // Not yet approvable: no warehouse receipt, no cash hand-in; the seller can never sign off their own settlement.
  const decide = {
    tripId,
    settlementId: settlement.id,
    contentHash: settlement.content_hash,
    decision: "approved",
    note: "Sample supervisor sign-off",
  };
  expect(
    (await webPost(office, "settlements/decide", decide)).status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (await webPost(sellerWeb, "settlements/decide", decide)).status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (
      await webPost(sellerWeb, "cash/remit", {
        tripId,
        amountMinor: total,
        reference: "SELF-HANDIN",
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (
      await h.db`select count(*)::int n from van_settlement_decisions where settlement_id=${settlement.id}`
    )[0].n,
  ).toBe(0);
  const unloadedEmpties = (
    await h.db`select facts->'empties' e from van_trip_observations where id=${settlement.facts.unloadId}`
  )[0].e;
  // 1. Warehouse physical receipt of the unloaded stock
  const receipt = await webPost(office, "observations/decide", {
    tripId,
    observationId: settlement.facts.unloadId,
    decision: "received",
    lines: unloadLines.map((/** @type {any} */ l) => ({
      productId: l.productId,
      lotId: l.lotId,
      status: l.status,
      receivedBase: l.quantityBase,
    })),
    empties: unloadedEmpties.map((/** @type {any} */ e) => ({
      typeCode: e.typeCode,
      quantity: e.quantity,
    })),
    note: "Sample warehouse physical receipt",
  });
  expect(receipt).toMatchObject({ status: 200 });
  // 2. Cash hand-in must equal the seller's declared count; a wrong amount is refused
  expect(
    (
      await webPost(office, "cash/remit", {
        tripId,
        amountMinor: String(BigInt(total) + 1n),
        reference: "SAMPLE-CASH",
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
  const cash = await webPost(office, "cash/remit", {
    tripId,
    amountMinor: total,
    reference: "SAMPLE-CASH",
  });
  expect(cash).toMatchObject({ status: 200 });
  // 3. Independent sign-off
  const approval = await webPost(office, "settlements/decide", decide);
  expect(approval).toMatchObject({ status: 200 });

  // Persisted facts
  const [trip] =
    await h.db`select status,closed_at,truck_location_id,source_location_id from van_trips where id=${tripId}`;
  expect(trip.status).toBe("closed");
  expect(trip.closed_at).toBeTruthy();
  const [sale] =
    await h.db`select total_centavos::text t,trip_id from van_sales where id=${saleId}`;
  expect(sale.t).toBe(total);
  expect(
    await h.db`select method,kind,amount_centavos::text a from van_payments where trip_id=${tripId}`,
  ).toEqual([{ method: "cash", kind: "sale", a: total }]);
  const [remit] =
    await h.db`select amount_centavos::text a,received_by,reference from van_cash_remittances where trip_id=${tripId}`;
  expect(remit).toMatchObject({
    a: total,
    received_by: officeProfile.id,
    reference: "SAMPLE-CASH",
  });
  const [decision] =
    await h.db`select decision,actor_profile_id from van_settlement_decisions where settlement_id=${settlement.id}`;
  expect(decision).toMatchObject({
    decision: "approved",
    actor_profile_id: officeProfile.id,
  });
  expect(decision.actor_profile_id).not.toBe(settlement.submitted_by);
  // stock: truck empty, the 22 unsold + nothing lost return to the warehouse, the 2 sold units left the books
  expect(
    (
      await h.db`select coalesce(sum(physical_base),0)::text q from inventory_balances where location_id=${trip.truck_location_id}`
    )[0].q,
  ).toBe("0");
  const depotFirst = (
    await h.db`select physical_base::text q from inventory_balances where location_id=${trip.source_location_id} and product_id=${first.id}`
  )[0];
  expect(Number(depotFirst.q)).toBeGreaterThan(0);
  // SAP: the approval only QUEUES the posting; nothing here (mock or real) has accepted it.
  const requests =
    await h.db`select status,integration_event_id from van_sap_requests where source_id=${settlement.id}`;
  expect(requests).toHaveLength(1);
  expect(requests[0].status).toBe("pending");
  // Exact replays: same idempotency key => same stored answer and no second effect; device ops replay as duplicates
  for (const r of [receipt, cash, approval]) expect(r.status).toBe(200);
  const replayApproval = await webPost(
    office,
    "settlements/decide",
    decide,
    approval.key,
  );
  expect(replayApproval).toMatchObject({ status: 200, body: approval.body });
  const replayCash = await webPost(
    office,
    "cash/remit",
    { tripId, amountMinor: total, reference: "SAMPLE-CASH" },
    cash.key,
  );
  expect(replayCash).toMatchObject({ status: 200, body: cash.body });
  for (const op of saved) {
    const r = await signedPost(h, device, "/api/sync/push", {
      version: 2,
      app: "van-android",
      deviceId: device.deviceId,
      scopeId: seller.org_unit_id,
      operations: [op],
    });
    expect(r.body.results[0].status).toBe("duplicate");
  }
  expect(
    (
      await h.db`select count(*)::int n from van_sales where trip_id=${tripId}`
    )[0].n,
  ).toBe(1);
  expect(
    (
      await h.db`select count(*)::int n from van_settlements where trip_id=${tripId}`
    )[0].n,
  ).toBe(1);
  expect(
    (
      await h.db`select count(*)::int n from van_cash_remittances where trip_id=${tripId}`
    )[0].n,
  ).toBe(1);
  expect(
    (
      await h.db`select count(*)::int n from van_settlement_decisions where settlement_id=${settlement.id}`
    )[0].n,
  ).toBe(1);
  expect(
    (
      await h.db`select count(*)::int n from van_sap_requests where source_id=${settlement.id}`
    )[0].n,
  ).toBe(1);
});
