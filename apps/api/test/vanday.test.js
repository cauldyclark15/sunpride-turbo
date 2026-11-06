import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { pbkdf2Sync } from "node:crypto";
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
  resolvePrice: async () => ({ unitPriceCentavos: 12500, priceListId: null, source: "test" }),
  creditCheck: async () => ({ status: "unknown", limit: null, exposure: null }),
}));
mock.module("../src/domains/analytics/refresh.js", () => ({
  enqueueRefresh: async () => {},
}));
const { install: installVan } = await import("../src/domains/van/index.js");
const { install: installInventory } = await import("../src/domains/inventory/index.js");
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
  h = await startHarness({ installers: [installInventory, installVan] });
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

describe("roster", () => {
  it("saves a weekly line, refuses a second line for the same truck or seller on the same days, lists by day, and ends", async () => {
    const [truck] = await h.db`insert into inventory_locations (organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values ('sunpride',${unit},'CEBU','TRK-R','Truck R','truck',true,false,true,true,false) returning id`;
    const [v] = await h.db`insert into vehicles(organization_id,org_unit_id,vehicle_code,plate_number,name,truck_location_id,home_location_id,status,created_by) values('sunpride',${unit},'VANR','ZZZ 111','Van R',${truck.id},${depot},'active','fixture') returning id`;
    const base = { vehicleId: v.id, routeId: routeA, sellerProfileId: who.profile.id, helperProfileId: helper.profileId, effectiveFrom: "2026-01-05" };
    const mon = await web(boss, "rosters/save", { ...base, weekdays: [1, 3, 5] });
    expect(mon.status).toBe(200);
    const clash = await web(boss, "rosters/save", { ...base, weekdays: [3, 6] });
    expect(clash.status).toBe(422);
    expect(msg(clash)).toBe("VANR is already rostered with Sam Seller on Wed in those dates");
    const none = await web(boss, "rosters/save", { ...base, weekdays: [] });
    expect(msg(none)).toBe("Pick the days of the week, Monday to Sunday");
    const sat = await web(boss, "rosters/save", { ...base, weekdays: [6], rosterId: undefined, helperProfileId: who.profile.id });
    expect(msg(sat)).toBe("The seller, helper and driver must be different people");
    const ok = await web(boss, "rosters/save", { ...base, weekdays: [6] });
    expect(ok.status).toBe(200);
    const list = await read(boss, `rosters?vehicleId=${v.id}`);
    expect(list.body.items.map((/** @type {any} */ r) => r.weekdayLabel).sort()).toEqual(["Mon, Wed, Fri", "Sat"]);
    expect((await read(boss, `rosters?vehicleId=${v.id}&date=2026-01-07`)).body.items).toHaveLength(1); // a Wednesday
    const ended = await web(boss, "rosters/save", { vehicleId: v.id, rosterId: mon.body.rosterId, end: true, effectiveTo: "2026-02-01" });
    expect(ended.body.ended).toBe(true);
    expect((await read(boss, `rosters?vehicleId=${v.id}&date=2026-03-04`)).body.items.map((/** @type {any} */ r) => r.weekdayLabel)).toEqual([]);
    expect(isoWeekday("2026-11-08")).toBe(7);
    await h.db`update van_rosters set status='ended' where vehicle_id=${v.id}`;
  });
});

describe("suggested load maths", () => {
  it("rounds up to cases, never below must-carry, subtracts what is on the truck and caps at the depot", () => {
    const base = { averageBase: 0, mustCarryBase: 0, shipFirstBase: 0, onTruckBase: 0, caseBase: 12, depotFreeBase: 1000 };
    expect(suggestLine({ ...base, averageBase: 30 }).suggestedBase).toBe(36);
    expect(suggestLine({ ...base, averageBase: 10, mustCarryBase: 24 })).toEqual({ suggestedBase: 24, flags: ["must_carry"] });
    expect(suggestLine({ ...base, averageBase: 30, onTruckBase: 5 }).suggestedBase).toBe(36); // 25 -> 3 cases
    expect(suggestLine({ ...base, averageBase: 30, onTruckBase: 30 }).suggestedBase).toBe(0);
    expect(suggestLine({ ...base, averageBase: 30, depotFreeBase: 30 })).toEqual({ suggestedBase: 24, flags: ["depot_short"] });
    expect(suggestLine({ ...base, caseBase: 0, averageBase: 7 })).toEqual({ suggestedBase: 7, flags: ["no_case_size"] });
  });
  it("an expiry 'ship first' row raises the line to at least that quantity and flags it", () => {
    const r = suggestLine({ averageBase: 6, mustCarryBase: 0, shipFirstBase: 24, onTruckBase: 0, caseBase: 6, depotFreeBase: 100 });
    expect(r.suggestedBase).toBe(24);
    expect(r.flags).toContain("ship_first");
    // Already enough on the truck for the usual sales, but the flagged batch still goes out.
    expect(suggestLine({ averageBase: 6, mustCarryBase: 0, shipFirstBase: 12, onTruckBase: 60, caseBase: 6, depotFreeBase: 100 }).suggestedBase).toBe(12);
  });
});

