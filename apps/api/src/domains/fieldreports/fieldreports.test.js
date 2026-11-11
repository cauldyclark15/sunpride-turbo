import shapes from "./wire-shapes.json";
import { wireError } from "./wire-check.js";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  createUser,
  startHarness,
  deviceKey,
  registerDevice,
  nativeSignIn,
  bind,
  signedPost,
} from "../../../test/harness.js";
import { capabilitiesFor } from "../../core/capabilities.js";
import { today, addDays } from "./common.js";
import {
  countIn,
  cadenceState,
  oneMonthAfter,
  effectiveStatus,
  carriesOver,
  rootCauseDue,
  classifyVisit,
  completenessOf,
  reportDueAt,
  weekOf,
} from "./rules.js";

// Adjacent domains are deliberately not implemented in this lane.
mock.module("../org/scope.js", () => ({
  scopeFilterForActor: async (
    /** @type {any} */ _db,
    /** @type {any} */ actor,
  ) => ({
    unitIds: ["super_admin", "analyst"].includes(actor.role)
      ? null
      : [actor.orgUnitId],
  }),
  outletOwnerUnit: async (/** @type {any} */ db, /** @type {any} */ id) =>
    (await db`select custodian_org_unit_id from outlets where id=${id}`)[0]
      ?.custodian_org_unit_id ?? null,
}));
mock.module("../visits/productive.js", () => ({
  DEFAULT_PRODUCTIVE_RULE: "any_listed_activity",
  isProductive: (/** @type {any} */ facts) => ({
    productive: facts.activities.some(
      (/** @type {any} */ a) =>
        a.kind === "merchandising" || a.kind === "order_intent",
    ),
    reason: "mock governed activity",
  }),
}));
const { install } = await import("./index.js");
/** @type {import('../../../test/harness.js').Harness} */ let h;
/** @type {any} */ let unit;
/** @type {any} */ let otherUnit;
/** @type {any} */ let trainer;
/** @type {any} */ let rep;
/** @type {any} */ let outsider;
/** @type {any} */ let product;
/** @type {any} */ let outlet;
/** @type {any} */ let visit;
/** @type {any} */ let plan;
/** @type {any} */ let activity;
const d = today();
/** @param {string} role @param {string} name @param {any} unitId @param {any} positionId */
async function identity(role, name, unitId, positionId) {
  const email = name + "@test.example";
  const user = await createUser(h, email, "test-only-password");
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,position_id) values(${user},${user},${name},${email},${role},'active',${unitId},${positionId}) returning *`;
  const res = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "test-only-password" }),
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return { ...p, cookie };
}
/** @param {string} name @param {any} [args] @param {any} [who] */
async function get(name, args = {}, who = trainer) {
  const res = await h.fetch(
    "/api/v1/fieldreports/" +
      name.replaceAll(".", "/") +
      "?args=" +
      encodeURIComponent(JSON.stringify(args)),
    { headers: { cookie: who.cookie } },
  );
  const body = /** @type {any} */ (await res.json());
  if (res.status === 200) {
    const error = wireError(/** @type {any} */ (shapes)[name], body);
    expect(error, name).toBeNull();
  }
  return { status: res.status, body };
}
/** @param {string} name @param {any} body @param {any} [who] @param {string} [key] */
async function post(name, body, who = trainer, key = crypto.randomUUID()) {
  const res = await h.fetch(
    "/api/v1/fieldreports/" + name.replaceAll(".", "/"),
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie: who.cookie },
      body: JSON.stringify({ ...body, idempotencyKey: key }),
    },
  );
  const result = /** @type {any} */ (await res.json());
  if (res.status === 200)
    expect(
      wireError(/** @type {any} */ (shapes)[name], result),
      name,
    ).toBeNull();
  return { status: res.status, body: result };
}
/** @param {{status:number,body:any}} r */
function ok(r) {
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
test("DAR completeness reads the whole bounded team/week with one submission query", async () => {
  const { completeness } = await import("./reads.js");
  let queries = 0;
  const db = new Proxy(h.db, {
    apply(target, self, args) {
      if (
        Array.isArray(args[0]) &&
        Object.hasOwn(args[0], "raw") &&
        args[0].join(" ").includes("from field_day_reports")
      )
        queries++;
      return Reflect.apply(target, self, args);
    },
  });
  const result = await completeness(
    {
      db,
      actor: { profileId: trainer.id, role: "manager", orgUnitId: unit.id },
      now: Date.now(),
    },
    { endDate: d, days: 7 },
  );
  expect(result.people.length).toBeGreaterThan(0);
  expect(result.dates).toHaveLength(7);
  expect(queries).toBe(1);
});

test("a read snapshot loads the organization tree once, not once per gated row", async () => {
  const { markReadOnlySnapshot, subtree } = await import("../org/scope.js");
  const counting = () => {
    let n = 0;
    const db = new Proxy(h.db, {
      apply(target, self, args) {
        if (
          Array.isArray(args[0]) &&
          Object.hasOwn(args[0], "raw") &&
          args[0].join(" ").includes("from org_units where organization_id")
        )
          n++;
        return Reflect.apply(target, self, args);
      },
    });
    return { db, count: () => n };
  };
  const plain = counting();
  for (let i = 0; i < 5; i++) await subtree(plain.db, unit.id);
  expect(plain.count()).toBe(5); // unmarked handles (writers) always re-read
  const snap = counting();
  markReadOnlySnapshot(snap.db);
  const first = await subtree(snap.db, unit.id);
  for (let i = 0; i < 4; i++)
    expect(await subtree(snap.db, unit.id)).toEqual(first);
  expect(snap.count()).toBe(1);
});

test("team enumeration skips a trainer's coaching and talk records stored outside current scope", async () => {
  const [session] =
    await h.db`insert into work_with_sessions(organization_id,trainer_profile_id,trainee_profile_id,org_unit_id,service_date,objective,mode,status,created_by,updated_by) values('test',${trainer.id},${outsider.id},${otherUnit.id},${d},'training','booking','open','test','test') returning id`;
  try {
    const r = await get("supervision.team.cockpit", { serviceDate: d });
    expect(r.status).toBe(200);
    expect(
      r.body.rows.every((/** @type {any} */ p) => p.profileId !== outsider.id),
    ).toBe(true);
    expect(
      (await get("supervision.work_with.detail", { sessionId: session.id }))
        .status,
    ).toBe(403);
  } finally {
    await h.db`delete from work_with_sessions where id=${session.id}`;
  }
});

beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  h.setHooks({
    loadProfile: async (db, userId) => {
      const [p] = await db`select * from profiles where user_id=${userId}`;
      return p
        ? {
            id: p.id,
            userId,
            name: p.name,
            role: p.role,
            status: p.status,
            orgUnitId: p.org_unit_id,
          }
        : null;
    },
    unitInScope: async (_db, actor, id) => actor.orgUnitId === id,
  });
  [unit] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('test','A','Area A','region','active','2020-01-01') returning *`;
  [otherUnit] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('test','B','Area B','region','active','2020-01-01') returning *`;
  const [ds] =
    await h.db`insert into positions(organization_id,code,label,category,active) values('test','DS','Distributor Specialist','supervisory',true) returning *`;
  const [rds] =
    await h.db`insert into positions(organization_id,code,label,category,active) values('test','RDS','Route Distribution Salesman','field',true) returning *`;
  await h.db`insert into position_standards(organization_id,position_id,effective_from,work_with_weekly_min,work_with_monthly_min,selling_weekdays,source_ref) values('test',${ds.id},'2020-01-01',4,16,array[1,2,3,4,5,6],'Memo 2026-01-20')`;
  await h.db`insert into position_standards(organization_id,position_id,effective_from,daily_calls_target,productive_call_target_pct,productive_call_rule,selling_weekdays,source_ref) values('test',${rds.id},'2020-01-01',30,85,'truck_seller',array[1,2,3,4,5,6],'Memo and later call answers')`;
  trainer = await identity("manager", "Trainer", unit.id, ds.id);
  rep = await identity("sales", "Rep", unit.id, rds.id);
  outsider = await identity("sales", "Other", otherUnit.id, rds.id);
  for (const p of [trainer, rep, outsider])
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,position_id,supervisor_id,effective_from,actor_subject,reason) values(${p.id},${p.org_unit_id},${p.role},${p.position_id},${p.id === rep.id ? trainer.id : null},'2020-01-01','test','fixture')`;
  [product] =
    await h.db`insert into products(code,name,category,uom,unit_price,active,organization_id) values('P1','Canned example','Canned','piece',1,true,'test') returning *`;
  [outlet] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values('test','S1','Store One','active',${unit.id},'test') returning *`;
  [plan] =
    await h.db`insert into coverage_plans(organization_id,assignee_profile_id,local_month,version,cycle_type,org_unit_id,requested_from,requested_to,effective_from,effective_to,status,prepared_by,prepared_at,content_revision,created_by,updated_by) values('test',${rep.id},${d.slice(0, 7)},1,'monthly',${unit.id},'2020-01-01','2030-01-01','2020-01-01','2030-01-01','active','test',now(),1,'test','test') returning *`;
  const snapshot = {
    orgUnitId: unit.id,
    outletName: outlet.name,
    outletCode: outlet.code,
    activityKind: "merchandise",
  };
  const [slot] =
    await h.db`insert into coverage_plan_slots(slot_key,plan_id,assignee_profile_id,service_date,kind,outlet_id,sequence,expected_duration_minutes,approved_snapshot,content_revision,updated_by) values('one',${plan.id},${rep.id},${d},'outlet_visit',${outlet.id},1,30,${snapshot},1,'test') returning *`;
  const [pv] =
    await h.db`insert into planned_visits(generation_key,plan_id,plan_version,plan_slot_id,assignee_profile_id,outlet_id,service_date,status,approved_snapshot,intents,expected_duration_minutes,generated_at) values('one',${plan.id},1,${slot.id},${rep.id},${outlet.id},${d},'planned',${snapshot},${h.db.array(["merchandise"], "TEXT")},30,now()) returning *`;
  [visit] =
    await h.db`insert into visit_executions(organization_id,client_visit_id,planned_visit_id,plan_id,slot_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,intents,state,outcome,productivity,last_server_time,checked_in_at,checked_out_at,started_at) values('test','one',${pv.id},${plan.id},${slot.id},${rep.id},${outlet.id},${unit.id},${d},'planned',${h.db.array(["merchandise"], "TEXT")},'completed','completed','verified',now(),${new Date(d + "T08:00:00+08:00")},${new Date(d + "T08:30:00+08:00")},${new Date(d + "T08:00:00+08:00")}) returning *`;
  [activity] =
    await h.db`insert into visit_activities(organization_id,org_unit_id,visit_id,assignee_profile_id,outlet_id,activity_kind,activity,device_time,server_time) values('test',${unit.id},${visit.id},${rep.id},${outlet.id},'note',${{ note: "Only a note, no merchandising evidence" }},now(),now()) returning *`;
  await h.db`insert into visit_location_evidence(organization_id,org_unit_id,visit_id,event,latitude,longitude,provider,policy_version,result,review_status,device_time,server_time) values('test',${unit.id},${visit.id},'check_in',10,124,'gps','test','within_radius','verified',now(),now())`;
  const [rule] =
    await h.db`insert into visit_activity_rules(organization_id,intent,effective_from,source_ref,provisional,actor_subject) values('test','merchandise','2020-01-01','Memo',false,'test') returning *`;
  await h.db`insert into visit_activity_rule_activities(visit_activity_rule_id,ordinal,kind,required) values(${rule.id},0,'merchandising',true)`;
}, 30000);
afterAll(async () => {
  await h?.close();
});

for (const [label, weekly, monthly] of [
  ["Sr CDS", 1, 4],
  ["CDS", 3, 12],
  ["DS", 4, 16],
])
  test(`${label}: cadence counts completed service dates, not open or cancelled sessions`, () => {
    const sessions = [
      { serviceDate: "2026-10-05", status: "completed" },
      { serviceDate: "2026-10-06", status: "open" },
      { serviceDate: "2026-10-07", status: "cancelled" },
      { serviceDate: "2026-09-30", status: "completed" },
    ];
    expect(countIn(sessions, "2026-10-01", "2026-10-31")).toBe(1);
    expect(
      cadenceState(Number(weekly), Number(weekly), "2026-10-11", "2026-10-12"),
    ).toBe("met");
    expect(cadenceState(0, Number(monthly), "2026-10-31", "2026-11-01")).toBe(
      "behind",
    );
  });
test("Talk Sheet closes only at Completed, carries open and overdue, preserves calendar-month root cause", () => {
  expect(carriesOver("on_going")).toBe(true);
  expect(carriesOver("overdue")).toBe(true);
  expect(carriesOver("completed")).toBe(false);
  expect(
    effectiveStatus(
      { status: "on_going", timeline: "2026-10-01" },
      "2026-10-02",
    ),
  ).toBe("overdue");
  expect(oneMonthAfter("2026-01-31")).toBe("2026-02-28");
  expect(
    rootCauseDue({ status: "on_going", openedOn: "2026-09-19" }, "2026-10-19"),
  ).toBe(true);
});
test("10 PM Manila boundary: first late submission stays late even after correction", () => {
  const due = reportDueAt("2026-10-19");
  expect(
    completenessOf({
      serviceDate: "2026-10-19",
      sellingDay: true,
      firstSubmittedAt: null,
      now: due,
    }),
  ).toBe("due");
  expect(
    completenessOf({
      serviceDate: "2026-10-19",
      sellingDay: true,
      firstSubmittedAt: null,
      now: due + 1,
    }),
  ).toBe("missing");
  expect(
    completenessOf({
      serviceDate: "2026-10-19",
      sellingDay: true,
      firstSubmittedAt: due + 1,
      now: due + 100,
    }),
  ).toBe("late");
});
test("per-diem counterexample: completed planned merchandise call with note only is not eligible; complete activity bound participates in hash", async () => {
  let r = ok(
    await get("supervision.per_diem.validation", {
      from: d,
      to: d,
      profileId: rep.id,
    }),
  );
  expect(r.selected.items[0].reasons).toContain("forms_missing");
  expect(r.selected.totals.validCalls).toBe(0);
  const before = r.selected.contentHash;
  for (let i = 0; i < 55; i++)
    await h.db`insert into visit_activities(organization_id,org_unit_id,visit_id,assignee_profile_id,outlet_id,activity_kind,activity,device_time,server_time) values('test',${unit.id},${visit.id},${rep.id},${outlet.id},'note',${{ note: "prefix " + i }},now(),now())`;
  await h.db`insert into visit_activities(organization_id,org_unit_id,visit_id,assignee_profile_id,outlet_id,activity_kind,activity,device_time,server_time) values('test',${unit.id},${visit.id},${rep.id},${outlet.id},'merchandising',${{ completed: true }},now(),now())`;
  r = ok(
    await get("supervision.per_diem.validation", {
      from: d,
      to: d,
      profileId: rep.id,
    }),
  );
  expect(r.selected.contentHash).not.toBe(before);
  expect(r.selected.items[0].missingForms).toEqual([]);
  expect(r.selected.totals.validCalls).toBe(1);
  expect(
    (
      await post("supervision.per_diem.decide", {
        from: d,
        to: d,
        profileId: rep.id,
        contentHash: before,
        decision: "validated",
      })
    ).status,
  ).toBe(409);
  const decision = ok(
    await post("supervision.per_diem.decide", {
      from: d,
      to: d,
      profileId: rep.id,
      contentHash: r.selected.contentHash,
      decision: "validated",
    }),
  );
  expect(
    (
      await h.db`select valid_calls from per_diem_validations where id=${decision}`
    )[0].valid_calls,
  ).toBe(1);
  // WEB-120: the claims list (no person picked) carries the decision, so it sticks after a reload.
  const list = ok(await get("supervision.per_diem.validation", { from: d, to: d }));
  const row = list.people.find((/** @type {any} */ x) => x.profileId === rep.id);
  expect(row.latest).toMatchObject({ decision: "validated" });
  expect(typeof row.latest.decidedAt).toBe("number");
});
test("DSR MTD uses the exact analytics sales source: order lines, not header totals; rejected/draft/voided excluded; returned signed lines count", async () => {
  await h.db`insert into customers(code,name,channel,territory,credit_limit,active) values ('C1','Store account','GT','Area A',0,true)`;
  await h.db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) select ${outlet.id},id,'test','2020-01-01','test','fixture' from customers where code='C1'`;
  const statuses = [
    "draft",
    "submitted",
    "pending_approval",
    "approved",
    "rejected",
    "sent_to_sap",
    "fulfilled",
    "posted",
    "partially_voided",
    "voided",
    "returned",
    "review_required",
  ];
  for (const status of statuses) {
    const [o] =
      await h.db`insert into orders(organization_id,client_request_id,order_number,customer_code,salesperson_subject,status,subtotal,total,created_at) values('test',${crypto.randomUUID()},${crypto.randomUUID()},'C1',${rep.user_id},${status},99999,99999,${new Date(d + "T09:00:00+08:00")}) returning id`;
    await h.db`insert into order_lines(order_id,product_code,description,quantity,unit_price,line_total) values(${o.id},'P1','Sample',1,1.11,${status === "returned" ? "-1.11" : "1.11"})`;
  }
  await h.db`insert into sales_targets(organization_id,subject_kind,profile_id,period,metric,value,effective_from,source_ref,created_by) values('test','employee',${rep.id},'monthly','sales_value',10000,'2020-01-01','Sample target','test')`;
  const [source] =
    await h.db`select sum(l.line_total*100)::bigint sales from orders o join order_lines l on l.order_id=o.id where o.salesperson_subject=${rep.user_id} and o.status not in ('draft','rejected','voided')`;
  const r = ok(
    await get("dsr.report.day", { profileId: rep.id, serviceDate: d }),
  );
  expect(r.totals.mtdSales).toBe(Number(source.sales));
  expect(r.totals.todaySales).toBe(Number(source.sales));
  expect(
    r.categories.reduce(
      (/** @type {number} */ n, /** @type {any} */ c) => n + c.mtdSales,
      0,
    ),
  ).toBe(Number(source.sales));
  expect(r.trend.at(-1).cumulative).toBe(Number(source.sales));
  expect(r.targets.monthly).toBe(1000000);
  expect(r.totals.balanceToSell).toBe(1000000 - Number(source.sales));
  const team = ok(await get("dsr.report.team", { serviceDate: d }));
  expect(team.totals.mtdSales).toBe(r.totals.mtdSales);
});
test("scope and self-only gates refuse foreign reads and analyst writes before any replay", async () => {
  expect(
    (await get("dsr.report.day", { profileId: outsider.id, serviceDate: d }))
      .status,
  ).toBe(403);
  expect(
    (
      await get(
        "dsr.report.day",
        { profileId: trainer.id, serviceDate: d },
        rep,
      )
    ).status,
  ).toBe(403);
  expect(
    (await get("supervision.team.day", { serviceDate: d }, rep)).status,
  ).toBe(403);
});
test("Work-With persists, refuses incomplete completion, counts only completed session and freezes training forms through acknowledgement", async () => {
  const body = {
    traineeProfileId: rep.id,
    serviceDate: d,
    objective: "training",
    mode: "booking",
  };
  const key = crypto.randomUUID();
  const sid = ok(await post("supervision.work_with.start", body, trainer, key));
  expect(
    ok(await post("supervision.work_with.start", body, trainer, key)),
  ).toBe(sid);
  expect(
    (
      await post(
        "supervision.work_with.start",
        { ...body, mode: "truck", truckReference: "T1" },
        trainer,
        key,
      )
    ).status,
  ).toBe(409);
  expect(
    (await post("supervision.work_with.complete", { sessionId: sid })).status,
  ).toBe(422);
  ok(
    await post("supervision.work_with.update", {
      sessionId: sid,
      observations: [
        { area: "bcp", item: "Review plans", rating: "met" },
        { area: "psf", item: "Presentation", rating: "met" },
      ],
      trainingLog: {
        topics: "Store coaching",
        tradeDevelopment: "Expand shelves",
        discussedWithTrainee: true,
      },
    }),
  );
  ok(await post("supervision.work_with.complete", { sessionId: sid }));
  const cad = ok(
    await get("supervision.work_with.cadence", { serviceDate: d }),
  );
  expect(cad.trainers[0].weeklyMin).toBe(4);
  expect(cad.trainers[0].monthlyMin).toBe(16);
  expect(cad.trainers[0].weekCount).toBe(1);
  expect(cad.trainers[0].monthCount).toBe(1);
  const fid = ok(
    await post("supervision.trainer_forms.create", {
      sessionId: sid,
      kind: "training_sheet",
    }),
  );
  expect(
    (await post("supervision.trainer_forms.sign", { formId: fid })).status,
  ).toBe(422);
  ok(
    await post("supervision.trainer_forms.update", {
      formId: fid,
      sheet: {
        objective: "Coach",
        result: "Learned",
        learnings: "Call steps",
        nextSteps: "Practice",
      },
    }),
  );
  ok(await post("supervision.trainer_forms.sign", { formId: fid }));
  expect(
    (await post("supervision.trainer_forms.update", { formId: fid, sheet: {} }))
      .status,
  ).toBe(403);
  expect(
    (await post("supervision.trainer_forms.acknowledge", { formId: fid }))
      .status,
  ).toBe(403);
  ok(
    await post(
      "supervision.trainer_forms.acknowledge",
      { formId: fid, comment: "Discussed" },
      rep,
    ),
  );
  const f = ok(await get("supervision.trainer_forms.detail", { formId: fid }));
  expect(f.form.status).toBe("acknowledged");
  expect(f.form.signedAt).toBeGreaterThan(0);
  expect(f.form.acknowledgedAt).toBeGreaterThan(0);
});
test("Talk Sheet chain carries open actions with original age; cannot omit carried line or finalize a month-old gap without root cause", async () => {
  const firstDate = addDays(d, -31);
  const sid = ok(
    await post("supervision.talk_sheet.create", {
      partnerName: "Sample Partner",
      meetingDate: firstDate,
    }),
  );
  ok(
    await post("supervision.talk_sheet.save", {
      sheetId: sid,
      acknowledgedByName: "Sample partner",
      nextContactDate: d,
      items: [
        {
          topic: "buying_accounts",
          gap: "Lost buyers",
          agreement: "Visit",
          correctiveAction: "Review route",
          responsible: "Trainer",
          timeline: addDays(d, -1),
          status: "on_going",
        },
      ],
    }),
  );
  ok(await post("supervision.talk_sheet.finalize", { sheetId: sid }));
  const next = ok(
    await post("supervision.talk_sheet.create", {
      partnerName: "  sample   partner ",
      meetingDate: d,
    }),
  );
  const r = ok(await get("supervision.talk_sheet.detail", { sheetId: next }));
  expect(r.items[0].carried).toBe(true);
  expect(r.items[0].rootCauseDue).toBe(true);
  expect(r.items[0].item.openedOn).toBe(firstDate);
  expect(
    (await post("supervision.talk_sheet.save", { sheetId: next, items: [] }))
      .status,
  ).toBe(422);
  ok(
    await post("supervision.talk_sheet.save", {
      sheetId: next,
      acknowledgedByName: "Sample partner",
      nextContactDate: addDays(d, 7),
    }),
  );
  expect(
    (await post("supervision.talk_sheet.finalize", { sheetId: next })).status,
  ).toBe(422);
  const i = r.items[0].item;
  ok(
    await post("supervision.talk_sheet.save", {
      sheetId: next,
      items: [
        {
          ...i,
          itemId: i._id,
          status: "completed",
          rootCause: "Route never covered the district",
        },
      ],
    }),
  );
  ok(await post("supervision.talk_sheet.finalize", { sheetId: next }));
  const register = ok(
    await get("supervision.talk_sheet.register", { serviceDate: d }),
  );
  expect(register.openItems).toHaveLength(0);
});
test("DAR/ROAR revisions freeze submitted summary and preserve first submission completeness", async () => {
  const before = ok(
    await get("field_reports.reports.day", { serviceDate: d }, rep),
  );
  expect(before.kind).toBe("roar");
  const key = crypto.randomUUID();
  const sub = ok(
    await post(
      "field_reports.reports.submit",
      { serviceDate: d, remarks: "Daily route report" },
      rep,
      key,
    ),
  );
  expect(sub.revision).toBe(1);
  expect(
    ok(
      await post(
        "field_reports.reports.submit",
        { serviceDate: d, remarks: "Daily route report" },
        rep,
        key,
      ),
    ).revision,
  ).toBe(1);
  const after = ok(
    await get("field_reports.reports.day", { serviceDate: d }, rep),
  );
  expect(after.submission.summary).toEqual(sub.summary);
  expect(after.revisions).toBe(1);
  const grid = ok(
    await get("field_reports.reports.completeness", { endDate: d, days: 7 }),
  );
  expect(
    grid.people.some((/** @type {any} */ p) => p.profileId === rep.id),
  ).toBe(true);
});
test("call-sheet catalog revisions, conflict and captured entries are persisted and auditable", async () => {
  const boss = await identity("super_admin", "Boss", unit.id, null);
  const input = {
    outletId: outlet.id,
    expectedRevision: null,
    header: { accountName: "Store One" },
    lines: [{ productId: product.id, pricing: "Sample pricing" }],
  };
  expect(ok(await post("callSheets.accounts.save", input, boss)).revision).toBe(
    1,
  );
  expect((await post("callSheets.accounts.save", input, boss)).status).toBe(
    409,
  );
  const second = ok(
    await post(
      "callSheets.accounts.save",
      { ...input, expectedRevision: 1 },
      boss,
    ),
  );
  expect(second.revision).toBe(2);
  expect(
    await h.db`select * from call_sheet_account_revisions where outlet_id=${outlet.id}`,
  ).toHaveLength(1);
  const [a] =
    await h.db`insert into visit_activities(organization_id,org_unit_id,visit_id,assignee_profile_id,outlet_id,activity_kind,activity,device_time,server_time) values('test',${unit.id},${visit.id},${rep.id},${outlet.id},'call_sheet',${{ templateRevision: 2, lines: [{ productId: product.id, order: 3, beginningInventory: 10, take: 2, delivered: 3, offtake: 4, endInventory: 9 }] }},now(),now()) returning id`;
  ok(await post("callSheets.entries.record", { activityId: a.id }, rep));
  const report = ok(
    await get(
      "callSheets.report.month",
      { outletId: outlet.id, localMonth: d.slice(0, 7) },
      boss,
    ),
  );
  expect(report.capturedVisits).toBe(1);
  expect(
    report.rows[0].weeks.reduce(
      (/** @type {number} */ n, /** @type {any} */ w) => n + (w.order ?? 0),
      0,
    ),
  ).toBe(3);
  expect(
    Number((await h.db`select count(*) n from field_report_audit`)[0].n),
  ).toBeGreaterThan(0);
  expect(
    Number(
      (
        await h.db`select count(*) n from change_log where entity='call_sheet_accounts'`
      )[0].n,
    ),
  ).toBeGreaterThan(0);
});

