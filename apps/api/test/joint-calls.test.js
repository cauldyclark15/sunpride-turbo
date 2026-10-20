import { test, expect, beforeAll, afterAll } from "bun:test";
import { startHarness } from "./harness.js";
import { analyticsFixture } from "./analytics-fixture.js";
import { sha256Hex } from "../src/core/util.js";
import { addDays } from "../src/domains/analytics/measures.js";
const { install: fieldreports } =
  await import("../src/domains/fieldreports/index.js");

/** @type {any} */ let h;
/** @type {any} */ let f;
/** @type {Record<string,string>} */ const cookies = {};
/** @type {string} */ let trainee;
beforeAll(async () => {
  h = await startHarness({ installers: [fieldreports] });
  f = await analyticsFixture(h);
  const [position] = await h.db`select id from positions where code='FIELD'`;
  /** @param {string} name @param {string} unit */
  async function trainer(name, unit) {
    const email = `${name}@example.com`;
    const [u] =
      await h.db`insert into users(email,password_hash) values(${email},'not-a-password-hash') returning id`;
    const [p] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,position_id) values(${u.id},${u.id},${name},${email},'manager','active',${unit},${position.id}) returning id`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,position_id,effective_from,actor_subject,reason) values(${p.id},${unit},'manager',${position.id},'2020-01-01','fixture','fixture')`;
    await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${u.id},${sha256Hex("sps_" + name)},'web',now()+interval '1 day')`;
    cookies[name] = "sp_session=sps_" + name;
    return p.id;
  }
  await trainer("coach-a", f.a);
  await trainer("coach-a2", f.a);
  [{ id: trainee }] = await h.db`select id from profiles where name='Agent 0'`;
}, 120000);
afterAll(async () => {
  await h?.close();
});
/** @param {string} name @param {any} args @param {string} cookie */
async function post(name, args, cookie) {
  const r = await h.fetch("/api/v1/fieldreports/" + name.replaceAll(".", "/"), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ...args, idempotencyKey: crypto.randomUUID() }),
  });
  return { status: r.status, body: /** @type {any} */ (await r.json()) };
}
/** @param {string} id @param {string} cookie */
async function detail(id, cookie) {
  const r = await h.fetch(
    "/api/v1/fieldreports/supervision/work_with/detail?args=" +
      encodeURIComponent(JSON.stringify({ sessionId: id })),
    { headers: { cookie } },
  );
  return /** @type {any} */ (await r.json());
}
/** @param {string} serviceDate @param {string} cookie */
async function start(serviceDate, cookie) {
  const r = await post(
    "supervision.work_with.start",
    {
      serviceDate,
      traineeProfileId: trainee,
      objective: "training",
      mode: "booking",
    },
    cookie,
  );
  expect(r.status).toBe(200);
  return typeof r.body === "string" ? r.body : (r.body.value ?? r.body.id);
}

test("F-223 agreed actions carry into the next joint call and must be reviewed there before completion", async () => {
  const first = await start(addDays(f.today, -1), cookies["coach-a"]);
  const bad = await post(
    "supervision.work_with.actions.save",
    {
      sessionId: first,
      actions: [
        {
          agreement: "Face SKUs",
          owner: "trainee",
          dueOn: addDays(f.today, -3),
        },
      ],
    },
    cookies["coach-a"],
  );
  expect(bad.status).toBe(422);
  const saved = await post(
    "supervision.work_with.actions.save",
    {
      sessionId: first,
      actions: [
        {
          agreement: "Face the top 5 SKUs at eye level",
          owner: "trainee",
          dueOn: f.today,
        },
        {
          agreement: "Send the trainee the PSF checklist",
          owner: "trainer",
          dueOn: f.today,
        },
      ],
    },
    cookies["coach-a"],
  );
  expect(saved.status).toBe(200);
  // Another trainer of the same trainee cannot edit this trainer's session.
  expect(
    (
      await post(
        "supervision.work_with.actions.save",
        { sessionId: first, actions: [] },
        cookies["coach-a2"],
      )
    ).status,
  ).toBe(403);
  const d1 = await detail(first, cookies["coach-a"]);
  expect(d1.jointCall.agreed.map((/** @type {any} */ a) => a.owner)).toEqual([
    "trainee",
    "trainer",
  ]);
  expect(d1.jointCall.carried).toEqual([]);
  // An action cannot be reviewed in the session that agreed it.
  expect(
    (
      await post(
        "supervision.work_with.actions.review",
        {
          sessionId: first,
          actionId: d1.jointCall.agreed[0].id,
          outcome: "done",
          note: "x",
        },
        cookies["coach-a"],
      )
    ).status,
  ).toBe(422);
  await h.db`update work_with_sessions set status='completed',completed_at=now() where id=${first}`;

  const second = await start(f.today, cookies["coach-a"]);
  const d2 = await detail(second, cookies["coach-a"]);
  expect(d2.jointCall.carried.map((/** @type {any} */ a) => a.status)).toEqual([
    "open",
    "open",
  ]);
  const carry = d2.gaps.filter((/** @type {any} */ g) =>
    g.code.startsWith("carry_forward:"),
  );
  expect(carry).toHaveLength(2);
  expect(carry[0].label).toContain("Face the top 5 SKUs at eye level");
  const blocked = await post(
    "supervision.work_with.complete",
    { sessionId: second },
    cookies["coach-a"],
  );
  expect(blocked.status).toBe(422);
  expect(JSON.stringify(blocked.body)).toContain("Review the action agreed on");
  // A different trainer's next joint call with the same trainee does not inherit these actions.
  const other = await start(f.today, cookies["coach-a2"]);
  expect((await detail(other, cookies["coach-a2"])).jointCall.carried).toEqual(
    [],
  );
  for (const [i, a] of d2.jointCall.carried.entries()) {
    const r = await post(
      "supervision.work_with.actions.review",
      {
        sessionId: second,
        actionId: a.id,
        outcome: i === 0 ? "done" : "not_done",
        note: i === 0 ? "Seen on shelf at Store 1" : "Checklist not yet sent",
      },
      cookies["coach-a"],
    );
    expect(r.status).toBe(200);
  }
  const again = await post(
    "supervision.work_with.actions.review",
    {
      sessionId: second,
      actionId: d2.jointCall.carried[0].id,
      outcome: "not_done",
      note: "changed",
    },
    cookies["coach-a"],
  );
  expect(again.status).toBe(409);
  const d3 = await detail(second, cookies["coach-a"]);
  expect(
    d3.gaps.filter((/** @type {any} */ g) =>
      g.code.startsWith("carry_forward:"),
    ),
  ).toEqual([]);
  expect(
    d3.jointCall.carried.map((/** @type {any} */ a) => [
      a.status,
      a.reviewNote,
    ]),
  ).toEqual([
    ["done", "Seen on shelf at Store 1"],
    ["not_done", "Checklist not yet sent"],
  ]);
  // The first session's actions cannot be rewritten once reviewed.
  await h.db`update work_with_sessions set status='open' where id=${first}`;
  expect(
    (
      await post(
        "supervision.work_with.actions.save",
        { sessionId: first, actions: [] },
        cookies["coach-a"],
      )
    ).status,
  ).toBe(409);
});
