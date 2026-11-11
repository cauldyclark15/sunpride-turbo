import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  startHarness,
  profileStore,
  boundDevice,
  signedPost,
} from "./harness.js";
import { sha256Hex } from "../src/core/util.js";

// IP-VANDAY: roster, nightly trips and suggested loads, load-out on the movement document with clerk-seller agreement,
// crew + device binding, the day board and the handheld bundle. Real Postgres, real stock posting; only audit, pricing
// and analytics boundaries are mocked.
mock.module("../src/domains/org/audit.js", () => ({
  writeAudit: async (/** @type {any} */ t, /** @type {any} */ e) => {
    await t`insert into audit_logs (subject,action,entity_type,entity_id,details) values (${e.subject},${e.action},${e.entityType},${e.entityId},${e.details ?? null})`;
  },
}));
mock.module("../src/domains/orders/pricing.js", () => ({
  // VAN-006: a governed list, so the handheld bundle carries price lines (every outlet gets the same quote).
  resolvePrice: async () => ({ unitPriceCentavos: 12500, priceListId: "11111111-1111-4111-8111-111111111111", source: "test" }),
  creditCheck: async () => ({ status: "unknown", limit: null, exposure: null }),
}));
mock.module("../src/domains/analytics/refresh.js", () => ({
  enqueueRefresh: async () => {},
}));
const { install: installVan } = await import("../src/domains/van/index.js");
const { install: installInventory } = await import("../src/domains/inventory/index.js");
const { install: installDecide } = await import("../src/domains/decide/index.js");
const { postMovement } = await import("../src/domains/inventory/posting.js");
const { suggestLine, generateTrips, computeSuggestion, installNightly } = await import("../src/domains/van/nightly.js");
const { crewProof, switchCrew, isoWeekday } = await import("../src/domains/van/roster.js");
const { today } = await import("../src/domains/van/model.js");

/** @type {any} */ let h;
/** @type {any} */ let who; // the seller (native device)
/** @type {any} */ let boss; // super admin: plans, approves, decides
/** @type {any} */ let clerk; // warehouse clerk (operations)
/** @type {any} */ let helper;
/** @type {any} */ let helper2;
const unit = crypto.randomUUID();
/** @type {string} */ let depot;
/** @type {string} */ let pcId;
/** @type {string} */ let csId;
/** @type {string} */ let routeA;
/** @type {string} */ let routeB;
/** @type {any} */ let prodA; // untracked, 12 per case, P80 a piece
/** @type {any} */ let prodB; // batch-tracked, 6 per case
/** @type {{early:string, late:string}} */ let lots;
const COST = 8000; // centavos per piece: one case of A = P960, above the P500 default tolerance
let seq = 0;

