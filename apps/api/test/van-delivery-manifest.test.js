import { afterAll, beforeAll, expect, test, mock } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
} from "./harness.js";
import { sha256Hex } from "../src/core/util.js";
import { runDueJobs } from "../src/core/jobs.js";
import { install as presell } from "../src/domains/presell/index.js";
import { install as visits } from "../src/domains/visits/index.js";
import { install as callflow } from "../src/domains/callflow/index.js";
import { install as orders } from "../src/domains/orders/index.js";
import {
  validateRequestedDay,
  policyAt,
} from "../src/domains/presell/promise.js";
import { validateDeliveryLines } from "../src/domains/presell/driver.js";
import {
  processHandoff,
  processNotification,
} from "../src/domains/presell/service.js";
import { configuration } from "../src/domains/callflow/engine.js";
import { tripOperationIds } from "../src/domains/van/settlement.js";
import { captureFieldOrder } from "../src/domains/orders/field.js";
import {
  ensurePresellSamples,
  ensurePresellDemo,
} from "../../../packages/db/seed/presell.js";
import { Dataset, persist } from "../../../packages/db/seed/store.js";

mock.module("../src/domains/org/scope.js", () => ({
  scopeFilterForActor: async (
    /** @type {any} */ db,
    /** @type {any} */ actor,
  ) => ({
    unitIds: ["super_admin", "analyst"].includes(actor.role)
      ? null
      : [actor.orgUnitId],
  }),
  outletOwnerUnit: async (/** @type {any} */ db, /** @type {string} */ id) =>
    (await db`select custodian_org_unit_id from outlets where id=${id}`)[0]
      ?.custodian_org_unit_id ?? null,
}));
/** @type {import('./harness.js').Harness} */ let h;
/** @type {ReturnType<typeof profileStore>} */ let profiles;
/** @type {any} */ let admin;
const DAY = 86400000,
  now = Date.now();
const day = (/** @type {number} */ at) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 10);
const today = day(now),
  next = day(now + 2 * DAY);
