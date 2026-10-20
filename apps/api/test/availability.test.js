import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  profileStore,
  boundDevice,
  signedPost,
} from "./harness.js";
import { capabilitiesFor } from "../src/core/capabilities.js";
import { manilaDate } from "../src/domains/visits/shared.js";
import {
  resolveSet,
  checklist,
  distribution,
  deriveOfftake,
  suggest,
} from "../src/domains/availability/rules.js";
import {
  createRelease,
  preview,
  publishRelease,
} from "../src/domains/availability/masters.js";
import {
  callSnapshot,
  record,
  decideProposal,
  availabilityStepComplete,
} from "../src/domains/availability/calls.js";
import {
  createUniverse,
  coverageAvailability,
  launchStatus,
} from "../src/domains/availability/metrics.js";
import { install } from "../src/domains/availability/index.js";

mock.module("../src/domains/org/scope.js", () => ({
  scopeFilterForActor: async (
    /** @type {any} */ _db,
    /** @type {any} */ a,
  ) => ({ unitIds: a.role === "super_admin" ? null : [a.orgUnitId] }),
  outletOwnerUnit: async (/** @type {any} */ db, /** @type {string} */ id) =>
    (await db`select custodian_org_unit_id from outlets where id=${id}`)[0]
      ?.custodian_org_unit_id ?? null,
}));
/** @type {any} */ let h;
/** @type {any} */ let profiles;
const id = () => crypto.randomUUID();
const unit = id(),
  foreignUnit = id(),
  outlet = id(),
  other = id(),
  provisional = id(),
  p1 = id(),
  p2 = id();
const now = Date.now(),
  day = manilaDate(now),
  early = new Date(now - 86400000);
/** @type {any} */ let field;
/** @type {any} */ let van;
/** @type {any} */ let admin;
let tripId = "",
  visitId = "",
  callKey = id();