/** @param {any} user */
async function persist(user) {
  const p = user.profile;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user.userId},${user.userId},${p.name},${user.email},${p.role},'active',${p.orgUnitId})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${p.orgUnitId},${p.role},now()-interval '1 day','fixture','fixture')`;
}
/** A web person with a session cookie. @param {string} role @param {string} name */
async function person(role, name) {
  const email = `${crypto.randomUUID()}@test.invalid`;
  const [u] = await h.db`insert into users (email,password_hash) values (${email},'fixture-not-a-login') returning id`;
  const profile = { id: crypto.randomUUID(), name, role, orgUnitId: unit };
  await persist({ profile, userId: u.id, email });
  const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
  await h.db`insert into sessions (user_id,token_hash,app,expires_at) values (${u.id},${sha256Hex(token)},'web',now()+interval '1 day')`;
  return { userId: u.id, profileId: profile.id, name, cookie: `sp_session=${token}` };
}
/** @param {any} p @param {number} qty @param {string} locationId @param {string|null} [lotId] */
async function stockIn(p, qty, locationId, lotId = null) {
  await h.db.begin(async (/** @type {any} */ db) =>
    postMovement(db, {
      kind: "opening_balance",
      sourceType: "van_day_fixture",
      sourceId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      occurredAt: Date.now(),
      organizationId: "sunpride",
      actor: { profileId: boss.profileId, userId: boss.userId },
      authorizedLocations: [locationId],
      lines: [
        {
          productId: p.id,
          fromLocationId: null,
          toLocationId: locationId,
          quantityBase: qty,
          uom: "base",
          unitCostMinor: COST,
          ...(lotId ? { lotId } : {}),
        },
      ],
    }),
  );
}
/** @param {string} productId @param {string} locationId */
async function stock(productId, locationId) {
  const [b] =
    await h.db`select available_stock_base,reserved_base,in_transit_base,physical_base from inventory_balances where product_id=${productId} and location_id=${locationId}`;
  return {
    available: Number(b?.available_stock_base ?? 0),
    reserved: Number(b?.reserved_base ?? 0),
    transit: Number(b?.in_transit_base ?? 0),
    physical: Number(b?.physical_base ?? 0),
  };
}
/** @param {any} who2 @param {string} path @param {any} body */
async function web(who2, path, body) {
  const res = await h.fetch(`/api/v1/van/${path}`, {
    method: "POST",
    headers: { cookie: who2.cookie, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {any} who2 @param {string} path */
async function read(who2, path) {
  const res = await h.fetch(`/api/v1/van/${path}`, { headers: { cookie: who2.cookie } });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
const msg = (/** @type {any} */ r) => String(r.body?.error?.message ?? r.body?.message ?? "");
/** @param {string} type @param {any} payload */
function op(type, payload) {
  const at = Date.now();
  return { clientOpId: crypto.randomUUID(), opType: type, clientTime: at, dependsOn: [], payload: Object.assign(payload, { deviceTime: at }) };
}
/** @param {any[]} operations */
const push = (operations) =>
  signedPost(h, who, "/api/sync/push", { version: 2, app: "van-android", deviceId: who.deviceId, scopeId: unit, operations });
/** @param {boolean} vanDay */
async function pull(vanDay) {
  const r = await signedPost(h, who, "/api/sync/pull", {
    version: 2,
    app: "van-android",
    deviceId: who.deviceId,
    since: null,
    pageCursor: null,
    scopes: [{ scopeId: unit, projection: "van.bundle", params: { serviceDate: today(), ...(vanDay ? { vanDay: true } : {}) } }],
    limit: 100,
  });
  expect(r.res.status).toBe(200);
  return /** @type {any} */ (r.body.bundles[0].data);
}

/** A fresh truck + roster line for the seller today, trip and suggested load generated. Earlier trips are put away.
 * @param {{mustCarry?:number, weekdays?:number[]}} [o] */
async function scenario(o = {}) {
  await h.db`update van_trips set status='closed' where status in ('planned','loading','loaded','active') and service_date=${today()}::date`;
  await h.db`update van_rosters set status='ended'`;
  const n = ++seq;
  const [truck] =
    await h.db`insert into inventory_locations (organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values ('sunpride',${unit},'CEBU',${`TRK${n}`},${`Truck ${n}`},'truck',true,false,true,true,false) returning id`;
  const [v] =
    await h.db`insert into vehicles(organization_id,org_unit_id,vehicle_code,plate_number,name,truck_location_id,home_location_id,status,created_by) values('sunpride',${unit},${`VAN${n}`},${`ABC ${1000 + n}`},${`Van ${n}`},${truck.id},${depot},'active','fixture') returning id`;
  const [r] =
    await h.db`insert into routes(organization_id,code,name,status,effective_from,created_by) values('sunpride',${`RT${n}`},${`Route ${n}`},'active',now()-interval '1 day','fixture') returning id`;
  await stockIn(prodA, 480, depot);
  await web(boss, "must-carry/save", { routeId: r.id, productId: prodA.id, minBase: o.mustCarry ?? 24 });
  const roster = await web(boss, "rosters/save", {
    vehicleId: v.id,
    routeId: r.id,
    sellerProfileId: who.profile.id,
    helperProfileId: helper.profileId,
    weekdays: o.weekdays ?? [1, 2, 3, 4, 5, 6, 7],
    effectiveFrom: today(),
  });
  expect(roster.status).toBe(200);
  const gen = await web(boss, "trips/generate", { date: today() });
  expect(gen.status).toBe(200);
  const tripId = gen.body.trips.find((/** @type {any} */ t) => t.vehicleCode === `VAN${n}`)?.tripId;
  expect(tripId).toBeTruthy();
  return { tripId, vehicleId: v.id, truckId: truck.id, routeId: r.id, rosterId: roster.body.rosterId, code: `VAN${n}` };
}
/** Approve, pick, dispatch the suggested load of a trip. @param {string} tripId */
async function toDispatched(tripId) {
  const a = await web(boss, "loads/approve-plan", { tripIds: [tripId] });
  expect(a.status).toBe(200);
  expect(a.body.approved).toBe(1);
  expect((await web(clerk, "loads/pick", { tripId })).status).toBe(200);
  const d = await web(clerk, "loads/dispatch", { tripId, driverName: "Pedro Reyes", vehiclePlate: "ABC 1234" });
  expect(d.status).toBe(200);
  return d.body;
}
/** @param {string} tripId */
async function loadIdOf(tripId) {
  const [l] = await h.db`select id from van_trip_loads where trip_id=${tripId} and status<>'cancelled'`;
  return l.id;
}
const planOf = async (/** @type {string} */ tripId) =>
  (await h.db`select * from van_planned_loads where trip_id=${tripId} and state<>'cancelled'`)[0];
const tripOf = async (/** @type {string} */ tripId) => (await h.db`select * from van_trips where id=${tripId}`)[0];

beforeAll(async () => {
  h = await startHarness({ installers: [installInventory, installVan, installDecide] });
  const profiles = profileStore(h);
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','Van day test','national','active',now()-interval '1 day')`;
  who = await boundDevice(h, profiles, { app: "van-android", orgUnitId: unit });
  who.profile.name = "Sam Seller";
  await persist(who);
  h.setHooks({
    rootUnitId: async () => unit,
    loadProfile: async (/** @type {any} */ db, /** @type {string} */ id) => {
      const [p] = await db`select * from profiles where user_id=${id} and deleted_at is null`;
      return p ? { id: p.id, userId: p.user_id, name: p.name, role: p.role, orgUnitId: p.org_unit_id, status: p.status } : null;
    },
  });
  [boss, clerk, helper, helper2] = await Promise.all([
    person("super_admin", "Boss Supervisor"),
    person("operations", "Cora Clerk"),
    person("sales", "Hana Helper"),
    person("sales", "Rey Relief"),
  ]);
  const [pc] = await h.db`insert into units_of_measure (organization_id,code,name,dimension,decimal_places,active) values ('sunpride','PC','Piece','count',0,true) returning id`;
  const [cs] = await h.db`insert into units_of_measure (organization_id,code,name,dimension,decimal_places,active) values ('sunpride','CS','Case','count',0,true) returning id`;
  pcId = pc.id;
  csId = cs.id;
  const [d] = await h.db`insert into inventory_locations (organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values ('sunpride',${unit},'CEBU','CEB-DEPOT','Cebu depot','warehouse',true,true,true,false,false) returning id`;
  depot = d.id;
  /** @param {string} name @param {number} perCase @param {boolean} tracked */
  const product = async (name, perCase, tracked) => {
    const [p] = await h.db`insert into products (code,name,category,uom,unit_price,active,organization_id,base_uom_id,quantity_scale,tracking_mode,allocation_policy) values (${`P-${crypto.randomUUID().slice(0, 8)}`},${name},'Frozen','PC',0,true,'sunpride',${pcId},1,${tracked ? "lot" : "none"},'fefo') returning *`;
    await h.db`insert into uom_conversions (organization_id,product_id,from_uom_id,to_uom_id,numerator,denominator,rounding_mode,effective_from,active) values ('sunpride',${p.id},${csId},${pcId},${perCase},1,'exact',now()-interval '1 year',true)`;
    if (tracked)
      await h.db`insert into product_inventory_policies (organization_id,product_id,base_uom_id,quantity_scale,quantity_precision,tracking_mode,allocation_policy,allow_mixed_lots_per_line,allow_negative_stock,quality_release_required,expiry_date_required,manufacture_date_required,minimum_remaining_shelf_life_days,costing_method,version,active) values ('sunpride',${p.id},${pcId},1,0,'lot','fefo',true,false,false,true,false,0,'weighted_average',1,true)`;
    return p;
  };
  prodA = await product("Longganisa 500g", 12, false);
  prodB = await product("Tocino 1kg", 6, true);
  /** @param {string} no @param {number} days */
  const lot = async (no, days) => {
    const [l] = await h.db`insert into inventory_lots(organization_id,product_id,lot_number,normalized_lot_number,source_type,received_at,expires_at,quality_status,unit_cost_minor) values('sunpride',${prodB.id},${no},${no},'fixture',now(),${new Date(Date.now() + days * 86400000)},'released',${COST}) returning id`;
    return l.id;
  };
  lots = { early: await lot("B-EARLY", 10), late: await lot("B-LATE", 60) };
  [{ id: routeA }, { id: routeB }] = await Promise.all([
    h.db`insert into routes(organization_id,code,name,status,effective_from,created_by) values('sunpride','RA','Mandaue route','active',now()-interval '1 day','fixture') returning id`.then((/** @type {any} */ r) => r[0]).then((/** @type {any} */ r) => ({ id: r.id })),
    h.db`insert into routes(organization_id,code,name,status,effective_from,created_by) values('sunpride','RB','Lapu-Lapu route','active',now()-interval '1 day','fixture') returning id`.then((/** @type {any} */ r) => r[0]).then((/** @type {any} */ r) => ({ id: r.id })),
  ]);
}, 60000);
afterAll(async () => {
  await h?.close();
});

