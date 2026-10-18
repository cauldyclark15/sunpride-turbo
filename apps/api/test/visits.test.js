import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  boundDevice,
  profileStore,
  signedPost,
  startHarness,
} from "./harness.js";

/** Scope seams use real fixture tables; no fabricated domain query results. */
mock.module("../src/domains/org/scope.js", () => ({
  scopeFilterForActor: async (
    /** @type {any} */ _db,
    /** @type {any} */ a,
  ) => ({
    unitIds: ["super_admin", "analyst"].includes(a.role) ? null : [a.orgUnitId],
  }),
  outletOwnerUnit: async (
    /** @type {any} */ db,
    /** @type {string} */ id,
    /** @type {number} */ at,
  ) => {
    const [row] =
      await db`select coalesce((select t.org_unit_id from outlet_assignments a join territory_ownerships t on t.territory_id=a.territory_id
      where a.outlet_id=o.id and a.deleted_at is null and t.deleted_at is null and a.effective_from<=${new Date(at)} and (a.effective_to is null or a.effective_to>${new Date(at)})
      and t.effective_from<=${new Date(at)} and (t.effective_to is null or t.effective_to>${new Date(at)})),o.custodian_org_unit_id) as owner from outlets o where o.id=${id}`;
    return row?.owner ?? null;
  },
}));
mock.module("../src/domains/org/audit.js", () => ({
  writeAudit: async (/** @type {any} */ db, /** @type {any} */ entry) => {
    await db`insert into audit_logs (subject,action,entity_type,entity_id,details) values (${entry.subject},${entry.action},${entry.entityType},${entry.entityId},${entry.details})`;
  },
}));
/** @type {any[]} */ const refreshes = [];
mock.module("../src/domains/analytics/refresh.js", () => ({
  enqueueRefresh: async (/** @type {any} */ ctx, /** @type {any} */ input) => {
    // It runs from a committed jobs row, outside the op transaction.
    const [{ n }] =
      await ctx.db`select count(*)::int as n from visit_executions where org_unit_id=${input.unitId}`;
    expect(n).toBeGreaterThan(0);
    refreshes.push(input);
  },
}));
const { install } = await import("../src/domains/visits/index.js");
const { isProductive, PRODUCTIVE_CODES } =
  await import("../src/domains/visits/productive.js");
