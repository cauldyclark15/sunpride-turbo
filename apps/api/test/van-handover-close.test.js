import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
} from "./harness.js";
import { today, PAYMENT_METHODS } from "../src/domains/van/model.js";

// SP-0191b: a trip the office hands over to another phone (Van app phone -> Field app phone here; Van app -> Van app
// takes the same server path) closes from the NEW phone, whose close list holds only its own operations. Operations of
// an unrelated phone still never count. Real Postgres and stock writer; pricing, analytics and org scope are mocked.
mock.module("../src/domains/orders/pricing.js", () => ({
  resolvePrice: async () => ({
    unitPriceCentavos: 12525,
    priceListId: null,
    source: "office",
    taxCode: "VAT12",
    taxBasisPoints: 1200,
    taxTreatment: "vatable",
    taxInclusive: true,
    sourceTaxInclusive: true,
    sourceUnitPriceCentavos: 12525,
  }),
  creditCheck: async () => ({ status: "within", limit: 1000000, exposure: 0 }),
}));
mock.module("../src/domains/org/scope.js", () => ({
  scopeFilterForActor: async (
    /** @type {any} */ _db,
    /** @type {any} */ actor,
  ) => ({ unitIds: actor.role === "super_admin" ? null : [actor.orgUnitId] }),
  outletOwnerUnit: async (/** @type {any} */ db, /** @type {string} */ id) =>
    (await db`select custodian_org_unit_id from outlets where id=${id}`)[0]
      ?.custodian_org_unit_id ?? null,
}));
mock.module("../src/domains/analytics/refresh.js", () => ({
  enqueueRefresh: async () => {},
}));
const { install } = await import("../src/domains/van/index.js");
const { install: installFiscal } =
  await import("../src/domains/fiscal/index.js");
const { cashExpectation, expectedStock } =
  await import("../src/domains/van/facts.js");
const { stockCountCode } = await import("../src/domains/van/approvals.js");
const { manifestGap } = await import("../src/domains/van/settlement.js");

/** @type {any} */ let h;
/** @type {any} */ let profiles;
const unit = crypto.randomUUID(),
  base = crypto.randomUUID(),
  product = crypto.randomUUID(),
  outlet = crypto.randomUUID(),
  depot = crypto.randomUUID(),
  truck = crypto.randomUUID();