describe("the suggested load for a trip, from real history", () => {
  it("averages the route's last 4 same-weekday trips, adds must-carry and ship-first, subtracts the truck, rounds to cases", async () => {
    const n = ++seq;
    const [truck] = await h.db`insert into inventory_locations (organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values ('sunpride',${unit},'CEBU',${`TRK${n}`},${`Truck ${n}`},'truck',true,false,true,true,false) returning id`;
    const [v] = await h.db`insert into vehicles(organization_id,org_unit_id,vehicle_code,plate_number,name,truck_location_id,home_location_id,status,created_by) values('sunpride',${unit},${`VAN${n}`},${`HIS ${n}`},'Van',${truck.id},${depot},'active','fixture') returning id`;
    const target = "2026-12-14"; // a Monday
    expect(isoWeekday(target)).toBe(1);
    // Mondays at -7,-14,-21,-28 sold A: 20,30,40,50 (average 35). -35 sold 500 but is the fifth: ignored. A Sunday sold 900: ignored.
    const history = [[-7, 20], [-14, 30], [-21, 40], [-28, 50], [-35, 500], [-1, 900]];
    const day = (/** @type {number} */ d) => new Date(new Date(`${target}T00:00:00Z`).getTime() + d * 86400000).toISOString().slice(0, 10);
    for (const [d, q] of history) {
      const [t] = await h.db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,route_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by) values('sunpride',${unit},${`H-${n}-${d}`},${v.id},${truck.id},${depot},${routeA},${day(d)}::date,${who.profile.id},${who.userId},'closed','fixture') returning id`;
      const saleId = crypto.randomUUID();
      await h.db`insert into van_sales(id,trip_id,receipt_number,total_centavos,receipt,captured_request) values(${saleId},${t.id},${`R-${n}-${d}`},1000,'{}','{}')`;
      await h.db`insert into van_sale_lines(sale_id,ordinal,product_id,quantity_base,total_centavos,facts) values(${saleId},1,${prodA.id},${q},1000,'{}')`;
    }
    const [trip] = await h.db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,route_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by) values('sunpride',${unit},${`T-${n}`},${v.id},${truck.id},${depot},${routeA},${target}::date,${who.profile.id},${who.userId},'planned','fixture') returning *`;
    await stockIn(prodA, 480, depot);
    await stockIn(prodB, 60, depot, lots.early);
    await stockIn(prodB, 60, depot, lots.late);
    await stockIn(prodA, 5, truck.id); // left on the truck from yesterday
    await web(boss, "must-carry/save", { routeId: routeA, productId: prodB.id, minBase: 6 });
    // The office asked to ship the later batch of B first, 24 pieces of it.
    await h.db`insert into inventory_expiry_actions(lot_id,location_id,product_id,action,quantity_base,acted_by) values(${lots.late},${depot},${prodB.id},'prioritise',24,'fixture')`;
    const s = await computeSuggestion(h.db, trip);
    const a = s.lines.find((/** @type {any} */ l) => l.productId === prodA.id);
    const b = s.lines.find((/** @type {any} */ l) => l.productId === prodB.id);
    expect(s.lines[0].productId).toBe(prodB.id); // ship-first lines lead
    expect(a).toMatchObject({ averageBase: 35, onTruckBase: 5, historyTrips: 4, caseBase: 12, suggestedBase: 36 }); // 35 - 5 = 30 -> 3 cases
    expect(b).toMatchObject({ mustCarryBase: 6, shipFirstBase: 24, suggestedBase: 24, caseBase: 6 });
    expect(b.flags).toContain("ship_first");
    expect(s.facts.historyTripIds).toHaveLength(4);
    await h.db`update inventory_expiry_actions set cleared_at=now() where lot_id=${lots.late}`; // later tests start without it
  });
});