/** @param {any} who @param {any} [body] @param {string} [app] */
function context(who, body = {}, app = "web") {
  return {
    db: h.db,
    actor: {
      userId: who.userId,
      subject: who.userId,
      profileId: who.profile.id,
      role: who.profile.role,
      orgUnitId: who.profile.orgUnitId,
      capabilities: new Set(capabilitiesFor(who.profile.role)),
    },
    app,
    now: Date.now(),
    body,
    payload: body,
    change: async () => 1,
    publish: () => {},
    enqueue: async () => null,
  };
}
/** @param {any} who */
async function persistPerson(who) {
  const p = who.profile;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values (${p.id},${who.userId},${who.userId},'Retail colleague',${who.email},${p.role},'active',${p.orgUnitId})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values (${p.id},${p.orgUnitId},${p.role},${early},'fixture','fixture')`;
}
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  profiles = profileStore(h);
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values (${unit},'sunpride','SUNPRIDE','Retail team','national','active',${early}),(${foreignUnit},'sunpride','FOREIGN','Foreign team','region','active',${early})`;
  field = await boundDevice(h, profiles, { orgUnitId: unit });
  van = await boundDevice(h, profiles, { orgUnitId: unit, app: "van-android" });
  admin = await boundDevice(h, profiles, {
    orgUnitId: unit,
    role: "super_admin",
  });
  for (const who of [field, van, admin]) await persistPerson(who);
  h.setHooks({
    unitInScope: async (
      /** @type {any} */ _db,
      /** @type {any} */ a,
      /** @type {string} */ u,
    ) => a.orgUnitId === u,
    scopeUnitIds: async (/** @type {any} */ _db, /** @type {any} */ a) => [
      a.orgUnitId,
    ],
    rootUnitId: async () => unit,
  });
  await h.db`insert into products(id,code,name,category,uom,unit_price,active,organization_id) values (${p1},'RETAIL-1','Corned beef sample','Canned','PC',0,true,'sunpride'),(${p2},'RETAIL-2','Meat loaf sample','Canned','PC',0,true,'sunpride')`;
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,subchannel,classification,enrolment_status,created_by) values (${outlet},'sunpride','RETAIL-A','Store A','active',${unit},'GT','sari-sari','A','approved','fixture'),(${other},'sunpride','RETAIL-B','Store B','active',${unit},'GT','sari-sari','B','approved','fixture'),(${provisional},'sunpride','RETAIL-P','Prospect','active',${unit},'GT',null,'A','provisional','fixture')`;
  for (const store of [outlet, other]) {
    await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values ('retail-fixture','outlets',${store},${store})`;
    // Only fixture plan ownership is substituted; production check/projection bodies are real.
    const plan = id(),
      slot = id();
    await h.db`insert into coverage_plans(id,organization_id,assignee_profile_id,local_month,version,cycle_type,org_unit_id,requested_from,requested_to,effective_from,effective_to,status,prepared_by,prepared_at,content_revision,created_by,updated_by) values (${plan},'sunpride',${field.profile.id},${day.slice(0, 7)},${store === outlet ? 1 : 2},'monthly',${unit},${early},${new Date(now + 86400000)},${early},${new Date(now + 86400000)},'active','fixture',${early},1,'fixture','fixture')`;
    await h.db`insert into coverage_plan_slots(id,slot_key,plan_id,assignee_profile_id,service_date,kind,outlet_id,intents,sequence,expected_duration_minutes,content_revision,updated_by) values (${slot},${slot},${plan},${field.profile.id},${day},'outlet_visit',${store},array['sell'],1,30,1,'fixture')`;
    await h.db`insert into planned_visits(generation_key,plan_id,plan_version,plan_slot_id,assignee_profile_id,outlet_id,service_date,status,approved_snapshot,intents,expected_duration_minutes,generated_at) values (${id()},${plan},1,${slot},${field.profile.id},${store},${day},'planned',${{ outletId: store, outletName: "Store", approvedAssigneeProfileId: field.profile.id }},array['sell'],30,${early})`;
  }
  const [v] =
    await h.db`insert into visit_executions(organization_id,client_visit_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,intents,state,productivity,last_server_time,checked_in_at) values ('sunpride',${callKey},${field.profile.id},${outlet},${unit},${day},'unplanned',array['sell'],'checked-in','pending',now(),${early}) returning id`;
  visitId = v.id;
  const truck = id(),
    vehicle = id();
  await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values (${truck},'sunpride',${unit},'CEB',${truck},'Truck','truck',true,true,true,true,false)`;
  await h.db`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by) values (${vehicle},'sunpride',${unit},${vehicle},'SAMPLE',${truck},${truck},'active','fixture')`;
  const [t] =
    await h.db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by) values ('sunpride',${unit},${id()},${vehicle},${truck},${truck},${day},${van.profile.id},${van.userId},'active','fixture') returning id`;
  tripId = t.id;
  for (const [kind, key, payload] of [
    [
      "rules",
      "default",
      { coverDays: 8, freshnessDays: 7, universeFreshnessDays: 7 },
    ],
    [
      "msl",
      "GT",
      {
        channel: "GT",
        priority: 0,
        lines: [
          { productId: p1, minimumBase: 2 },
          { productId: p2, minimumBase: 1 },
        ],
      },
    ],
  ])
    await h.db`insert into availability_releases(kind,policy_key,version,label,status,effective_from,payload,source_ref,sample,actor_subject) values (${kind},${key},1,'SAMPLE retail policy','published',${early},${payload},'TEST sample',true,'fixture')`;
});
afterAll(async () => {
  await h?.close();
});

test("F-211 F-219 office setup exposes bounded current territory choices", async () => {
  const signIn = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: admin.email, password: admin.password }),
  });
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers.get("set-cookie").split(";")[0];
  const response = await h.fetch("/api/v1/availability/releases", {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.territories).toEqual([]);
  expect(
    body.outlets.find((/** @type {any} */ row) => row.id === outlet)
      .territoryId,
  ).toBeNull();
  expect(body.products.some((/** @type {any} */ row) => row.id === p1)).toBe(
    true,
  );
});

