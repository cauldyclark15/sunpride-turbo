import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
} from "./harness.js";
import { today } from "../src/domains/van/model.js";

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
async function differences() {
  const res = await h.fetch("/api/v1/van/load-differences", {
    headers: { cookie },
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
/** @type {string} */ let lastConfirmId = "";
async function confirmShort() {
  const confirm = op("load.confirm", {
    tripId: trip.tripId,
    loadId: load.loadId,
    lines: [{ lineNumber: 1, actualBase: "40", reason: "short_loaded" }],
  });
  lastConfirmId = confirm.clientOpId;
  const r = await push([confirm]);
  expect(r.body.results[0].status).toBe("applied");
}
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

test("a short load waits in the list with cases, pieces and pesos; reject needs a reason and sends it back to the seller", async () => {
  const v = await web("vehicles/create", {
    orgUnitId: unit,
    vehicleCode: "V1",
    plateNumber: "SAMPLE",
    truckLocationId: truck,
    homeLocationId: depot,
  });
  expect(v.status).toBe(200);
  const t = await web("trips/plan", {
    vehicleId: v.body.vehicleId,
    salespersonProfileId: who.profile.id,
    serviceDate: today(),
  });
  trip = t.body;
  const l = await web("loads/plan", {
    tripId: trip.tripId,
    lines: [{ productId: product, expectedBase: "48" }],
  });
  load = l.body;
  expect((await differences()).body.items).toEqual([]);
  await confirmShort();

  const list = await differences();
  expect(list.status).toBe(200);
  expect(list.body.items).toHaveLength(1);
  const item = list.body.items[0];
  expect(item).toMatchObject({
    tripId: trip.tripId,
    sellerName: who.profile.name,
    canDecide: true,
    differenceCentavos: "80000",
  });
  expect(item.lines[0]).toMatchObject({
    reason: "short_loaded",
    differenceBase: "-8",
    expected: { cases: 4, pieces: 0 },
    counted: { cases: 3, pieces: 4 },
    differenceCentavos: "80000",
  });

  const noReason = await web("loads/approve", {
    tripId: trip.tripId,
    decision: "reject",
  });
  expect(noReason.status).toBe(400);
  const rejected = await web("loads/approve", {
    tripId: trip.tripId,
    decision: "reject",
    note: "Recount the second pallet",
  });
  expect(rejected.status).toBe(200);
  expect(postings).toHaveLength(0);
  const [row] =
    await h.db`select status,approval_note from van_trip_loads where id=${load.loadId}`;
  expect(row).toMatchObject({
    status: "planned",
    approval_note: "Recount the second pallet",
  });
  expect((await differences()).body.items).toEqual([]);
});

test("IP-P0 fix: after a reject the seller's bundle says planned, names the count the office sent back and why, so the phone can recount", async () => {
  const b = await pullBundle(true);
  expect(b.load.status).toBe("planned");
  expect(b.load.confirmRequestId).toBe(lastConfirmId);
  expect(b.load.rejectionNote).toBe("Recount the second pallet");
  // An older phone validates the frozen v1 load strictly: it must not see the new keys.
  const old = await pullBundle(false);
  expect(old.load.status).toBe("planned");
  expect(Object.keys(old.load).sort()).toEqual(["lines", "loadId", "status"]);
  // The recount is a fresh load.confirm and the server takes it.
  await confirmShort();
  const [row] =
    await h.db`select status,confirm_request_id from van_trip_loads where id=${load.loadId}`;
  expect(row).toMatchObject({
    status: "discrepancy",
    confirm_request_id: lastConfirmId,
  });
  const again = await pullBundle(true);
  expect(again.load.status).toBe("discrepancy");
  expect(again.load.rejectionNote).toBeNull();
  // Put it back so the next test starts from the rejected state it expects.
  const back = await web("loads/approve", {
    tripId: trip.tripId,
    decision: "reject",
    note: "Count it once more",
  });
  expect(back.status).toBe(200);
  const second = await pullBundle(true);
  expect(second.load.confirmRequestId).toBe(lastConfirmId);
  expect(second.load.rejectionNote).toBe("Count it once more");
});

test("a supervisor in scope approves the counted load once; the posted quantity is what the seller counted", async () => {
  await confirmShort();
  expect((await differences()).body.items).toHaveLength(1);
  const key = crypto.randomUUID();
  const approved = await web(
    "loads/approve",
    {
      tripId: trip.tripId,
      decision: "approve",
      note: "Checked with the clerk",
    },
    key,
  );
  expect(approved.status).toBe(200);
  expect(postings.at(-1).kind).toBe("van_load");
  expect(postings.at(-1).lines[0].quantityBase).toBe(40);
  const [row] =
    await h.db`select status,approved_by from van_trip_loads where id=${load.loadId}`;
  expect(row.status).toBe("posted");
  expect(row.approved_by).toBe(manager.userId);
  expect((await differences()).body.items).toEqual([]);
  // Replaying the same request posts nothing twice.
  const before = postings.length;
  const again = await web(
    "loads/approve",
    {
      tripId: trip.tripId,
      decision: "approve",
      note: "Checked with the clerk",
    },
    key,
  );
  expect(again.status).toBe(200);
  expect(postings.length).toBe(before);
});

test("the person the trip belongs to cannot decide their own load difference", async () => {
  const [v] =
    await h.db`select id from vehicles where truck_location_id=${truck}`;
  const t = await web("trips/plan", {
    vehicleId: v.id,
    salespersonProfileId: manager.profile.id,
    serviceDate: "2099-01-02",
  });
  expect(t.status).toBe(200);
  const l = await web("loads/plan", {
    tripId: t.body.tripId,
    lines: [{ productId: product, expectedBase: "12" }],
  });
  expect(l.status).toBe(200);
  await h.db`update van_trip_loads set status='discrepancy',confirmed_by='someone-else',confirmed_at=now() where id=${l.body.loadId}`;
  await h.db`update van_trip_load_lines set actual_base=10,discrepancy_reason='short_loaded' where load_id=${l.body.loadId}`;
  const list = await differences();
  expect(list.body.items).toHaveLength(1);
  expect(list.body.items[0].canDecide).toBe(false);
  const own = await web("loads/approve", {
    tripId: t.body.tripId,
    decision: "approve",
    note: "mine",
  });
  expect(own.status).toBe(403);
  const [row] =
    await h.db`select status from van_trip_loads where id=${l.body.loadId}`;
  expect(row.status).toBe("discrepancy");
});
