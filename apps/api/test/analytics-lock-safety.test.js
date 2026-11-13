import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDb, tx } from "@sunpride/db/client";
import { createUser, startHarness } from "./harness.js";
import { setSupervisorPin } from "../src/domains/storepos/overrides.js";
import { rebuildDay } from "../src/domains/analytics/refresh.js";

// SP-0169 (22:38 codex lane): the analytics day rebuild sat `idle in transaction` while
// holding FK key-share locks on profiles (analytics_daily_sales/agent_daily_metrics
// rows reference them), and office supervisor-PIN saves (`profiles … for update`)
// hung behind it until the API restarted.

/** @template T @param {Promise<T>} p @param {number} ms */
const within = (p, ms) =>
  Promise.race([p, Bun.sleep(ms).then(() => /** @type {const} */ ("hung"))]);

/** @type {any} */ let h;
const unit = crypto.randomUUID();
/** @type {any} */ let admin;
/** @type {string} */ let supervisorId;

beforeAll(async () => {
  h = await startHarness({ listen: false });
  h.setHooks({ unitInScope: async () => true });
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','LOCKS','SAMPLE Lock unit','national','active',now()-interval '1 day')`;
  /** @param {string} email @param {string} role */
  const person = async (email, role) => {
    const userId = await createUser(h, email, "fixture password only");
    const id = crypto.randomUUID();
    await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${id},${userId},${userId},${email},${email},${role},'active',${unit})`;
    return { id, userId };
  };
  const a = await person("lock-admin@example.com", "super_admin");
  supervisorId = (await person("lock-boss@example.com", "super_admin")).id;
  admin = {
    profileId: a.id,
    userId: a.userId,
    role: "super_admin",
    orgUnitId: unit,
  };
});
afterAll(async () => {
  await h?.close();
});

test("a supervisor-PIN save does not wait on FK key-share locks other transactions hold on the profile", async () => {
  const other = createDb(h.dbUrl, { max: 1 });
  try {
    /** @type {() => void} */ let locked = () => {};
    const holds = new Promise((r) => (locked = () => r(undefined)));
    /** @type {() => void} */ let finish = () => {};
    const done = new Promise((r) => (finish = () => r(undefined)));
    // What an analytics/order/visit insert referencing the profile holds until commit.
    const holder = tx(other, async (t) => {
      await t`select id from profiles where id=${supervisorId} for key share`;
      locked();
      await done;
    });
    await holds;
    const saved = await within(
      tx(h.db, (db) =>
        setSupervisorPin(db, admin, { profileId: supervisorId, pin: "482915" }),
      ).then(
        (r) => (r?.id ? "saved" : "no id"),
        (e) => `error: ${e.message}`,
      ),
      3000,
    );
    finish();
    await holder;
    expect(saved).toBe("saved");
  } finally {
    await other.close({ timeout: 1 });
  }
});

test("two PIN saves for the same person still serialize (no lost rotation)", async () => {
  const results = await Promise.all(
    ["111357", "246802"].map((pin) =>
      tx(h.db, (db) =>
        setSupervisorPin(db, admin, { profileId: supervisorId, pin }),
      ),
    ),
  );
  expect(results.every((r) => r.id)).toBe(true);
  const [open] =
    await h.db`select count(*)::int n from store_supervisor_pins where profile_id=${supervisorId} and effective_to is null`;
  expect(open.n).toBe(1);
});

test("the analytics day rebuild finishes and leaves no transaction idle", async () => {
  const day = "2026-11-12";
  const res = await within(
    rebuildDay(h.db, day).then(() => "done"),
    20_000,
  );
  expect(res).toBe("done");
  const [st] =
    await h.db`select count(*)::int as n from pg_stat_activity where datname=current_database() and state='idle in transaction'`;
  expect(st.n).toBe(0);
  const [row] =
    await h.db`select count(*)::int n from analytics_refresh_state where service_date=${day}`;
  expect(row.n).toBe(1);
});
