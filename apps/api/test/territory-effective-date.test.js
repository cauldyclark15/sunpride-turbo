import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { createUser, startHarness } from "./harness.js";
import { install } from "../src/domains/org/index.js";
import { manilaBusinessDate } from "../src/core/docnum.js";

/** @type {import('./harness.js').Harness} */ let h;
let cookie = "";
let root = "";
let territoryId = "";
/** @type {ReturnType<typeof spyOn>|undefined} */ let clock;

/** @param {string} path @param {Record<string,any>} [body] */
async function call(path, body) {
  const response = await h.fetch(`/api/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
/** @param {string} code @param {number} effectiveFrom */
const input = (code, effectiveFrom) => ({
  code,
  name: `SAMPLE ${code}`,
  channel: "General trade",
  orgUnitId: root,
  effectiveFrom,
  reason: "SAMPLE same-day territory proof",
});
const todayStart = () => Date.parse(`${manilaBusinessDate()}T00:00:00+08:00`);

beforeAll(async () => {
  // Honor the configured proof port without reserving it in ordinary test runs.
  h = await startHarness({
    installers: [install],
    port: Number(process.env.PORT ?? 0),
  });
  const password = "test-only-same-day-territory";
  await createUser(h, "boss@example.com", password);
  const signIn = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "boss@example.com", password }),
  });
  expect(signIn.status).toBe(200);
  cookie = signIn.headers.get("set-cookie")?.split(";")[0] ?? "";
  const me = await h.fetch("/api/me", { headers: { cookie } });
  const body = await me.json();
  root = body.profile.orgUnitId;
  await h.db`update org_units set effective_from='2020-01-01' where id=${root}`;
  const [territory] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by) values('sunpride','EXISTING','SAMPLE existing territory','active','2020-01-01','system:test') returning id`;
  territoryId = territory.id;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${territoryId},${root},'2020-01-01','system:test','SAMPLE')`;
}, 30000);
afterEach(() => {
  clock?.mockRestore();
  clock = undefined;
});
afterAll(async () => {
  if (h) await h.close();
});

test.each([
  ["2026-11-18T16:00:00.000Z", "2026-11-19", "MIDNIGHT"],
  ["2026-11-19T04:00:00.000Z", "2026-11-19", "NOON"],
  ["2026-11-19T15:59:59.999Z", "2026-11-19", "LATE"],
  ["2026-11-19T16:00:00.000Z", "2026-11-20", "NEXT_DAY"],
])(
  "SP-0204 accepts today's Manila midnight at %s and persists the owner and audit",
  async (now, day, code) => {
    clock = spyOn(Date, "now").mockReturnValue(Date.parse(now));
    const from = Date.parse(`${day}T00:00:00+08:00`);
    const result = await call("territories/create", input(code, from));
    expect(result.status).toBe(200);
    const detail = await call(
      `territories/detail?territoryId=${result.body}&asOf=${Date.parse(now)}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.territory.effectiveFrom).toBe(from);
    expect(detail.body.owner.orgUnitId).toBe(root);
    const [saved] =
      await h.db`select t.effective_from,o.effective_from as owner_from,o.reason from territories t join territory_ownerships o on o.territory_id=t.id where t.id=${result.body}`;
    expect(+saved.effective_from).toBe(from);
    expect(+saved.owner_from).toBe(from);
    expect(saved.reason).toBe("SAMPLE same-day territory proof");
    const [audit] =
      await h.db`select count(*)::int n from audit_logs where entity_id=${result.body} and action='territories.create'`;
    expect(audit.n).toBe(1);
  },
);

test("SP-0204 saves today's actual Manila date and lists the territory immediately", async () => {
  const from = todayStart();
  const result = await call("territories/create", input("CURRENT_DATE", from));
  expect(result.status).toBe(200);
  const list = await call("territories/list?q=CURRENT_DATE");
  expect(list.status).toBe(200);
  expect(
    list.body.page.find((/** @type {any} */ row) => row._id === result.body)
      ?.effectiveFrom,
  ).toBe(from);
  const detail = await call(`territories/detail?territoryId=${result.body}`);
  expect(detail.status).toBe(200);
  expect(detail.body.owner.orgUnitId).toBe(root);
});

test("SP-0204 still schedules tomorrow's territory with its exact start and end", async () => {
  const from = todayStart() + 86400000;
  const to = from + 86400000;
  const result = await call("territories/create", {
    ...input("FUTURE", from),
    effectiveTo: to,
  });
  expect(result.status).toBe(200);
  const [saved] =
    await h.db`select effective_from,effective_to from territories where id=${result.body}`;
  expect(+saved.effective_from).toBe(from);
  expect(+saved.effective_to).toBe(to);
});

test("SP-0204 rejects previous-day starts and invalid intervals without adding a territory", async () => {
  const from = todayStart();
  const previous = await call(
    "territories/create",
    input("PREVIOUS", from - 1),
  );
  expect(previous.status).toBe(422);
  expect(previous.body.error.message).toBe(
    "Choose today or a future effective date.",
  );
  const invalid = await call("territories/create", {
    ...input("BAD_END", from),
    effectiveTo: from,
  });
  expect(invalid.status).toBe(422);
  const malformed = await call("territories/create", {
    ...input("BAD_START", from),
    effectiveFrom: "today",
  });
  expect(malformed.status).toBe(422);
  const [count] =
    await h.db`select count(*)::int n from territories where code in ('PREVIOUS','BAD_END','BAD_START')`;
  expect(count.n).toBe(0);
});

test("SP-0204 retains prospective-only territory changes and route creation", async () => {
  const effectiveFrom = todayStart();
  for (const [path, body] of [
    [
      "territories/transferOwner",
      { territoryId, orgUnitId: root, effectiveFrom, reason: "SAMPLE" },
    ],
    [
      "territories/deactivate",
      { territoryId, effectiveTo: effectiveFrom, reason: "SAMPLE" },
    ],
    [
      "territories/routes/create",
      {
        territoryId,
        code: "TODAY_ROUTE",
        name: "SAMPLE route",
        effectiveFrom,
        reason: "SAMPLE",
      },
    ],
  ]) {
    const result = await call(
      /** @type {string} */ (path),
      /** @type {Record<string,any>} */ (body),
    );
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe("not_prospective");
  }
});

test("SP-0204 still requires the owning unit to cover today's effective interval", async () => {
  const from = todayStart();
  const [unit] =
    await h.db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from) values('sunpride','UPCOMING','SAMPLE future unit','REGION',${root},'active',${new Date(from + 86400000)}) returning id`;
  const result = await call("territories/create", {
    ...input("BAD_OWNER", from),
    orgUnitId: unit.id,
  });
  expect(result.status).toBe(422);
  expect(result.body.error.message).toBe(
    "Unit does not cover effective interval",
  );
  const [count] =
    await h.db`select count(*)::int n from territories where code='BAD_OWNER'`;
  expect(count.n).toBe(0);
});
