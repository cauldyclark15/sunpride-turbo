import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  startHarness,
  profileStore,
  boundDevice,
  signedPost,
} from "./harness.js";
import { install as visits } from "../src/domains/visits/index.js";
import { install as van } from "../src/domains/van/index.js";
import { install as callflow } from "../src/domains/callflow/index.js";
import { manilaDate } from "../src/domains/visits/shared.js";
import { rootUnitId } from "../src/domains/org/scope.js";
import {
  configuration,
  configurationsForApp,
  profileAt,
  locationResult,
  locationMissing,
  unavailableReason,
  PROFILE_FIELD,
  validateSteps,
} from "../src/domains/callflow/engine.js";
import { ensureCallflowSamples } from "../../../packages/db/seed/callflow.js";
/** @type {import("./harness.js").Harness} */ let h;
/** @type {ReturnType<typeof profileStore>} */ let profiles;
const DAY = 86400000;
const rootUnit = crypto.randomUUID();
beforeAll(async () => {
  h = await startHarness({ installers: [visits, van, callflow] });
  profiles = profileStore(h);
  h.setHooks({ rootUnitId });
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values (${rootUnit},'sunpride','SUNPRIDE','Sample national','national','active',${new Date(Date.now() - 30 * DAY)})`;
  await ensureCallflowSamples(h.db, Date.now() - DAY);
});
afterAll(async () => {
  await h?.close();
});
/** @param {any} [options] */
async function fixture(options = {}) {
  const now = Date.now(),
    day = manilaDate(now),
    early = new Date(now - 10 * 86400000),
    unit = options.unit ?? crypto.randomUUID();
  await h.db`insert into org_units (id,organization_id,code,name,type_code,status,effective_from,parent_id) values (${unit},'sunpride',${unit},'Cebu team','territory','active',${early},${unit === rootUnit ? null : rootUnit}) on conflict do nothing`;
  const d = await boundDevice(h, profiles, {
    app: options.app ?? "field-android",
    role: options.role ?? "sales",
    orgUnitId: unit,
  });
  const [position] =
    await h.db`insert into positions (organization_id,code,label,category,active) values ('sunpride',${crypto.randomUUID()},'Field specialist','field',true) returning id`;
  await h.db`insert into position_standards (organization_id,position_id,effective_from,productive_call_rule,source_ref) values ('sunpride',${position.id},${early},${options.rule ?? "any_listed_activity"},'TEST fixture')`;
  await h.db`insert into profiles (id,user_id,name,email,role,status,org_unit_id,position_id) values (${d.profile.id},${d.userId},'Field colleague',${d.email},${d.profile.role},'active',${unit},${position.id})`;
  const [employee] =
    await h.db`insert into employee_assignments (profile_id,org_unit_id,role,position_id,effective_from,actor_subject,reason)
    values (${d.profile.id},${unit},${d.profile.role},${position.id},${early},${d.userId},'Fixture') returning id`;
  const [territory] =
    await h.db`insert into territories (organization_id,code,name,status,effective_from,created_by) values ('sunpride',${crypto.randomUUID()},'Mandaue','active',${early},${d.userId}) returning id`;
  await h.db`insert into territory_ownerships (territory_id,org_unit_id,effective_from,actor_subject,reason) values (${territory.id},${unit},${early},${d.userId},'Fixture')`;
  await h.db`insert into territory_salespeople (territory_id,profile_id,effective_from,actor_subject,reason) values (${territory.id},${d.profile.id},${early},${d.userId},'Fixture')`;
  const [customer] =
    await h.db`insert into customers (code,name,channel,territory,credit_limit,active) values (${crypto.randomUUID()},'Test account','GT','Cebu',0,true) returning id`;
  const [outlet] =
    await h.db`insert into outlets (organization_id,code,name,status,custodian_org_unit_id,created_by) values ('sunpride',${crypto.randomUUID()},'Test store','active',${unit},${d.userId}) returning id`;
  await h.db`insert into outlet_assignments (outlet_id,territory_id,effective_from,actor_subject,reason) values (${outlet.id},${territory.id},${early},${d.userId},'Fixture')`;
  await h.db`insert into outlet_customer_links (outlet_id,customer_id,source,effective_from,actor_subject,reason) values (${outlet.id},${customer.id},'fixture',${early},${d.userId},'Fixture')`;
  await h.db`insert into outlet_pins (outlet_id,latitude,longitude,radius_meters,source,status,effective_from,proposed_by,proposed_at,verified_by,verified_at)
    values (${outlet.id},10.33,123.94,100,'fixture','verified',${early},'first',${early},'second',${early})`;
  const snapshot = {
    outletId: outlet.id,
    orgUnitId: unit,
    approvedAssigneeProfileId: d.profile.id,
    employeeAssignmentId: employee.id,
  };
  const [plan] =
    await h.db`insert into coverage_plans (organization_id,assignee_profile_id,local_month,version,cycle_type,org_unit_id,requested_from,requested_to,effective_from,effective_to,status,prepared_by,prepared_at,approval_signature,content_revision,created_by,updated_by)
    values ('sunpride',${d.profile.id},${day.slice(0, 7)},1,'monthly',${unit},${early},${new Date(now + DAY)},${early},${new Date(now + DAY)},'active',${d.userId},${early},'signed-fixture',1,${d.userId},${d.userId}) returning id`;
  const [slot] =
    await h.db`insert into coverage_plan_slots (slot_key,plan_id,assignee_profile_id,service_date,kind,outlet_id,intents,sequence,expected_duration_minutes,approved_snapshot,content_revision,updated_by)
    values ('one',${plan.id},${d.profile.id},${day},'outlet_visit',${outlet.id},array['merchandise'],1,30,${snapshot},1,${d.userId}) returning id`;
  const [planned] =
    await h.db`insert into planned_visits (generation_key,plan_id,plan_version,plan_slot_id,assignee_profile_id,outlet_id,service_date,status,approved_snapshot,intents,expected_duration_minutes,generated_at)
    values (${crypto.randomUUID()},${plan.id},1,${slot.id},${d.profile.id},${outlet.id},${day},'planned',${snapshot},array['merchandise'],30,${early}) returning id`;
  const [sku] =
    await h.db`insert into products (code,name,category,uom,unit_price,active,organization_id) values (${crypto.randomUUID()},'Test corned beef','Canned','PC',0,true,'sunpride') returning id`;
  return {
    d,
    unit,
    day,
    now,
    outlet: outlet.id,
    customer: customer.id,
    planned: planned.id,
    plan: plan.id,
    slot: slot.id,
    sku: sku.id,
    territory: territory.id,
    fix: {
      latitude: 10.33,
      longitude: 123.94,
      accuracyMeters: 5,
      fixTime: now,
      provider: "gps",
      mockSignal: false,
    },
  };
}

/** @param {any} f */
async function config(f) {
  return configuration(h.db, PROFILE_FIELD, { id: f.outlet }, f.now);
}
/** @param {string} type @param {any} p */
function operation(type, p) {
  return {
    clientOpId: crypto.randomUUID(),
    opType: type,
    clientTime: p.deviceTime ?? p.capturedAt,
    dependsOn: [],
    payload: p,
  };
}
/** @param {any} f @param {any[]} operations */
async function push(f, ...operations) {
  const r = await signedPost(h, f.d, "/api/sync/push", {
    version: 2,
    deviceId: f.d.deviceId,
    scopeId: f.unit,
    operations,
  });
  expect(r.res.status).toBe(200);
  return r.body.results;
}
/** @param {any} f @param {any} [changes] */
async function start(f, changes = {}) {
  const c = await config(f);
  if (!c) throw new Error("missing config");
  const op = operation("visit.checkIn", {
    clientVisitId: crypto.randomUUID(),
    plannedVisitId: f.planned,
    outletId: f.outlet,
    serviceDate: f.day,
    intents: ["merchandise"],
    deviceTime: f.now,
    location: f.fix,
    flowDefinitionId: c.definition.id,
    ...changes,
  });
  return { op, result: (await push(f, op))[0] };
}
/** @param {any} f @param {string} id @param {any} [changes] */
async function end(f, id, changes = {}) {
  const at = f.now + 1000;
  return operation("visit.checkOut", {
    visitId: id,
    outcome: "nonproductive",
    reasonCode: "no_demand",
    zeroSaleReason: "no_demand",
    shortCallReason: "Buyer asked to end the visit",
    deviceTime: at,
    location: { ...f.fix, fixTime: at },
    ...changes,
  });
}

test("F-006 F-107 configured field call uses versioned steps and exact replay", async () => {
  const f = await fixture();
  const s = await start(f);
  expect(s.result.status).toBe("applied");
  const note = operation("visit.activity", {
    visitId: s.result.ack.entityId,
    deviceTime: f.now + 1,
    activity: { kind: "note", text: "Sample call" },
  });
  expect((await push(f, note))[0].status).toBe("applied");
  const e = await end(f, s.result.ack.entityId);
  expect((await push(f, e))[0].status).toBe("applied");
  expect(
    (await push(f, s.op, note, e)).map((/** @type {any} */ r) => r.status),
  ).toEqual(["duplicate", "duplicate", "duplicate"]);
  const [c] =
    await h.db`select * from call_executions where visit_id=${s.result.ack.entityId}`;
  expect(c.state).toBe("closed");
  expect(c.definition_snapshot.channelProfile).toBe(PROFILE_FIELD);
  expect(c.zero_sale_reason.code).toBe("no_demand");
  const events =
    await h.db`select adapter from call_step_events where call_id=${c.id} order by created_at,id`;
  expect(events.map((/** @type {any} */ r) => r.adapter)).toEqual([
    "check_in",
    "note",
    "check_out",
  ]);
});
test("F-106 outside radius, mock flag, stale fix, bad accuracy and missing pin refuse without any visit", async () => {
  for (const change of [
    { latitude: 11 },
    { mockSignal: true },
    { fixTime: Date.now() - 120000 },
    { accuracyMeters: 51 },
  ]) {
    const f = await fixture();
    const s = await start(f, { location: { ...f.fix, ...change } });
    expect(s.result.status).toBe("rejected");
    expect(
      (
        await h.db`select id from visit_executions where assignee_profile_id=${f.d.profile.id}`
      ).length,
    ).toBe(0);
  }
  const f = await fixture();
  await h.db`update outlet_pins set effective_to=now()-interval '1 second' where outlet_id=${f.outlet}`;
  expect((await start(f)).result.status).toBe("rejected");
});
test("FLD-080 a Start and End with NO location fix are recorded for supervisor review, not refused", async () => {
  const f = await fixture();
  const s = await start(f, {
    location: null,
    locationUnavailable: "location_off",
  });
  expect(s.result.status).toBe("applied");
  const id = s.result.ack.entityId;
  const e = await end(f, id, { location: null });
  expect((await push(f, e))[0].status).toBe("applied");
  const evidence =
    await h.db`select event,result,review_status from visit_location_evidence where visit_id=${id} order by event`;
  expect(
    evidence.map((/** @type {any} */ r) => [r.event, r.result, r.review_status]),
  ).toEqual([
    ["check_in", "unavailable", "pending_review"],
    ["check_out", "unavailable", "pending_review"],
  ]);
  const [c] =
    await h.db`select state from call_executions where visit_id=${id}`;
  expect(c.state).toBe("closed");
  // A mock fix is still refused, and a no-fix start on an integrity-blocked phone is too.
  const g = await fixture();
  expect(
    (await start(g, { location: { ...g.fix, mockSignal: true } })).result
      .status,
  ).toBe("rejected");
  expect(locationMissing({ device: { integrity_blocked: true } }, null)).toBe(
    false,
  );
  expect(locationMissing({ device: {} }, undefined)).toBe(true);
  expect(locationMissing({ device: {} }, g.fix)).toBe(false);
  expect(unavailableReason("location_off")).toBe(
    "Location unavailable · supervisor will review: phone location turned off",
  );
  expect(unavailableReason("<script>")).toBe(
    "Location unavailable · supervisor will review: no location fix",
  );
});
test("F-106 server refuses a configured flow with omitted or wrong definition, not a legacy bypass", async () => {
  const f = await fixture();
  expect((await start(f, { flowDefinitionId: null })).result.code).toBe(
    "invalid_plan",
  );
  expect(
    (await start(f, { flowDefinitionId: crypto.randomUUID() })).result.code,
  ).toBe("invalid_plan");
});
test("F-120 no-order closes require a snapshotted controlled reason for every outcome", async () => {
  const f = await fixture();
  const s = await start(f);
  const id = s.result.ack.entityId;
  for (const reason of [null, "invented", "draft_is_not_an_order"])
    expect(
      (await push(f, await end(f, id, { zeroSaleReason: reason })))[0].status,
    ).toBe("rejected");
  expect((await push(f, await end(f, id)))[0].status).toBe("applied");
});
// agent1 SMP-C0293: a merchandiser call is execution-only (no order, no no-order reason list to pick from), so its
// End is accepted without a no-order reason; a selling call still needs one.
test("merchandiser call ends without a no-order reason; a selling call still needs one", async () => {
  const f = await fixture();
  const s = await start(f);
  const id = s.result.ack.entityId;
  await h.db`update call_executions set definition_snapshot=definition_snapshot || ${{ channelProfile: "merchandiser" }}::jsonb,
    reasons_snapshot='[]'::jsonb where visit_id=${id} or id::text=${id}`;
  expect(
    (await push(f, await end(f, id, { zeroSaleReason: null })))[0].status,
  ).toBe("applied");
});
test("F-207 class dwell is frozen at start; short calls require a reason and independent review", async () => {
  const f = await fixture();
  const s = await start(f),
    id = s.result.ack.entityId;
  expect(
    (await push(f, await end(f, id, { shortCallReason: null })))[0].status,
  ).toBe("rejected");
  expect((await push(f, await end(f, id)))[0].status).toBe("applied");
  const rows =
    await h.db`select r.* from call_flow_reviews r join call_executions c on c.id=r.call_id where c.visit_id=${id} and r.kind='short_call'`;
  expect(rows.length).toBe(1);
  const res = await h.fetch("/api/v1/callflow/reviews/decide", {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.d.access}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      reviewId: rows[0].id,
      decision: "approve",
      reason: "Own call",
    }),
  });
  expect(res.status).toBe(403);
});
test("F-204 sequence deviation keeps the original planned stop and creates a separate reasoned event", async () => {
  const f = await fixture();
  await h.db`update coverage_plan_slots set sequence=2 where id=${f.slot}`;
  const [slot] =
    await h.db`insert into coverage_plan_slots(slot_key,plan_id,assignee_profile_id,service_date,kind,outlet_id,intents,sequence,expected_duration_minutes,approved_snapshot,content_revision,updated_by)
 select 'earlier',plan_id,assignee_profile_id,service_date,kind,outlet_id,intents,1,expected_duration_minutes,approved_snapshot,content_revision,updated_by from coverage_plan_slots where id=${f.slot} returning id`;
  await h.db`insert into planned_visits(generation_key,plan_id,plan_version,plan_slot_id,assignee_profile_id,outlet_id,service_date,status,approved_snapshot,intents,expected_duration_minutes,generated_at)
 select ${crypto.randomUUID()},plan_id,plan_version,${slot.id},assignee_profile_id,outlet_id,service_date,status,approved_snapshot,intents,expected_duration_minutes,generated_at from planned_visits where id=${f.planned}`;
  expect((await start(f)).result.code).toBe("mcp_order");
  const s = await start(f, { sequenceReason: "Buyer appointment first" });
  expect(s.result.status).toBe("applied");
  const [c] =
    await h.db`select * from call_executions where visit_id=${s.result.ack.entityId}`;
  expect(c.source).toBe("deviated");
  expect(c.planned_visit_id).toBe(f.planned);
  expect(c.planned_sequence).toBe(2);
  expect(c.deviation_reason).toBe("Buyer appointment first");
});
test("F-205 unplanned source remains separate and needs a reason", async () => {
  const f = await fixture();
  const s = await start(f, {
    plannedVisitId: null,
    unplannedReason: "Requested by supervisor",
  });
  expect(s.result.status).toBe("applied");
  const [c] =
    await h.db`select * from call_executions where visit_id=${s.result.ack.entityId}`;
  expect(c.source).toBe("unplanned");
  expect(c.planned_visit_id).toBe(null);
});
/** @param {any} f @param {string} path @param {any} body */
async function webCall(f, path, body) {
  const res = await h.fetch(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.d.access}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
test("F-106 outside exception is separately approved before capture and consumed once", async () => {
  const f = await fixture();
  const supervisor = await fixture({ role: "super_admin", unit: f.unit });
  const request = await webCall(f, "/api/v1/callflow/geofence/request", {
    deviceId: f.d.deviceId,
    outletId: f.outlet,
    kind: "geofence_start",
    reason: "Construction blocks the store entrance",
  });
  expect(request.status).toBe(200);
  expect(
    (
      await webCall(f, "/api/v1/callflow/reviews/decide", {
        reviewId: request.body.id,
        decision: "approve",
        reason: "Own exception",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await webCall(supervisor, "/api/v1/callflow/reviews/decide", {
        reviewId: request.body.id,
        decision: "approve",
        reason: "Entrance closure verified",
      })
    ).status,
  ).toBe(200);
  const at = Date.now();
  const location = { ...f.fix, latitude: 11, fixTime: at };
  const accepted = await start(f, {
    deviceTime: at,
    location,
    geofenceApprovalId: request.body.id,
  });
  expect(accepted.result.status).toBe("applied");
  const [r] =
    await h.db`select * from call_flow_reviews where id=${request.body.id}`;
  expect(r.consumed_by).not.toBe(null);
  expect((await push(f, accepted.op))[0].status).toBe("duplicate");
});
test("FLD-084 unplanned outside-radius start waits for a supervisor approval, then starts", async () => {
  const f = await fixture();
  const supervisor = await fixture({ role: "super_admin", unit: f.unit });
  const at = Date.now();
  const location = { ...f.fix, latitude: 11, fixTime: at };
  const unplanned = {
    plannedVisitId: null,
    unplannedReason: "Owner asked for a delivery check",
    intents: ["sell"],
    deviceTime: at,
    location,
  };
  // A reason alone does not start an outside-radius call.
  expect((await start(f, unplanned)).result.status).not.toBe("applied");
  const request = await webCall(f, "/api/v1/callflow/geofence/request", {
    deviceId: f.d.deviceId,
    outletId: f.outlet,
    kind: "geofence_start",
    reason: "Store entrance closed for construction",
  });
  expect(request.status).toBe(200);
  // Requested but not yet decided: still refused.
  expect(
    (await start(f, { ...unplanned, geofenceApprovalId: request.body.id }))
      .result.status,
  ).not.toBe("applied");
  expect(
    (
      await webCall(supervisor, "/api/v1/callflow/reviews/decide", {
        reviewId: request.body.id,
        decision: "approve",
        reason: "Closure confirmed by phone",
      })
    ).status,
  ).toBe(200);
  // The approval reaches the phone with the store's call flow on the next sync.
  const synced = await configuration(
    h.db,
    PROFILE_FIELD,
    { id: f.outlet },
    Date.now(),
    { profileId: f.d.profile.id, deviceId: f.d.deviceId },
  );
  expect(
    synced.geofenceApprovals.some(
      (/** @type {any} */ g) =>
        g.id === request.body.id && g.kind === "geofence_start",
    ),
  ).toBe(true);
  const later = Date.now();
  const accepted = await start(f, {
    ...unplanned,
    deviceTime: later,
    location: { ...location, fixTime: later },
    geofenceApprovalId: request.body.id,
  });
  expect(accepted.result.status).toBe("applied");
  const [c] =
    await h.db`select * from call_executions where visit_id=${accepted.result.ack.entityId}`;
  expect(c.source).toBe("unplanned");
  expect(c.unplanned_reason).toBe("Owner asked for a delivery check");
  const [r] =
    await h.db`select * from call_flow_reviews where id=${request.body.id}`;
  expect(r.consumed_by).toBe(c.id);
});
test("F-107 F-120 F-205 van calls run the same engine through signed API operations", async () => {
  const f = await fixture({ app: "van-android" });
  const trip = crypto.randomUUID(),
    vehicle = crypto.randomUUID(),
    truck = crypto.randomUUID(),
    depot = crypto.randomUUID();
  for (const [id, type] of [
    [truck, "truck"],
    [depot, "warehouse"],
  ])
    await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production)
      values (${id},'sunpride',${f.unit},'CEBU',${id},'Sample location',${type},true,true,true,true,false)`;
  await h.db`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by)
    values (${vehicle},'sunpride',${f.unit},${vehicle},'SAMPLE',${truck},${depot},'active','fixture')`;
  await h.db`insert into van_trips(id,organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,started_at,started_device_id,created_by)
 values (${trip},'sunpride',${f.unit},${trip},${vehicle},${truck},${depot},${f.day},${f.d.profile.id},${f.d.userId},'active',now(),null,'fixture')`;
  const route = crypto.randomUUID(),
    offRoute = crypto.randomUUID(),
    early = new Date(f.now - DAY);
  for (const id of [route, offRoute]) {
    await h.db`insert into routes(id,organization_id,code,name,status,effective_from,created_by) values (${id},'sunpride',${id},'Sample route','active',${early},'fixture')`;
    await h.db`insert into route_territories(route_id,territory_id,effective_from,actor_subject,reason) values (${id},${f.territory},${early},'fixture','Sample route')`;
  }
  await h.db`update van_trips set route_id=${route} where id=${trip}`;
  await h.db`update outlet_assignments set route_id=${offRoute},sequence=1 where outlet_id=${f.outlet}`;
  const bundle = await signedPost(h, f.d, "/api/sync/pull", {
    version: 2,
    app: "van-android",
    deviceId: f.d.deviceId,
    since: null,
    pageCursor: null,
    scopes: [
      {
        scopeId: f.unit,
        projection: "van.bundle",
        params: { serviceDate: f.day },
      },
    ],
    limit: 100,
  });
  expect(bundle.res.status).toBe(200);
  const offered = bundle.body.bundles[0].data.customers.find(
    (/** @type {any} */ o) => o.outletId === f.outlet,
  );
  expect(offered?.source).toBe("unplanned");
  expect(offered?.callFlow.definition.channelProfile).toBe("van_selling");
  const c = await configuration(h.db, "van_selling", { id: f.outlet }, f.now);
  if (!c) throw new Error("No van definition");
  const clientCallId = crypto.randomUUID();
  const s = operation("call.start", {
    tripId: trip,
    clientCallId,
    outletId: f.outlet,
    flowDefinitionId: c.definition.id,
    deviceTime: f.now,
    location: f.fix,
    unplannedReason: "Sample outlet visit",
  });
  expect((await push(f, s))[0].status).toBe("applied");
  // Sample active trips may be unbound, as canonical van access already permits; a different bound device still refuses.
  const another = await fixture({ app: "van-android", unit: f.unit });
  await h.db`update van_trips set started_device_id=${another.d.deviceId} where id=${trip}`;
  expect(
    (
      await push(
        f,
        operation("call.step", {
          tripId: trip,
          clientCallId,
          adapter: "stock_check",
          observation: "Must refuse",
          deviceTime: f.now + 1,
        }),
      )
    )[0].status,
  ).toBe("rejected");
  await h.db`update van_trips set started_device_id=null where id=${trip}`;
  const check = operation("call.step", {
    tripId: trip,
    clientCallId,
    adapter: "stock_check",
    observation: "Shelf counted",
    deviceTime: f.now + 1,
  });
  expect((await push(f, check))[0].status).toBe("applied");
  const missingPhoto = operation("call.step", {
    tripId: trip,
    clientCallId,
    adapter: "evidence",
    photoSha256: "0".repeat(64),
    deviceTime: f.now + 1,
  });
  expect((await push(f, missingPhoto))[0].status).toBe("rejected");
  const bytes = new Uint8Array([255, 216, 255, 217]),
    checksum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const claim = await signedPost(h, f.d, "/api/media/claims", {
    version: 2,
    deviceId: f.d.deviceId,
    purpose: "truck-damage",
    ownerId: trip,
    mime: "image/jpeg",
    size: bytes.length,
    sha256: checksum,
  });
  expect(claim.res.status).toBe(200);
  expect(
    (
      await fetch(claim.body.uploadUrl, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${claim.body.uploadToken}`,
          "content-type": "image/jpeg",
        },
        body: bytes,
      })
    ).status,
  ).toBe(200);
  const evidence = operation("call.step", {
    tripId: trip,
    clientCallId,
    adapter: "evidence",
    photoSha256: checksum,
    deviceTime: f.now + 1,
  });
  expect((await push(f, evidence))[0].status).toBe("applied");
  expect((await push(f, evidence))[0].status).toBe("duplicate");
  const out = operation("call.close", {
    tripId: trip,
    clientCallId,
    deviceTime: f.now + 2,
    location: { ...f.fix, fixTime: f.now + 2 },
    shortCallReason: "Buyer unavailable",
  });
  expect((await push(f, out))[0].status).toBe("rejected");
  const close = operation("call.close", {
    ...out.payload,
    zeroSaleReason: "buyer_unavailable",
  });
  expect((await push(f, close))[0].status).toBe("applied");
  expect(
    (await push(f, s, check, close)).map((/** @type {any} */ r) => r.status),
  ).toEqual(["duplicate", "duplicate", "duplicate"]);
  const [call] =
    await h.db`select * from call_executions where client_call_id=${clientCallId}`;
  expect(call.definition_snapshot.channelProfile).toBe("van_selling");
  expect(call.state).toBe("closed");
  expect(call.zero_sale_reason.code).toBe("buyer_unavailable");
  // FLD-080: a van call with NO fix starts and is filed for supervisor review; the review can never be an approval.
  const noFixId = crypto.randomUUID();
  const noFix = operation("call.start", {
    ...s.payload,
    clientCallId: noFixId,
    deviceTime: f.now + 3,
    location: null,
    locationUnavailable: "no_signal",
  });
  expect((await push(f, noFix))[0].status).toBe("applied");
  const [open] =
    await h.db`select id from call_executions where client_call_id=${noFixId}`;
  const filed =
    await h.db`select kind,reason,consumed_by from call_flow_reviews where call_id=${open.id}`;
  expect(
    filed.map((/** @type {any} */ r) => [r.kind, r.reason, r.consumed_by]),
  ).toContainEqual([
    "geofence_start",
    "Location unavailable · supervisor will review: no signal",
    open.id,
  ]);
});

test("F-107 definition grammar supports later channel adapters without executable conditions", () => {
  const steps = [
    {
      key: "in",
      adapter: "check_in",
      label: "Check in",
      required: true,
      condition: "always",
    },
    {
      key: "planogram",
      adapter: "planogram",
      label: "Planogram",
      required: true,
      condition: "always",
    },
    {
      key: "out",
      adapter: "check_out",
      label: "Check out",
      required: true,
      condition: "always",
    },
  ];
  expect(validateSteps(steps)).toEqual(steps);
  expect(() =>
    validateSteps(steps.map((s) => ({ ...s, condition: "eval(payload)" }))),
  ).toThrow();
  expect(() => validateSteps([...steps, steps[0]])).toThrow();
  expect(() =>
    validateSteps([
      steps[0],
      steps[1],
      { ...steps[1], key: "second_planogram" },
      steps[2],
    ]),
  ).toThrow();
});
test("F-006 F-120 optional captured media still attaches after offline call close, with exact replay", async () => {
  const f = await fixture(),
    startResult = await start(f),
    visitId = startResult.result.ack.entityId;
  expect((await push(f, await end(f, visitId)))[0].status).toBe("applied");
  // Wire-media fixture only: this does not claim a CameraX/OS capture or integrity attestation.
  const bytes = new Uint8Array([255, 216, 255, 217]),
    checksum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const claim = await signedPost(h, f.d, "/api/media/claims", {
    version: 2,
    deviceId: f.d.deviceId,
    purpose: "visit-photo",
    ownerId: visitId,
    mime: "image/jpeg",
    size: bytes.length,
    sha256: checksum,
  });
  expect(claim.res.status).toBe(200);
  const upload = await fetch(claim.body.uploadUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${claim.body.uploadToken}`,
      "content-type": "image/jpeg",
    },
    body: bytes,
  });
  expect(upload.status).toBe(200);
  const blob = /** @type {any} */ (await upload.json());
  const attach = operation("evidence.attach", {
    visitId,
    blobId: blob.blobId,
    checksum,
    mime: "image/jpeg",
    size: bytes.length,
    capturedAt: f.now + 500,
    photoType: "storefront",
    source: "mobile",
  });
  expect((await push(f, attach))[0]).toMatchObject({ status: "applied" });
  expect((await push(f, attach))[0].status).toBe("duplicate");
  const events =
    await h.db`select e.id from call_step_events e join call_executions c on c.id=e.call_id where c.visit_id=${visitId} and e.adapter='evidence'`;
  expect(events.length).toBe(1);
});
test("F-006 F-207 a missing checkout cannot deadlock the next day or invent dwell/outcome", async () => {
  const f = await fixture(),
    yesterday = f.now - DAY;
  const previous = await start(f, {
    plannedVisitId: null,
    serviceDate: manilaDate(yesterday),
    deviceTime: yesterday,
    location: { ...f.fix, fixTime: yesterday },
    unplannedReason: "Sample prior-day call",
  });
  expect(previous.result.status).toBe("applied");
  const next = await start(f);
  expect(next.result.status).toBe("applied");
  const [old] =
    await h.db`select * from call_executions where visit_id=${previous.result.ack.entityId}`;
  expect(old.state).toBe("interrupted");
  expect(old.interrupted_at).not.toBe(null);
  expect(old.ended_at).toBe(null);
  expect(old.duration_ms).toBe(null);
  expect(old.zero_sale_reason).toBe(null);
  const reviews =
    await h.db`select id from call_flow_reviews where call_id=${old.id} and kind='day_boundary'`;
  expect(reviews.length).toBe(1);
  expect((await push(f, next.op))[0].status).toBe("duplicate");
  expect(
    (
      await h.db`select id from call_flow_reviews where call_id=${old.id} and kind='day_boundary'`
    ).length,
  ).toBe(1);
});
test("F-106 checkout approval uses the open call policy even after a new policy becomes effective", async () => {
  const f = await fixture(),
    admin = await fixture({ role: "super_admin", unit: f.unit }),
    old = await config(f),
    started = await start(f);
  expect(started.result.status).toBe("applied");
  const from = Date.now() + 1000;
  const publication = await webCall(admin, "/api/v1/callflow/policy/publish", {
    channelProfile: PROFILE_FIELD,
    outletClass: "*",
    radiusMeters: 100,
    maxAccuracyMeters: 50,
    maxFixAgeMs: 60000,
    minDwellMs: 180000,
    effectiveFrom: from,
  });
  expect(publication.status).toBe(200);
  await Bun.sleep(Math.max(0, from - Date.now() + 10));
  const request = await webCall(f, "/api/v1/callflow/geofence/request", {
    deviceId: f.d.deviceId,
    outletId: f.outlet,
    kind: "geofence_end",
    reason: "Store exit is blocked",
  });
  expect(request.status).toBe(200);
  const [review] =
    await h.db`select policy_id from call_flow_reviews where id=${request.body.id}`;
  expect(review.policy_id).toBe(old.policy.id);
  expect(review.policy_id).not.toBe(publication.body.id);
  expect(
    (
      await webCall(admin, "/api/v1/callflow/reviews/decide", {
        reviewId: request.body.id,
        decision: "approve",
        reason: "Exit closure verified",
      })
    ).status,
  ).toBe(200);
  const refreshed = await configuration(
    h.db,
    PROFILE_FIELD,
    { id: f.outlet },
    Date.now(),
    { profileId: f.d.profile.id, deviceId: f.d.deviceId },
  );
  expect(refreshed.policy.id).toBe(publication.body.id);
  expect(
    refreshed.geofenceApprovals.find(
      (/** @type {any} */ g) => g.id === request.body.id,
    ).policyId,
  ).toBe(old.policy.id);
  const at = Date.now();
  expect(
    (
      await push(
        f,
        await end(f, started.result.ack.entityId, {
          deviceTime: at,
          location: { ...f.fix, latitude: 11, fixTime: at },
          geofenceApprovalId: request.body.id,
        }),
      )
    )[0].status,
  ).toBe("applied");
});
test("F-106 pure radius and age checks use capture time so late offline upload is valid", () => {
  const c = {
    pin: { latitude: 10, longitude: 123 },
    policy: { radiusMeters: 100, maxAccuracyMeters: 50, maxFixAgeMs: 60000 },
  };
  const at = Date.now() - DAY,
    fix = {
      latitude: 10,
      longitude: 123,
      accuracyMeters: 5,
      fixTime: at,
      mockSignal: false,
      provider: "gps",
    };
  expect(locationResult(c, fix, at)).toBe("within_radius");
  expect(locationResult(c, fix, at, true)).toBe("unreliable");
  expect(locationResult(c, { ...fix, longitude: 124 }, at)).toBe(
    "outside_radius",
  );
});
test("F-107 publishing is prospective, versioned, audited, read back and immutable", async () => {
  const f = await fixture({ role: "super_admin" });
  const c = await config(f);
  if (!c) throw new Error("missing config");
  const from = Date.now() + 60000;
  const res = await h.fetch("/api/v1/callflow/definition/publish", {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.d.access}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      channelProfile: "future_merchandiser",
      label: "Sample future configuration",
      steps: c.definition.steps,
      effectiveFrom: from,
    }),
  });
  expect(res.status).toBe(200);
  const body = /** @type {any} */ (await res.json());
  const [row] =
    await h.db`select * from call_flow_definitions where id=${body.id}`;
  expect(row.version).toBe(1);
  expect(+new Date(row.effective_from)).toBe(from);
  expect(row.steps).toEqual(c.definition.steps);
  await expect(
    (async () =>
      await h.db`update call_flow_definitions set label='mutated' where id=${body.id}`)(),
  ).rejects.toThrow();
  expect(
    (
      await h.db`select id from audit_logs where entity_id=${body.id} and action='callflow.definition.published'`
    ).length,
  ).toBe(1);
});
test("F-107 F-301 F-310 F-407 effective channel bindings select another profile in the same field engine", async () => {
  const f = await fixture({ role: "super_admin" }),
    current = await config(f),
    at = Date.now() + 60000;
  const profile = `channel_${crypto.randomUUID().replaceAll("-", "")}`;
  const definition = await webCall(f, "/api/v1/callflow/definition/publish", {
    channelProfile: profile,
    label: "Sample channel",
    steps: current.definition.steps,
    effectiveFrom: at,
  });
  expect(definition.status).toBe(200);
  const policy = await webCall(f, "/api/v1/callflow/policy/publish", {
    channelProfile: profile,
    outletClass: "*",
    radiusMeters: 100,
    maxAccuracyMeters: 50,
    maxFixAgeMs: 60000,
    minDwellMs: 180000,
    effectiveFrom: at,
  });
  expect(policy.status).toBe(200);
  const published = await webCall(f, "/api/v1/callflow/binding/publish", {
    app: "field-android",
    channelCode: profile,
    outletClass: "*",
    channelProfile: profile,
    effectiveFrom: at,
  });
  expect(published.status).toBe(200);
  const outlet = { id: f.outlet, classification: null, channel: profile };
  expect(await profileAt(h.db, "field-android", outlet, at - 1)).toBe(
    PROFILE_FIELD,
  );
  expect(await profileAt(h.db, "field-android", outlet, at)).toBe(profile);
  expect(
    (await configurationsForApp(h.db, "field-android", [outlet], at, {})).get(
      f.outlet,
    ).definition.id,
  ).toBe(definition.body.id);
  const [stored] =
    await h.db`select * from call_flow_channel_bindings where id=${published.body.id}`;
  expect(stored.channel_profile).toBe(profile);
  await expect(
    (async () =>
      await h.db`update call_flow_channel_bindings set channel_profile='other' where id=${stored.id}`)(),
  ).rejects.toThrow();
});
test("F-107 required step adapters cannot be bypassed by a client done flag; the existing note handler advances the same engine", async () => {
  const f = await fixture(),
    key = `channel_${crypto.randomUUID().replaceAll("-", "")}`,
    early = new Date(f.now - DAY);
  const steps = [
    {
      key: "in",
      adapter: "check_in",
      label: "Start",
      required: true,
      condition: "always",
    },
    {
      key: "record",
      adapter: "note",
      label: "Observation",
      required: true,
      condition: "always",
    },
    {
      key: "out",
      adapter: "check_out",
      label: "End",
      required: true,
      condition: "always",
    },
  ];
  const [def] =
    await h.db`insert into call_flow_definitions(channel_profile,version,label,steps,effective_from,published_by) values (${key},1,'Sample required observation',${{ values: steps }}::jsonb->'values',${early},'fixture') returning id`;
  await h.db`insert into call_flow_policies(channel_profile,outlet_class,version,radius_meters,max_accuracy_meters,max_fix_age_ms,min_dwell_ms,effective_from,published_by) values (${key},'*',1,100,50,60000,180000,${early},'fixture')`;

  await h.db`update outlets set channel=${key} where id=${f.outlet}`;
  await h.db`insert into call_flow_channel_bindings(app,channel_code,outlet_class,channel_profile,version,effective_from,published_by) values ('field-android',${key},'*',${key},1,${early},'fixture')`;
  const s = await start(f, { flowDefinitionId: def.id });
  expect(s.result.status).toBe("applied");
  const id = s.result.ack.entityId;
  expect(
    (await push(f, await end(f, id, { completedSteps: ["record"] })))[0].status,
  ).toBe("rejected");
  expect(
    (
      await push(
        f,
        operation("visit.activity", {
          visitId: id,
          deviceTime: f.now + 1,
          activity: { kind: "note", text: "Actual captured observation" },
        }),
      )
    )[0].status,
  ).toBe("applied");
  expect((await push(f, await end(f, id)))[0].status).toBe("applied");
  const [call] = await h.db`select * from call_executions where visit_id=${id}`;
  expect(call.definition_snapshot.channelProfile).toBe(key);
});
test("F-205 reports keep unplanned calls apart and exclude another salesperson", async () => {
  const f = await fixture(),
    other = await fixture();
  expect(
    (
      await start(f, {
        plannedVisitId: null,
        unplannedReason: "Supervisor requested store",
      })
    ).result.status,
  ).toBe("applied");
  expect((await start(other)).result.status).toBe("applied");
  const response = await h.fetch("/api/v1/callflow/report", {
    headers: { authorization: `Bearer ${f.d.access}` },
  });
  const body = /** @type {any} */ (await response.json());
  expect({ status: response.status, error: body.error }).toEqual({
    status: 200,
    error: undefined,
  });
  expect(body.counts).toEqual({ planned: 0, deviated: 0, unplanned: 1 });
  expect(body.items.length).toBe(1);
  expect(body.items[0].reason).toBe("Supervisor requested store");
});
test("F-006 F-107 nationwide flow masters refuse an area-only administrator but permit the national administrator", async () => {
  const area = await fixture({ role: "admin" }),
    national = await fixture({ role: "admin", unit: rootUnit }),
    c = await config(area),
    from = Date.now() + 60000,
    key = `national_${crypto.randomUUID().replaceAll("-", "")}`;
  const definition = {
    channelProfile: key,
    label: "Sample national flow",
    steps: c.definition.steps,
    effectiveFrom: from,
  };
  for (const [kind, payload] of [
    ["definition", definition],
    [
      "policy",
      {
        channelProfile: key,
        outletClass: "*",
        radiusMeters: 100,
        maxAccuracyMeters: 50,
        maxFixAgeMs: 60000,
        minDwellMs: 180000,
        effectiveFrom: from,
      },
    ],
    ["reason", { code: key, label: "Sample reason", effectiveFrom: from }],
    [
      "binding",
      {
        app: "field-android",
        channelCode: "*",
        outletClass: "*",
        channelProfile: PROFILE_FIELD,
        effectiveFrom: from,
      },
    ],
  ])
    expect(
      (await webCall(area, `/api/v1/callflow/${kind}/publish`, payload)).status,
    ).toBe(403);
  expect(
    (
      await h.db`select id from call_flow_definitions where channel_profile=${key}`
    ).length,
  ).toBe(0);
  const saved = await webCall(
    national,
    "/api/v1/callflow/definition/publish",
    definition,
  );
  expect(saved.status).toBe(200);
  expect(
    (await h.db`select id from call_flow_definitions where id=${saved.body.id}`)
      .length,
  ).toBe(1);
});