// IP-INT3 gap 5 (van half): replay the exact JSON the phone sends for `load.accept` and `crew.switch`, made by the
// phone's own serializers (LoadAccept.payload, CrewSwitch.payload + PinProofs) and committed as fixtures/phone-ops.json
// by PhoneRoundTripFixtureTest. Only ids, the clock and the PIN proof (bound to this run's device, trip and PIN version,
// recomputed with the server's own `crewProof`) are replaced; the keys and value shapes are the phone's.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/phone-ops.json", import.meta.url), "utf8"),
);
/** @param {string} name */
const captured = (name) =>
  structuredClone(fixture.ops.find((/** @type {any} */ o) => o.name === name).op);
const keyOf = (/** @type {string} */ pin, /** @type {string} */ salt) =>
  pbkdf2Sync(pin, salt, 160000, 32, "sha256").toString("hex");

it("the server's crew proof agrees byte for byte with the phone's proof in the fixture", () => {
  const sw = captured("crew.switch");
  expect(
    crewProof(fixture.test.keyHex, {
      deviceId: fixture.test.deviceId,
      tripId: fixture.test.tripId,
      toProfileId: fixture.test.helperId,
      pinId: fixture.test.pinId,
      at: sw.clientTime,
    }),
  ).toBe(sw.payload.proof);
});