/** @param {string} role @param {string} unit */
async function person(role, unit) {
  const user = await createUser(
    h,
    `${crypto.randomUUID()}@test.invalid`,
    "fixture-only-long-password",
  );
  const p = profiles.set(user, {
    role,
    orgUnitId: unit,
    name: "Sample colleague",
  });
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user},${user},'Sample colleague',${user + "@test.invalid"},${role},'active',${unit})`;
  const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
  await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${user},${sha256Hex(token)},'web',now()+interval '1 day')`;
  return { ...p, cookie: `sp_session=${token}` };
}
/** @param {any} who @param {string} path @param {any} [body] */
async function api(who, path, body) {
  const r = await h.fetch("/api/v1/" + path, {
    method: body ? "POST" : "GET",
    headers: { cookie: who.cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: /** @type {any} */ (await r.json()) };
}
/** @param {string} action @param {any} body @param {any} [who] */
async function cmd(action, body, who = admin) {
  return api(who, "presell/" + action, {
    idempotencyKey: crypto.randomUUID(),
    ...body,
  });
}
/** @param {any} [opts] */
async function fixture(opts = {}) {
  const unit = crypto.randomUUID();
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride',${unit},'Cebu','region','active','2020-01-01')`;
  const d = await boundDevice(h, profiles, {
    app: opts.app ?? "van-android",
    role: "sales",
    orgUnitId: unit,
  });
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${d.profile.id},${d.userId},${d.userId},'Sample driver',${d.email},'sales','active',${unit})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${d.profile.id},${unit},'sales','2020-01-01',${d.userId},'fixture')`;
  const [customer] =
    await h.db`insert into customers(code,name,channel,territory,credit_limit,active) values(${crypto.randomUUID()},'Sample account','gt_presell','Cebu',0,true) returning *`;
  const [outlet] =
    await h.db`insert into outlets(organization_id,code,name,address,status,custodian_org_unit_id,channel,created_by) values('sunpride',${crypto.randomUUID()},'Sample store','Cebu street','active',${unit},'gt_presell',${d.userId}) returning *`;
  const [territory] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by) values('sunpride',${crypto.randomUUID()},'Cebu','active','2020-01-01',${d.userId}) returning id`;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${territory.id},${unit},'2020-01-01',${d.userId},'fixture')`;
  await h.db`insert into outlet_assignments(outlet_id,territory_id,effective_from,actor_subject,reason) values(${outlet.id},${territory.id},'2020-01-01',${d.userId},'fixture')`;
  await h.db`insert into territory_salespeople(territory_id,profile_id,effective_from,actor_subject,reason) values(${territory.id},${d.profile.id},'2020-01-01',${d.userId},'fixture')`;
  await h.db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) values(${outlet.id},${customer.id},'sample','2020-01-01',${d.userId},'fixture')`;
  await h.db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,status,effective_from,proposed_by,proposed_at,verified_by,verified_at) values(${outlet.id},10.33,123.94,100,'fixture','verified','2020-01-01','one','2020-01-01','two','2020-01-01')`;
  const [sku] =
    await h.db`insert into products(code,name,category,uom,unit_price,active,organization_id,quantity_scale) values(${crypto.randomUUID()},'Sample food','Food','PC',1,true,'sunpride',1) returning id`;
  const [order] =
    await h.db`insert into orders(organization_id,client_request_id,order_number,order_type,customer_code,salesperson_subject,salesperson_profile_id,created_by_subject,org_unit_id,outlet_id,territory_id,service_date,status,subtotal,total,amount_known) values('sunpride',${crypto.randomUUID()},${"SAMPLE-" + crypto.randomUUID().slice(0, 8)},'field_order',${customer.code},${d.userId},${d.profile.id},${d.userId},${unit},${outlet.id},${territory.id},${today},${opts.status ?? "approved"},1,1,true) returning *`;
  await h.db`insert into order_lines(order_id,ordinal,product_id,product_code,description,uom,quantity,quantity_base,unit_price,line_total) values(${order.id},0,${sku.id},'FOOD','Sample food','PC',10,10,1,10)`;
  const policy = await policyAt(h.db, now);
  await h.db`insert into presell_order_promises(order_id,requested_delivery_date,policy_id,policy_snapshot,captured_at) values(${order.id},${opts.deliveryDay ?? next},${policy.id},${policy},${new Date(now)})`;
  const [location] =
    await h.db`insert into inventory_locations(organization_id,site_code,code,name,type,active,org_unit_id,allows_picking,allows_receiving,allows_sale,allows_production) values('sunpride','CEBU',${crypto.randomUUID()},'Sample truck','truck',true,${unit},true,true,true,false) returning id`;
  const [vehicle] =
    await h.db`insert into vehicles(organization_id,vehicle_code,name,plate_number,status,org_unit_id,truck_location_id,home_location_id,created_by) values('sunpride',${crypto.randomUUID()},'Sample truck','SAMPLE','active',${unit},${location.id},${location.id},${d.userId}) returning id`;
  const [trip] =
    await h.db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,salesperson_profile_id,salesperson_subject,service_date,status,truck_location_id,source_location_id,created_by) values('sunpride',${unit},${crypto.randomUUID()},${vehicle.id},${d.profile.id},${d.userId},${opts.deliveryDay ?? next},'active',${location.id},${location.id},${d.userId}) returning *`;
  return { unit, d, outlet, sku, order, trip, policy };
}
beforeAll(async () => {
  h = await startHarness({ installers: [visits, orders, callflow, presell] });
  profiles = profileStore(h);
  const unit = crypto.randomUUID();
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','National','national','active','2020-01-01')`;
  admin = await person("super_admin", unit);
  await ensurePresellSamples(h.db, now - DAY);
});
afterAll(async () => {
  await h?.close();
});
/** @param {any} f */
async function release(f) {
  const c = await cmd("confirm", {
    orderId: f.order.id,
    confirmedDeliveryDate: day(f.trip.service_date.getTime()),
    reason: "Sample buyer confirmation",
  });
  expect(c.status).toBe(200);
  await processHandoff(h.db, c.body.id);
  return (
    await h.db`select * from delivery_drops where handoff_id=${c.body.id}`
  )[0];
}
/** @param {any} f */
async function dispatched(f) {
  const drop = await release(f),
    r = await cmd("createRun", { tripId: f.trip.id, label: "Cebu delivery" });
  expect(r.status).toBe(200);
  expect(
    (await cmd("schedule", { dropId: drop.id, runId: r.body.id })).status,
  ).toBe(200);
  expect((await cmd("releaseRun", { runId: r.body.id })).status).toBe(200);
  return { ...drop, runId: r.body.id };
}
/** @param {string} type @param {any} p */
const op = (type, p) => ({
  clientOpId: crypto.randomUUID(),
  opType: type,
  clientTime: p.deviceTime,
  dependsOn: [],
  payload: p,
});
/** @param {any} f @param {any[]} ops */
async function push(f, ...ops) {
  const r = await signedPost(h, f.d, "/api/sync/push", {
    version: 2,
    deviceId: f.d.deviceId,
    scopeId: f.unit,
    operations: ops,
  });
  expect(r.res.status).toBe(200);
  return r.body.results;
}

/**
 * Delivery operations (delivery.confirm / delivery.timing) are trip operations in the phone's close manifest
 * (TripCloseStore lists every done outbox row). Each accepted one must be in the server's known set for that trip,
 * derived from the drop's released run, and rejected or replayed ones must add nothing. Known-set level proof only:
 * the full trip.close chain (cash/stock/unload) on a delivery trip is not exercised here.
 */