test("F-216 F-219 publication preview shows target products, not a false missing MSL", async () => {
  for (const kind of ["focus", "launch"]) {
    const label = `SAMPLE ${kind} preview`;
    const release = await tx(h.db, (/** @type {any} */ db) =>
      createRelease({
        ...context(admin),
        db,
        body: {
          kind,
          key: `preview-${kind}`,
          label,
          sourceRef: "SAMPLE test",
          sample: true,
          effectiveFrom: Date.now() + 60000,
          payload: {
            outletIds: [outlet],
            ...(kind === "focus"
              ? {
                  lines: [
                    {
                      productId: p1,
                      minimumBase: 1,
                      objective: "Secure shelf position",
                    },
                  ],
                }
              : {
                  productIds: [p1],
                  buildTargets: [{ date: day, outlets: 1 }],
                }),
          },
        },
      }),
    );
    const result = await preview(
      context(admin, { releaseId: release.id, outletIds: [outlet, other] }),
    );
    expect(result.kind).toBe(kind);
    expect(result.rows[0].label).toBe(label);
    expect(result.rows[0].lines).toBe(1);
    expect(result.rows[1].label).toBe("Not in this audience");
    expect(result.rows[1].lines).toBe(0);
  }
});

test("F-211 MSL precedence and ambiguous same-rank sets fail closed", () => {
  const store = { id: outlet, channel: "GT", classification: "A" };
  const broad = { id: "b", payload: { channel: "GT", priority: 0 } },
    specific = {
      id: "s",
      payload: { channel: "GT", classification: "A", priority: 0 },
    },
    override = { id: "o", payload: { outletIds: [outlet], priority: 0 } };
  expect(resolveSet(store, [broad, specific]).id).toBe("s");
  expect(resolveSet(store, [broad, specific, override]).id).toBe("o");
  expect(() =>
    resolveSet(store, [specific, { ...specific, id: "tie" }]),
  ).toThrow("equal precedence");
});
test("F-212 omitted MSL lines stay unmeasured; incomplete completion is refused", () => {
  const r = [{ productId: p1 }, { productId: p2 }];
  const a = checklist(r, [{ productId: p1, state: "present" }], false);
  expect(a.checked).toBe(1);
  expect(a.required).toBe(2);
  expect(a.lines[1].state).toBe("not_checked");
  expect(() =>
    checklist(r, [{ productId: p1, state: "present" }], true),
  ).toThrow("every MSL");
  expect(() =>
    checklist(r, [{ productId: p1, state: "absent", shelfBase: 2 }], false),
  ).toThrow("contradicts");
});
test("F-214 stocking ND and WD share all universe members and distinguish unknown", () => {
  const members = [
    { outletId: "a", turnoverWeight: 10 },
    { outletId: "b", turnoverWeight: 30 },
  ];
  expect(
    distribution(
      members,
      new Map([
        ["a", { state: "present" }],
        ["b", { state: "absent", backroomBase: 0 }],
      ]),
    ),
  ).toMatchObject({ ndPct: 50, wdPct: 25, unknown: 0 });
  expect(
    distribution(members, new Map([["a", { state: "present" }]])),
  ).toMatchObject({ ndPct: null, ndLowerPct: 50, wdPct: null, unknown: 1 });
  expect(
    distribution(
      [{ outletId: "a", turnoverWeight: null }],
      new Map([["a", { state: "present" }]]),
    ),
  ).toMatchObject({ ndPct: 100, wdPct: null, weightsKnown: false });
});
test("F-217 measured offtake conserves shelf/backroom/deliveries/returns and refuses negative demand", () => {
  expect(
    deriveOfftake(
      { shelfBase: 5, backroomBase: 5, at: 0 },
      {
        shelfBase: 2,
        backroomBase: 3,
        deliveredBase: 4,
        returnsBase: 1,
        at: 86400000,
      },
    ),
  ).toMatchObject({ quantityBase: 8, days: 1 });
  expect(
    deriveOfftake(
      { shelfBase: 1, backroomBase: 0, at: 0 },
      {
        shelfBase: 2,
        backroomBase: 0,
        deliveredBase: 0,
        returnsBase: 0,
        at: 86400000,
      },
    ),
  ).toBeNull();
});
test("F-213 F-218 cold-start absent MSL and focus SKU suggestions are explainable, never zero due only to no history", () => {
  const a = suggest(
    {
      absent: true,
      minimumBase: 2,
      historyDailyBase: null,
      stockBase: 0,
      focus: { minimumBase: 3, objective: "Launch trial" },
      upliftPct: 10,
    },
    { coverDays: 8 },
  );
  expect(a.quantityBase).toBe(3);
  expect(a.reasons.join(" ")).toContain("Absent MSL");
  expect(a.reasons.join(" ")).toContain("Launch trial");
});
test("F-211 draft preview/publish is versioned, scoped and detects a changed preview", async () => {
  const r = await tx(h.db, (/** @type {any} */ db) =>
    createRelease({
      ...context(admin, {
        kind: "focus",
        key: "launch",
        label: "Focus sample",
        sourceRef: "SAMPLE",
        sample: true,
        effectiveFrom: Date.now() + 10000,
        payload: {
          channel: "GT",
          lines: [
            { productId: p1, minimumBase: 1, objective: "Secure first order" },
          ],
        },
      }),
      db,
    }),
  );
  const input = { releaseId: r.id, outletIds: [outlet] };
  const p = await preview(context(admin, input));
  await expect(
    tx(h.db, (/** @type {any} */ db) =>
      publishRelease({
        ...context(admin, { ...input, previewHash: "stale" }),
        db,
      }),
    ),
  ).rejects.toThrow("Preview changed");
  const result = await tx(h.db, (/** @type {any} */ db) =>
    publishRelease({
      ...context(admin, { ...input, previewHash: p.hash }),
      db,
    }),
  );
  expect(result.duplicate).toBe(false);
  expect(
    (await h.db`select status from availability_releases where id=${r.id}`)[0]
      .status,
  ).toBe("published");
  await expect(createRelease(context(field, {}))).rejects.toThrow();
});
test("F-212 F-213 field checklist persists all lines, immutable snapshot, absent proposal and explicit acceptance", async () => {
  const snapshot = await tx(h.db, (/** @type {any} */ db) =>
    callSnapshot({ ...context(field), db }, outlet, day),
  );
  expect(snapshot.lines.length).toBe(2);
  const checkId = id();
  const payload = {
    checkId,
    snapshotId: snapshot.snapshotId,
    callKey,
    visitId,
    deviceTime: Date.now(),
    complete: true,
    lines: [
      { productId: p1, state: "present" },
      { productId: p2, state: "absent", backroomBase: 0 },
    ],
  };
  await tx(h.db, (/** @type {any} */ db) =>
    record({ ...context(field, payload), db }),
  );
  const [saved] =
    await h.db`select * from availability_checks where id=${checkId}`;
  expect(saved.required_count).toBe(2);
  expect(saved.proposals).toEqual([
    expect.objectContaining({ productId: p2, quantityBase: 1 }),
  ]);
  expect(await availabilityStepComplete(h.db, field.profile.id, callKey)).toBe(
    true,
  );
  expect(
    (
      await tx(h.db, (/** @type {any} */ db) =>
        record({ ...context(field, payload), db }),
      )
    ).entityId,
  ).toBe(checkId);
  await expect(
    tx(h.db, (/** @type {any} */ db) =>
      record({
        ...context(field, {
          ...payload,
          lines: [
            { productId: p1, state: "absent" },
            { productId: p2, state: "absent" },
          ],
        }),
        db,
      }),
    ),
  ).rejects.toThrow("different answers");
  await expect(
    (async () => {
      await h.db`update availability_checks set present_count=0 where id=${checkId}`;
    })(),
  ).rejects.toThrow("immutable");
  await expect(
    tx(h.db, (/** @type {any} */ db) =>
      record({
        ...context(field, {
          ...payload,
          checkId: id(),
          lines: [{ productId: p1, state: "present" }],
        }),
        db,
      }),
    ),
  ).rejects.toThrow("every MSL");
  const decision = {
    decisionId: id(),
    checkId,
    productId: p2,
    decision: "accepted",
    quantityBase: 4,
    orderKey: id(),
  };
  await tx(h.db, (/** @type {any} */ db) =>
    decideProposal({ ...context(field, decision), db }),
  );
  expect(
    (
      await h.db`select quantity_base from availability_proposal_decisions where check_id=${checkId}`
    )[0].quantity_base,
  ).toBe("4");
});
test("F-212 F-213 real signed van projection and push use the same checklist engine; suspended device cannot replay", async () => {
  const c = context(van, {}, "van-android");
  const snapshot = await tx(h.db, (/** @type {any} */ db) =>
    callSnapshot({ ...c, db }, outlet, day),
  );
  const operation = {
    clientOpId: id(),
    opType: "availability.record",
    clientTime: Date.now(),
    dependsOn: [],
    payload: {
      checkId: id(),
      snapshotId: snapshot.snapshotId,
      callKey: id(),
      tripId,
      deviceTime: Date.now(),
      complete: true,
      lines: [
        { productId: p1, state: "absent", backroomBase: 0 },
        { productId: p2, state: "present", method: "scan" },
      ],
    },
  };
  const request = {
    version: 2,
    app: "van-android",
    deviceId: van.deviceId,
    scopeId: unit,
    operations: [operation],
  };
  const result = await signedPost(h, van, "/api/sync/push", request);
  expect(result.res.status).toBe(200);
  expect(result.body.results[0].status).toBe("applied");
  expect(
    (
      await h.db`select checked_count from availability_checks where id=${operation.payload.checkId}`
    )[0].checked_count,
  ).toBe(2);
  await h.db`update registered_devices set status='suspended' where id=${van.deviceId}`;
  await expect(
    tx(h.db, (/** @type {any} */ db) =>
      record({
        ...c,
        db,
        device: { id: van.deviceId },
        payload: operation.payload,
      }),
    ),
  ).rejects.toThrow();
  await h.db`update registered_devices set status='active' where id=${van.deviceId}`;
});
test("F-214 F-215 F-220 cockpit ND/WD/OSA reconcile to one validated universe and exclude provisional stores", async () => {
  await expect(
    tx(h.db, (/** @type {any} */ db) =>
      createUniverse({
        ...context(admin, {
          label: "Invalid census",
          serviceDate: day,
          sample: false,
          sourceRef: "fixture",
          members: [
            {
              outletId: provisional,
              turnoverWeight: 1,
              validationRef: "not valid",
            },
          ],
        }),
        db,
      }),
    ),
  ).rejects.toThrow("unvalidated");
  await tx(h.db, (/** @type {any} */ db) =>
    createUniverse({
      ...context(admin, {
        label: "Validated sample universe",
        serviceDate: day,
        sample: false,
        sourceRef: "fixture census",
        members: [
          { outletId: outlet, turnoverWeight: 10, validationRef: "approved" },
          { outletId: other, turnoverWeight: 30, validationRef: "approved" },
        ],
      }),
      db,
    }),
  );
  const p = {
      from: day,
      to: day,
      channel: null,
      compare: { from: day, to: day },
    },
    s = { ids: [unit], ownProfileId: null };
  const a = await coverageAvailability(context(admin), p, s);
  expect(a.details.universe?.members).toBe(2);
  expect(a.details.rows.every((/** @type {any} */ r) => r.universe === 2)).toBe(
    true,
  );
  expect(a.details.rows[0].unknown).toBe(1);
  expect(a.details.rows[0].ndPct).toBeNull();
  expect(a.details.osa).toBe(50);
  expect(a.details.completeness).toBe(100);
  expect(a.details.billed).toBeNull();
  // Current ownership withdrawal removes historical identities as well as numerator data.
  await h.db`update outlets set custodian_org_unit_id=${foreignUnit} where id=${other}`;
  const b = await coverageAvailability(context(admin), p, s);
  expect(b.details.universe?.members).toBe(1);
  expect(
    b.details.depths.some((/** @type {any} */ r) => r.outletId === other),
  ).toBe(false);
  await h.db`update outlets set custodian_org_unit_id=${unit} where id=${other}`;
});
test("F-216 launch target cohort, build plan and no-order state are explicit", async () => {
  const [r] =
    await h.db`insert into availability_releases(kind,policy_key,version,label,status,effective_from,payload,source_ref,sample,actor_subject) values ('launch','new-product',1,'SAMPLE launch','published',${early},${{ productIds: [p1], outletIds: [outlet, other], buildTargets: [{ date: day, outlets: 1 }] }},'SAMPLE',true,'fixture') returning id`;
  const result = await launchStatus(
    context(admin),
    { ids: [unit], ownProfileId: null },
    r.id,
    day,
  );
  expect(result.targets).toBe(2);
  expect(result.curve[0]).toEqual({ date: day, plan: 1, actual: 0 });
  expect(result.rows[0].firstOrderDate).toBeNull();
});

