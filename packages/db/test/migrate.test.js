import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, tx } from "../src/client.js";
import { migrate, MIGRATIONS_DIR } from "../src/migrate.js";

const baseUrl = (
  await Bun.file(`${process.env.HOME}/.sunpride-keys/pg-lane-core-url`).text()
).trim();
const name = `sunpride_lane_core_t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const admin = createDb(baseUrl, { max: 1 });
/** @type {import('../src/client.js').Db} */
let db;

beforeAll(async () => {
  await admin.unsafe(`create database ${name}`);
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  db = createDb(url.toString(), { max: 4 });
});

afterAll(async () => {
  await db?.close();
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.close();
});

describe("migrate", () => {
  test("applies 0001 once and records it", async () => {
    const first = await migrate(db, MIGRATIONS_DIR);
    expect(first).toContain("0001_platform.sql");
    const second = await migrate(db, MIGRATIONS_DIR);
    expect(second).toEqual([]);
    const rows = await db`select name from schema_migrations order by name`;
    expect(rows.map((/** @type {any} */ r) => r.name)).toContain(
      "0001_platform.sql",
    );
    const tables =
      await db`select table_name from information_schema.tables where table_schema = 'public'`;
    const names = tables.map((/** @type {any} */ r) => r.table_name);
    for (const t of [
      "users",
      "sessions",
      "access_tokens",
      "registered_devices",
      "device_challenges",
      "rate_limits",
      "op_receipts",
      "change_log",
      "files",
      "jobs",
      "embeddings",
      "schema_migrations",
    ])
      expect(names).toContain(t);
  });

  test("lexical order, failing file rolls back and is not recorded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mig-"));
    await writeFile(
      join(dir, "0002_b.sql"),
      "create table zz_b (id int references zz_a(id));",
    );
    await writeFile(
      join(dir, "0001_a.sql"),
      "create table zz_a (id int primary key);",
    );
    await writeFile(
      join(dir, "0003_bad.sql"),
      "create table zz_c (id int); select broken_syntax(;",
    );
    await expect(migrate(db, dir)).rejects.toThrow();
    const rows =
      await db`select name from schema_migrations where name like '000%' and name <> '0001_platform.sql' order by name`;
    expect(rows.map((/** @type {any} */ r) => r.name)).toEqual([
      "0001_a.sql",
      "0002_b.sql",
    ]);
    const c = await db`select to_regclass('zz_c') as t`;
    expect(c[0].t).toBeNull();
  });

  test("bump_change_seq sets updated_at and change_seq on update", async () => {
    await db`create table zz_sync (id int primary key, v text, updated_at timestamptz not null default now(), change_seq bigint not null default nextval('change_seq'))`;
    await db`create trigger zz_sync_bump before update on zz_sync for each row execute function bump_change_seq()`;
    await db`insert into zz_sync (id, v, updated_at) values (1, 'a', now() - interval '1 day')`;
    const [before] =
      await db`select change_seq, updated_at from zz_sync where id = 1`;
    await db`update zz_sync set v = 'b' where id = 1`;
    const [after] =
      await db`select change_seq, updated_at from zz_sync where id = 1`;
    expect(BigInt(after.change_seq)).toBeGreaterThan(BigInt(before.change_seq));
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );
  });

  test("tx commits and rolls back", async () => {
    await db`create table zz_tx (id int primary key)`;
    await tx(db, async (t) => {
      await t`insert into zz_tx values (1)`;
    });
    await expect(
      tx(db, async (t) => {
        await t`insert into zz_tx values (2)`;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await db`select id from zz_tx order by id`;
    expect(rows.map((/** @type {any} */ r) => r.id)).toEqual([1]);
  });

  test("jobs coalescing index allows one pending row per key", async () => {
    await db`insert into jobs (kind, coalesce_key) values ('k', 'a')`;
    await expect(
      (async () =>
        db`insert into jobs (kind, coalesce_key) values ('k', 'a')`)(),
    ).rejects.toThrow();
    await db`update jobs set status = 'done' where kind = 'k'`;
    await db`insert into jobs (kind, coalesce_key) values ('k', 'a')`;
  });

  test("embeddings accepts a vector of declared dims", async () => {
    const owner = crypto.randomUUID();
    await db`insert into embeddings (owner_table, owner_id, model, dims, embedding) values ('x', ${owner}, 'm', 3, '[1,2,3]')`;
    await expect(
      (async () =>
        db`insert into embeddings (owner_table, owner_id, model, dims, embedding) values ('x', ${owner}, 'm', 4, '[1,2,3]')`)(),
    ).rejects.toThrow();
  });
});