test("delivery.confirm and delivery.timing applied ops are in the trip's known set; rejected and replayed ones add nothing", async () => {
  const f = await fixture({ deliveryDay: today }),
    drop = await dispatched(f),
    at = Date.now(),
    config = await configuration(h.db, "driver_delivery", f.outlet, at),
    fix = {
      latitude: 10.33,
      longitude: 123.94,
      accuracyMeters: 5,
      fixTime: at,
      provider: "gps",
      mockSignal: false,
    };
  const applied = /** @type {any[]} */ ([]);
  /** @param {any} o @param {string} expected */
  const run = async (o, expected = "applied") => {
    const r = (await push(f, o))[0];
    expect(r.status).toBe(expected);
    if (expected === "applied") applied.push(o);
    return r;
  };
  const audits = async (/** @type {string} */ id) =>
    (
      await h.db`select count(*)::int n, min(trip_id::text) trip from van_audit_events where details->>'clientOpId'=${id}`
    )[0];
  const start = op("call.start", {
    tripId: f.trip.id,
    clientCallId: crypto.randomUUID(),
    outletId: f.outlet.id,
    deviceTime: at,
    location: fix,
    flowDefinitionId: config.definition.id,
    unplannedReason: "Assigned delivery",
  });
  await run(start);
  /** @param {string} stage @param {number} offset @param {string|null} [reason] */
  const timing = (stage, offset, reason = null) =>
    op("delivery.timing", {
      tripId: f.trip.id,
      dropId: drop.id,
      clientCallId: start.payload.clientCallId,
      deviceTime: at + offset,
      stage,
      ...(reason ? { reason } : {}),
    });
  const early = timing("unloading", 1);
  await run(early, "rejected");
  const arrival = timing("arrival", 1);
  await run(arrival);
  await run(arrival, "duplicate");
  await run(timing("unloading", 2));
  const [line] =
    await h.db`select * from delivery_drop_lines where drop_id=${drop.id}`;
  const digest = "d".repeat(64);
  await h.db`insert into files(owner_id,purpose,sha256,mime,size,device_id,created_by,status,path,stored_at) values(${f.trip.id},'truck-damage',${digest},'image/jpeg',100,${f.d.deviceId},${f.d.userId},'stored','fixture.jpg',now())`;
  const p = {
    tripId: f.trip.id,
    dropId: drop.id,
    clientCallId: start.payload.clientCallId,
    deviceTime: at + 2,
    location: { ...fix, fixTime: at + 2 },
    receiverName: "Sample buyer",
    signature: [
      [0.1, 0.2],
      [0.8, 0.7],
    ],
    photoSha256: digest,
    watermark: {
      version: 1,
      outletId: f.outlet.id,
      profileId: f.d.profile.id,
      capturedAt: at + 2,
      latitude: fix.latitude,
      longitude: fix.longitude,
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
  };
  const bad = op("delivery.confirm", { ...p, signature: [] });
  await run(bad, "rejected");
  const proof = op("delivery.confirm", p);
  await run(proof);
  await run(proof, "duplicate");
  // same proof under a NEW op id: no second proof/effect, but it is an applied receipt and must be in the manifest
  const again = op("delivery.confirm", p);
  await run(again);
  await run(timing("departure", 3));
  await run(
    op("call.close", {
      tripId: f.trip.id,
      clientCallId: start.payload.clientCallId,
      deviceTime: at + 3,
      location: { ...fix, fixTime: at + 3 },
      zeroSaleReason: "delivery_only",
    }),
  );
  // known set == exactly the applied receipts of this trip (nothing rejected, nothing foreign, nothing missing)
  const known = (await tripOperationIds(h.db, f.trip.id))
    .map((/** @type {any} */ r) => r.id)
    .sort();
  expect(known).toEqual(applied.map((o) => o.clientOpId).sort());
  for (const o of applied) {
    const a = await audits(o.clientOpId);
    expect(a.n).toBe(1);
    expect(a.trip).toBe(f.trip.id);
  }
  for (const o of [early, bad]) expect((await audits(o.clientOpId)).n).toBe(0);
  // one proof, one delivery_confirm step, one drop result: the second op id had no business effect
  expect(
    (
      await h.db`select count(*)::int n from delivery_proofs where drop_id=${drop.id}`
    )[0].n,
  ).toBe(1);
  expect(
    (
      await h.db`select count(*)::int n from call_step_events where call_id=(select call_id from delivery_proofs where drop_id=${drop.id}) and adapter='delivery_confirm'`
    )[0].n,
  ).toBe(1);
  // an applied receipt belongs to exactly one trip: another trip's known set never contains it
  const other = await fixture({ deliveryDay: today });
  expect(
    (await tripOperationIds(h.db, other.trip.id)).map(
      (/** @type {any} */ r) => r.id,
    ),
  ).toEqual([]);
});
