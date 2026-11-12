import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";
import { capabilitiesFor } from "../src/core/capabilities.js";
import {
  install,
  command,
  activateDue,
} from "../src/domains/coverage/index.js";
import { read } from "../src/domains/coverage/reads.js";
import { assertNotLocked } from "../src/domains/coverage/lock.js";
import { tx } from "@sunpride/db/client";
import { recordChange } from "../src/core/sync.js";
import { localDate, dto } from "../src/domains/coverage/model.js";
import {
  deadlineState,
  mcpDeadlines,
} from "../src/domains/coverage/deadlines.js";

/** @type {Awaited<ReturnType<typeof startHarness>>} */ let h;
/** @type {any} */ let platform;
/** @type {any} */ let unit;
/** @type {any} */ let position;
/** @type {any} */ let sales;
/** @type {any} */ let supervisor;
/** @type {any} */ let manager;
/** @type {any} */ let territory;
/** @type {any} */ let route;
/** @type {any} */ let outlet;
const now = Date.parse("2026-10-15T12:00:00+08:00");
/** @param {string} name @param {string} role @param {string|null} boss */
async function person(name, role, boss = null) {
  const db = h.db;
  const [u] =
    await db`insert into users(email,password_hash) values (${`${name}@example.com`},'test-unused') returning id`;
  const [p] =
    await db`insert into profiles(user_id,name,email,role,status,org_unit_id,position_id) values (${u.id},${name},${`${name}@example.com`},${role},'active',${unit.id},${position.id}) returning *`;
  await db`insert into employee_assignments(profile_id,org_unit_id,role,position_id,supervisor_id,effective_from,actor_subject,reason) values (${p.id},${unit.id},${role},${position.id},${boss},${new Date(now)},${u.id},'Fixture')`;
  return p;
}
/** @param {any} p @param {number} [clock] */
const ctx = (p, clock = now) => ({
  db: h.db,
  now: clock,
  actor: {
    profileId: p.id,
    userId: p.user_id,
    subject: p.user_id,
    role: p.role,
    orgUnitId: p.org_unit_id,
    capabilities: new Set(capabilitiesFor(p.role)),
  },
  publish: async () => {},
});
/** @param {any} p @param {string} action @param {any} body @param {number} [clock] */
const run = (p, action, body, clock = now) =>
  command(ctx(p, clock), platform, action, {
    ...body,
    idempotencyKey: body.idempotencyKey ?? crypto.randomUUID(),
  });
