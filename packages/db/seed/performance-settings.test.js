import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDb } from "../src/client.js";
import { migrate } from "../src/migrate.js";
import { seedDemo } from "./index.js";
import { ident } from "./store.js";

/** @type {import('../src/client.js').Db} */ let db;
/** @type {import('../src/client.js').Db} */ let admin;
let database = "";
beforeAll(async () => {
  const base = (
    await Bun.file(`${process.env.HOME}/.sunpride-keys/pg-lane-core-url`).text()
  ).trim();
  const url = new URL(base);
  admin = createDb(base, { max: 1 });
  database = `sunpride_lane_core_t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.unsafe(`create database ${ident(database)}`);
  url.pathname = `/${database}`;
  db = createDb(url.toString(), { max: 1 });
  await migrate(db);
  await db`set jit=on`;
  await db`set work_mem='4MB'`;
  // F-025: execute the production seed with a database-side check at its actual
  // bulk writer, not a mock that merely observes two SET statements.
  await db.unsafe(`create function seed_native_settings_guard() returns trigger language plpgsql as $$
    begin
      if current_setting('jit')<>'off' or current_setting('work_mem')<>'64MB' then
        raise exception 'Bulk seed needs transaction-local native query settings';
      end if;
      return new;
    end; $$;
    create trigger seed_native_settings_guard before insert on orders
    for each row execute function seed_native_settings_guard()`);
}, 120000);
afterAll(async () => {
  await db?.close();
  if (database && admin)
    await admin.unsafe(`drop database ${ident(database)} with (force)`);
  await admin?.close();
}, 120000);

test("F-025 native seed tuning reaches the actual writer and restores caller settings after commit and replay", async () => {
  const [before] =
    await db`select current_setting('jit') as jit,current_setting('work_mem') as work_mem`;
  const seeded = await seedDemo(db, { days: 3, anchorDate: "2026-10-19" });
  expect(seeded.duplicate).toBe(false);
  expect((await db`select count(*)::int n from orders`)[0].n).toBeGreaterThan(
    0,
  );
  expect(
    (
      await db`select current_setting('jit') as jit,current_setting('work_mem') as work_mem`
    )[0],
  ).toEqual(before);
  expect(
    (await seedDemo(db, { days: 3, anchorDate: "2026-10-19" })).duplicate,
  ).toBe(true);
  expect(
    (
      await db`select current_setting('jit') as jit,current_setting('work_mem') as work_mem`
    )[0],
  ).toEqual(before);
}, 30000);
