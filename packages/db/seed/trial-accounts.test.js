import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { seedDemo, resetDemo } from "./index.js";
import { createTrialAccounts, TRIAL_ROLES } from "./trial-accounts.js";
import { BATCH, todayManila } from "./store.js";

/** @type {{db:import('../src/client.js').Db,dbUrl:string,fetch:(path:string,init?:RequestInit)=>Promise<Response>,close:()=>Promise<void>,setHooks:(hooks:any)=>void}} */ let h;
let dir = "",
  recordPath = "",
  outPath = "";
/** @type {Awaited<ReturnType<typeof createTrialAccounts>>} */ let first;
/** @type {Record<string,string>} */ let originalPasswords;

async function credentials() {
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  return /** @type {import('./trial-accounts.js').Credential[]} */ (
    Object.values(record.databases).flat()
  );
}

beforeAll(async () => {
  process.env.SP_LANE ??= "smasters";
  // The DB checker must not transitively typecheck every unrelated API installer.
  const harnessPath = new URL(
    "../../../apps/api/test/harness.js",
    import.meta.url,
  ).href;
  const { startHarness } = await import(harnessPath);
  h = await startHarness({ installers: [] });
  // Exercise the actual auth routes; this test needs no domain projections.
  h.setHooks({
    loadProfile: async (
      /** @type {import('../src/client.js').Db} */ db,
      /** @type {string} */ id,
    ) => {
      const [p] =
        await db`select * from profiles where user_id=${id} and deleted_at is null`;
      return p
        ? {
            id: p.id,
            userId: id,
            name: p.name,
            role: p.role,
            orgUnitId: p.org_unit_id,
            status: p.status,
          }
        : null;
    },
  });
  await seedDemo(h.db, { anchorDate: todayManila(), days: 3 });
  dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "sp-trial-test-"));
  await mkdir(join(dir, ".sunpride-keys"), { mode: 0o700 });
  recordPath = join(dir, ".sunpride-keys/trial-accounts.json");
  outPath = join(dir, "trial-accounts.txt");
  first = await createTrialAccounts(h.db, { recordPath, outPath });
  originalPasswords = Object.fromEntries(
    (await credentials()).map((a) => [a.email, a.password]),
  );
}, 120_000);

afterAll(async () => {
  await h?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
}, 120_000);

test("F-008 three trial accounts per persona plus two area and two regional managers; no new app roles", async () => {
  expect(first.created).toBe(31);
  expect(first.total).toBe(31);
  expect(first.counts).toEqual(
    Object.fromEntries(TRIAL_ROLES.map((r) => [r.slug, r.count ?? 3])),
  );
  const rows =
    await h.db`select p.role,count(*)::int n from users u join profiles p on p.user_id=u.id where u.email like '%@trial.sunpride.test' group by p.role`;
  expect(
    Object.fromEntries(rows.map((/** @type {any} */ r) => [r.role, r.n])),
  ).toEqual({
    admin: 3,
    manager: 10,
    sales: 6,
    approver: 3,
    operations: 3,
    analyst: 3,
    viewer: 3,
  });
});

test("every login signs in through the actual API and resolves its linked profile", async () => {
  for (const a of await credentials()) {
    const res = await h.fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: a.email, password: a.password }),
    });
    expect(res.status).toBe(200);
    const me = await h.fetch("/api/me", {
      headers: { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] },
    });
    expect(me.status).toBe(200);
    const data = /** @type {any} */ (await me.json());
    expect(data.profile.id).toBe(a.profileId);
    expect(data.profile.role).toBe(a.role);
  }
}, 60_000);

test("prefers existing field people and preserves their route, today's stops and owned sales", async () => {
  for (const a of (await credentials()).filter((a) => a.persona === "agent")) {
    const [profile] =
      await h.db`select employee_code from profiles where id=${a.profileId}`;
    expect(String(profile.employee_code).startsWith("SMP-F")).toBe(true);
    const [facts] = await h.db`select
      (select count(*)::int from route_salespeople where profile_id=${a.profileId} and deleted_at is null) routes,
      (select count(*)::int from planned_visits where assignee_profile_id=${a.profileId} and service_date=${todayManila()} and status='planned') visits,
      (select count(*)::int from sales_assignments where salesperson_subject=${a.userId}) customers`;
    expect(facts.routes).toBeGreaterThan(0);
    expect(facts.visits).toBeGreaterThan(0);
    expect(facts.customers).toBeGreaterThan(0);
  }
});