/** @type {any} */ let seller; // Field app phone
/** @type {any} */ let vanSeller; // Van app phone (starts the trip)
/** @type {any} */ let stranger; // an unrelated Van app phone
/** @type {any} */ let manager;
let cookie = "";
/** @type {{invoice:string, credit:string}} */ const series = {
  invoice: "",
  credit: "",
};
/** @param {any} user */
async function persistPerson(user) {
  const p = user.profile;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user.userId},${user.userId},${p.name},${user.email},${p.role},'active',${p.orgUnitId})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${p.orgUnitId},${p.role},now()-interval '1 day','fixture','fixture')`;
}
/** @param {boolean} on */
const setSelling = (on) =>
  h.db`update profiles set selling=${on},scope_epoch=scope_epoch+1 where id=${seller.profile.id}`;

beforeAll(async () => {
  h = await startHarness({ installers: [install, installFiscal] });
  profiles = profileStore(h);
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','VAN','Van team','national','active',now()-interval '1 day')`;
  seller = await boundDevice(h, profiles, {
    app: "field-android",
    orgUnitId: unit,
  });
  seller.profile.name = "Rhea Field";
  await persistPerson(seller);
  vanSeller = await boundDevice(h, profiles, {
    app: "van-android",
    orgUnitId: unit,
  });
  await persistPerson(vanSeller);
  stranger = await boundDevice(h, profiles, {
    app: "van-android",
    orgUnitId: unit,
  });
  await persistPerson(stranger);
  const userId = await createUser(
    h,
    "manager@example.com",
    "correct horse battery",
  );
  manager = {
    userId,
    email: "manager@example.com",
    profile: profiles.set(userId, {
      role: "super_admin",
      orgUnitId: unit,
      name: "Supervisor",
    }),
  };
  await persistPerson(manager);
  h.setHooks({
    loadProfile: async (/** @type {any} */ db, /** @type {string} */ id) => {
      const [p] =
        await db`select * from profiles where user_id=${id} and deleted_at is null`;
      return p
        ? {
            id: p.id,
            userId: p.user_id,
            name: p.name,
            role: p.role,
            orgUnitId: p.org_unit_id,
            status: p.status,
          }
        : null;
    },
  });
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: manager.email,
      password: "correct horse battery",
    }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  expect(login.status).toBe(200);
  await h.db`insert into units_of_measure(id,organization_id,code,name,dimension,decimal_places,active) values(${base},'sunpride','PC','Piece','count',0,true)`;
  await h.db`insert into products(id,organization_id,code,name,category,uom,unit_price,active,base_uom_id,quantity_scale) values(${product},'sunpride','SAMPLE','Sample product','Canned','PC',0,true,${base},1)`;
  for (const [id, code, type] of [
    [depot, "DEPOT", "warehouse"],
    [truck, "TRUCK", "truck"],
  ])
    await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${id},'sunpride',${unit},'CEBU',${code},${code},${type},true,true,true,true,false)`;
  await h.db`insert into inventory_balances(product_code,warehouse_code,on_hand,reserved,available,as_of,organization_id,product_id,location_id,physical_base,weighted_average_cost_minor) values('SAMPLE','TRUCK',0,0,0,now(),'sunpride',${product},${truck},0,10000)`;
  await h.db`insert into inventory_balances(product_code,warehouse_code,on_hand,reserved,available,as_of,organization_id,product_id,location_id,physical_base,available_stock_base,available_base,weighted_average_cost_minor,inventory_value_minor) values('SAMPLE','DEPOT',1000,0,1000,now(),'sunpride',${product},${depot},1000,1000,1000,10000,10000000)`;
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values(${outlet},'sunpride','STORE','Sample store','active',${unit},'GT','fixture')`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('fiscal-test','org_units',${unit},'branch')`;
  for (const method of PAYMENT_METHODS)
    await h.db`insert into fiscal_tender_rules(org_unit_id,method,label,reference_label,enabled,effective_from,sample,entered_by) values(${unit},${method.code},${method.label},${method.referenceLabel},true,now()-interval '1 day',true,${manager.profile.id})`;
  for (const [kind, prefix] of [
    ["sales_invoice", "SEL-SI"],
    ["credit_memo", "SEL-CM"],
  ]) {
    const [reg] =
      await h.db`insert into fiscal_registrations(org_unit_id,entity_name,branch_name,tin,address,document_type,status,effective_from,entered_by,sample) values(${unit},'SAMPLE','Sample branch','SAMPLE TIN','Sample address',${kind},'sample_not_filed',now()-interval '1 day',${manager.profile.id},true) returning id`;
    const [s] =
      await h.db`insert into fiscal_series(registration_id,prefix,first_serial,last_serial,next_allocate,effective_from) values(${reg.id},${prefix},1,1000,1,now()-interval '1 day') returning id`;
    series[kind === "sales_invoice" ? "invoice" : "credit"] = s.id;
  }
}, 30000);
afterAll(async () => {
  await h?.close();
});

/** @param {string} path @param {any} body */
async function web(path, body) {
  const res = await h.fetch(`/api/v1/van/${path}`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} path */
async function read(path) {
  const res = await h.fetch(`/api/v1/van/${path}`, { headers: { cookie } });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} type @param {any} payload */
function op(type, payload) {
  const at = Date.now();
  return {
    clientOpId: crypto.randomUUID(),
    opType: type,
    clientTime: at,
    dependsOn: [],
    payload: Object.assign(payload, { deviceTime: at }),
  };
}
/** The van wire from a given phone. @param {any} phone @param {any} operation */
async function send(phone, operation) {
  const r = await signedPost(h, phone, "/api/sync/push", {
    version: 2,
    app: phone.app,
    deviceId: phone.deviceId,
    scopeId: unit,
    operations: [operation],
  });
  expect(r.res.status).toBe(200);
  return r.body.results[0];
}
/** @param {any} phone @param {any} operation */
async function apply(phone, operation) {
  const r = await send(phone, operation);
  expect(r.status, JSON.stringify(r)).toBe("applied");
  return operation;
}
/** @param {any[]} ops */
const manifest = (ops) =>
  ops.map((o) => ({
    kind: o.opType,
    clientRequestId: o.clientOpId,
    status: "done",
  }));
test("a trip handed over from the Van app phone to a Field app phone closes from the new phone; an unrelated phone's operations are still refused", async () => {
  await setSelling(true);
  const v = await web("vehicles/create", {
    orgUnitId: unit,
    vehicleCode: "V1",
    plateNumber: "SAMPLE",
    truckLocationId: truck,
    homeLocationId: depot,
  });
  expect(v.status).toBe(200);
  const trip = (
    await web("trips/plan", {
      vehicleId: v.body.vehicleId,
      salespersonProfileId: vanSeller.profile.id,
      serviceDate: today(),
    })
  ).body;
  const load = (
    await web("loads/plan", {
      tripId: trip.tripId,
      lines: [{ productId: product, expectedBase: "48" }],
    })
  ).body;
  // Phone 1 (Van app) loads and starts the trip.
  const first = [
    await apply(
      vanSeller,
      op("load.confirm", {
        tripId: trip.tripId,
        loadId: load.loadId,
        lines: [{ lineNumber: 1, actualBase: "48" }],
      }),
    ),
    await apply(
      vanSeller,
      op("trip.start", {
        tripId: trip.tripId,
        vehicleConfirmed: true,
        routeConfirmed: true,
      }),
    ),
  ];
  // The office hands the trip (person and phone) to the Field app phone.
  const handed = await web("trips/handover", {
    tripId: trip.tripId,
    toProfileId: seller.profile.id,
    toDeviceId: seller.deviceId,
    reason: "Phone swap",
  });
  expect(handed.status, JSON.stringify(handed.body)).toBe(200);
  const [moved] =
    await h.db`select started_device_id from van_trips where id=${trip.tripId}`;
  expect(moved.started_device_id).toBe(seller.deviceId);
  // Phone 2 counts stock and cash; the office receives the cash.
  const countId = crypto.randomUUID();
  const lines = (await expectedStock(h.db, trip.tripId)).map(
    (/** @type {any} */ e) => ({
      productId: e.productId,
      status: e.status,
      expectedBase: String(e.expectedBase),
      countedBase: String(e.expectedBase),
      reasonCode: "",
    }),
  );
  const expected = String(await cashExpectation(h.db, trip.tripId));
  const second = [
    await apply(
      seller,
      op("stock.reconcile", {
        tripId: trip.tripId,
        reconciliationId: countId,
        countCode: stockCountCode(trip.tripId, countId, lines),
        varianceLines: 0,
        shortBase: "0",
        overBase: "0",
        lines,
      }),
    ),
    await apply(
      seller,
      op("cash.reconcile", {
        tripId: trip.tripId,
        reconciliationId: crypto.randomUUID(),
        currency: "PHP",
        expectedMinor: expected,
        declaredMinor: expected,
        counts: [{ denominationMinor: "1", count: expected }],
        reasonCode: "",
      }),
    ),
  ];
  const remit = await web("cash/remit", {
    tripId: trip.tripId,
    amountMinor: expected,
    reference: "SAMPLE-HANDIN",
  });
  expect(remit.status, JSON.stringify(remit.body)).toBe(200);
  /** @param {any[]} ops */
  const close = (ops) =>
    op("trip.close", {
      tripId: trip.tripId,
      closeId: crypto.randomUUID(),
      exceptionsReviewed: true,
      operations: manifest(ops),
    });
  // An operation the unrelated phone really sent (applied receipt on ITS device) never counts for this trip.
  const foreign = op("sale.record", { tripId: crypto.randomUUID() });
  await h.db`insert into op_receipts(subject,device_id,client_op_id,payload_hash,op_type,status) values(${stranger.userId},${stranger.deviceId},${foreign.clientOpId},${"0".repeat(64)},'sale.record','applied')`;
  expect(await send(seller, close([...second, foreign]))).toMatchObject({
    status: "rejected",
    code: "dependency_missing",
  });
  // Even if it were recorded against this trip, an op whose only receipt is on an unrelated phone is neither excused
  // from the list nor accepted on it (checked on the rule itself: van audit rows are append-only).
  const [row] = await h.db`select * from van_trips where id=${trip.tripId}`;
  const known = [...first, ...second, foreign].map((o) => ({
    id: o.clientOpId,
  }));
  expect(await manifestGap(h.db, row, manifest(second), known)).toBe(
    "incomplete",
  );
  expect(
    await manifestGap(h.db, row, manifest([...second, foreign]), known),
  ).toBe("unsynced");
  expect(
    await manifestGap(h.db, row, manifest(second), known.slice(0, 4)),
  ).toBeNull();
  // The new phone's own list is still checked: leaving out one of ITS operations is refused.
  expect(await send(seller, close([second[0]]))).toMatchObject({
    status: "rejected",
    code: "dependency_missing",
  });
  // The new phone closes with only its own operations (phone 1's load and start are already at the office) ...
  await apply(seller, close(second));
  const [closed] =
    await h.db`select status from van_trips where id=${trip.tripId}`;
  expect(closed.status).toBe("closed");
  expect(first).toHaveLength(2);
});