test("F-211 F-214 marked sample policies never override real stores, policies or census", async () => {
  const { releasesAt } = await import("../src/domains/availability/masters.js");
  const real = {
    id: "real",
    sample: false,
    payload: { channel: "GT", priority: 0 },
  };
  const sample = {
    id: "sample",
    sample: true,
    payload: { channel: "GT", priority: 99, outletIds: [outlet] },
  };
  expect(
    resolveSet({ id: outlet, channel: "GT", is_sample: true }, [sample, real])
      .id,
  ).toBe("real");
  expect(
    resolveSet({ id: outlet, channel: "GT", is_sample: false }, [sample]),
  ).toBeNull();
  const [r] =
    await h.db`insert into availability_releases(kind,policy_key,version,label,status,effective_from,payload,source_ref,sample,actor_subject) values ('rules','real-rules',1,'Governed policy','published',${early},${{ coverDays: 9, freshnessDays: 7, universeFreshnessDays: 7 }},'governed',false,'fixture') returning id`;
  try {
    expect(
      (await releasesAt(h.db, "rules", Date.now())).map(
        (/** @type {any} */ x) => x.id,
      ),
    ).toEqual([r.id]);
    await h.db`insert into availability_universes(label,service_date,members,source_ref,sample,actor_subject) values ('Newer sample',${day},${[{ outletId: outlet, turnoverWeight: 1 }]},'SAMPLE',true,'fixture')`;
    const k = await coverageAvailability(
      context(admin),
      { from: day, to: day, channel: null, compare: { from: day, to: day } },
      { ids: [unit], ownProfileId: null },
    );
    expect(k.details.universe?.sample).toBe(false);
    expect(k.details.universe?.members).toBe(2);
  } finally {
    await h.db`delete from availability_releases where id=${r.id}`;
  }
});
test("F-212 offline capture uses device Start, not later server check-in receipt", async () => {
  const snapshot = await tx(h.db, (/** @type {any} */ db) =>
    callSnapshot({ ...context(field), db }, outlet, day),
  );
  const started = Date.now() - 3_600_000,
    captured = Date.now() - 1_800_000;
  await h.db`update visit_executions set started_at=${new Date(started)},checked_in_at=now() where id=${visitId}`;
  const payload = {
    checkId: id(),
    snapshotId: snapshot.snapshotId,
    callKey,
    visitId,
    deviceTime: captured,
    complete: true,
    lines: [
      { productId: p1, state: "present" },
      { productId: p2, state: "absent", backroomBase: 0 },
    ],
  };
  const r = await tx(h.db, (/** @type {any} */ db) =>
    record({ ...context(field, payload), db }),
  );
  expect(r.entityId).toBe(payload.checkId);
  expect(
    (
      await h.db`select device_time from availability_checks where id=${payload.checkId}`
    )[0].device_time.getTime(),
  ).toBe(captured);
});
test("F-212 authorized unplanned outlet has the same availability snapshot", async () => {
  const tomorrow = manilaDate(Date.now() + 86_400_000);
  const snapshot = await tx(h.db, (/** @type {any} */ db) =>
    callSnapshot({ ...context(field), db }, other, tomorrow),
  );
  expect(snapshot.setupNeeded).toBe(false);
  expect(snapshot.lines).toHaveLength(2);
});
test("F-213 newly assigned MSL SKUs authorize order capture without an Annex-C catalog", async () => {
  const { validateAccountCapture } =
    await import("../src/domains/visits/capture.js");
  const [visit] =
    await h.db`select * from visit_executions where id=${visitId}`;
  await validateAccountCapture(context(field), visit, {
    kind: "order_intent",
    lines: [{ productId: p2, uom: "PC" }],
  });
  await expect(
    validateAccountCapture(context(field), visit, {
      kind: "order_intent",
      lines: [{ productId: id(), uom: "PC" }],
    }),
  ).rejects.toThrow();
});
test("F-214 shelf absence with counted back-room stock is stocking, not OSA", () => {
  const members = [{ outletId: "a", turnoverWeight: 10 }];
  expect(
    distribution(
      members,
      new Map([["a", { state: "absent", shelfBase: 0, backroomBase: 5 }]]),
    ),
  ).toMatchObject({ ndPct: 100, wdPct: 100, stocking: 1 });
  expect(
    distribution(
      members,
      new Map([["a", { state: "absent", shelfBase: 0, backroomBase: null }]]),
    ),
  ).toMatchObject({ ndPct: null, wdPct: null, unknown: 1 });
  expect(
    distribution(
      members,
      new Map([["a", { state: "absent", shelfBase: 0, backroomBase: 0 }]]),
    ),
  ).toMatchObject({ ndPct: 0, wdPct: 0, absent: 1 });
});
test("F-217 missing interval deliveries/returns keeps derived offtake unknown", () => {
  const first = { shelfBase: 10, backroomBase: 0, at: 0 };
  const raw = checklist(
    [{ productId: p1 }],
    [{ productId: p1, state: "present", shelfBase: 10, backroomBase: 0 }],
    true,
  ).lines[0];
  expect(raw.deliveredBase).toBeNull();
  expect(raw.returnsBase).toBeNull();
  expect(deriveOfftake(first, { ...raw, at: 86_400_000 })).toBeNull();
  expect(
    deriveOfftake(first, {
      ...raw,
      deliveredBase: 10,
      returnsBase: 0,
      at: 86_400_000,
    }),
  ).toMatchObject({ quantityBase: 10 });
});
test("F-212 F-220 van evidence operations join the trip manifest authority", async () => {
  const rows =
    await h.db`select details->>'clientOpId' as id from van_audit_events where trip_id=${tripId} and kind='availability.record'`;
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBeString();
  const [receipt] =
    await h.db`select op_type from op_receipts where client_op_id=${rows[0].id}`;
  expect(receipt.op_type).toBe("availability.record");
});
test("F-215 F-220 non-void van checkout contributes one physical call and linked lines", async () => {
  const sale = id();
  await h.db`insert into van_sales(id,trip_id,receipt_number,outlet_id,total_centavos,receipt,captured_request) values (${sale},${tripId},${sale},${outlet},1000,${{}},${{}})`;
  await h.db`insert into van_sale_lines(sale_id,ordinal,product_id,quantity_base,total_centavos,facts) values (${sale},0,${p1},2,1000,${{}})`;
  const period = {
      from: day,
      to: day,
      channel: null,
      compare: { from: day, to: day },
    },
    scope = { ids: [unit], ownProfileId: null };
  const retail = await coverageAvailability(context(admin), period, scope);
  expect(retail.details.calls).toBe(1);
  expect(retail.details.strike).toBe(100);
  expect(retail.details.linesPerCall).toBe(1);
  expect(retail.details.covered).toBe(1);
  expect(retail.details.frequencyAchieved).toBe(50);
  expect(retail.details.callMetrics).toContainEqual(
    expect.objectContaining({ profileId: van.profile.id, orders: 1, lines: 1 }),
  );
  const [trip] =
    await h.db`select truck_location_id from van_trips where id=${tripId}`;
  await h.db`update inventory_locations set org_unit_id=${foreignUnit} where id=${trip.truck_location_id}`;
  try {
    expect(
      (
        await coverageAvailability(context(admin), period, {
          ids: [unit],
          ownProfileId: null,
        })
      ).details.calls,
    ).toBe(0);
  } finally {
    await h.db`update inventory_locations set org_unit_id=${unit} where id=${trip.truck_location_id}`;
  }
});
test("F-212 fresh transport UUID replay also joins the van close manifest", async () => {
  const [check] =
    await h.db`select * from availability_checks where trip_id=${tripId} order by device_time limit 1`;
  const payload = {
    checkId: check.id,
    snapshotId: check.snapshot_id,
    callKey: check.call_key,
    tripId,
    deviceTime: new Date(check.device_time).getTime(),
    complete: check.complete,
    lines: check.lines,
  };
  const op = {
    clientOpId: id(),
    opType: "availability.record",
    clientTime: Date.now(),
    dependsOn: [],
    payload,
  };
  const response = await signedPost(h, van, "/api/sync/push", {
    version: 2,
    app: "van-android",
    deviceId: van.deviceId,
    scopeId: unit,
    operations: [op],
  });
  expect(response.body.results[0].status).toBe("applied");
  expect(
    (
      await h.db`select id from van_audit_events where trip_id=${tripId} and details->>'clientOpId'=${op.clientOpId}`
    ).length,
  ).toBe(1);
  expect(
    (await h.db`select id from availability_checks where id=${check.id}`)
      .length,
  ).toBe(1);
});