describe("the phone's own operations", () => {
  it("load.accept and crew.switch, as the phone serializes them, are accepted and recorded", async () => {
    const sc = await scenario();
    await toDispatched(sc.tripId);
    const loadId = await loadIdOf(sc.tripId);
    const now = Date.now();

    // load.accept: the seller counted the 24 pieces the clerk sent, same as sent, with a note.
    const accept = captured("load.accept");
    const acceptShape = JSON.stringify(Object.keys(accept.payload).sort());
    expect(accept.payload.lines[0]).toEqual({ productId: fixture.test.productId, lotId: null, actualBase: "24" });
    accept.clientTime = now;
    accept.payload.deviceTime = now;
    accept.payload.tripId = sc.tripId;
    accept.payload.loadId = loadId;
    accept.payload.lines[0].productId = prodA.id;
    expect(JSON.stringify(Object.keys(accept.payload).sort())).toBe(acceptShape); // same keys the phone sends
    const start = op("trip.start", { tripId: sc.tripId, vehicleConfirmed: true, routeConfirmed: true });
    const r = await push([accept, start]);
    expect(r.res.status).toBe(200);
    expect(r.body.results.map((/** @type {any} */ x) => x.status)).toEqual(["applied", "applied"]);
    expect((await planOf(sc.tripId)).state).toBe("accepted");
    expect((await tripOf(sc.tripId)).status).toBe("active");
    expect((await stock(prodA.id, sc.truckId)).available).toBe(24);
    // The same bytes again are a replay, not a second count.
    expect((await push([accept])).body.results[0].status).toBe("duplicate");

    // crew.switch: the helper takes over the phone with their own PIN.
    expect((await web(boss, "crew/pin", { profileId: helper.profileId, pin: "482915" })).status).toBe(200);
    const [k] = await h.db`select id,pin_salt from van_crew_pins where profile_id=${helper.profileId} and effective_to is null`;
    const sw = captured("crew.switch");
    const switchShape = JSON.stringify(Object.keys(sw.payload).sort());
    expect(sw.payload.proof).toMatch(/^[a-f0-9]{64}$/);
    // (the PIN only counts from the moment it was set, so the op's time is taken after that)
    const at = Date.now();
    sw.clientTime = at;
    sw.payload.deviceTime = at;
    sw.payload.tripId = sc.tripId;
    sw.payload.toProfileId = helper.profileId;
    sw.payload.pinId = k.id;
    sw.payload.proof = crewProof(keyOf("482915", k.pin_salt), {
      deviceId: who.deviceId,
      tripId: sc.tripId,
      toProfileId: helper.profileId,
      pinId: k.id,
      at: sw.clientTime,
    });
    expect(JSON.stringify(Object.keys(sw.payload).sort())).toBe(switchShape);
    // the phone's proof (another device, trip and PIN version) is not valid here
    const stale = structuredClone(sw);
    stale.clientOpId = crypto.randomUUID();
    stale.payload.proof = captured("crew.switch").payload.proof;
    expect((await push([stale])).body.results[0].status).toBe("rejected");
    const s = await push([sw]);
    expect(s.body.results[0], JSON.stringify(s.body.results[0])).toMatchObject({ status: "applied" });
    const [live] = await h.db`select profile_id,role,method from van_crew_sessions where device_id=${who.deviceId} and ended_at is null`;
    expect(live).toMatchObject({ profile_id: helper.profileId, role: "helper", method: "pin_offline" });
    const acts = await h.db`select profile_id from van_crew_actions where trip_id=${sc.tripId} and op_type='crew.switch'`;
    expect(acts.map((/** @type {any} */ a) => a.profile_id)).toEqual([helper.profileId]);
  });
});