describe("the nightly plan", () => {
  it("makes tomorrow's trips and suggested loads from the roster; a re-run, the 20:00 job and Copy yesterday never duplicate", async () => {
    await h.db`update van_trips set status='closed' where status in ('planned','loading','loaded','active')`;
    await h.db`update van_rosters set status='ended'`;
    const tomorrow = today(Date.now() + 86400000),
      later = today(Date.now() + 2 * 86400000);
    const mk = async (/** @type {string} */ seller, /** @type {string|null} */ helperId) => {
      const n = ++seq;
      const [truck] = await h.db`insert into inventory_locations (organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values ('sunpride',${unit},'CEBU',${`TRK${n}`},${`Truck ${n}`},'truck',true,false,true,true,false) returning id`;
      const [v] = await h.db`insert into vehicles(organization_id,org_unit_id,vehicle_code,plate_number,name,truck_location_id,home_location_id,status,created_by) values('sunpride',${unit},${`VAN${n}`},${`NGT ${n}`},'Van',${truck.id},${depot},'active','fixture') returning id`;
      const [r] = await h.db`insert into routes(organization_id,code,name,status,effective_from,created_by) values('sunpride',${`NR${n}`},${`Night route ${n}`},'active',now()-interval '1 day','fixture') returning id`;
      await web(boss, "must-carry/save", { routeId: r.id, productId: prodA.id, minBase: 24 });
      const saved = await web(boss, "rosters/save", { vehicleId: v.id, routeId: r.id, sellerProfileId: seller, helperProfileId: helperId, weekdays: [1, 2, 3, 4, 5, 6, 7], effectiveFrom: today() });
      expect(saved.status).toBe(200);
      return v;
    };
    const v1 = await mk(who.profile.id, helper.profileId);
    const v2 = await mk(helper2.profileId, null);
    // A third truck whose seller (Hana) already has a trip tomorrow on another truck: needs a person.
    const clash = await mk(helper.profileId, null).catch(() => null);
    void clash;
    await h.db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by) select 'sunpride',${unit},${`MAN-${seq}`},v.id,v.truck_location_id,${depot},${tomorrow}::date,${helper.profileId},(select user_id from profiles where id=${helper.profileId}),'planned','fixture' from vehicles v where v.vehicle_code=${`VAN${seq}`}`;
    await stockIn(prodA, 480, depot);

    const { tx } = await import("@sunpride/db/client");
    const first = await tx(h.db, (/** @type {any} */ t) => generateTrips(t, { day: tomorrow, by: "system:van-nightly", trigger: "nightly" }));
    expect(first.planned).toBe(2);
    const made = await h.db`select t.*,(select count(*)::int from van_trip_crew c where c.trip_id=t.id) as crew from van_trips t where t.service_date=${tomorrow}::date and t.generated_by='nightly' order by t.trip_number`;
    expect(made).toHaveLength(2);
    expect(made.every((/** @type {any} */ t) => t.status === "planned" && t.roster_id)).toBe(true);
    expect(made.map((/** @type {any} */ t) => t.crew).sort()).toEqual([1, 2]); // seller (+ helper on the first truck)
    const plans = await h.db`select p.*,l.suggested_base,l.flags from van_planned_loads p join van_planned_load_lines l on l.planned_load_id=p.id where p.trip_id in ${h.db(made.map((/** @type {any} */ t) => t.id))}`;
    expect(plans.every((/** @type {any} */ p) => p.state === "suggested" && p.source === "nightly" && Number(p.suggested_base) === 24)).toBe(true);
    expect(plans[0].flags).toContain("must_carry");

    const again = await tx(h.db, (/** @type {any} */ t) => generateTrips(t, { day: tomorrow, by: "system:van-nightly", trigger: "nightly" }));
    expect(again.planned).toBe(0);
    expect(again.alreadyPlanned).toBeGreaterThanOrEqual(2);
    // the 20:00 job itself (tomorrow from now) is the same day: still no duplicates
    /** @type {any} */ let run;
    installNightly({ registerJob: (/** @type {string} */ _k, /** @type {any} */ fn) => (run = fn), scheduler: { daily: () => {} }, publish: async () => {} });
    await run({ db: h.db });
    const [{ n }] = await h.db`select count(*)::int as n from van_trips where service_date=${tomorrow}::date and generated_by='nightly'`;
    expect(n).toBe(2);
    expect((await h.db`select count(*)::int as n from van_planned_loads where trip_id in ${h.db(made.map((/** @type {any} */ t) => t.id))}`)[0].n).toBe(2);
    const runs = await h.db`select planned,already_planned from van_nightly_runs where service_date=${tomorrow}::date order by ran_at`;
    expect(runs.map((/** @type {any} */ r) => r.planned)).toEqual([2, 0, 0]);

    // Copy yesterday: the same trucks, sellers and loads on the next day; again idempotent.
    const copy = await web(boss, "trips/copy", { fromDate: tomorrow, toDate: later });
    expect(copy.status).toBe(200);
    expect(copy.body.planned).toBeGreaterThanOrEqual(2);
    const copied = await h.db`select p.source,l.suggested_base from van_planned_loads p join van_trips t on t.id=p.trip_id join van_planned_load_lines l on l.planned_load_id=p.id where t.service_date=${later}::date and t.generated_by='copy'`;
    expect(copied.length).toBeGreaterThanOrEqual(2);
    expect(copied.every((/** @type {any} */ c) => c.source === "copy" && Number(c.suggested_base) === 24)).toBe(true);
    expect((await web(boss, "trips/copy", { fromDate: tomorrow, toDate: later })).body.planned).toBe(0);
    void v1;
    void v2;
  });
});

describe("load-out on the movement document", () => {
  it("edit, approve (reserves), pick, dispatch (In transit); the seller accepts short inside the allowed difference and starts the trip offline in the same push", async () => {
    const sc = await scenario();
    const detail = await read(boss, `loads/plan?tripId=${sc.tripId}`);
    expect(detail.body.plan.state).toBe("suggested");
    expect(detail.body.lines).toHaveLength(1);
    expect(detail.body.lines[0]).toMatchObject({ suggestedBase: 24, mustCarryBase: 24, caseBase: 12 });
    const before = await stock(prodA.id, depot);
    // The supervisor edits the suggestion: 3 cases. A clerk may not.
    expect((await web(helper, "loads/edit", { tripId: sc.tripId, lines: [{ productId: prodA.id, quantityBase: 36 }] })).status).toBe(403);
    expect((await web(boss, "loads/edit", { tripId: sc.tripId, lines: [{ productId: prodA.id, quantityBase: 36 }] })).status).toBe(200);
    expect((await web(boss, "loads/edit", { tripId: sc.tripId, lines: [{ productId: prodA.id, quantityBase: 100000 }] })).status).toBe(422);
    const board0 = await read(boss, `day-board?date=${today()}`);
    expect(board0.body.rows.find((/** @type {any} */ r) => r.tripId === sc.tripId).primary.kind).toBe("approve_load");

    const a = await web(boss, "loads/approve-plan", { tripIds: [sc.tripId] });
    expect(a.body.results[0].number).toMatch(/^LOAD-CEB-DEPOT-\d{6}-\d{4}$|^LOAD-[A-Z0-9-]+-\d{6}-\d{4}$/);
    expect((await stock(prodA.id, depot)).reserved - before.reserved).toBe(36);
    expect((await tripOf(sc.tripId)).status).toBe("loading");
    const [doc] = await h.db`select d.* from stock_transfers d join van_planned_loads p on p.stock_transfer_id=d.id where p.trip_id=${sc.tripId}`;
    expect(doc).toMatchObject({ type: "van_load_out", status: "approved" });
    expect(doc.destination_location_id).toBe(sc.truckId);
    // The pick list: product with its batch, by group
    expect((await web(clerk, "loads/pick", { tripId: sc.tripId })).status).toBe(200);
    const list = await read(clerk, `loads/pick-list?tripId=${sc.tripId}`);
    expect(list.body.lines[0]).toMatchObject({ approvedBase: 36, caseBase: 12, group: "Frozen" });
    // The seller cannot dispatch their own load; the clerk dispatches with the header.
    expect((await web(clerk, "loads/dispatch", { tripId: sc.tripId, driverName: "Pedro Reyes", vehiclePlate: "ABC 1234" })).status).toBe(200);
    const after = await stock(prodA.id, depot);
    expect(after.reserved - before.reserved).toBe(0);
    expect((await stock(prodA.id, `${(await h.db`select in_transit_location_id as t from stock_transfers where id=${doc.id}`)[0].t}`)).transit).toBeGreaterThanOrEqual(36);
    const [sent] = await h.db`select status,driver_name,vehicle_plate,receiver_name from stock_transfers where id=${doc.id}`;
    expect(sent).toMatchObject({ status: "shipped", driver_name: "Pedro Reyes", vehicle_plate: "ABC 1234", receiver_name: "Sam Seller" });

    // The phone: the opt-in vanDay section carries the dispatched load; an older phone sees none of it.
    const old = await pull(false);
    expect(old.vanDay).toBeUndefined();
    expect(old.load.lines[0].expectedBase).toBe("36");
    const b = await pull(true);
    expect(b.vanDay.version).toBe(1);
    expect(b.vanDay.load).toMatchObject({ state: "dispatched", canAccept: true, canStartTrip: false, clerkName: "Cora Clerk" });
    expect(b.vanDay.load.lines[0]).toMatchObject({ productId: prodA.id, sentBase: "36", caseBase: 12, countedBase: null });
    expect(b.vanDay.roster.vehicleCode).toBe(sc.code);
    expect(b.vanDay.crew.members.map((/** @type {any} */ m) => m.role)).toEqual(["seller", "helper"]);

    // No signal in the depot: accept (5 pieces short = P400, under a case) and start, both queued, applied in order.
    const loadId = await loadIdOf(sc.tripId);
    const accept = op("load.accept", { tripId: sc.tripId, loadId, lines: [{ productId: prodA.id, actualBase: "31", reason: "short_loaded" }] });
    const start = op("trip.start", { tripId: sc.tripId, vehicleConfirmed: true, routeConfirmed: true, openingFloatCentavos: 100000 });
    const r = await push([accept, start]);
    expect(r.body.results.map((/** @type {any} */ x) => x.status)).toEqual(["applied", "applied"]);
    expect((await tripOf(sc.tripId)).status).toBe("active");
    const plan = await planOf(sc.tripId);
    expect(plan).toMatchObject({ state: "accepted", agreement: "within_tolerance" });
    expect((await stock(prodA.id, sc.truckId)).available).toBe(31);
    const [closed] = await h.db`select status,variance_status from stock_transfers where id=${doc.id}`;
    expect(closed).toEqual({ status: "closed", variance_status: "auto_accepted" });
    const [line] = await h.db`select expected_base::text,actual_base::text,discrepancy_reason from van_trip_load_lines where trip_id=${sc.tripId}`;
    expect(line).toEqual({ expected_base: "36", actual_base: "31", discrepancy_reason: "short_loaded" });
  });

  it("one case short is above the allowed difference: the clerk recounts on their own device, they agree, no supervisor, and the van leaves", async () => {
    const sc = await scenario();
    await toDispatched(sc.tripId);
    const loadId = await loadIdOf(sc.tripId);
    const r = await push([op("load.accept", { tripId: sc.tripId, loadId, lines: [{ productId: prodA.id, actualBase: "12", reason: "short_loaded" }] })]);
    expect(r.body.results[0].status).toBe("applied");
    expect((await planOf(sc.tripId)).state).toBe("recount");
    expect((await tripOf(sc.tripId)).status).toBe("loading");
    // Not yet: the phone cannot start, and the clerk's recount is what is awaited.
    const early = await push([op("trip.start", { tripId: sc.tripId, vehicleConfirmed: true, routeConfirmed: true })]);
    expect(early.body.results[0]).toMatchObject({ status: "rejected", code: "load_not_posted" });
    const waiting = await pull(true);
    expect(waiting.vanDay.load).toMatchObject({ state: "recount", waitingForClerk: true, canAccept: false });
    const board = await read(boss, `day-board?date=${today()}`);
    expect(board.body.rows.find((/** @type {any} */ x) => x.tripId === sc.tripId)).toMatchObject({ load: { state: "difference", label: "Difference" }, primary: { kind: "recount" } });
    // The seller cannot send a second count while the clerk is to recount.
    const twice = await push([op("load.accept", { tripId: sc.tripId, loadId, lines: [{ productId: prodA.id, actualBase: "24" }] })]);
    expect(twice.body.results[0].status).toBe("rejected");

    const agree = await web(clerk, "loads/recount", { tripId: sc.tripId, agree: true });
    expect(agree.status).toBe(200);
    expect(agree.body).toMatchObject({ state: "accepted", agreement: "both_agreed" });
    const plan = await planOf(sc.tripId);
    expect(plan).toMatchObject({ state: "accepted", agreement: "both_agreed" });
    expect(plan.seller_signed_at && plan.clerk_signed_at).toBeTruthy();
    expect((await tripOf(sc.tripId)).status).toBe("loaded");
    expect((await stock(prodA.id, sc.truckId)).available).toBe(12);
    const [res] = await h.db`select r.decided_by,r.charge_to,r.auto,r.short_base::int as short_base,r.short_reason_code from stock_transfer_resolutions r join van_planned_loads p on p.stock_transfer_id=r.transfer_id where p.trip_id=${sc.tripId}`;
    expect(res).toMatchObject({ decided_by: clerk.userId, charge_to: "dispatch_side", auto: false, short_base: 12, short_reason_code: "SHORT-PICK" });
    expect((await push([op("trip.start", { tripId: sc.tripId, vehicleConfirmed: true, routeConfirmed: true })])).body.results[0].status).toBe("applied");
    const counts = await h.db`select side,round from van_load_counts where planned_load_id=${plan.id} order by side`;
    expect(counts).toEqual([{ side: "clerk", round: 1 }, { side: "seller", round: 1 }]);
  });

  it("when clerk and seller disagree it goes to Decide on the existing load-difference approval; the supervisor posts the seller's count", async () => {
    const sc = await scenario();
    await toDispatched(sc.tripId);
    const loadId = await loadIdOf(sc.tripId);
    await push([op("load.accept", { tripId: sc.tripId, loadId, lines: [{ productId: prodA.id, actualBase: "12", reason: "short_loaded" }] })]);
    const same = await web(clerk, "loads/recount", { tripId: sc.tripId, lines: [{ productId: prodA.id, countedBase: 24 }] });
    expect(same.body.state).toBe("disputed");
    expect((await planOf(sc.tripId)).state).toBe("disputed");
    const queue = await read(boss, "load-differences");
    const item = queue.body.items.find((/** @type {any} */ i) => i.tripId === sc.tripId);
    expect(item).toBeTruthy();
    // The clerk cannot decide it (no van.load.approve); the seller's own trip is not theirs to approve.
    expect((await web(clerk, "loads/approve", { tripId: sc.tripId, decision: "approve" })).status).toBe(403);
    const decided = await web(boss, "loads/approve", { tripId: sc.tripId, decision: "approve", basis: "seller", note: "Seller counted twice" });
    expect(decided.status).toBe(200);
    expect((await tripOf(sc.tripId)).status).toBe("loaded");
    expect((await stock(prodA.id, sc.truckId)).available).toBe(12);
    const [res] = await h.db`select r.decided_by,r.charge_to from stock_transfer_resolutions r join van_planned_loads p on p.stock_transfer_id=r.transfer_id where p.trip_id=${sc.tripId}`;
    expect(res).toEqual({ decided_by: boss.userId, charge_to: "dispatch_side" });
    expect((await planOf(sc.tripId)).agreement).toBe("supervisor");
  });

  it("a supervisor can send a disputed load back; both count again as round 2 and a clean count is accepted", async () => {
    const sc = await scenario();
    await toDispatched(sc.tripId);
    const loadId = await loadIdOf(sc.tripId);
    await push([op("load.accept", { tripId: sc.tripId, loadId, lines: [{ productId: prodA.id, actualBase: "12", reason: "short_loaded" }] })]);
    await web(clerk, "loads/recount", { tripId: sc.tripId, lines: [{ productId: prodA.id, countedBase: 24 }] });
    expect((await web(boss, "loads/approve", { tripId: sc.tripId, decision: "reject", note: "Count the pallet together" })).status).toBe(200);
    expect((await planOf(sc.tripId)).state).toBe("dispatched");
    const phone = await pull(true);
    expect(phone.load.rejectionNote).toBeUndefined(); // old fields unchanged without params.handheld
    expect(phone.vanDay.load).toMatchObject({ state: "dispatched", canAccept: true });
    const r = await push([op("load.accept", { tripId: sc.tripId, loadId, lines: [{ productId: prodA.id, actualBase: "24" }] })]);
    expect(r.body.results[0].status).toBe("applied");
    expect((await planOf(sc.tripId)).state).toBe("accepted");
    expect((await stock(prodA.id, sc.truckId)).available).toBe(24);
    expect((await h.db`select round from van_load_counts where planned_load_id=${(await planOf(sc.tripId)).id} and side='seller' order by round`).map((/** @type {any} */ x) => x.round)).toEqual([1, 2]);
  });

  it("the old confirm-load op is refused on a documented load; the old manual load replaces a suggestion", async () => {
    const sc = await scenario();
    await toDispatched(sc.tripId);
    const loadId = await loadIdOf(sc.tripId);
    const legacy = await push([op("load.confirm", { tripId: sc.tripId, loadId, lines: [{ lineNumber: 1, actualBase: "24" }] })]);
    expect(legacy.body.results[0].status).toBe("rejected");
    const sc2 = await scenario();
    const manual = await web(boss, "loads/plan", { tripId: sc2.tripId, lines: [{ productId: prodA.id, expectedBase: "12" }] });
    expect(manual.status).toBe(200);
    expect(await planOf(sc2.tripId)).toBeUndefined();
  });

  it("change before dispatch makes a new document and frees the old reservation; cancelling the trip frees the rest", async () => {
    const sc = await scenario();
    const before = await stock(prodA.id, depot);
    await web(boss, "loads/approve-plan", { tripId: sc.tripId });
    expect((await stock(prodA.id, depot)).reserved - before.reserved).toBe(24);
    const am = await web(boss, "loads/amend", { tripId: sc.tripId, lines: [{ productId: prodA.id, quantityBase: 48 }] });
    expect(am.status).toBe(200);
    expect((await stock(prodA.id, depot)).reserved - before.reserved).toBe(48);
    const docs = await h.db`select status from stock_transfers where source_ref=${`van_trip:${sc.tripId}`} order by created_at`;
    expect(docs.map((/** @type {any} */ d) => d.status)).toEqual(["cancelled", "approved"]);
    const c = await web(boss, "trips/cancel", { tripId: sc.tripId, reason: "Truck broke down" });
    expect(c.status).toBe(200);
    expect((await stock(prodA.id, depot)).reserved - before.reserved).toBe(0);
    expect((await h.db`select state from van_planned_loads where trip_id=${sc.tripId}`)[0].state).toBe("cancelled");
  });
});

/** The key the phone derives from a PIN, and the proof it signs the switch with. @param {string} pin @param {string} salt */
const keyOf = (pin, salt) => pbkdf2Sync(pin, salt, 160000, 32, "sha256").toString("hex");
/** An offline `crew.switch` op, signed the way the phone signs it. @param {string} tripId @param {string} toProfileId @param {string} pin */
async function switchOp(tripId, toProfileId, pin) {
  const [k] = await h.db`select id,pin_salt from van_crew_pins where profile_id=${toProfileId} and effective_to is null`;
  const o = op("crew.switch", { tripId, toProfileId, pinId: k.id, proof: "" });
  o.payload.proof = crewProof(keyOf(pin, k.pin_salt), { deviceId: who.deviceId, tripId, toProfileId, pinId: k.id, at: o.clientTime });
  return o;
}

describe("crew on the truck's phone", () => {
  it("a helper takes over the phone with their own PIN: no revocation, no 'Phone removed', who-is-on-it is recorded, and a helper cannot close the trip", async () => {
    const sc = await scenario();
    await toDispatched(sc.tripId);
    const loadId = await loadIdOf(sc.tripId);
    expect((await push([op("load.accept", { tripId: sc.tripId, loadId, lines: [{ productId: prodA.id, actualBase: "24" }] }), op("trip.start", { tripId: sc.tripId, vehicleConfirmed: true, routeConfirmed: true })])).body.results.map((/** @type {any} */ r) => r.status)).toEqual(["applied", "applied"]);
    // The office gives each person their own PIN (6-12 digits); a short one is refused in plain words.
    expect(msg(await web(boss, "crew/pin", { profileId: helper.profileId, pin: "1234" }))).toBe("Use a PIN of 6 to 12 digits");
    expect((await web(boss, "crew/pin", { profileId: helper.profileId, pin: "482915" })).status).toBe(200);
    expect((await web(boss, "crew/pin", { profileId: who.profile.id, pin: "730216" })).status).toBe(200);
    const [before] = await h.db`select status,profile_id,bound_subject,credential_id from registered_devices where id=${who.deviceId}`;

    const toHelper = await switchOp(sc.tripId, helper.profileId, "482915");
    expect((await push([toHelper])).body.results[0].status).toBe("applied");
    const [live] = await h.db`select s.profile_id,s.role,s.method,s.ended_at from van_crew_sessions s where s.device_id=${who.deviceId} and s.ended_at is null`;
    expect(live).toMatchObject({ profile_id: helper.profileId, role: "helper", method: "pin_offline" });
    // The phone itself is exactly as it was: same owner, still active, still bound. Nothing was revoked.
    const [after] = await h.db`select status,profile_id,bound_subject,credential_id from registered_devices where id=${who.deviceId}`;
    expect(after).toEqual(before);
    expect(after.status).toBe("active");
    const b = await pull(true); // and it still downloads its bundle
    expect(b.vanDay.crew.onDevice).toMatchObject({ name: "Hana Helper", role: "helper" });
    expect(b.vanDay.crew.members.find((/** @type {any} */ m) => m.role === "helper").pinId).toBeTruthy();
    expect(b.vanDay.crew.members.find((/** @type {any} */ m) => m.role === "helper").hash).toMatch(/^[a-f0-9]{64}$/);

    // A wrong PIN proof, and a person who is not on this trip's crew, are refused.
    const [k] = await h.db`select id,pin_salt from van_crew_pins where profile_id=${helper.profileId} and effective_to is null`;
    const bad = op("crew.switch", { tripId: sc.tripId, toProfileId: helper.profileId, pinId: k.id, proof: "a".repeat(64) });
    expect((await push([bad])).body.results[0].status).toBe("rejected");
    expect((await push([op("crew.switch", { tripId: sc.tripId, toProfileId: helper2.profileId, pinId: k.id, proof: "a".repeat(64) })])).body.results[0].status).toBe("rejected");

    // Helpers sell and collect but do not close the trip.
    const closing = await push([op("trip.close", { tripId: sc.tripId })]);
    expect(closing.body.results[0].status).toBe("rejected");

    // Back to the seller. The person whose PIN signs a switch is the one acting: the helper took the phone, then the seller took it back.
    const back = await switchOp(sc.tripId, who.profile.id, "730216");
    expect((await push([back])).body.results[0].status).toBe("applied");
    const acts = await h.db`select a.op_type,a.profile_id from van_crew_actions a where a.trip_id=${sc.tripId} and a.op_type='crew.switch' order by a.occurred_at`;
    expect(acts.map((/** @type {any} */ a) => a.profile_id)).toEqual([helper.profileId, who.profile.id]);
    const history = await read(boss, `crew?tripId=${sc.tripId}`);
    expect(history.body.sessions.map((/** @type {any} */ s) => s.name)).toEqual(["Hana Helper", "Sam Seller"]);
    expect(history.body.crew.map((/** @type {any} */ c) => [c.role, c.hasPin])).toEqual([["seller", true], ["helper", true]]);
    expect((await tripOf(sc.tripId)).salesperson_profile_id).toBe(who.profile.id); // the seller stays accountable
    // Same op again is a replay, not a second session.
    expect((await push([back])).body.results[0].status).toBe("duplicate");
  });

  it("online PINs: right PIN switches, five wrong ones lock that person for ten minutes, and strangers cannot spend tries", async () => {
    const { verifyCrewPinOnline } = await import("../src/domains/van/roster.js");
    expect(await verifyCrewPinOnline(h.db, helper.profileId, "482915")).toBe(true);
    for (let i = 0; i < 5; i++)
      await expect(verifyCrewPinOnline(h.db, helper.profileId, "000000")).rejects.toThrow("That PIN was not accepted");
    await expect(verifyCrewPinOnline(h.db, helper.profileId, "482915")).rejects.toThrow("Too many wrong PINs");
    await h.db`delete from van_crew_pin_attempts where profile_id=${helper.profileId}`;
    // The route needs a signed-in person before it counts a try.
    const res = await h.fetch("/api/v1/van/crew-sessions", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "k1" }, body: JSON.stringify({ toProfileId: helper.profileId, pin: "000000" }) });
    expect(res.status).toBe(401);
    expect((await h.db`select count(*)::int as n from van_crew_pin_attempts where profile_id=${helper.profileId}`)[0].n).toBe(0);
    // Someone who is not the phone's owner cannot take it over from their own login; the office can.
    const sc = await scenario();
    const mine = await web(helper, "crew-sessions", { deviceId: who.deviceId, tripId: sc.tripId, toProfileId: helper.profileId, pin: "482915" });
    expect(mine.status).toBe(403);
    const office = await web(boss, "crew-sessions", { deviceId: who.deviceId, tripId: sc.tripId, toProfileId: helper.profileId, office: true });
    expect(office.status).toBe(200);
    expect((await h.db`select profile_id,method from van_crew_sessions where device_id=${who.deviceId} and ended_at is null`)[0]).toMatchObject({ profile_id: helper.profileId, method: "office" });
    const [d] = await h.db`select status from registered_devices where id=${who.deviceId}`;
    expect(d.status).toBe("active");
  });

  it("a phone belongs to a truck: bind, replace, unbind, and the bundle names the truck; the crew switch needs no new binding", async () => {
    const sc = await scenario();
    const sc2 = await scenario();
    const noDevice = await web(boss, "devices/bind", { vehicleId: sc.vehicleId, deviceId: crypto.randomUUID() });
    expect(noDevice.status).toBe(422);
    expect(msg(noDevice)).toBe("Choose a van phone that is set up and working");
    expect((await web(boss, "devices/bind", { vehicleId: sc.vehicleId, deviceId: who.deviceId })).status).toBe(200);
    expect((await pull(true)).vanDay.device.vehicle).toMatchObject({ vehicleId: sc.vehicleId });
    expect((await web(boss, "devices/bind", { vehicleId: sc.vehicleId, deviceId: who.deviceId })).body.unchanged).toBe(true);
    expect((await web(boss, "devices/bind", { vehicleId: sc2.vehicleId, deviceId: who.deviceId })).status).toBe(200);
    expect((await h.db`select vehicle_id from van_device_bindings where device_id=${who.deviceId} and released_at is null`).map((/** @type {any} */ r) => r.vehicle_id)).toEqual([sc2.vehicleId]);
    expect((await web(boss, "devices/unbind", { deviceId: who.deviceId })).status).toBe(200);
    expect((await pull(true)).vanDay.device.vehicle).toBeNull();
    expect(msg(await web(boss, "devices/unbind", { deviceId: who.deviceId }))).toBe("That phone is not on a truck");
  });

  it("a supervisor hands the trip to another person: the new seller is accountable, the old phone's operations are refused", async () => {
    const sc = await scenario();
    await toDispatched(sc.tripId);
    const loadId = await loadIdOf(sc.tripId);
    await push([op("load.accept", { tripId: sc.tripId, loadId, lines: [{ productId: prodA.id, actualBase: "24" }] }), op("trip.start", { tripId: sc.tripId, vehicleConfirmed: true, routeConfirmed: true })]);
    expect((await web(helper, "trips/handover", { tripId: sc.tripId, toProfileId: helper2.profileId, reason: "Sick" })).status).toBe(403);
    const done = await web(boss, "trips/handover", { tripId: sc.tripId, toProfileId: helper2.profileId, reason: "Seller is sick" });
    expect(done.status).toBe(200);
    expect((await tripOf(sc.tripId)).salesperson_profile_id).toBe(helper2.profileId);
    expect((await h.db`select profile_id,role from van_trip_crew where trip_id=${sc.tripId} and ended_at is null order by role`).map((/** @type {any} */ c) => `${c.role}`)).toContain("seller");
    const blocked = await push([op("crew.switch", { tripId: sc.tripId, toProfileId: helper.profileId, pinId: crypto.randomUUID(), proof: "a".repeat(64) })]);
    expect(blocked.res.status !== 200 || blocked.body.results[0].status === "rejected").toBe(true); // the old phone is not this trip's phone any more
    expect((await h.db`select details from van_audit_events where trip_id=${sc.tripId} and kind='van.trip.handed_over'`)).toHaveLength(1);
  });
});

describe("the van day board", () => {
  it("shows every rostered truck with load status, trip status, cash and one primary action, in plain words", async () => {
    const sc = await scenario();
    // A second rostered truck with no trip yet.
    const [truck] = await h.db`insert into inventory_locations (organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values ('sunpride',${unit},'CEBU','TRK-BRD','Truck B','truck',true,false,true,true,false) returning id`;
    const [v] = await h.db`insert into vehicles(organization_id,org_unit_id,vehicle_code,plate_number,name,truck_location_id,home_location_id,status,created_by) values('sunpride',${unit},'VANBRD','BRD 777','Van B',${truck.id},${depot},'active','fixture') returning id`;
    expect((await web(boss, "rosters/save", { vehicleId: v.id, routeId: routeB, sellerProfileId: helper2.profileId, weekdays: [1, 2, 3, 4, 5, 6, 7], effectiveFrom: today() })).status).toBe(200);
    const row = async () => (await read(boss, `day-board?date=${today()}`)).body;
    const find = (/** @type {any} */ b) => b.rows.find((/** @type {any} */ r) => r.tripId === sc.tripId);
    let b = await row();
    expect(b.rows.find((/** @type {any} */ r) => r.vehicleCode === "VANBRD")).toMatchObject({ trip: { label: "No trip yet" }, primary: { kind: "plan_trip", label: "Plan trip" } });
    expect(b.summary.text).toMatch(/^\d+ trips planned, \d+ need attention$/);
    expect(find(b)).toMatchObject({ load: { state: "suggested", label: "Suggested", products: 1, totalBase: 24 }, trip: { label: "Planned", stage: "planned" }, primary: { kind: "approve_load" }, sellerName: "Sam Seller" });
    await web(boss, "loads/approve-plan", { tripIds: [sc.tripId] });
    expect(find(await row())).toMatchObject({ load: { state: "approved" }, primary: { kind: "pick", label: "Start picking" } });
    await web(clerk, "loads/pick", { tripId: sc.tripId });
    expect(find(await row()).primary.kind).toBe("dispatch");
    await web(clerk, "loads/dispatch", { tripId: sc.tripId });
    expect(find(await row())).toMatchObject({ load: { state: "dispatched", number: expect.stringMatching(/^LOAD-/) }, primary: { kind: "wait_seller", enabled: false } });
    const loadId = await loadIdOf(sc.tripId);
    await push([op("load.accept", { tripId: sc.tripId, loadId, lines: [{ productId: prodA.id, actualBase: "24" }] })]);
    expect(find(await row())).toMatchObject({ load: { state: "accepted", label: "Accepted" }, trip: { label: "Loaded", stage: "loaded" }, primary: { kind: "wait_start" } });
    await push([op("trip.start", { tripId: sc.tripId, vehicleConfirmed: true, routeConfirmed: true, openingFloatCentavos: 200000 })]);
    const on = find(await row());
    expect(on).toMatchObject({ trip: { label: "On route", stage: "on_route" }, primary: { kind: "view_trip" }, cash: { expectedCentavos: 200000, salesCentavos: 0 }, settlement: { label: "Not yet" } });
    expect(on.crew.map((/** @type {any} */ c) => c.role)).toEqual(["seller", "helper"]);
    // A sales person may read the board but not plan from it.
    const hb = await read(helper, `day-board?date=${today()}`);
    expect(hb.status).toBe(200);
    expect((await web(helper, "trips/generate", { date: today() })).status).toBe(403);
  });
});