test("each seller has a truck trip today, without sharing another seller's active truck", async () => {
  for (const a of (await credentials()).filter((a) => a.persona === "van")) {
    const rows =
      await h.db`select * from van_trips where salesperson_profile_id=${a.profileId} and salesperson_subject=${a.userId} and service_date=${todayManila()} and status not in ('closed','cancelled')`;
    expect(rows.length).toBe(1);
    expect(Boolean(rows[0].vehicle_id)).toBe(true);
  }
});

test("supervisor personas are team-area scoped and managers retain regional scope", async () => {
  const rows =
    await h.db`select u.email,ou.type_code,p.id from users u join profiles p on p.user_id=u.id join org_units ou on ou.id=p.org_unit_id where u.email like '%@trial.sunpride.test'`;
  expect(
    rows
      .filter((/** @type {any} */ r) =>
        String(r.email).startsWith("supervisor"),
      )
      .every((/** @type {any} */ r) => r.type_code === "territory"),
  ).toBe(true);
  expect(
    rows
      .filter((/** @type {any} */ r) =>
        String(r.email).startsWith("salesmanager"),
      )
      .every((/** @type {any} */ r) => r.type_code === "region"),
  ).toBe(true);
});

test("regional repair preserves credentials and ledger, is idempotent, and gives every supervisor area an unloaded trip", async () => {
  const { placeDemoStock } = await import("./placement.js");
  const before = await h.db`select id,password_hash from users order by id`;
  const ledger =
    await h.db`select id,quantity_delta_base,value_delta_minor from inventory_ledger_entries order by id`;
  await h.db`update inventory_locations set org_unit_id=(select id from org_units where code='SUNPRIDE') where code like 'SMP-%'`;
  const repaired = await placeDemoStock(h.db);
  expect(repaired.locations).toBeGreaterThan(0);
  expect(await placeDemoStock(h.db)).toEqual({
    locations: 0,
    vehicles: 0,
    plannedTrips: 0,
  });
  expect(await h.db`select id,password_hash from users order by id`).toEqual(
    before,
  );
  expect(
    await h.db`select id,quantity_delta_base,value_delta_minor from inventory_ledger_entries order by id`,
  ).toEqual(ledger);
  const [bad] =
    await h.db`select count(*)::int n from profiles p join users u on u.id=p.user_id where u.email like 'supervisor%@trial.sunpride.test' and not exists(select 1 from van_trips t where t.org_unit_id=p.org_unit_id and t.service_date=${todayManila()})`;
  expect(bad.n).toBe(0);
});

test("idempotent repeat creates zero and preserves all passwords", async () => {
  const again = await createTrialAccounts(h.db, { recordPath, outPath });
  expect(again.created).toBe(0);
  expect(again.rotated).toBe(0);
  const same = (await credentials()).every(
    (a) => originalPasswords[a.email] === a.password,
  );
  expect(same).toBe(true);
});