const { phoneRules } = await import("../src/domains/visits/rules.js");
const { manilaDate } = await import("../src/domains/visits/shared.js");
/** @type {import('./harness.js').Harness} */ let h;
/** @type {ReturnType<typeof profileStore>} */ let profiles;
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  profiles = profileStore(h);
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
  await h.db`insert into org_units (id,organization_id,code,name,type_code,status,effective_from) values (${unit},'sunpride',${unit},'Cebu team','territory','active',${early}) on conflict do nothing`;
  const d = await boundDevice(h, profiles, {
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
const DAY = 86400000;
/** @param {string} type @param {any} payload @param {string[]} [dependsOn] */
function op(type, payload, dependsOn = []) {
  return {
    clientOpId: crypto.randomUUID(),
    opType: type,
    clientTime: payload.deviceTime ?? payload.capturedAt ?? Date.now(),
    dependsOn,
    payload,
  };
}
/** @param {any} f @param {any[]} operations */
async function push(f, operations) {
  const result = await signedPost(h, f.d, "/api/sync/push", {
    version: 2,
    app: f.d.app,
    deviceId: f.d.deviceId,
    scopeId: f.unit,
    operations,
  });
  expect(result.res.status).toBe(200);
  if (result.res.status !== 200) throw new Error(JSON.stringify(result.body));
  return result.body.results;
}
/** @param {any} f @param {any} [changes] */
function startOp(f, changes = {}) {
  return op("visit.checkIn", {
    clientVisitId: crypto.randomUUID(),
    plannedVisitId: f.planned,
    outletId: f.outlet,
    serviceDate: f.day,
    deviceTime: f.now,
    location: f.fix,
    intents: ["merchandise"],
    ...changes,
  });
}
/** @param {any} f @param {any} [changes] */
async function start(f, changes = {}) {
  const operation = startOp(f, changes),
    [r] = await push(f, [operation]);
  expect(r.status).toBe("applied");
  return { id: r.ack.entityId, operation, result: r };
}
/** @param {any} f @param {string} path @param {any} [body] */
async function web(f, path, body) {
  const res = await h.fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${f.d.access}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}

test("full signed check-in → activity → collection → checkout; exact receipts and conflict without duplicate facts", async () => {
  const f = await fixture(),
    s = await start(f);
  const a = op(
    "visit.activity",
    {
      visitId: s.id,
      deviceTime: f.now + 1,
      activity: { kind: "merchandising", displayCondition: "compliant" },
    },
    [s.operation.clientOpId],
  );
  const c = op(
    "collection.record",
    {
      visitId: s.id,
      deviceTime: f.now + 2,
      amountMinor: 12550,
      currency: "PHP",
      method: "cash",
      reference: "TEST-R1",
    },
    [a.clientOpId],
  );
  const e = op(
    "visit.checkOut",
    {
      visitId: s.id,
      deviceTime: f.now + 3,
      outcome: "completed",
      reasonCode: null,
      location: f.fix,
    },
    [c.clientOpId],
  );
  const results = await push(f, [a, c, e]);
  expect(results.map((/** @type {any} */ r) => r.status)).toEqual([
    "applied",
    "applied",
    "applied",
  ]);
  const replay = await push(f, [s.operation, a, c, e]);
  expect(replay.map((/** @type {any} */ r) => r.status)).toEqual([
    "duplicate",
    "duplicate",
    "duplicate",
    "duplicate",
  ]);
  expect(replay.map((/** @type {any} */ r) => r.ack)).toEqual([
    s.result.ack,
    ...results.map((/** @type {any} */ r) => r.ack),
  ]);
  const [conflict] = await push(f, [
    { ...c, payload: { ...c.payload, amountMinor: 1 } },
  ]);
  expect(conflict.code).toBe("idempotency_conflict");
  const [{ n, amount }] =
    await h.db`select count(*)::int n,sum(amount_minor)::text amount from field_collections where visit_id=${s.id}`;
  expect({ n, amount }).toEqual({ n: 1, amount: "12550" });
  const [visit] = await h.db`select * from visit_executions where id=${s.id}`;
  expect(visit.state).toBe("checked-out");
  expect(visit.missing_activities).toEqual([]);
  expect(Number(visit.call_duration_ms)).toBe(3);
  const [{ events }] =
    await h.db`select count(*)::int as events from execution_events where correlation_id=${s.id}`;
  expect(events).toBe(4);
  await h.app.scheduler.drain();
  expect(
    refreshes.some(
      (r) => r.kind === "visit" && r.date === f.day && r.unitId === f.unit,
    ),
  ).toBe(true);
  expect(
    refreshes.some((r) => r.kind === "collection" && r.unitId === f.unit),
  ).toBe(true);
  const read = await web(f, `/api/v1/visits/detail?visitId=${s.id}`);
  expect(read.status).toBe(200);
  expect(read.body.productiveCall.productive).toBe(true);
  expect(read.body.timeline).toHaveLength(4);
  expect(read.body.locationEvidence[0].distanceLabel).toBe(
    "0 m from verified pin",
  );
  const listing = await web(
    f,
    `/api/v1/visits/list?date=${f.day}&person=${f.d.profile.id}&outlet=${f.outlet}&status=checked-out&onPlan=true`,
  );
  expect(listing.status).toBe(200);
  expect(listing.body.rows.map((/** @type {any} */ r) => r.id)).toEqual([s.id]);
});

for (const code of PRODUCTIVE_CODES)
  test(`objective ${code} independently qualifies a completed planned call`, () => {
    expect(
      isProductive(
        { inRoutePlan: true, state: "checked-out", codes: [code] },
        { productiveCallRule: "any_listed_activity" },
      ).productive,
    ).toBe(true);
  });
test("note-only, outcome-only, unknown rule, off-plan and still-open do not count", () => {
  const base = { inRoutePlan: true, state: "checked-out" };
  expect(
    isProductive(
      { ...base, activityKinds: ["note"], outcome: "completed" },
      { rule: "any_listed_activity" },
    ).productive,
  ).toBe(false);
  expect(
    isProductive({ ...base, codes: [] }, { rule: "any_listed_activity" })
      .productive,
  ).toBe(false);
  expect(
    isProductive({ ...base, codes: ["collection"] }, { rule: "unknown" })
      .productive,
  ).toBe(false);
  expect(
    isProductive(
      { ...base, inRoutePlan: false, codes: ["collection"] },
      { rule: "any_listed_activity" },
    ).productive,
  ).toBe(false);
  expect(
    isProductive(
      { ...base, state: "in-progress", codes: ["collection"] },
      { rule: "any_listed_activity" },
    ).productive,
  ).toBe(false);
});
test("truck merchandising requires inventory marker; marker alone and call-sheet alone do not qualify", () => {
  const base = {
    inRoutePlan: true,
    state: "checked-out",
    activityKinds: ["merchandising"],
  };
  expect(isProductive(base, { rule: "truck_seller" }).productive).toBe(false);
  expect(
    isProductive(
      { ...base, reasonCode: "no_sales_due_to_inventory" },
      { rule: "truck_seller" },
    ).productive,
  ).toBe(true);
  expect(
    isProductive(
      { ...base, activityKinds: [], noSalesDueToInventory: true },
      { rule: "truck_seller" },
    ).productive,
  ).toBe(false);
  expect(
    isProductive(
      { ...base, activityKinds: ["call_sheet"] },
      { rule: "any_listed_activity" },
    ).productive,
  ).toBe(false);
});

test("one open call, call sequence, wrong date, signed snapshot and duplicate plan-stop are enforced", async () => {
  const f = await fixture();
  const wrong = startOp(f, { serviceDate: manilaDate(f.now - DAY) });
  expect((await push(f, [wrong]))[0].code).toBe("wrong_date");
  await h.db`update coverage_plan_slots set approved_snapshot=${{ bad: "snapshot" }} where id=${f.slot}`;
  expect((await push(f, [startOp(f)]))[0].code).toBe("invalid_plan");
  await h.db`update coverage_plan_slots set approved_snapshot=(select approved_snapshot from planned_visits where id=${f.planned}) where id=${f.slot}`;
  const s = await start(f);
  expect(
    (
      await push(f, [
        startOp(f, { plannedVisitId: null, unplannedReason: "Follow up" }),
      ])
    )[0].code,
  ).toBe("call_open");
  expect(
    (
      await push(f, [
        op("visit.checkOut", {
          visitId: s.id,
          deviceTime: f.now + 1,
          location: null,
          outcome: "nonproductive",
          reasonCode: "store_closed",
        }),
      ])
    )[0].status,
  ).toBe("applied");
  expect((await push(f, [startOp(f)]))[0].code).toBe("idempotency_conflict");
});
test("two different concurrent check-ins cannot open two calls", async () => {
  const f = await fixture();
  const results = await Promise.all([
    push(f, [startOp(f)]),
    push(f, [
      startOp(f, { plannedVisitId: null, unplannedReason: "Follow up" }),
    ]),
  ]);
  expect(results.flat().filter((r) => r.status === "applied")).toHaveLength(1);
  expect(results.flat().find((r) => r.status !== "applied").code).toBe(
    "call_open",
  );
});
test("completed End preserves missing required forms and never treats note as productive", async () => {
  const f = await fixture(),
    s = await start(f);
  await push(f, [
    op("visit.activity", {
      visitId: s.id,
      deviceTime: f.now + 1,
      activity: { kind: "note", text: "Nothing sold" },
    }),
  ]);
  expect(
    (
      await push(f, [
        op("visit.checkOut", {
          visitId: s.id,
          deviceTime: f.now + 2,
          location: null,
          outcome: "completed",
          reasonCode: null,
        }),
      ])
    )[0].status,
  ).toBe("applied");
  const [v] = await h.db`select * from visit_executions where id=${s.id}`;
  expect(v.missing_activities).toEqual(["merchandising"]);
  expect(v.productivity).toBe("nonproductive");
});
test("frozen Start rules survive a later master correction; 500th required activity is included", async () => {
  const f = await fixture(),
    s = await start(f);
  const [rule] =
    await h.db`insert into visit_activity_rules (organization_id,intent,effective_from,source_ref,provisional,actor_subject)
    values ('sunpride','merchandise',${new Date(f.now - 1000)},'TEST corrected master',true,${f.d.userId}) returning id`;
  try {
    await h.db`insert into visit_activity_rule_activities (visit_activity_rule_id,ordinal,kind,required) values (${rule.id},0,'inventory_check',true)`;
    expect(
      (await phoneRules(h.db, f.now)).find((r) => r.intent === "merchandise")
        ?.activities,
    ).toEqual([{ kind: "inventory_check", required: true }]);
    await h.db`insert into visit_activities (organization_id,org_unit_id,visit_id,assignee_profile_id,outlet_id,activity_kind,activity,device_time,server_time)
      select 'sunpride',${f.unit},${s.id},${f.d.profile.id},${f.outlet},'note',${{ kind: "note", text: "Prefix" }},${new Date(f.now)},${new Date(f.now)} from generate_series(1,499)`;
    await push(f, [
      op("visit.activity", {
        visitId: s.id,
        deviceTime: f.now + 1,
        activity: { kind: "merchandising", displayCondition: "compliant" },
      }),
    ]);
    expect(
      (
        await push(f, [
          op("visit.checkOut", {
            visitId: s.id,
            deviceTime: f.now + 2,
            location: null,
            outcome: "completed",
            reasonCode: null,
          }),
        ])
      )[0].status,
    ).toBe("applied");
    const [v] = await h.db`select * from visit_executions where id=${s.id}`;
    expect(v.missing_activities).toEqual([]);
    expect(
      v.activity_rules_snapshot.find(
        (/** @type {any} */ r) => r.intent === "merchandise",
      ).activities[0].kind,
    ).toBe("merchandising");
  } finally {
    await h.db`delete from visit_activity_rules where id=${rule.id}`;
  }
});

test("real media claim and PUT; visit/person/device binding; attach exact replay and metadata conflict", async () => {
  const f = await fixture(),
    s = await start(f),
    other = await fixture({ unit: f.unit });
  const bytes = new Uint8Array([255, 216, 255, 217]),
    checksum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const claim = {
    version: 2,
    deviceId: f.d.deviceId,
    purpose: "visit-photo",
    ownerId: s.id,
    mime: "image/jpeg",
    size: bytes.length,
    sha256: checksum,
  };
  const denied = await signedPost(h, other.d, "/api/media/claims", {
    ...claim,
    deviceId: other.d.deviceId,
  });
  expect(denied.res.status).toBe(403);
  const c = await signedPost(h, f.d, "/api/media/claims", claim);
  expect(c.res.status).toBe(200);
  const raw = await fetch(c.body.uploadUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${c.body.uploadToken}`,
      "content-type": "image/jpeg",
    },
    body: bytes,
  });
  expect(raw.status).toBe(200);
  const uploaded = /** @type {any} */ (await raw.json());
  expect(uploaded.blobId).toBe(c.body.uploadId);
  const a = op("evidence.attach", {
    visitId: s.id,
    blobId: uploaded.blobId,
    checksum,
    mime: "image/jpeg",
    size: bytes.length,
    capturedAt: f.now,
    photoType: "storefront",
    source: "mobile",
  });
  expect((await push(other, [a]))[0].code).toBe("out_of_scope");
  const [result] = await push(f, [a]);
  expect(result.status).toBe("applied");
  expect((await push(f, [a]))[0].ack).toEqual(result.ack);
  expect(
    (await push(f, [{ ...a, clientOpId: crypto.randomUUID() }]))[0].ack
      .entityId,
  ).toBe(result.ack.entityId);
  expect(
    (
      await push(f, [
        {
          ...a,
          clientOpId: crypto.randomUUID(),
          payload: { ...a.payload, photoType: "other" },
        },
      ])
    )[0].code,
  ).toBe("idempotency_conflict");
  const [{ n }] =
    await h.db`select count(*)::int n from evidence_upload_claims where storage_id=${uploaded.blobId} and profile_id=${f.d.profile.id} and device_id=${f.d.deviceId} and consumed_at is not null`;
  expect(n).toBe(1);
  const image = await h.fetch(`/api/v1/visits/media/${result.ack.entityId}`, {
    headers: { authorization: `Bearer ${f.d.access}` },
  });
  expect(image.status).toBe(200);
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
  const forbidden = await h.fetch(
    `/api/v1/visits/media/${result.ack.entityId}`,
    { headers: { authorization: `Bearer ${other.d.access}` } },
  );
  expect(forbidden.status).toBe(403);
  await push(f, [
    op("visit.checkOut", {
      visitId: s.id,
      deviceTime: f.now + 1,
      location: null,
      outcome: "nonproductive",
      reasonCode: "test_end",
    }),
  ]);
  const second = await start(f, {
    plannedVisitId: null,
    deviceTime: f.now + 2,
    unplannedReason: "Second test call",
  });
  const [wrongVisit] = await push(f, [
    {
      ...a,
      clientOpId: crypto.randomUUID(),
      payload: { ...a.payload, visitId: second.id },
    },
  ]);
  expect(wrongVisit.code).toBe("evidence_pending_review");
});

test("location is a flag, not a check-in block; independent manager decision leaves immutable raw evidence unchanged", async () => {
  const f = await fixture({ role: "manager" }),
    s = await start(f, { location: { ...f.fix, latitude: 11 } }),
    manager = await fixture({ unit: f.unit, role: "manager" });
  const [raw] =
    await h.db`select * from visit_location_evidence where visit_id=${s.id}`;
  expect(raw.result).toBe("outside_radius");
  const self = await web(f, "/api/v1/visits/location-exception/decide", {
    evidenceId: raw.id,
    decision: "approve",
    reason: "supervised",
  });
  expect(self.status).toBe(403);
  const decided = await web(
    manager,
    "/api/v1/visits/location-exception/decide",
    { evidenceId: raw.id, decision: "approve", reason: "supervised" },
  );
  expect(decided.status).toBe(200);
  expect(decided.body.reviewStatus).toBe("approved_exception");
  const [after] =
    await h.db`select * from visit_location_evidence where id=${raw.id}`;
  expect(after).toEqual(raw);
  expect(
    (
      await web(manager, "/api/v1/visits/location-exception/decide", {
        evidenceId: raw.id,
        decision: "reject",
        reason: "second",
      })
    ).status,
  ).toBe(409);
  const detail = await web(manager, `/api/v1/visits/detail?visitId=${s.id}`);
  expect(detail.body.locationEvidence[0].reviewStatus).toBe(
    "approved_exception",
  );
  expect(detail.body.locationEvidence[0].rawReviewStatus).toBe(
    "pending_review",
  );
  await expect(
    (async () => {
      await h.db`update visit_location_evidence set result='within_radius' where id=${raw.id}`;
    })(),
  ).rejects.toThrow("append-only");
});

test("current owner and current person scope gate historical visit reads and new writes", async () => {
  const f = await fixture(),
    s = await start(f),
    foreign = await fixture();
  const before = await web(f, `/api/v1/visits/detail?visitId=${s.id}`);
  expect(before.status).toBe(200);
  await h.db`update territory_ownerships set effective_to=now() where territory_id=${f.territory}`;
  await h.db`insert into territory_ownerships (territory_id,org_unit_id,effective_from,actor_subject,reason) values (${f.territory},${foreign.unit},now(),${foreign.d.userId},'Transfer')`;
  expect((await web(f, `/api/v1/visits/detail?visitId=${s.id}`)).status).toBe(
    403,
  );
  expect(
    (
      await push(f, [
        op("visit.activity", {
          visitId: s.id,
          deviceTime: f.now + 1,
          activity: { kind: "note", text: "No" },
        }),
      ])
    )[0].code,
  ).toBe("out_of_scope");
  const hidden = await web(
    f,
    `/api/v1/visits/list?date=${f.day}&person=${f.d.profile.id}`,
  );
  expect(hidden.body.rows).toEqual([]);
});

test("field collections validate positive integer PHP and cannot write after End; refused op rolls back", async () => {
  const f = await fixture(),
    s = await start(f);
  for (const amount of [0, -1, 1.5])
    expect(
      (
        await push(f, [
          op("collection.record", {
            visitId: s.id,
            deviceTime: f.now,
            amountMinor: amount,
            currency: "PHP",
            method: "cash",
            reference: "TEST",
          }),
        ])
      )[0].code,
    ).toBe("invalid_request");
  const [{ n }] =
    await h.db`select count(*)::int n from field_collections where visit_id=${s.id}`;
  expect(n).toBe(0);
  await push(f, [
    op("visit.checkOut", {
      visitId: s.id,
      deviceTime: f.now + 1,
      location: null,
      outcome: "nonproductive",
      reasonCode: "closed",
    }),
  ]);
  expect(
    (
      await push(f, [
        op("collection.record", {
          visitId: s.id,
          deviceTime: f.now + 2,
          amountMinor: 100,
          currency: "PHP",
          method: "cash",
          reference: "TEST",
        }),
      ])
    )[0].code,
  ).toBe("invalid_transition");
});

test("field task assigned by scoped supervisor, completed with exact replay by visitor", async () => {
  const f = await fixture(),
    manager = await fixture({ unit: f.unit, role: "manager" }),
    s = await start(f);
  const created = await web(manager, "/api/v1/visits/tasks/create", {
    personId: f.d.profile.id,
    outletId: f.outlet,
    kind: "merchandising",
    required: true,
    effectiveFrom: f.now - 1000,
  });
  expect(created.status).toBe(200);
  const operation = op("task.complete", {
    visitId: s.id,
    taskId: created.body.id,
    deviceTime: f.now + 1,
    evidenceIds: [],
  });
  const [r] = await push(f, [operation]);
  expect(r.status).toBe("applied");
  expect((await push(f, [operation]))[0].ack).toEqual(r.ack);
  const tasks = await web(f, `/api/v1/visits/tasks?date=${f.day}`);
  expect(
    tasks.body.rows.find((/** @type {any} */ t) => t.id === created.body.id)
      .status,
  ).toBe("completed");
});

test("merchandising writes assortment-based OSA, missing rows, compliance and competitor prices, with idempotent replay", async () => {
  const f = await fixture(),
    s = await start(f),
    admin = await fixture({ unit: f.unit, role: "super_admin" });
  const [assortment] =
    await h.db`insert into outlet_assortments (organization_id,outlet_id,effective_from,source_ref,actor_subject) values ('sunpride',${f.outlet},${new Date(f.now - 10000)},'TEST required',${admin.d.userId}) returning id`;
  await h.db`insert into outlet_assortment_products (outlet_assortment_id,ordinal,product_id) values (${assortment.id},0,${f.sku})`;
  const operation = op("merchandising.record", {
    clientAuditId: crypto.randomUUID(),
    visitId: s.id,
    deviceTime: f.now + 1,
    availability: [{ productId: f.sku, status: "out_of_stock", facings: 0 }],
    compliance: [
      {
        kind: "price_tag",
        finding: "non_compliant",
        actionTaken: "Replaced label",
      },
    ],
    competitors: [
      {
        kind: "price",
        brand: "Test competitor",
        observedPriceMinor: 4567,
        currency: "PHP",
      },
    ],
  });
  const [r] = await push(f, [operation]);
  expect(r.status).toBe("applied");
  expect((await push(f, [operation]))[0].ack).toEqual(r.ack);
  const read = await web(f, `/api/v1/visits/detail?visitId=${s.id}`);
  expect(read.status).toBe(200);
  expect(read.body.merchandising.onShelfAvailabilityPercent).toBe(0);
  expect(read.body.merchandising.requiredOutOfStockCount).toBe(1);
  expect(read.body.merchandising.compliance[0].finding).toBe("non_compliant");
  expect(read.body.merchandising.competitors[0].observedPriceMinor).toBe(4567);
  const [changed] = await push(f, [
    {
      ...operation,
      clientOpId: crypto.randomUUID(),
      payload: { ...operation.payload, competitors: [] },
    },
  ]);
  expect(changed.code).toBe("idempotency_conflict");
});
test("OSA is unknown without governed assortment, not healthy zero", async () => {
  const f = await fixture(),
    s = await start(f);
  await push(f, [
    op("merchandising.record", {
      clientAuditId: crypto.randomUUID(),
      visitId: s.id,
      deviceTime: f.now,
      availability: [],
      compliance: [{ kind: "display", finding: "compliant" }],
      competitors: [],
    }),
  ]);
  const read = await web(f, `/api/v1/visits/detail?visitId=${s.id}`);
  expect(read.body.merchandising.onShelfAvailabilityPercent).toBeNull();
});
test("activity-rule web writer is prospective, national, audited and projects exact phone keys", async () => {
  const admin = await fixture({ role: "super_admin" }),
    at = Date.now() + 60000;
  const request = {
    intent: "merchandise",
    effectiveFrom: at,
    sourceRef: "TEST policy",
    provisional: true,
    activities: [{ kind: "price_check", required: true }],
  };
  const set = await web(admin, "/api/v1/visits/activity-rules/set", request);
  expect(set.status).toBe(200);
  const before = await phoneRules(h.db, at - 1),
    after = await phoneRules(h.db, at);
  expect(
    before.find((r) => r.intent === "merchandise")?.activities[0]?.kind,
  ).toBe("merchandising");
  expect(after.find((r) => r.intent === "merchandise")?.activities).toEqual(
    request.activities,
  );
  expect(Object.keys(after[0]).sort()).toEqual([
    "activities",
    "intent",
    "version",
  ]);
  const [{ n }] =
    await h.db`select count(*)::int n from audit_logs where entity_id=${set.body.id}`;
  expect(n).toBe(1);
  expect(
    (
      await web(admin, "/api/v1/visits/activity-rules/set", {
        ...request,
        effectiveFrom: at - 1,
      })
    ).status,
  ).toBe(400);
});

test("all seven native activity forms retain their wire fields; call-sheet and order quantity guards match legacy limits", async () => {
  const f = await fixture(),
    s = await start(f);
  const [account] =
    await h.db`insert into call_sheet_accounts (organization_id,outlet_id,revision,header_account_name,updated_by) values ('sunpride',${f.outlet},1,'Test store',${f.d.userId}) returning id`;
  await h.db`insert into call_sheet_account_lines (call_sheet_account_id,ordinal,product_id) values (${account.id},0,${f.sku})`;
  const forms = [
    { kind: "note", text: "Buyer meeting note" },
    {
      kind: "merchandising",
      displayCondition: "needs_action",
      actionTaken: "Fixed display",
    },
    {
      kind: "inventory_check",
      productId: f.sku,
      icoFinding: "present",
      observedQuantity: 2,
    },
    {
      kind: "price_check",
      productId: f.sku,
      observedPriceMinor: 4567,
      currency: "PHP",
      compliant: false,
    },
    { kind: "promotion", programRef: "TEST-P", finding: "not_executed" },
    {
      kind: "call_sheet",
      lines: [
        {
          productId: f.sku,
          order: 2,
          beginningInventory: 0,
          take: null,
          delivered: null,
          offtake: 1,
          endInventory: null,
        },
      ],
    },
    {
      kind: "order_intent",
      clientOrderId: crypto.randomUUID(),
      lines: [{ productId: f.sku, uom: "PC", quantity: 2 }],
    },
  ];
  for (const [index, form] of forms.entries()) {
    const [r] = await push(f, [
      op("visit.activity", {
        visitId: s.id,
        deviceTime: f.now + index,
        activity: form,
      }),
    ]);
    expect(r.status).toBe("applied");
    const [row] =
      await h.db`select activity from visit_activities where id=${r.ack.entityId}`;
    expect(row.activity).toEqual(form);
  }
  const empty = {
    kind: "call_sheet",
    lines: [
      {
        productId: f.sku,
        order: null,
        beginningInventory: null,
        take: null,
        delivered: null,
        offtake: null,
        endInventory: null,
      },
    ],
  };
  expect(
    (
      await push(f, [
        op("visit.activity", {
          visitId: s.id,
          deviceTime: f.now,
          activity: empty,
        }),
      ])
    )[0].code,
  ).toBe("invalid_request");
  const fraction = {
    kind: "order_intent",
    clientOrderId: crypto.randomUUID(),
    lines: [{ productId: f.sku, uom: "PC", quantity: 1.5 }],
  };
  expect(
    (
      await push(f, [
        op("visit.activity", {
          visitId: s.id,
          deviceTime: f.now,
          activity: fraction,
        }),
      ])
    )[0].code,
  ).toBe("invalid_request");
});

test("order catalog authorization never admits a product added on a later service day", async () => {
  const f = await fixture(),
    s = await start(f);
  const next = new Date(`${f.day}T00:00:00+08:00`).getTime() + DAY;
  const [account] =
    await h.db`insert into call_sheet_accounts (organization_id,outlet_id,revision,header_account_name,updated_by,updated_at)
    values ('sunpride',${f.outlet},2,'Test store',${f.d.userId},${new Date(next)}) returning id`;
  await h.db`insert into call_sheet_account_lines (call_sheet_account_id,ordinal,product_id) values (${account.id},0,${f.sku})`;
  const operation = op("visit.activity", {
    visitId: s.id,
    deviceTime: f.now,
    activity: {
      kind: "order_intent",
      clientOrderId: crypto.randomUUID(),
      lines: [{ productId: f.sku, uom: "PC", quantity: 1 }],
    },
  });
  expect((await push(f, [operation]))[0].code).toBe("invalid_request");
  const [rev] =
    await h.db`insert into call_sheet_account_revisions (organization_id,outlet_id,revision,effective_from,superseded_at)
    values ('sunpride',${f.outlet},1,${new Date(f.now - DAY)},${new Date(next)}) returning id`;
  await h.db`insert into call_sheet_account_revision_products (call_sheet_account_revision_id,ordinal,product_id) values (${rev.id},0,${f.sku})`;
  expect((await push(f, [operation]))[0].status).toBe("applied");
});

test("a lower-sequence unclosed planned stop blocks check-in; replaced stops no longer block", async () => {
  const f = await fixture();
  await h.db`update coverage_plan_slots set sequence=2 where id=${f.slot}`;
  const [slot] =
    await h.db`insert into coverage_plan_slots (slot_key,plan_id,assignee_profile_id,service_date,kind,outlet_id,intents,sequence,expected_duration_minutes,approved_snapshot,content_revision,updated_by)
    select 'earlier',plan_id,assignee_profile_id,service_date,kind,outlet_id,intents,1,30,approved_snapshot,1,updated_by from coverage_plan_slots where id=${f.slot} returning id`;
  const [earlier] =
    await h.db`insert into planned_visits (generation_key,plan_id,plan_version,plan_slot_id,assignee_profile_id,outlet_id,service_date,status,approved_snapshot,intents,expected_duration_minutes,generated_at)
    select ${crypto.randomUUID()},plan_id,1,${slot.id},assignee_profile_id,outlet_id,service_date,'planned',approved_snapshot,intents,30,generated_at from planned_visits where id=${f.planned} returning id`;
  expect((await push(f, [startOp(f)]))[0].code).toBe("mcp_order");
  await h.db`update planned_visits set status='replaced' where id=${earlier.id}`;
  expect((await push(f, [startOp(f)]))[0].status).toBe("applied");
});

test("late offline work is retained in supervisor queue and trace; accepting it appends an event", async () => {
  const f = await fixture(),
    manager = await fixture({ unit: f.unit, role: "manager" });
  const past = f.now - DAY,
    day = manilaDate(past);
  const s = await start(f, {
    plannedVisitId: null,
    serviceDate: day,
    deviceTime: past,
    location: { ...f.fix, fixTime: past },
    unplannedReason: "Offline follow up",
  });
  const queue = await web(
    manager,
    `/api/v1/visits/late-sync/list?unitId=${f.unit}`,
  );
  expect(queue.status).toBe(200);
  expect(queue.body.rows.some((/** @type {any} */ r) => r.id === s.id)).toBe(
    true,
  );
  const trace = await web(
    manager,
    `/api/v1/visits/trace?personId=${f.d.profile.id}&date=${day}`,
  );
  expect(trace.status).toBe(200);
  expect(trace.body.points[0].late).toBe(true);
  expect(trace.body.points[0].result).toBe("within_radius");
  const decided = await web(manager, "/api/v1/visits/late-sync/decide", {
    visitId: s.id,
    decision: "accept",
    reason: "offline_reviewed",
  });
  expect(decided.status).toBe(200);
  const [visit] = await h.db`select * from visit_executions where id=${s.id}`;
  expect(visit.late_review_status).toBe("accepted");
  const [{ n }] =
    await h.db`select count(*)::int n from execution_events where entity_id=${s.id} and kind='visit.late_sync.decided'`;
  expect(n).toBe(1);
});

test("assortment version is prospective, audited and current owner scoped", async () => {
  const f = await fixture({ role: "super_admin" }),
    at = Date.now() + 60000;
  const body = {
    outletId: f.outlet,
    productIds: [f.sku],
    effectiveFrom: at,
    sourceRef: "TEST planogram",
  };
  const set = await web(f, "/api/v1/visits/assortments/set", body);
  expect(set.status).toBe(200);
  const before = await web(
    f,
    `/api/v1/visits/assortments/current?outletId=${f.outlet}&asOf=${at - 1}`,
  );
  expect(before.body.assortment).toBeNull();
  const after = await web(
    f,
    `/api/v1/visits/assortments/current?outletId=${f.outlet}&asOf=${at}`,
  );
  expect(after.body.assortment.productIds).toEqual([f.sku]);
  expect((await web(f, "/api/v1/visits/assortments/set", body)).status).toBe(
    409,
  );
  const [{ n }] =
    await h.db`select count(*)::int n from audit_logs where entity_id=${set.body.id}`;
  expect(n).toBe(1);
});

test("invalid competitor/compliance/facings and foreign evidence leave no merchandising rows", async () => {
  const f = await fixture(),
    s = await start(f);
  const base = {
    clientAuditId: crypto.randomUUID(),
    visitId: s.id,
    deviceTime: f.now,
    availability: [],
    compliance: [],
    competitors: [],
  };
  for (const payload of [
    {
      ...base,
      availability: [{ productId: f.sku, status: "out_of_stock", facings: 1 }],
    },
    { ...base, compliance: [{ kind: "promotion", finding: "compliant" }] },
    {
      ...base,
      competitors: [
        {
          kind: "price",
          brand: "Test",
          observedPriceMinor: 3.5,
          currency: "PHP",
        },
      ],
    },
    {
      ...base,
      compliance: [
        {
          kind: "display",
          finding: "compliant",
          evidenceIds: [crypto.randomUUID()],
        },
      ],
    },
  ]) {
    const [r] = await push(f, [op("merchandising.record", payload)]);
    expect(r.status).toBe("rejected");
  }
  const [{ n }] =
    await h.db`select count(*)::int n from merchandising_audits where visit_id=${s.id}`;
  expect(n).toBe(0);
});