/** @param {string} date */
const slot = (date) => ({
  slotKey: `visit:${date}`,
  serviceDate: date,
  kind: "outlet_visit",
  outletId: outlet.id,
  routeId: route.id,
  sequence: 1,
  expectedDurationMinutes: 30,
  requiredObjectives: ["sell"],
  intents: ["sell"],
});
const roster = () => [
  {
    outletId: outlet.id,
    territoryId: territory.id,
    routeId: route.id,
    frequency: "monthly",
    preferredWeekdays: [],
    customLocalDates: [],
    priority: 1,
    expectedDurationMinutes: 30,
    requiredObjectives: ["sell"],
  },
];
beforeAll(async () => {
  h = await startHarness({
    installers: [
      (/** @type {any} */ r, /** @type {any} */ p) => {
        platform = p;
        install(r, p);
      },
    ],
  });
  const db = h.db;
  [unit] =
    await db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values ('sunpride','CEB','Cebu','region','active',${new Date(now - 86400000)}) returning *`;
  [position] =
    await db`insert into positions(organization_id,code,label,category,active) values ('sunpride','KAS','Key Accounts','field',true) returning *`;
  manager = await person("Manager", "manager");
  supervisor = await person("Supervisor", "manager", manager.id);
  sales = await person("Salesperson", "sales", supervisor.id);
  [territory] =
    await db`insert into territories(organization_id,code,name,status,effective_from,created_by) values ('sunpride','CEB','Cebu','active',${new Date(now)},${manager.user_id}) returning *`;
  await db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values (${territory.id},${unit.id},${new Date(now)},${manager.user_id},'Fixture')`;
  [route] =
    await db`insert into routes(organization_id,code,name,status,effective_from,created_by) values ('sunpride','R1','North route','active',${new Date(now)},${manager.user_id}) returning *`;
  await db`insert into route_territories(route_id,territory_id,effective_from,actor_subject,reason) values (${route.id},${territory.id},${new Date(now)},${manager.user_id},'Fixture')`;
  await db`insert into route_salespeople(route_id,profile_id,is_primary,effective_from,actor_subject,reason) values (${route.id},${sales.id},true,${new Date(now)},${manager.user_id},'Fixture')`;
  [outlet] =
    await db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values ('sunpride','STORE1','Corner store','active',${unit.id},${manager.user_id}) returning *`;
  await db`insert into outlet_assignments(outlet_id,territory_id,route_id,sequence,effective_from,actor_subject,reason) values (${outlet.id},${territory.id},${route.id},1,${new Date(now)},${manager.user_id},'Fixture')`;
  await db`insert into position_standards(organization_id,position_id,effective_from,daily_calls_target,selling_weekdays,source_ref) values ('sunpride',${position.id},${new Date(now)},5,ARRAY[1,2,3,4,5,6],'Client memo')`;
  const [template] =
    await db`insert into position_routine_templates(organization_id,position_id,effective_from,weekday,day_kind,source_ref,provisional,actor_subject) values ('sunpride',${position.id},${new Date(now)},0,'day_off','Client memo',false,${manager.user_id}) returning id`;
  await db`insert into position_routine_template_activities(position_routine_template_id,ordinal,sequence,name,kind) values (${template.id},0,1,'Day off','non_visit')`;
}, 30000);
afterAll(async () => {
  await h?.close();
});

/** @type {any} */ let approved;
test("create → saveOutlets → routines → saveSlots → submit → approve → activate; midday hires use live lookup", async () => {
  const p = await run(sales, "plans/create", {
    assigneeProfileId: sales.id,
    localMonth: "2026-10",
  });
  expect(p.effectiveFrom).toBe(localDate("2026-10-15"));
  await run(sales, "plans/saveOutlets", { planId: p._id, outlets: roster() });
  const templates = await read(ctx(sales), "routines/listForPosition", {
    planId: p._id,
  });
  expect(templates.templates).toHaveLength(1);
  const applied = await run(sales, "routines/applyToDraft", { planId: p._id });
  expect(applied.created).toBe(2);
  await run(sales, "plans/saveSlots", {
    planId: p._id,
    slots: [slot("2026-10-16")],
  });
  await run(sales, "plans/submit", { planId: p._id });
  approved = await run(supervisor, "plans/approve", { planId: p._id });
  expect(approved.contentHash).toMatch(/^[0-9a-f]{64}$/);
  expect(approved.approvalCapacity).toBe("supervisor");
  const key = crypto.randomUUID();
  const first = await run(supervisor, "activation/activate", {
    planId: p._id,
    idempotencyKey: key,
  });
  expect(first.count).toBe(1);
  expect(
    await run(supervisor, "activation/activate", {
      planId: p._id,
      idempotencyKey: key,
    }),
  ).toEqual(first);
  expect(
    await run(
      supervisor,
      "activation/activate",
      { planId: p._id },
      now + 86400000,
    ),
  ).toEqual(first);
  const [v] = await h.db`select * from planned_visits where plan_id=${p._id}`;
  expect(v.approved_snapshot.outletName).toBe("Corner store");
  await h.db`update outlets set name='Renamed store' where id=${outlet.id}`;
  const view = await read(ctx(supervisor), "exports/schedule", {
    planId: p._id,
    paginationOpts: { numItems: 20, cursor: null },
  });
  expect(view.page[0].name).toBe("Corner store");
  expect(
    (await read(ctx(supervisor), "review", { planId: p._id })).planned,
  ).toBe(1);
});
test("same-day hire approval rejects with the dated message and zero plan, slot, audit or command writes", async () => {
  const sales = await person("SameDay", "sales", supervisor.id);
  await h.db`insert into route_salespeople(route_id,profile_id,is_primary,effective_from,actor_subject,reason) values (${route.id},${sales.id},false,${new Date(now)},${manager.user_id},'Fixture')`;
  const p = await run(sales, "plans/create", {
    assigneeProfileId: sales.id,
    localMonth: "2026-10",
  });
  await run(sales, "plans/saveOutlets", { planId: p._id, outlets: roster() });
  await run(sales, "plans/saveSlots", {
    planId: p._id,
    slots: [slot("2026-10-15")],
  });
  await run(sales, "plans/submit", { planId: p._id });
  const before = await read(ctx(sales), "plans/detail", { planId: p._id });
  const audit =
    await h.db`select * from coverage_audit_events where plan_id=${p._id}`;
  const [count] = await h.db`select count(*) as n from coverage_commands`;
  await expect(
    run(supervisor, "plans/approve", { planId: p._id }),
  ).rejects.toThrow("Assignee not assigned on 2026-10-15");
  expect(await read(ctx(sales), "plans/detail", { planId: p._id })).toEqual(
    before,
  );
  expect(
    await h.db`select * from coverage_audit_events where plan_id=${p._id}`,
  ).toEqual(audit);
  expect((await h.db`select count(*) as n from coverage_commands`)[0].n).toBe(
    count.n,
  );
});
test("manager substitutes only while supervisor is away; self/preparer approval never allowed", async () => {
  const p = await run(sales, "plans/create", {
    assigneeProfileId: sales.id,
    localMonth: "2026-11",
  });
  await run(sales, "plans/saveOutlets", { planId: p._id, outlets: roster() });
  await run(sales, "plans/saveSlots", {
    planId: p._id,
    slots: [slot("2026-11-02")],
  });
  await run(sales, "plans/submit", { planId: p._id });
  await expect(
    run(manager, "plans/approve", { planId: p._id }),
  ).rejects.toThrow("direct supervisor");
  const away = await run(manager, "away/record", {
    profileId: supervisor.id,
    fromDate: "2026-10-15",
    toDate: "2026-10-16",
    reason: "Leave",
  });
  const approved = await run(manager, "plans/approve", { planId: p._id });
  expect(approved.approvalCapacity).toBe("backup");
  expect(approved.approvedOnBehalfOfProfileId).toBe(supervisor.id);
  await run(manager, "away/end", { awayId: away._id });
});
test("deadline last-week and first-week boundaries are Manila, preserving late history", () => {
  const d = mcpDeadlines("2026-11");
  expect(d.submissionOpensDate).toBe("2026-10-25");
  expect(d.approvalDueDate).toBe("2026-11-07");
  expect(deadlineState(d, null, d.submissionDueAt).state).toBe("overdue");
  expect(
    deadlineState(
      d,
      { status: "submitted", submitted_at: new Date(d.submissionDueAt) },
      d.approvalDueAt,
    ),
  ).toMatchObject({ state: "approval_overdue", submittedLate: true });
  expect(
    deadlineState(
      d,
      { status: "approved", approved_at: new Date(d.approvalDueAt) },
      d.approvalDueAt,
    ).state,
  ).toBe("approved_late");
});
test("summary includes not-started people, current statuses, late people, my queue, prior and trend", async () => {
  const unused = await person("Newperson", "sales", supervisor.id);
  const s = await read(ctx(supervisor), "summary", { month: "2026-10" });
  expect(s.counts.not_started).toBe(3);
  expect(
    s.rows.find(/** @param {any} r */ (r) => r.profileId === unused.id).status,
  ).toBe("not_started");
  expect(s.awaitingMine).toBeGreaterThan(0);
  expect(s.lateCount).toBeGreaterThan(0);
  expect(s.trend).toHaveLength(4);
});
test("approved whole interval locks both outlet and route edits, not just visit date", async () => {
  await expect(
    tx(h.db, (db) =>
      assertNotLocked(db, {
        outletIds: [outlet.id],
        from: localDate("2026-10-20"),
        to: localDate("2026-10-21"),
      }),
    ),
  ).rejects.toThrow("approved MCP");
  await expect(
    tx(h.db, (db) =>
      assertNotLocked(db, {
        routeIds: [route.id],
        from: localDate("2026-10-20"),
      }),
    ),
  ).rejects.toThrow("approved MCP");
  await tx(h.db, (db) =>
    assertNotLocked(db, {
      routeIds: [route.id],
      from: localDate("2026-12-01"),
    }),
  );
});
test("content-hash tampering is rejected and does not create visits", async () => {
  const [p] = await h.db`select * from coverage_plans where id=${approved._id}`;
  await h.db`update coverage_plans set signed_content=${{ ...p.signed_content, other: "tamper" }} where id=${p.id}`;
  await expect(
    run(supervisor, "activation/activate", { planId: p.id }),
  ).rejects.toThrow("Signed plan content");
  await h.db`update coverage_plans set signed_content=${p.signed_content} where id=${p.id}`;
});
test("real HTTP cookie workflow, DTOs and every coverage reader", async () => {
  h.setHooks({
    loadProfile: async (db, userId) => {
      const [p] = await db`select * from profiles where user_id=${userId}`;
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
  const session = async (/** @type {any} */ p) => {
    const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
    await h.db`insert into sessions(token_hash,user_id,app,expires_at) values (${new Bun.CryptoHasher("sha256").update(token).digest("hex")},${p.user_id},'web',${new Date(Date.now() + 3600000)})`;
    return `sp_session=${token}`;
  };
  const sellerCookie = await session(sales),
    supervisorCookie = await session(supervisor);
  const post = async (
    /** @type {string} */ cookie,
    /** @type {string} */ path,
    /** @type {any} */ body,
  ) => {
    const res = await h.fetch(`/api/v1/coverage/${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ ...body, idempotencyKey: crypto.randomUUID() }),
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    return /** @type {any} */ (data);
  };
  const p = await post(sellerCookie, "plans/create", {
    assigneeProfileId: sales.id,
    localMonth: "2030-01",
  });
  await post(sellerCookie, "plans/saveOutlets", {
    planId: p._id,
    outlets: roster(),
  });
  await post(sellerCookie, "plans/saveSlots", {
    planId: p._id,
    slots: [slot("2030-01-02")],
  });
  await post(sellerCookie, "plans/submit", { planId: p._id });
  await post(supervisorCookie, "plans/approve", { planId: p._id });
  const args = {
    planId: p._id,
    assigneeProfileId: sales.id,
    localMonth: "2030-01",
    month: "2030-01",
    profileId: supervisor.id,
    asOf: Date.now(),
    outletId: outlet.id,
    routeId: route.id,
    territoryId: territory.id,
    paginationOpts: { numItems: 20, cursor: null },
  };
  for (const action of [
    "profile",
    "permissions",
    "people",
    "summary",
    "plans/list",
    "plans/detail",
    "discovery/list",
    "discovery/attribution",
    "calendar/status",
    "calendar/approvalView",
    "activation/plannedForMonth",
    "routines/listForPosition",
    "away/list",
    "history/list",
    "views/filterOptions",
    "views/calendar",
    "views/byRoute",
    "views/workload",
    "map/forPlan",
    "exceptions/forPlan",
    "exports/schedule",
    "review",
    "lookup/territories",
    "lookup/routes",
    "lookup/route",
    "lookup/outlets",
    "lookup/outlet",
    "lookup/roster",
  ]) {
    const res = await h.fetch(
      `/api/v1/coverage/${action}?input=${encodeURIComponent(JSON.stringify(args))}`,
      { headers: { cookie: supervisorCookie } },
    );
    const data = await res.json();
    expect({
      action,
      status: res.status,
      data: res.status === 200 ? "ok" : data,
    }).toEqual({ action, status: 200, data: "ok" });
  }
  const unauthenticated = await h.fetch(
    "/api/v1/coverage/summary?month=2030-01",
  );
  expect(unauthenticated.status).toBe(401);
  const denied = await h.fetch(`/api/v1/coverage/plans/approve`, {
    method: "POST",
    headers: { cookie: sellerCookie, "content-type": "application/json" },
    body: JSON.stringify({
      planId: p._id,
      idempotencyKey: crypto.randomUUID(),
    }),
  });
  expect(denied.status).toBe(403);
});
test("revision copies a future suffix, freezes signed evidence, and activation replaces old visits transactionally", async () => {
  const clock = Date.parse("2026-10-16T12:00:00+08:00");
  const next = await run(
    sales,
    "plans/createRevision",
    {
      planId: approved._id,
      effectiveFromDate: "2026-10-16",
      reason: "New route priority",
    },
    clock,
  );
  const details = await read(ctx(sales, clock), "plans/detail", {
    planId: next._id,
  });
  expect(details.slots).toHaveLength(1);
  expect(details.plan.territoryIds).toEqual([territory.id]);
  await run(sales, "plans/submit", { planId: next._id }, clock);
  await run(supervisor, "plans/approve", { planId: next._id }, clock);
  const activated = await run(
    supervisor,
    "activation/activate",
    { planId: next._id },
    clock,
  );
  expect(activated.count).toBe(1);
  const [old] =
    await h.db`select * from planned_visits where plan_id=${approved._id}`;
  const [replacement] =
    await h.db`select * from planned_visits where plan_id=${next._id}`;
  expect(old.status).toBe("replaced");
  expect(old.replaced_by_visit_id).toBe(replacement.id);
  expect(replacement.replacement_of_visit_id).toBe(old.id);
  expect(
    (await h.db`select status from coverage_plans where id=${approved._id}`)[0]
      .status,
  ).toBe("superseded");
});
test("approval independently denies the preparer and repeats authorization before command replay", async () => {
  const p = await run(supervisor, "plans/create", {
    assigneeProfileId: sales.id,
    localMonth: "2027-02",
  });
  await run(supervisor, "plans/saveOutlets", {
    planId: p._id,
    outlets: roster(),
  });
  await run(supervisor, "plans/saveSlots", {
    planId: p._id,
    slots: [slot("2027-02-02")],
  });
  await run(supervisor, "plans/submit", { planId: p._id });
  await expect(
    run(supervisor, "plans/approve", { planId: p._id }),
  ).rejects.toThrow("Independent approver");
  const key = crypto.randomUUID(),
    body = {
      assigneeProfileId: sales.id,
      localMonth: "2027-03",
      idempotencyKey: key,
    };
  await run(sales, "plans/create", body);
  await h.db`update profiles set status='disabled' where id=${sales.id}`;
  await expect(run(sales, "plans/create", body)).rejects.toThrow(
    "no longer active",
  );
  await h.db`update profiles set status='active' where id=${sales.id}`;
});
test("eligible uncovered stores appear in route and map views; transferred current ownership never grants old-scope reads", async () => {
  const db = h.db;
  const [o] =
    await db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values ('sunpride','UNCOVERED','Uncovered shop','active',${unit.id},${manager.user_id}) returning *`;
  await db`insert into outlet_assignments(outlet_id,territory_id,route_id,effective_from,actor_subject,reason) values (${o.id},${territory.id},${route.id},${new Date(now)},${manager.user_id},'Fixture')`;
  const routes = await read(ctx(supervisor), "views/byRoute", {
    planId: approved._id,
    paginationOpts: { numItems: 20, cursor: null },
  });
  expect(routes.page[0].uncoveredCount).toBe(1);
  const map = await read(ctx(supervisor), "map/forPlan", {
    planId: approved._id,
    paginationOpts: { numItems: 20, cursor: null },
  });
  expect(
    map.page.find(/** @param {any} row */ (row) => row.outletId === o.id)
      .inPlan,
  ).toBe(false);
  const foreign = { ...supervisor, org_unit_id: crypto.randomUUID() };
  await expect(
    read(ctx(foreign), "plans/detail", { planId: approved._id }),
  ).rejects.toThrow("outside your organizational scope");
  const [other] =
    await db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values ('sunpride','OTHER','Other region','region','active',${new Date(now)}) returning id`;
  await db`update territory_ownerships set org_unit_id=${other.id} where territory_id=${territory.id}`;
  await expect(
    read(ctx(supervisor), "exports/schedule", { planId: approved._id }),
  ).rejects.toThrow("outside your organizational scope");
  await db`update territory_ownerships set org_unit_id=${unit.id} where territory_id=${territory.id}`;
});
test("custom cadence and anchor stay Manila date strings through SQL and a copied revision", async () => {
  const p = await run(sales, "plans/create", {
    assigneeProfileId: sales.id,
    localMonth: "2031-04",
  });
  const outlets = roster().map((o) => ({
    ...o,
    frequency: "custom",
    anchorLocalDate: "2031-04-03",
    customLocalDates: ["2031-04-03"],
    preferredWeekdays: [4],
  }));
  await run(sales, "plans/saveOutlets", { planId: p._id, outlets });
  await run(sales, "plans/saveSlots", {
    planId: p._id,
    slots: [slot("2031-04-03")],
  });
  await run(sales, "plans/submit", { planId: p._id });
  await run(supervisor, "plans/approve", { planId: p._id });
  const revision = await run(sales, "plans/createRevision", {
    planId: p._id,
    effectiveFromDate: "2031-04-02",
    reason: "Cadence test",
  });
  const detail = await read(ctx(sales), "plans/detail", {
    planId: revision._id,
  });
  expect(detail.outlets[0].anchorLocalDate).toBe("2031-04-03");
  expect(detail.outlets[0].customLocalDates).toEqual(["2031-04-03"]);
  expect(detail.slots[0].serviceDate).toBe("2031-04-03");
});
test("WEB-115 a plan past 500 rows saves and opens; a broken approval still opens with a notice", async () => {
  const p = await run(sales, "plans/create", {
    assigneeProfileId: sales.id,
    localMonth: "2031-05",
  });
  await run(sales, "plans/saveOutlets", { planId: p._id, outlets: roster() });
  const dates = Array.from(
    { length: 26 },
    (_, i) => `2031-05-${String(i + 2).padStart(2, "0")}`,
  );
  const slots = dates.flatMap((date) =>
    Array.from({ length: 25 }, (_, n) => ({
      ...slot(date),
      slotKey: `visit:${date}:${n}`,
      sequence: n + 1,
    })),
  );
  expect(slots.length).toBe(650);
  await run(sales, "plans/saveSlots", { planId: p._id, slots });
  const draft = await read(ctx(sales), "plans/detail", { planId: p._id });
  expect(draft.slots).toHaveLength(650);
  expect(draft.notices).toEqual([]);
  await run(sales, "plans/submit", { planId: p._id });
  await run(supervisor, "plans/approve", { planId: p._id });
  const signed = await read(ctx(sales), "plans/detail", { planId: p._id });
  expect(signed.signatureValid).toBe(true);
  await h.db`update coverage_plans set content_hash='tampered' where id=${p._id}`;
  const broken = await read(ctx(sales), "plans/detail", { planId: p._id });
  expect(broken.signatureValid).toBe(false);
  expect(broken.notices[0]).toContain("approval record does not match");
  expect(broken.slots).toHaveLength(650);
  const calendar = await read(ctx(sales), "views/calendar", {
    planId: p._id,
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(calendar.page.length).toBe(10);
});
test("minute activation job activates due signed plans and queues after-commit day refreshes", async () => {
  expect(
    h.app.scheduler.tasks.some((t) => t.name === "coverage.activation"),
  ).toBe(true);
  await activateDue(platform, Date.parse("2030-01-01T12:00:00+08:00"));
  const [p] =
    await h.db`select * from coverage_plans where local_month='2030-01' and assignee_profile_id=${sales.id}`;
  expect(p.status).toBe("active");
  const visits = await h.db`select * from planned_visits where plan_id=${p.id}`;
  expect(visits).toHaveLength(1);
  const jobs =
    await h.db`select * from jobs where kind='coverage.refresh' and payload->>'date'='2030-01-02'`;
  expect(jobs).toHaveLength(1);
  const changes =
    await h.db`select * from change_log where entity='planned_visits' and entity_id=${visits[0].id}`;
  expect(changes.length).toBeGreaterThan(0);
});
test("changed idempotency content refuses replay; no duplicate plan", async () => {
  const key = crypto.randomUUID(),
    b = {
      assigneeProfileId: sales.id,
      localMonth: "2026-12",
      idempotencyKey: key,
    };
  const first = await run(sales, "plans/create", b);
  expect(await run(sales, "plans/create", b)).toEqual(first);
  await expect(
    run(sales, "plans/create", { ...b, localMonth: "2027-01" }),
  ).rejects.toThrow("already used");
});

test("WEB-118 removing an outlet prunes its dated visits; outlets off the assignee's routes are refused on add", async () => {
  const db = h.db;
  const [otherRoute] =
    await db`insert into routes(organization_id,code,name,status,effective_from,created_by) values ('sunpride','R118','Other route','active',${new Date(now)},${manager.user_id}) returning *`;
  await db`insert into route_territories(route_id,territory_id,effective_from,actor_subject,reason) values (${otherRoute.id},${territory.id},${new Date(now)},${manager.user_id},'Fixture')`;
  const [far] =
    await db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values ('sunpride','STORE118','Far store','active',${unit.id},${manager.user_id}) returning *`;
  await db`insert into outlet_assignments(outlet_id,territory_id,route_id,sequence,effective_from,actor_subject,reason) values (${far.id},${territory.id},${otherRoute.id},1,${new Date(now)},${manager.user_id},'Fixture')`;
  const p = await run(sales, "plans/create", {
    assigneeProfileId: sales.id,
    localMonth: "2026-12",
  });
  await expect(
    run(sales, "plans/saveOutlets", {
      planId: p._id,
      outlets: [...roster(), { ...roster()[0], outletId: far.id, routeId: otherRoute.id }],
    }),
  ).rejects.toThrow("Outlet is on a route the assignee does not serve");
  // An outlet the assignee serves, with dated visits, then removed.
  await run(sales, "plans/saveOutlets", { planId: p._id, outlets: roster() });
  await run(sales, "plans/saveSlots", {
    planId: p._id,
    slots: [slot("2026-12-02"), slot("2026-12-09")],
  });
  await expect(run(sales, "plans/submit", { planId: p._id })).resolves.toBeTruthy();
  await run(supervisor, "plans/returnPlan", { planId: p._id, reason: "Redo" });
  await run(sales, "plans/saveOutlets", { planId: p._id, outlets: [] });
  const left =
    await db`select count(*)::int as n from coverage_plan_slots where plan_id=${p._id} and kind='outlet_visit'`;
  expect(left[0].n).toBe(0);
  await expect(run(sales, "plans/submit", { planId: p._id })).rejects.toThrow(
    "Plan needs dated slots before submitting",
  );
});
test("WEB-118 Save assignment on a plan without its primary assignment records one, so it can be submitted", async () => {
  const p = await run(sales, "plans/create", {
    assigneeProfileId: sales.id,
    localMonth: "2031-07",
  });
  await h.db`delete from coverage_assignments where plan_id=${p._id}`;
  await run(sales, "plans/setAssignment", {
    planId: p._id,
    reason: "Restore primary assignment",
    effectiveFrom: localDate("2031-07-01"),
    effectiveTo: localDate("2031-08-01"),
  });
  const rows =
    await h.db`select assignee_profile_id,is_primary,reason from coverage_assignments where plan_id=${p._id}`;
  expect(rows).toEqual([
    { assignee_profile_id: sales.id, is_primary: true, reason: "Restore primary assignment" },
  ]);
  await run(sales, "plans/saveOutlets", { planId: p._id, outlets: roster() });
  await run(sales, "plans/saveSlots", { planId: p._id, slots: [slot("2031-07-02")] });
  await expect(run(sales, "plans/submit", { planId: p._id })).resolves.toBeTruthy();
});