describe("VAN-006: the handheld's own pull after the office dispatches", () => {
  it("a dispatched Loading trip reaches the phone with every param the app sends", async () => {
    const sc = await scenario();
    await toDispatched(sc.tripId);
    // A real route: 26 stores in the unit and 24 products on the truck. Quote lines keyed per outlet were
    // 26 x 24 = 624 > the frozen 600 bound, so the server refused the whole bundle (422) and the phone sat "paused".
    for (let i = 0; i < 26; i++)
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('sunpride',${`V6-${i}`},${`Store ${i}`},'active',${unit},'gt','fixture')`;
    for (let i = 0; i < 23; i++) await stockIn(await (async () => {
      const [p] = await h.db`insert into products (code,name,category,uom,unit_price,active,organization_id,base_uom_id,quantity_scale,tracking_mode,allocation_policy) values (${`V6-${i}`},${`Item ${i}`},'Frozen','PC',0,true,'sunpride',${pcId},1,'none','fefo') returning *`;
      return p;
    })(), 12, sc.truckId);
    // Exactly the scope params VanSyncClient.bootstrap() sends.
    const r = await signedPost(h, who, "/api/sync/pull", {
      version: 2, app: "van-android", deviceId: who.deviceId, since: null, pageCursor: null, limit: 100,
      scopes: [{ scopeId: unit, projection: "van.bundle", params: { serviceDate: today(), catalogue: true, schemeEngine: 1,
        posMode: true, handheld: true, vanDay: true, categories: true, refunds: true, privilegeCap: true } }],
    });
    expect(r.res.status, JSON.stringify(r.body)).toBe(200);
    const data = /** @type {any} */ (r.body).bundles[0].data;
    expect(data.trip?.tripId).toBe(sc.tripId);
    expect(data.trip.status).toBe("loading");
    expect(data.customers.length).toBeGreaterThanOrEqual(26);
    expect(data.products.length).toBeGreaterThanOrEqual(24);
    // Identical quotes share one list; every customer still points at lines that exist.
    expect(data.priceLines.length).toBeLessThanOrEqual(600);
    const lists = new Set(data.priceLines.map((/** @type {any} */ l) => l.priceListId));
    for (const c of data.customers) expect(lists.has(c.priceListId)).toBe(true);
  });
});
