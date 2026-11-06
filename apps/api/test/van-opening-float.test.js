import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
} from "./harness.js";
import { openingFloat, today } from "../src/domains/van/model.js";

/** @type {any[]} */ const postings = [];
mock.module("../src/domains/inventory/posting.js", () => ({
  postMovement: async (/** @type {any} */ db, /** @type {any} */ input) => {
    postings.push(input);
    const id = crypto.randomUUID();
    await db`insert into inventory_movements(id,organization_id,movement_number,movement_type,source_type,source_document_id,status,effective_at,posted_at,posted_by,idempotency_key,schema_version)
    values(${id},${input.organizationId},${id},${input.kind},${input.sourceType},${input.sourceId},'posted',now(),now(),${input.actor.userId},${input.idempotencyKey},1)`;
    return { movementId: id, duplicate: false };
  },
}));
mock.module("../src/domains/org/scope.js", () => ({
  scopeFilterForActor: async (
    /** @type {any} */ _db,
    /** @type {any} */ actor,
  ) => ({ unitIds: actor.role === "super_admin" ? null : [actor.orgUnitId] }),
  outletOwnerUnit: async () => null,
}));
const { install } = await import("../src/domains/van/index.js");
/** @type {any} */ let h;
/** @type {any} */ let profiles;
const unit = crypto.randomUUID(),
  base = crypto.randomUUID(),
  caseId = crypto.randomUUID(),
  product = crypto.randomUUID(),
  depot = crypto.randomUUID(),
  truck = crypto.randomUUID();
/** @type {any} */ let who;
/** @type {any} */ let manager;
let cookie = "";
/** @param {any} user */
async function persistPerson(user) {
  const p = user.profile;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user.userId},${user.userId},${p.name},${user.email},${p.role},'active',${p.orgUnitId})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${p.orgUnitId},${p.role},now()-interval '1 day','fixture','fixture')`;
}
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  profiles = profileStore(h);
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','VAN','Van team','national','active',now()-interval '1 day')`;
  who = await boundDevice(h, profiles, { app: "van-android", orgUnitId: unit });
  await persistPerson(who);
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
  await h.db`insert into units_of_measure(id,organization_id,code,name,dimension,decimal_places,active) values(${base},'sunpride','PC','Piece','count',0,true),(${caseId},'sunpride','CS','Case','count',0,true)`;
  await h.db`insert into products(id,organization_id,code,name,category,uom,unit_price,active,base_uom_id,quantity_scale) values(${product},'sunpride','SAMPLE','Sample product','Canned','PC',0,true,${base},1)`;
  await h.db`insert into uom_conversions(organization_id,product_id,from_uom_id,to_uom_id,numerator,denominator,rounding_mode,effective_from,active) values('sunpride',${product},${caseId},${base},12,1,'exact',now()-interval '1 day',true)`;
  for (const [id, code, type] of [
    [depot, "DEPOT", "warehouse"],
    [truck, "TRUCK", "truck"],
  ])
    await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${id},'sunpride',${unit},'CEBU',${code},${code},${type},true,true,true,true,false)`;
  await h.db`insert into inventory_balances(product_code,warehouse_code,on_hand,reserved,available,as_of,organization_id,product_id,location_id,physical_base,weighted_average_cost_minor) values('SAMPLE','DEPOT',100,0,100,now(),'sunpride',${product},${depot},100,10000)`;
}, 30000);
afterAll(async () => {
  await h?.close();
});
/** @param {string} path @param {any} body @param {string} [key] */
async function web(path, body, key = crypto.randomUUID()) {
  const res = await h.fetch(`/api/v1/van/${path}`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
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
/** @param {any[]} operations */
function push(operations) {
  return signedPost(h, who, "/api/sync/push", {
    version: 2,
    app: "van-android",
    deviceId: who.deviceId,
    scopeId: unit,
    operations,
  });
}
/** @type {any} */ let trip;
/** @type {any} */ let load;

let trucks = 0;
/** @param {number|string|undefined} openingFloatCentavos */
async function startTrip(openingFloatCentavos) {
  // One truck per trip: a vehicle can only have one live trip a day, and earlier test trips are put away.
  await h.db`update van_trips set status='closed' where status in ('active','loaded','loading','planned')`;
  const truckId = crypto.randomUUID(),
    code = `T${++trucks}`;
  await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${truckId},'sunpride',${unit},'CEBU',${code},${code},'truck',true,true,true,true,false)`;
  const vehicleId = (
    await web("vehicles/create", {
      orgUnitId: unit,
      vehicleCode: code,
      plateNumber: code,
      truckLocationId: truckId,
      homeLocationId: depot,
    })
  ).body.vehicleId;
  const t = await web("trips/plan", {
    vehicleId,
    salespersonProfileId: who.profile.id,
    serviceDate: today(),
  });
  const trip = t.body;
  const l = await web("loads/plan", {
    tripId: trip.tripId,
    lines: [{ productId: product, expectedBase: "12" }],
  });
  const confirm = await push([
    op("load.confirm", {
      tripId: trip.tripId,
      loadId: l.body.loadId,
      lines: [{ lineNumber: 1, actualBase: "12" }],
    }),
  ]);
  expect(confirm.body.results[0].status).toBe("applied");
  const start = op("trip.start", {
    tripId: trip.tripId,
    vehicleConfirmed: true,
    routeConfirmed: true,
    ...(openingFloatCentavos === undefined ? {} : { openingFloatCentavos }),
  });
  return { trip, start };
}
/** @param {string} tripId @param {string} kind @param {string} method @param {number} centavos */
const cash = (tripId, kind, method, centavos) =>
  h.db`insert into van_payments(id,trip_id,kind,method,amount_centavos,facts) values(${crypto.randomUUID()},${tripId},${kind},${method},${centavos},'{}')`;