test("native field.sales and team.summary projections use signed v2 pull and scoped DTOs", async () => {
  const key = await deviceKey();
  const deviceId = await registerDevice(h, {
    profileId: trainer.id,
    orgUnitId: unit.id,
    key,
  });
  const signed = await nativeSignIn(
    h,
    trainer.email,
    "test-only-password",
    "field-android",
    { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
  );
  expect(
    (await bind(h, signed.body.accessToken, deviceId, key)).res.status,
  ).toBe(200);
  const who = { access: signed.body.accessToken, deviceId, key };
  for (const [projection, params] of /** @type {[string,any][]} */ ([
    ["field.sales", { profileId: rep.id, serviceDate: d }],
    ["team.summary", { serviceDate: d, directOnly: true }],
  ])) {
    const result = await signedPost(h, who, "/api/sync/pull", {
      version: 2,
      app: "field-android",
      deviceId,
      since: null,
      pageCursor: null,
      scopes: [{ scopeId: unit.id, projection, params }],
      limit: 100,
    });
    expect(result.res.status, JSON.stringify(result.body)).toBe(200);
    const data = result.body.bundles[0].data;
    if (projection === "field.sales") {
      const report = ok(
        await get("dsr.report.day", { profileId: rep.id, serviceDate: d }),
      );
      expect(data.totals.mtdSales).toBe(report.totals.mtdSales);
      expect(data.calls).toEqual({
        productiveCallRule: report.calls.productiveCallRule,
        calls: report.calls.calls,
        productiveCalls: report.calls.productiveCalls,
      });
      expect(Object.keys(data).sort()).toEqual([
        "calls",
        "serviceDate",
        "targets",
        "totals",
      ]);
    } else {
      expect(data.people.map((/** @type {any} */ p) => p.profileId)).toEqual([
        rep.id,
      ]);
      expect(data.directOnly).toBe(true);
      expect(JSON.stringify(data)).not.toContain("latitude");
    }
  }
});
test("finished-command replay is stable, but current scope withdrawal wins before replay", async () => {
  const startKey = crypto.randomUUID();
  const startBody = {
    traineeProfileId: rep.id,
    serviceDate: d,
    objective: "training",
    mode: "booking",
  };
  const sid = ok(
    await post("supervision.work_with.start", startBody, trainer, startKey),
  );
  ok(
    await post("supervision.work_with.update", {
      sessionId: sid,
      observations: [
        { area: "bcp", item: "Review", rating: "met" },
        { area: "psf", item: "Present", rating: "met" },
      ],
      trainingLog: {
        topics: "Coach",
        tradeDevelopment: "Shelf",
        discussedWithTrainee: true,
      },
    }),
  );
  const key = crypto.randomUUID();
  ok(
    await post(
      "supervision.work_with.complete",
      { sessionId: sid },
      trainer,
      key,
    ),
  );
  expect(
    ok(
      await post(
        "supervision.work_with.complete",
        { sessionId: sid },
        trainer,
        key,
      ),
    ),
  ).toBeNull();
  await h.db`update employee_assignments set org_unit_id=${otherUnit.id} where profile_id=${rep.id}`;
  try {
    expect(
      (await post("supervision.work_with.start", startBody, trainer, startKey))
        .status,
    ).toBe(403);
    expect(
      (await get("dsr.report.day", { profileId: rep.id, serviceDate: d }))
        .status,
    ).toBe(403);
  } finally {
    await h.db`update employee_assignments set org_unit_id=${unit.id} where profile_id=${rep.id}`;
  }
  const analyst = await identity("analyst", "Analyst", unit.id, null);
  expect(
    (
      await post(
        "field_reports.reports.submit",
        { serviceDate: d, remarks: "Denied" },
        analyst,
      )
    ).status,
  ).toBe(403);
});

test("Annex D and G freeze trainer signatures, trainee acknowledgement and actual evaluation session dates", async () => {
  const [s] =
    await h.db`select id from work_with_sessions where trainer_profile_id=${trainer.id} and status='completed' order by completed_at limit 1`;
  const programId = ok(
    await post("supervision.trainer_forms.create", {
      sessionId: s.id,
      kind: "training_program",
    }),
  );
  ok(
    await post("supervision.trainer_forms.update", {
      formId: programId,
      program: {
        area: "Area A",
        objectives: ["Improve calls"],
        strengths: "Knows accounts",
        improvementAreas: "Close each call",
        plansForNextContact: "Review next week",
      },
    }),
  );
  ok(await post("supervision.trainer_forms.sign", { formId: programId }));
  ok(
    await post(
      "supervision.trainer_forms.acknowledge",
      { formId: programId },
      rep,
    ),
  );
  const evaluationId = ok(
    await post("supervision.trainer_forms.create", {
      sessionId: s.id,
      kind: "job_evaluation",
    }),
  );
  const ratings = [
    "preparation",
    "trade_coverage",
    "call_procedure",
    "closing_day",
    "area_management",
    "sales_qualities",
    "others",
  ].map((section, i) => ({
    item:
      section +
      "." +
      [
        "review_plans",
        "route_order",
        "close",
        "fund_accounting",
        "meeting_objectives",
        "initiative",
        "account_penetration",
      ][i],
    rating: 2,
  }));
  const content = {
    periodStart: d,
    periodEnd: d,
    district: "Sample district",
    area: "Area A",
    ratings,
    overall: 2,
    remarks: "Sample evaluation",
  };
  expect(
    (
      await post("supervision.trainer_forms.update", {
        formId: evaluationId,
        evaluation: { ...content, periodEnd: "not-a-date" },
      })
    ).status,
  ).toBe(400);
  ok(
    await post("supervision.trainer_forms.update", {
      formId: evaluationId,
      evaluation: content,
    }),
  );
  ok(await post("supervision.trainer_forms.sign", { formId: evaluationId }));
  ok(
    await post(
      "supervision.trainer_forms.acknowledge",
      { formId: evaluationId },
      rep,
    ),
  );
  const detail = ok(
    await get("supervision.trainer_forms.detail", { formId: evaluationId }),
  );
  expect(detail.form.evaluationSessions.length).toBeGreaterThan(0);
  expect(
    detail.form.evaluationSessions.every(
      (/** @type {any} */ r) => r.serviceDate === d,
    ),
  ).toBe(true);
  const history = ok(
    await get("supervision.trainer_forms.program", {
      traineeProfileId: rep.id,
    }),
  );
  expect(
    history.blocks.some((/** @type {any} */ b) => b.formId === programId),
  ).toBe(true);
  expect(history.latestEvaluation.formId).toBe(evaluationId);
});

test("every management read returns real data without a server error", async () => {
  for (const [name, args] of [
    ["supervision.team.options", { serviceDate: d }],
    ["supervision.team.day", { serviceDate: d }],
    ["supervision.team.cockpit", { serviceDate: d }],
    ["supervision.activity.map", { serviceDate: d }],
    ["supervision.exceptions.queue", { serviceDate: d }],
    ["analytics.productivity.roster", { endDate: d }],
    ["analytics.productivity.person", { profileId: rep.id, from: d, to: d }],
    ["supervision.work_with.mine", { serviceDate: d }],
    ["supervision.trainer_forms.mine", {}],
    ["supervision.trainer_forms.program", { traineeProfileId: rep.id }],
    ["supervision.talk_sheet.mine", {}],
    ["dsr.report.salesmen", { serviceDate: d }],
    [
      "callSheets.accounts.list",
      { paginationOpts: { numItems: 20, cursor: null } },
    ],
  ])
    ok(await get(String(name), args));
});
