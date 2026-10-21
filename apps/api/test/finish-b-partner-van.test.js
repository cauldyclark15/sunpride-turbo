import { afterAll, beforeAll, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  createUser,
  deviceKey,
  registerDevice,
  nativeSignIn,
  bind,
  signedPost,
} from "./harness.js";
import { domainInstallers } from "../src/domains/index.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import { actorFor } from "../src/core/context.js";
import { invite } from "../src/domains/distributors/setup.js";
import { saveVanArrangement } from "../src/domains/distributors/van-arrangement.js";
import { distributorVanContext } from "../src/domains/distributors/seams.js";
import { planTrip } from "../src/domains/van/commands.js";
import { tripFor, outletFor } from "../src/domains/van/access.js";
import { enforcePartnerOp } from "../src/domains/partners/boundary.js";
import { manilaDate } from "../src/domains/visits/shared.js";
/** @type {any} */ let h;
/** @type {any} */ let d;
/** @type {any} */ let c;
/** @type {any} */ let actor;
/** @type {any} */ let who;
/** @type {any} */ let trip;
let unit = "",
  store = "",
  vehicle = "";
const early = new Date(Date.now() - 86400000);
beforeAll(async () => {
  h = await startHarness({ installers: domainInstallers });
  unit = await ensureRoot(h.db);
  const [admin] =
    await h.db`insert into users(email,password_hash) values('sample-partner-van-office@example.com','fixture-not-a-login') returning id`;
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${admin.id},${admin.id},'Sample van office','sample-partner-van-office@example.com','super_admin','active',${unit}) returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},'super_admin',${early},${admin.id},'Sample fixture')`;
  c = { db: h.db, actor: await actorFor(h.db, admin.id), now: Date.now() };
  [d] =
    await h.db`insert into distributors(code,name,org_unit_id,status,source,partner_kind,effective_from) values('SAMPLE-VAN','Sample van partner',${unit},'accredited','sample','distributor',${early}) returning *`;
  const saved = await invite(c, d, {
    access: "van",
    name: "Sample partner van operator",
    email: "sample-partner-van@example.com",
    grants: ["read", "van"],
  });
  const user = await createUser(
    h,
    saved.email,
    "Test-only-partner-van-fixture",
  );
  await h.db`update profiles set user_id=${user},auth_subject=${user} where id=${saved.profileId}`;
  const key = await deviceKey(),
    deviceId = await registerDevice(h, {
      profileId: saved.profileId,
      orgUnitId: unit,
      app: "van-android",
      key,
    });
  const login = await nativeSignIn(
    h,
    saved.email,
    "Test-only-partner-van-fixture",
    "van-android",
    { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
  );
  expect(login.res.status).toBe(200);
  who = { access: login.body.accessToken, deviceId, key };
  expect((await bind(h, who.access, deviceId, key)).res.status).toBe(200);
  actor = await actorFor(h.db, user);
  const [o] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by,enrolment_status) values('sunpride','SAMPLE-VAN','Sample consignment store','active',${unit},'fixture','approved') returning id`;
  store = o.id;
  const [master] =
    await h.db`insert into distributor_master_versions(distributor_id,source,source_key,version,payload_hash,payload,effective_from) values(${d.id},'sample','SAMPLE-VAN',1,'fixture',${{ products: [], terms: {} }},${early}) returning id`;
  await h.db`insert into distributor_outlets(distributor_id,outlet_id,master_version_id,effective_from) values(${d.id},${store},${master.id},${early})`;
  const locations = [];
  for (const type of ["warehouse", "truck"]) {
    const [l] =
      await h.db`insert into inventory_locations(organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values('sunpride',${unit},'SAMPLE',${"SAMPLE-VAN-" + type},${"Sample " + type},${type},true,true,true,true,false) returning id`;
    locations.push(l.id);
  }
  const [v] =
    await h.db`insert into vehicles(organization_id,org_unit_id,vehicle_code,plate_number,name,truck_location_id,home_location_id,status,created_by) values('sunpride',${unit},'SAMPLE-0585','SAMPLE-PLATE','Sample company consignment van',${locations[1]},${locations[0]},'active','fixture') returning id`;
  vehicle = v.id;
  await tx(h.db, (db) =>
    saveVanArrangement({ ...c, db, now: Date.now() }, d, {
      vehicleId: vehicle,
      reference: "SAMPLE company-owned consignment",
    }),
  );
  const planned = await tx(h.db, (db) =>
    planTrip(db, c.actor, {
      vehicleId: vehicle,
      salespersonProfileId: actor.profileId,
      serviceDate: manilaDate(Date.now()),
      driverName: "Sample driver",
      helperName: "Sample helper",
      operationsVersion: 0,
    }),
  );
  [trip] = await h.db`select * from van_trips where id=${planned.tripId}`;
}, 60000);
afterAll(async () => {
  await h?.close();
});
const pull = () =>
  signedPost(h, who, "/api/sync/pull", {
    version: 2,
    scopes: [
      {
        scopeId: unit,
        projection: "van.bundle",
        params: { serviceDate: manilaDate(Date.now()) },
      },
    ],
  });
test("F-408 a configured partner uses the existing signed van bundle and trip authority, with only its assigned stores", async () => {
  const context = await distributorVanContext(c, d);
  expect(context.ready).toBe(true);
  expect(context.trips[0].id).toBe(trip.id);
  expect(
    (await tripFor(h.db, actor, trip.id, "van.operate")).distributor_id,
  ).toBe(d.id);
  expect((await outletFor(h.db, actor, store)).id).toBe(store);
  const r = await pull();
  expect(r.res.status).toBe(200);
  const data = r.body.bundles[0].data;
  expect(data.trip.tripId).toBe(trip.id);
  expect(data.customers.map((/** @type {any} */ o) => o.outletId)).toEqual([
    store,
  ]);
});
test("F-408 employee trips, field op namespaces and withdrawn partner grants cannot become a van escape", async () => {
  await h.db`update van_trips set distributor_id=null where id=${trip.id}`;
  await expect(tripFor(h.db, actor, trip.id, "van.operate")).rejects.toThrow(
    "another operator",
  );
  await h.db`update van_trips set distributor_id=${d.id} where id=${trip.id}`;
  await expect(
    tx(h.db, (db) =>
      enforcePartnerOp(db, actor, {
        opType: "visit.checkIn",
        clientTime: Date.now(),
        payload: { tripId: trip.id, outletId: store },
      }),
    ),
  ).rejects.toThrow("partner vans");
  await h.db`update distributor_users set effective_to=now() where distributor_id=${d.id} and profile_id=${actor.profileId}`;
  expect((await pull()).res.status).toBe(403);
});