async function expected(/** @type {string} */ tripId) {
  const res = await h.fetch(`/api/v1/van/trip?tripId=${tripId}`, {
    headers: { cookie },
  });
  const body = /** @type {any} */ (await res.json());
  return body.cash;
}

test("a P2,000 float with P1,000 of cash sales expects P3,000; replay is idempotent", async () => {
  const { trip, start } = await startTrip(200000);
  const first = await push([start]);
  expect(first.body.results[0].status).toBe("applied");
  const [row] =
    await h.db`select status,opening_float_centavos::text as f from van_trips where id=${trip.tripId}`;
  expect(row).toEqual({ status: "active", f: "200000" });

  await cash(trip.tripId, "sale", "cash", 100000);
  await cash(trip.tripId, "sale", "gcash", 50000); // not cash: never in the drawer
  const c = await expected(trip.tripId);
  expect(c.openingFloatCentavos).toBe(200000);
  expect(c.expectedCentavos).toBe(300000);

  const again = await push([start]);
  expect(again.body.results[0].status).toBe("duplicate");
  expect(again.body.results[0].ack).toEqual(first.body.results[0].ack);
  expect((await expected(trip.tripId)).expectedCentavos).toBe(300000);
});

test("collections add and cash refunds subtract; the float stays its own line", async () => {
  const { trip, start } = await startTrip(100000);
  expect((await push([start])).body.results[0].status).toBe("applied");
  await cash(trip.tripId, "sale", "cash", 80000);
  await cash(trip.tripId, "collection", "cash", 20000);
  await cash(trip.tripId, "refund", "cash", 5000);
  const c = await expected(trip.tripId);
  expect(c).toMatchObject({
    openingFloatCentavos: 100000,
    cashSalesCentavos: 80000,
    collectionsCentavos: 20000,
    refundsCentavos: 5000,
    expectedCentavos: 100000 + 80000 + 20000 - 5000,
  });
});

test("no float means zero; the field is optional", async () => {
  const { trip, start } = await startTrip(undefined);
  expect((await push([start])).body.results[0].status).toBe("applied");
  await cash(trip.tripId, "sale", "cash", 40000);
  const c = await expected(trip.tripId);
  expect(c.openingFloatCentavos).toBe(0);
  expect(c.expectedCentavos).toBe(40000);
});

