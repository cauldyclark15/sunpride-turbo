import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
} from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { today } from "../src/domains/van/model.js";
import { postMovement } from "../src/domains/inventory/posting.js";

/** IP-INT2FIX P1-2: a reload dispatched by the pre-document code (stock moved depot -> truck "in transit", no stock_transfers
 * document) must still be receivable after the deploy, without reserving or double posting anything. */
mock.module("../src/domains/org/scope.js", () => ({
  scopeFilterForActor: async () => ({ unitIds: null }),
  outletOwnerUnit: async (/** @type {any} */ db, /** @type {string} */ id) =>
    (await db`select custodian_org_unit_id from outlets where id=${id}`)[0]
      ?.custodian_org_unit_id,
}));
const { install } = await import("../src/domains/van/index.js");
/** @type {any} */ let h;
/** @type {any} */ let who;
/** @type {any} */ let boss;
/** @type {any} */ let trip;
/** @type {any} */ let actor;
/** @type {any} */ let office;
const unit = crypto.randomUUID(),
  truck = crypto.randomUUID(),
  depot = crypto.randomUUID(),
  vehicle = crypto.randomUUID(),
  outlet = crypto.randomUUID();
const policy = {
  intervalMinutes: 60,
  bands: [
    { productId: null, label: "Sample frozen", minDeciC: -250, maxDeciC: -180 },
  ],
};
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  const profiles = profileStore(h);
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','ROOT','Sample team','national','active',now()-interval '10 days')`;
  who = await boundDevice(h, profiles, { app: "van-android", orgUnitId: unit });
  const userId = await createUser(
    h,
    "boss-vanops@example.com",
    "correct horse battery",
  );
  boss = {
    userId,
    email: "boss-vanops@example.com",
    profile: profiles.set(userId, { role: "super_admin", orgUnitId: unit }),
  };
  for (const u of [who, boss]) {
    await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${u.profile.id},${u.userId},${u.userId},${u.profile.name},${u.email},${u.profile.role},'active',${unit})`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${u.profile.id},${unit},${u.profile.role},now()-interval '10 days','fixture','fixture')`;
  }
  for (const [id, code, type] of [
    [depot, "DEPOT", "warehouse"],
    [truck, "TRUCK", "truck"],
  ])
    await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${id},'sunpride',${unit},'CEBU',${code},${code},${type},true,true,true,true,false)`;
  await h.db`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by) values(${vehicle},'sunpride',${unit},'VANOPS','SAMPLE',${truck},${depot},'active',${boss.userId})`;
  const [t] =
    await h.db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by,operations_version,started_device_id,start_odometer_km) values('sunpride',${unit},'SAMPLE-VANOPS',${vehicle},${truck},${depot},${today()},${who.profile.id},${who.userId},'active',${boss.userId},1,${who.deviceId},1000) returning *`;
  trip = t;
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values(${outlet},'sunpride','STORE','Sample store','active',${unit},'GT','fixture')`;
  for (const [kind, facts] of Object.entries({
    cold_chain: policy,
    variance: { toleranceBasisPoints: 50, escalateAfterHours: 24 },
    returnables: { items: [{ code: "crate", label: "Sample crate" }] },
    return_reasons: { items: [{ code: "damaged", label: "Damaged" }] },
  }))
    await h.db`insert into van_policy_versions(org_unit_id,kind,effective_from,source_ref,facts,created_by) values(${unit},${kind},now()-interval '10 days','SAMPLE',${facts},${boss.profile.id})`;
  actor = await actorFor(h.db, who.userId);
  office = await actorFor(h.db, boss.userId);
}, 30000);
afterAll(async () => {
  await h?.close();
});
/** @param {string} kind @param {any} p */
function op(kind, p) {
  const at = Date.now();
  return {
    clientOpId: crypto.randomUUID(),
    opType: kind,
    clientTime: at,
    dependsOn: [],
    payload: {
      tripId: trip.id,
      settlementVersion: 1,
      observationId: crypto.randomUUID(),
      ...p,
      deviceTime: at,
    },
  };
}
/** @param {any} o */
async function push(o) {
  return signedPost(h, who, "/api/sync/push", {
    version: 2,
    app: "van-android",
    deviceId: who.deviceId,
    scopeId: unit,
    operations: [o],
  });
}
/** @param {any} o */
async function apply(o) {
  const r = await push(o);
  expect(r.res.status).toBe(200);
  expect(r.body.results[0].status).toBe("applied");
  return r;
}

/** @type {string} */ let product = "";
/** @param {string} location */
const stock = async (location) =>
  (
    await h.db`select physical_base::text as physical,available_stock_base::text as sellable,damaged_base::text as damaged,in_transit_base::text as in_transit,reserved_base::text as reserved from inventory_balances where location_id=${location} and product_id=${product}`
  )[0] ?? {
    physical: "0",
    sellable: "0",
    damaged: "0",
    in_transit: "0",
    reserved: "0",
  };

/** What the pre-document code did for dispatch, step for step (reloads.js on main). Returns the request id. @param {number} quantity */
async function oldDispatch(quantity) {
  const request = crypto.randomUUID();
  const facts = {
    lines: [{ productId: product, quantityBase: String(quantity) }],
    note: "SAMPLE old reload",
  };
  await h.db`insert into van_trip_observations(id,trip_id,client_op_id,kind,captured_at,recorded_by,device_id,facts) values(${request},${trip.id},${crypto.randomUUID()},'reload_request',now(),${who.profile.id},${who.deviceId},${facts})`;
  await h.db`insert into van_reload_events(request_id,kind,facts,actor_profile_id) values(${request},'approved',${{ note: "ok", lines: [] }},${boss.profile.id})`;
  const moved = await h.db.begin((/** @type {any} */ db) =>
    postMovement(db, {
      kind: "transfer_ship",
      sourceType: "van_reload",
      sourceId: request,
      idempotencyKey: `van:reload:ship:${request}`,
      occurredAt: Date.now(),
      organizationId: "sunpride",
      actor: { profileId: boss.profile.id, userId: boss.userId },
      authorizedLocations: [depot, truck],
      lines: [
        {
          productId: product,
          fromLocationId: depot,
          toLocationId: truck,
          fromStockStatus: "available",
          toStockStatus: "in_transit",
          quantityBase: quantity,
          uom: "PC",
        },
      ],
    }),
  );
  await h.db`insert into van_reload_events(request_id,kind,facts,actor_profile_id,movement_id) values(${request},'dispatched',${{ note: "sent", lines: facts.lines.map((l) => ({ ...l, lotId: null, batch: null, expiresAt: null, qualityStatus: "released" })) }},${boss.profile.id},${moved.movementId})`;
  return request;
}
const sentLines = async (/** @type {string} */ request) =>
  (
    await h.db`select facts from van_reload_events where request_id=${request} and kind='dispatched'`
  )[0].facts.lines;

test("a reload dispatched before the deploy is received from the truck's in-transit stock, once, with nothing reserved", async () => {
  const base =
    await h.db`insert into units_of_measure(id,organization_id,code,name,dimension,decimal_places,active) values(${crypto.randomUUID()},'sunpride','PC','Piece','count',0,true) returning id`;
  product = crypto.randomUUID();
  await h.db`insert into products(id,organization_id,code,name,category,uom,unit_price,active,base_uom_id,quantity_scale) values(${product},'sunpride','I2F-RELOAD','Old reload item','Frozen','PC',0,true,${base[0].id},1)`;
  await h.db`insert into product_inventory_policies(organization_id,product_id,base_uom_id,quantity_scale,quantity_precision,tracking_mode,allocation_policy,allow_mixed_lots_per_line,allow_negative_stock,quality_release_required,shelf_life_days,expiry_date_required,manufacture_date_required,minimum_remaining_shelf_life_days,costing_method,version,active) values('sunpride',${product},${base[0].id},1,0,'none','fefo',true,false,false,null,false,false,0,'weighted_average',1,true)`;
  await h.db.begin((/** @type {any} */ db) =>
    postMovement(db, {
      kind: "opening_balance",
      sourceType: "sample_fixture",
      sourceId: "i2f-reload",
      idempotencyKey: "i2f-reload-open",
      occurredAt: Date.now(),
      organizationId: "sunpride",
      actor: { profileId: boss.profile.id, userId: boss.userId },
      authorizedLocations: [depot],
      lines: [
        {
          productId: product,
          fromLocationId: null,
          toLocationId: depot,
          quantityBase: 40,
          uom: "PC",
          unitCostMinor: 50,
        },
      ],
    }),
  );
  const request = await oldDispatch(12);
  expect(await stock(truck)).toMatchObject({ in_transit: "12", sellable: "0" });
  expect((await stock(depot)).sellable).toBe("28");
  // the phone echoes the dispatched lines, exactly what beta.25/26 sends
  const r = await apply(
    op("reload.receive", {
      requestId: request,
      lines: await sentLines(request),
    }),
  );
  expect(r.body.results[0].status).toBe("applied");
  expect(await stock(truck)).toMatchObject({
    in_transit: "0",
    sellable: "12",
    damaged: "0",
  });
  // nothing was reserved and no document was made behind the seller's back
  expect((await stock(depot)).reserved).toBe("0");
  expect((await stock(depot)).sellable).toBe("28");
  expect(
    (
      await h.db`select count(*)::int as n from stock_transfers where source_ref=${`van_reload:${request}`}`
    )[0].n,
  ).toBe(0);
  const [received] =
    await h.db`select facts,movement_id from van_reload_events where request_id=${request} and kind='received'`;
  expect(received.facts.legacy).toBe(true);
  expect(received.movement_id).toBeTruthy();
  // receiving the same reload again is refused and posts nothing
  const again = await push(
    op("reload.receive", {
      requestId: request,
      lines: await sentLines(request),
    }),
  );
  expect(again.body.results[0].status).toBe("rejected");
  expect(await stock(truck)).toMatchObject({ in_transit: "0", sellable: "12" });
}, 60000);

test("an old in-flight reload can be received with damaged pieces, and a count that does not add up is refused", async () => {
  const request = await oldDispatch(10);
  const lines = (/** @type {number} */ good, /** @type {number} */ damaged) => [
    {
      productId: product,
      lotId: null,
      receivedGoodBase: String(good),
      receivedDamagedBase: String(damaged),
      reasonCode: "DMG-TRANSIT",
      photoCount: 1,
    },
  ];
  const short = await push(
    op("reload.receive", { requestId: request, lines: lines(5, 2) }),
  );
  expect(short.body.results[0].status).toBe("rejected");
  expect(await stock(truck)).toMatchObject({
    in_transit: "10",
    sellable: "12",
  });
  await apply(op("reload.receive", { requestId: request, lines: lines(8, 2) }));
  expect(await stock(truck)).toMatchObject({
    in_transit: "0",
    sellable: "20",
    damaged: "2",
  });
  expect(
    (
      await h.db`select count(*)::int as n from stock_transfers where source_ref=${`van_reload:${request}`}`
    )[0].n,
  ).toBe(0);
}, 60000);