test("CLI --rotate issues new credentials, revokes old sessions and prints no secrets", async () => {
  const p = Bun.spawn(
    [
      process.execPath,
      new URL("./trial-accounts.js", import.meta.url).pathname,
      "--rotate",
      "--per-role",
      "3",
      "--out",
      outPath,
    ],
    {
      env: { ...process.env, HOME: dir, DATABASE_URL: h.dbUrl },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = await new Response(p.stdout).text();
  const error = await new Response(p.stderr).text();
  expect(await p.exited).toBe(0);
  expect(error.length).toBe(0);
  const result = JSON.parse(output);
  expect(result.rotated).toBe(31);
  expect(result.created).toBe(0);
  const text = await readFile(outPath, "utf8");
  for (const a of await credentials()) {
    expect(a.password !== originalPasswords[a.email]).toBe(true);
    expect(output.includes(a.password)).toBe(false);
    expect(text.includes(a.password)).toBe(true);
    const [user] =
      await h.db`select password_hash from users where id=${a.userId}`;
    expect(await Bun.password.verify(a.password, user.password_hash)).toBe(
      true,
    );
  }
  const [active] =
    await h.db`select count(*)::int n from sessions s join users u on u.id=s.user_id where u.email like '%@trial.sunpride.test' and revoked_at is null`;
  expect(active.n).toBe(0);
}, 60_000);

test("private files are mode 0600 and include sign-in, account and demo instructions", async () => {
  expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
  expect((await stat(outPath)).mode & 0o777).toBe(0o600);
  const text = await readFile(outPath, "utf8");
  expect(
    text.includes("Demo data: invented sample company, not real Sunpride data"),
  ).toBe(true);
  expect(text.includes("https://sunpride.cauldnclark.com/account")).toBe(true);
  expect(text.includes("bottom left → Account → Change password")).toBe(true);
  expect(text.split(" · ").length).toBe(63);
});

test("a tester-changed password is preserved and no stale password is handed out", async () => {
  const a = (await credentials())[0];
  const hash = await Bun.password.hash("tester-chosen-secret", {
    algorithm: "argon2id",
  });
  await h.db`update users set password_hash=${hash} where id=${a.userId}`;
  await createTrialAccounts(h.db, { recordPath, outPath });
  const [user] =
    await h.db`select password_hash from users where id=${a.userId}`;
  expect(
    await Bun.password.verify("tester-chosen-secret", user.password_hash),
  ).toBe(true);
  const text = await readFile(outPath, "utf8");
  const line = text.split("\n").find((line) => line.includes(a.email)) ?? "";
  expect(line.includes(a.password)).toBe(false);
  expect(line.includes("Password changed by tester")).toBe(true);
});

test("F-008 five-tier chain and area/regional trial scope are effective data, not title permissions", async () => {
  const { rowId } = await import("./store.js");
  const scopePath = new URL(
    "../../../apps/api/src/domains/org/scope.js",
    import.meta.url,
  ).href;
  const { scopeFilterForActor } = await import(scopePath);
  const chain = await h.db`with recursive reporting as (
    select p.id,p.name,a.supervisor_id,1 depth from profiles p join employee_assignments a on a.profile_id=p.id where p.id=${rowId("profiles", "agent")} and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) and a.deleted_at is null
    union all select p.id,p.name,a.supervisor_id,r.depth+1 from reporting r join profiles p on p.id=r.supervisor_id join employee_assignments a on a.profile_id=p.id where r.depth<10 and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) and a.deleted_at is null
  ) select * from reporting order by depth`;
  expect(chain.length).toBe(5);
  for (const a of (await credentials()).filter((a) =>
    ["areamanager", "regionalmanager"].includes(a.persona),
  )) {
    const [p] = await h.db`select * from profiles where id=${a.profileId}`;
    const scope = await scopeFilterForActor(h.db, {
      role: p.role,
      orgUnitId: p.org_unit_id,
    });
    expect(scope.unitIds.includes(rowId("org_units", "territory-0"))).toBe(
      true,
    );
    expect(scope.unitIds.includes(rowId("org_units", "national"))).toBe(false);
    expect(scope.unitIds.includes(rowId("org_units", "territory-3"))).toBe(
      a.persona === "regionalmanager",
    );
  }
});

test("seed reset removes all created trial rows and adopted demo people; outside sessions still guard reset", async () => {
  const saved = await credentials();
  let refusal = "";
  try {
    await resetDemo(h.db);
  } catch (error) {
    refusal = error instanceof Error ? error.message : "Unknown reset error";
  }
  expect(refusal.startsWith("Reset refused: non-sample sessions")).toBe(true);
  await h.db`delete from sessions where user_id in (select id from users where email like '%@trial.sunpride.test')`;
  const result = await resetDemo(h.db);
  expect(result.deleted).toBeGreaterThan(0);
  const [owned] =
    await h.db`select count(*)::int n from sample_data_rows where batch=${BATCH}`;
  expect(owned.n).toBe(0);
  const rows =
    await h.db`select id from users where email like '%@trial.sunpride.test'`;
  expect(rows.length).toBe(0);
  for (const a of saved) {
    const profiles =
      await h.db`select id from profiles where id=${a.profileId}`;
    expect(profiles.length).toBe(0);
  }
}, 120_000);