test("an out-of-range or non-whole float is refused and the trip stays unstarted", async () => {
  for (const bad of [-1, 10_000_001, 1.5, "12.5", "abc", true]) {
    const { trip, start } = await startTrip(/** @type {any} */ (bad));
    const r = await push([start]);
    expect(r.body.results[0]).toMatchObject({
      status: "rejected",
      code: "invalid_request",
    });
    const [row] =
      await h.db`select status,opening_float_centavos::text as f from van_trips where id=${trip.tripId}`;
    expect(row).toEqual({ status: "loaded", f: "0" });
    await h.db`update van_trips set status='cancelled' where id=${trip.tripId}`;
  }
});

test("the top of the range (P100,000) is accepted", async () => {
  const { start } = await startTrip(10_000_000);
  expect((await push([start])).body.results[0].status).toBe("applied");
});

test("out-of-range opening cash is refused in plain words, with the machine code kept", () => {
  for (const bad of [-1, 10_000_001, 2.5, "x", "1e3"]) {
    try {
      openingFloat({ openingFloatCentavos: bad }, "openingFloatCentavos");
      throw new Error("accepted");
    } catch (e) {
      expect(/** @type {any} */ (e).code).toBe("invalid_request");
      expect(/** @type {any} */ (e).message).toBe(
        "Opening cash must be between ₱0 and ₱100,000",
      );
    }
  }
  expect(openingFloat({}, "openingFloatCentavos")).toBe(0n);
  expect(openingFloat({ a: "5", b: 5 }, "a", "b")).toBe(5n);
  expect(() => openingFloat({ a: "5", b: 6 }, "a", "b")).toThrow("twice");
});

/** The seller's phone pulls its bundle; `handheld` is the negotiated v2 extension. @param {boolean} handheld */
async function pullBundle(handheld) {
  const r = await signedPost(h, who, "/api/sync/pull", {
    version: 2,
    app: "van-android",
    deviceId: who.deviceId,
    since: null,
    pageCursor: null,
    scopes: [
      {
        scopeId: unit,
        projection: "van.bundle",
        params: {
          serviceDate: today(),
          ...(handheld ? { handheld: true } : {}),
        },
      },
    ],
    limit: 100,
  });
  expect(r.res.status).toBe(200);
  return /** @type {any} */ (r.body.bundles[0].data);
}

test("IP-P0 fix: the bundle carries the trip's opening float and the handheld card; an older phone gets neither", async () => {
  await h.db`update employee_assignments set supervisor_id=${manager.profile.id} where profile_id=${who.profile.id}`;
  const { trip, start } = await startTrip(250000);
  expect((await push([start])).body.results[0].status).toBe("applied");
  const [veh] =
    await h.db`select v.vehicle_code,v.plate_number from van_trips t join vehicles v on v.id=t.vehicle_id where t.id=${trip.tripId}`;

  const b = await pullBundle(true);
  expect(b.trip.tripId).toBe(trip.tripId);
  expect(b.trip.openingFloatCentavos).toBe(250000);
  expect(b.policy.handheld).toEqual({
    vehicleCode: veh.vehicle_code,
    plateNumber: veh.plate_number,
    supervisorName: "Supervisor",
    supervisorPhone: null,
  });

  // Frozen v1 trip and policy are validated strictly by older phones: nothing new unless asked for.
  const old = await pullBundle(false);
  expect(old.trip.openingFloatCentavos).toBeUndefined();
  expect(old.policy.handheld).toBeUndefined();

  // No trip today: the card still names the van this handheld last drove and the supervisor.
  await h.db`update van_trips set service_date=service_date-1 where salesperson_profile_id=${who.profile.id}`;
  const none = await pullBundle(true);
  expect(none.trip).toBeNull();
  expect(none.policy.handheld).toEqual({
    vehicleCode: veh.vehicle_code,
    plateNumber: veh.plate_number,
    supervisorName: "Supervisor",
    supervisorPhone: null,
  });

  // A seller nobody supervises, on a handheld that never drove: unknown parts are null, not invented.
  await h.db`update employee_assignments set supervisor_id=null where profile_id=${who.profile.id}`;
  await h.db`update van_trips set status='cancelled' where salesperson_profile_id=${who.profile.id}`;
  const bare = await pullBundle(true);
  expect(bare.policy.handheld).toEqual({
    vehicleCode: null,
    plateNumber: null,
    supervisorName: null,
    supervisorPhone: null,
  });
});
