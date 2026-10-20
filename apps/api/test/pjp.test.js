import { beforeAll, afterAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";
import { capabilitiesFor } from "../src/core/capabilities.js";
import { install, command } from "../src/domains/coverage/index.js";
import { pjpCommand, pjpRead } from "../src/domains/coverage/pjp.js";
import { localDate } from "../src/domains/coverage/model.js";
import { readAdherence } from "../src/domains/coverage/adherence.js";
import { schedulePjp } from "../src/domains/coverage/pjp-schedule.js";
import { seedCoverageSpec } from "../../../packages/db/seed/coverage-spec.js";

/** @type {any} */ let h;
/** @type {any} */ let platform;
/** @type {any} */ let unit;
/** @type {any} */ let sales;
/** @type {any} */ let manager;
/** @type {any} */ let foreign;
/** @type {any} */ let route;
/** @type {any} */ let territory;
/** @type {any[]} */ let outlets = [];
const now = Date.parse("2026-10-20T08:00:00+08:00");
/** @param {any} p */
const ctx = (p) => ({
  db: h.db,
  now,
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
/** @param {any} p @param {string} action @param {any} body */
const run = (p, action, body) =>
  pjpCommand(ctx(p), platform, action, {
    idempotencyKey: crypto.randomUUID(),
    ...body,
  });
/** @param {string} name @param {string} role @param {string} unitId */
async function person(name, role, unitId) {
  const db = h.db;
  const [u] =
    await db`insert into users(email,password_hash) values (${name + "@pjp.test"},'unused') returning *`;
  const [p] =
    await db`insert into profiles(user_id,name,email,role,status,org_unit_id) values (${u.id},${name},${u.email},${role},'active',${unitId}) returning *`;
  await db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values (${p.id},${unitId},${role},${new Date(now - 86400000)},${u.id},'F-201 fixture')`;
  return p;
}
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
    await db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values ('sunpride','PJP','PJP Cebu','region','active',${new Date(now - 86400000)}) returning *`;
  const [other] =
    await db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values ('sunpride','OTHER','Other region','region','active',${new Date(now - 86400000)}) returning *`;
  h.setHooks({
    unitInScope: async (
      /** @type {any} */ _db,
      /** @type {any} */ actor,
      /** @type {string} */ id,
    ) => actor.orgUnitId === id,
    scopeUnitIds: async (/** @type {any} */ _db, /** @type {any} */ actor) => [
      actor.orgUnitId,
    ],
  });
  sales = await person("rep", "sales", unit.id);
  manager = await person("boss", "manager", unit.id);
  foreign = await person("foreign", "manager", other.id);
  [territory] =
    await db`insert into territories(organization_id,code,name,status,effective_from,created_by) values ('sunpride','PJP','PJP territory','active',${new Date(now - 86400000)},${manager.user_id}) returning *`;
  await db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values (${territory.id},${unit.id},${new Date(now - 86400000)},${manager.user_id},'Fixture')`;
  [route] =
    await db`insert into routes(organization_id,code,name,status,effective_from,created_by) values ('sunpride','PJP','PJP beat','active',${new Date(now - 86400000)},${manager.user_id}) returning *`;
  await db`insert into route_territories(route_id,territory_id,effective_from,actor_subject,reason) values (${route.id},${territory.id},${new Date(now - 86400000)},${manager.user_id},'Fixture')`;
  await db`insert into route_salespeople(route_id,profile_id,is_primary,effective_from,actor_subject,reason) values (${route.id},${sales.id},true,${new Date(now - 86400000)},${manager.user_id},'Fixture')`;
  for (let i = 0; i < 8; i++) {
    const [o] =
      await db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,classification,sales_potential,created_by) values ('sunpride',${"PJP" + i},${"PJP store " + i},'active',${unit.id},'A',1000,${manager.user_id}) returning *`;
    outlets.push(o);
    await db`insert into outlet_assignments(outlet_id,territory_id,route_id,sequence,effective_from,actor_subject,reason) values (${o.id},${territory.id},${route.id},${i + 1},${new Date(now - 86400000)},${manager.user_id},'Fixture')`;
  }
  const admin = { ...manager, role: "super_admin" };
  await db`update profiles set role='super_admin' where id=${manager.id}`;
  manager = admin;
  await run(manager, "policy", {
    orgUnitId: unit.id,
    classKey: "A",
    label: "Sample weekly A",
    intervalWeeks: 1,
    serviceMinutes: 30,
    objectives: ["Check shelf availability", "Collect overdue invoice"],
    fromDate: "2026-10-20",
    sourceRef: "SAMPLE F-201",
  });
}, 30000);
afterAll(async () => {
  await h?.close();
});
const templateBody = () => ({
  name: "Cebu weekly beat",
  assigneeProfileId: sales.id,
  anchorDate: "2026-10-19",
  fromDate: "2026-11-01",
  toDate: "2026-12-01",
  capacityMinutes: 90,
  travelMinutes: 10,
  sellingWeekdays: [1, 2, 3, 4, 5],
  stops: outlets.map((o) => ({ outletId: o.id })),
});
/** @type {any} */ let template;
/** @type {any} */ let simulation;
/** @type {any} */ let generated;
test("F-201 class policies drive balanced repeat cycles and simulation has no business writes", async () => {
  template = await run(sales, "template", templateBody());
  simulation = await run(sales, "simulate", {
    templateId: template._id,
    month: "2026-11",
  });
  expect(simulation.result.totalVisits).toBeGreaterThanOrEqual(32);
  expect(simulation.result.overloadedDays).toHaveLength(0);
  expect(
    simulation.result.days.every((/** @type {any} */ d) => d.visits <= 2),
  ).toBe(true);
  expect(
    simulation.result.slots.every((/** @type {any} */ s) =>
      s.requiredObjectives.includes("Check shelf availability"),
    ),
  ).toBe(true);
  expect((await h.db`select count(*)::int as n from coverage_plans`)[0].n).toBe(
    0,
  );
  expect((await h.db`select count(*)::int as n from planned_visits`)[0].n).toBe(
    0,
  );
});
test("F-202 simulate → generate → independent publish reuses signed coverage and idempotent activation", async () => {
  const body = {
    templateId: template._id,
    simulationId: simulation.simulationId,
    idempotencyKey: "generate-once",
  };
  generated = await run(sales, "generate", body);
  expect(await run(sales, "generate", body)).toEqual(generated);
  expect(generated.status).toBe("submitted");
  await expect(
    run(sales, "publish", { planId: generated._id }),
  ).rejects.toThrow();
  await expect(
    run(manager, "publish", { planId: generated._id, idempotencyKey: "pub" }),
  ).resolves.toMatchObject({ status: "approved" });
  const [plan] =
    await h.db`select * from coverage_plans where id=${generated._id}`;
  expect(plan.signed_content.pjpSource.inputHash).toBe(simulation.hash);
  expect(plan.content_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(plan.signed_content.slots).toHaveLength(simulation.result.totalVisits);
  const review = await readAdherence(
    { ...ctx(manager), now: localDate("2026-12-01") },
    { asOf: "2026-12-01" },
  );
  expect(review.summary.planned).toBeGreaterThan(0);
  expect(review.summary.actual).toBe(0);
  expect(
    (
      await readAdherence(
        { ...ctx(foreign), now: localDate("2026-12-01") },
        { asOf: "2026-12-01" },
      )
    ).summary.planned,
  ).toBe(0);
  const activation = await command(
    { ...ctx(manager), now: localDate("2026-11-01") },
    platform,
    "activation/activate",
    { planId: generated._id, idempotencyKey: "activation" },
  );
  expect(activation.count).toBe(simulation.result.totalVisits);
  expect(
    (
      await h.db`select count(*)::int as n from planned_visits where plan_id=${generated._id}`
    )[0].n,
  ).toBe(simulation.result.totalVisits);
});
test("F-201 generated slots cannot be manually changed while retaining simulated provenance", async () => {
  await expect(
    command(ctx(sales), platform, "plans/saveSlots", {
      planId: generated._id,
      slots: [],
      idempotencyKey: "tamper",
    }),
  ).rejects.toThrow("immutable");
});
test("F-201 changed master inputs invalidate simulation and leave zero partial generated rows", async () => {
  const t = await run(sales, "template", templateBody());
  const s = await run(sales, "simulate", {
    templateId: t._id,
    month: "2026-11",
  });
  await h.db`update outlets set classification='MISSING' where id=${outlets[0].id}`;
  const [before] = await h.db`select count(*)::int as n from coverage_plans`;
  await expect(
    run(sales, "generate", { templateId: t._id, simulationId: s.simulationId }),
  ).rejects.toThrow("policy");
  expect((await h.db`select count(*)::int as n from coverage_plans`)[0].n).toBe(
    before.n,
  );
  await h.db`update outlets set classification='A' where id=${outlets[0].id}`;
});
test("F-201 overload is visible and publication is refused without partial writes", async () => {
  const t = await run(sales, "template", {
    ...templateBody(),
    capacityMinutes: 10,
  });
  const s = await run(sales, "simulate", {
    templateId: t._id,
    month: "2026-11",
  });
  expect(s.result.overloadedDays.length).toBeGreaterThan(0);
  await expect(
    run(sales, "generate", { templateId: t._id, simulationId: s.simulationId }),
  ).rejects.toThrow("overloaded");
  expect(
    (
      await h.db`select count(*)::int as n from pjp_publications where template_id=${t._id}`
    )[0].n,
  ).toBe(0);
});
test("F-201 scope is checked before idempotent replay, and inactive actors cannot reuse commands", async () => {
  await expect(
    run(foreign, "simulate", { templateId: template._id, month: "2026-11" }),
  ).rejects.toThrow();
  expect((await pjpRead(ctx(foreign), {})).templates).toHaveLength(0);
  await h.db`update profiles set status='disabled' where id=${sales.id}`;
  await expect(
    run(sales, "generate", {
      templateId: template._id,
      simulationId: simulation.simulationId,
      idempotencyKey: "generate-once",
    }),
  ).rejects.toThrow("active");
  await h.db`update profiles set status='active' where id=${sales.id}`;
});
test("F-201 policies are effective-dated, unknown classes never receive silent defaults", async () => {
  await expect(
    run(manager, "policy", {
      orgUnitId: unit.id,
      classKey: "B",
      label: "B",
      intervalWeeks: 1,
      serviceMinutes: 10,
      objectives: [],
      fromDate: "2026-10-19",
      sourceRef: "SAMPLE",
    }),
  ).rejects.toThrow("today");
  await expect(run(sales, "policy", { orgUnitId: unit.id })).rejects.toThrow();
});
test("F-201 fortnightly and four-week phases cross month boundaries without resetting", () => {
  const t = {
    effective_from: "2026-11-01T00:00:00+08:00",
    effective_to: "2027-01-01T00:00:00+08:00",
    anchor_date: "2026-10-19",
    org_unit_id: unit.id,
    capacity_minutes: 480,
    travel_minutes: 10,
    selling_weekdays: [1],
    stops: [{ outletId: "a", weekday: 1, phaseWeek: 0 }],
  };
  const o = [
    {
      id: "a",
      classification: "A",
      name: "A",
      route_id: route.id,
      territory_id: territory.id,
    },
  ];
  const p = [
    {
      id: "policy",
      org_unit_id: unit.id,
      class_key: "A",
      interval_weeks: 4,
      service_minutes: 30,
      objectives: [],
      effective_from: new Date(now),
    },
  ];
  expect(
    schedulePjp(t, o, p, "2026-11").slots.map((s) => s.serviceDate),
  ).toEqual(["2026-11-16"]);
  expect(
    schedulePjp(t, o, p, "2026-12").slots.map((s) => s.serviceDate),
  ).toEqual(["2026-12-14"]);
});
test("F-201 discovery requires stored scope as well as a transferred rep's current scope", async () => {
  await h.db`update employee_assignments set org_unit_id=${foreign.org_unit_id} where profile_id=${sales.id}`;
  await h.db`update profiles set org_unit_id=${foreign.org_unit_id} where id=${sales.id}`;
  try {
    const result = await pjpRead(ctx(foreign), {});
    expect(
      result.people.some((/** @type {any} */ p) => p._id === sales.id),
    ).toBe(true);
    expect(result.templates).toHaveLength(0);
    expect(result.existingPlans).toHaveLength(0);
    expect(result.publications).toHaveLength(0);
  } finally {
    await h.db`update employee_assignments set org_unit_id=${unit.id} where profile_id=${sales.id}`;
    await h.db`update profiles set org_unit_id=${unit.id} where id=${sales.id}`;
  }
});
test("F-201 additive sample seeding is idempotent and never classifies unmarked outlets", async () => {
  const db = h.db,
    rep = await person("SampleSeedRep", "sales", unit.id);
  await db`insert into route_salespeople(route_id,profile_id,is_primary,effective_from,actor_subject,reason) values (${route.id},${rep.id},false,${new Date(now - 86400000)},${manager.user_id},'Fixture')`;
  const created = [];
  for (const name of ["Sample seed outlet", "Unmarked real outlet"]) {
    const [o] =
      await db`insert into outlets(organization_id,code,name,status,enrolment_status,custodian_org_unit_id,created_by) values ('sunpride',${crypto.randomUUID()},${name},'active','approved',${unit.id},${manager.user_id}) returning *`;
    await db`insert into outlet_assignments(outlet_id,territory_id,route_id,sequence,effective_from,actor_subject,reason) values (${o.id},${territory.id},${route.id},${created.length + 20},${new Date(now - 86400000)},${manager.user_id},'Fixture')`;
    created.push(o);
  }
  for (const [table, id] of [
    ["profiles", manager.id],
    ["profiles", rep.id],
    ["outlets", created[0].id],
  ])
    await db`insert into sample_data_rows(batch,table_name,row_id,key) values ('sunpride-demo-v2',${table},${id},${table + ":" + id})`;
  expect(await seedCoverageSpec(db, "2026-10-20")).toEqual({
    policies: 1,
    templates: 1,
  });
  expect(await seedCoverageSpec(db, "2026-10-20")).toEqual({
    policies: 0,
    templates: 0,
  });
  expect(
    (await db`select classification from outlets where id=${created[0].id}`)[0]
      .classification,
  ).toBe("SAMPLE-A");
  expect(
    (await db`select classification from outlets where id=${created[1].id}`)[0]
      .classification,
  ).toBeNull();
  expect(
    (
      await db`select count(*)::int as n from sample_data_rows where table_name='pjp_templates'`
    )[0].n,
  ).toBe(1);
});
