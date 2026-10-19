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
  process.env.SP_LANE = "acct";
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

test("three accounts per client persona, seven distinct application roles and no super-admin", async () => {
  expect(first.created).toBe(27);
  expect(first.total).toBe(27);
  expect(first.counts).toEqual(
    Object.fromEntries(TRIAL_ROLES.map((r) => [r.slug, 3])),
  );
  const rows =
    await h.db`select p.role,count(*)::int n from users u join profiles p on p.user_id=u.id where u.email like '%@trial.sunpride.test' group by p.role`;
  expect(
    Object.fromEntries(rows.map((/** @type {any} */ r) => [r.role, r.n])),
  ).toEqual({
    admin: 3,
    manager: 6,
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
  expect(result.rotated).toBe(27);
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
  expect(text.split(" · ").length).toBe(55);
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
