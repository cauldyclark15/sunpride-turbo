// Schema lane test: applies the CORE stub plus every 0100-0199 domain migration to a fresh
// throwaway database, then proves each mapped table accepts a minimal row and is readable
// through every index's leading column, and that CHECK / UNIQUE / EXCLUDE constraints bite.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PKG = join(import.meta.dir, '..');
const MIGRATIONS = join(PKG, 'migrations');
const STUB = join(import.meta.dir, 'fixtures', '0001_platform_stub.sql');
const DB_NAME = `sunpride_lane_schema_t${Math.random().toString(36).slice(2, 10)}`;

/** @param {string} url @param {string} name */
function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const laneUrl = readFileSync(join(homedir(), '.sunpride-keys', 'pg-lane-schema-url'), 'utf8').trim();
/** @type {SQL} */
let admin;
/** @type {SQL} */
let db;
let created = false;

/** @param {string} name */
const qi = (name) => `"${name.replaceAll('"', '""')}"`;

beforeAll(async () => {
  admin = new SQL(laneUrl, { max: 1 });
  await admin.unsafe(`create database ${qi(DB_NAME)}`);
  created = true;
  db = new SQL(withDatabase(laneUrl, DB_NAME), { max: 4 });
  const files = [STUB, ...readdirSync(MIGRATIONS).filter((f) => /^01\d\d_.*\.sql$/.test(f)).sort().map((f) => join(MIGRATIONS, f))];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    await db.begin(async (tx) => {
      await tx.unsafe(text).simple();
    });
  }
}, 120_000);

afterAll(async () => {
  try {
    if (db) await db.close();
  } finally {
    if (created) await admin.unsafe(`drop database if exists ${qi(DB_NAME)} with (force)`);
    await admin.close();
  }
}, 60_000);

/** Parse MAPPING.md: rows of `| Convex | `pg`, `pg2` | migration | notes |`. */
function mapping() {
  const rows = [];
  for (const line of readFileSync(join(PKG, 'MAPPING.md'), 'utf8').split('\n')) {
    const m = /^\| (\w+) \| (.+?) \| (\S+.*?) \| (.*) \|$/.exec(line);
    if (!m || m[1] === 'Convex') continue;
    const tables = [...m[2].matchAll(/`([a-z0-9_]+)`/g)].map((x) => x[1]);
    rows.push({ convex: m[1], tables, migration: m[3], core: m[3].includes('lane CORE') });
  }
  return rows;
}

/**
 * @typedef {{ name: string, nullable: boolean, hasDefault: boolean, generated: boolean, udt: string, dataType: string }} ColInfo
 */

/** @param {string} table */
async function columns(table) {
  const rows = await db`
    select column_name, is_nullable, column_default, is_generated, udt_name, data_type
    from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
    order by ordinal_position`;
  return /** @type {ColInfo[]} */ (
    rows.map((/** @type {any} */ r) => ({
      name: r.column_name,
      nullable: r.is_nullable === 'YES',
      hasDefault: r.column_default != null,
      generated: r.is_generated === 'ALWAYS',
      udt: r.udt_name,
      dataType: r.data_type,
    }))
  );
}

/** @param {string} table @returns {Promise<Map<string, string>>} column -> referenced table */
async function foreignKeys(table) {
  const rows = await db`
    select a.attname as col, c.confrelid::regclass::text as ref
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.conrelid = ${table}::regclass and array_length(c.conkey, 1) = 1`;
  return new Map(rows.map((/** @type {any} */ r) => [r.col, r.ref]));
}

/** @param {string} table @returns {Promise<Map<string, string>>} column -> check definition */
async function checks(table) {
  const rows = await db`
    select a.attname as col, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'c' and c.conrelid = ${table}::regclass and array_length(c.conkey, 1) = 1`;
  return new Map(rows.map((/** @type {any} */ r) => [r.col, r.def]));
}

/** @type {Map<string, string>} table -> inserted row id */
const inserted = new Map();

/** Value for a required column, as a text literal cast in SQL. @param {ColInfo} c @param {string | undefined} check */
function valueFor(c, check) {
  if (c.name === 'local_month') return '2026-10';
  if (check && c.udt === 'text') {
    const lit = /'((?:[^']|'')*)'::text/.exec(check);
    if (lit) return lit[1].replaceAll("''", "'");
  }
  switch (c.udt) {
    case 'uuid':
      return crypto.randomUUID();
    case 'text':
    case 'citext':
      return 'x';
    case 'int2':
    case 'int4':
    case 'int8':
    case 'numeric':
    case 'float8':
      return '1';
    case 'bool':
      return 'false';
    case 'date':
      return '2026-10-19';
    case 'timestamptz':
      return '2026-10-19T00:00:00Z';
    case 'jsonb':
      return '{}';
    default:
      if (c.dataType === 'ARRAY') return '{}';
      throw new Error(`no filler for ${c.name} ${c.udt}`);
  }
}

/** Insert (once) a minimal valid row, building required FK parents first. @param {string} table @param {string[]} [stack] */
async function ensureRow(table, stack = []) {
  const have = inserted.get(table);
  if (have) return have;
  if (stack.includes(table)) throw new Error(`required FK cycle: ${[...stack, table].join(' -> ')}`);
  const [cols, fks, cks] = await Promise.all([columns(table), foreignKeys(table), checks(table)]);
  /** @type {string[]} */
  const names = [];
  /** @type {string[]} */
  const exprs = [];
  /** @type {string[]} */
  const params = [];
  for (const c of cols) {
    if (c.generated || c.nullable || c.hasDefault) continue;
    const ref = fks.get(c.name);
    const v = ref ? await ensureRow(ref, [...stack, table]) : valueFor(c, cks.get(c.name));
    params.push(v);
    names.push(qi(c.name));
    exprs.push(`$${params.length}::${c.dataType === 'ARRAY' ? `${c.udt.slice(1)}[]` : c.udt}`);
  }
  const sqlText = names.length
    ? `insert into ${qi(table)} (${names.join(', ')}) values (${exprs.join(', ')}) returning id`
    : `insert into ${qi(table)} default values returning id`;
  const rows = await db.unsafe(sqlText, params);
  const id = String(rows[0].id);
  inserted.set(table, id);
  return id;
}

/** @param {() => Promise<unknown>} fn */
async function sqlState(fn) {
  try {
    await fn();
  } catch (e) {
    const err = /** @type {any} */ (e);
    return String(err.errno ?? err.code);
  }
  return 'no error';
}

describe('domain schema', () => {
  test('MAPPING.md lists all 146 Convex tables once', () => {
    const rows = mapping();
    expect(rows.length).toBe(146);
    expect(new Set(rows.map((r) => r.convex)).size).toBe(146);
    expect(rows.filter((r) => r.core).length).toBe(6);
    for (const r of rows.filter((x) => !x.core)) expect(r.tables.length).toBeGreaterThan(0);
  });

  test('every mapped Postgres table exists, and no unmapped domain table does', async () => {
    const pg = new Set(
      (await db`select tablename from pg_tables where schemaname = 'public'`).map((/** @type {any} */ r) => r.tablename),
    );
    const mapped = mapping().filter((r) => !r.core).flatMap((r) => r.tables);
    expect(new Set(mapped).size).toBe(mapped.length);
    for (const t of mapped) expect(pg.has(t) ? t : `missing ${t}`).toBe(t);
    const stub = new Set(['users', 'registered_devices', 'files']);
    const unmapped = [...pg].filter((t) => !stub.has(t) && !mapped.includes(t));
    expect(unmapped).toEqual([]);
  });

  test('every table takes a minimal row and reads it back through each index leading column', async () => {
    const tables = mapping().filter((r) => !r.core).flatMap((r) => r.tables);
    let probes = 0;
    for (const table of tables) {
      const id = await ensureRow(table);
      const idx = await db`
        select i.relname as index, a.attname as col
        from pg_index x
        join pg_class i on i.oid = x.indexrelid
        left join pg_attribute a on a.attrelid = x.indrelid and a.attnum = x.indkey[0]
        where x.indrelid = ${table}::regclass`;
      expect(idx.length).toBeGreaterThan(0);
      for (const { index, col } of idx) {
        if (!col) continue; // expression-led exclusion index (sales_targets subject coalesce)
        const c = qi(col);
        const rows = await db.unsafe(
          `select id from ${qi(table)} where ${c} is not distinct from (select ${c} from ${qi(table)} where id = $1::uuid)`,
          [id],
        );
        expect(rows.map((/** @type {any} */ r) => String(r.id)), `${table}.${index}`).toContain(id);
        probes += 1;
      }
    }
    expect(inserted.size).toBeGreaterThanOrEqual(tables.length);
    expect(probes).toBeGreaterThan(400);
  }, 120_000);

  test('CHECK keeps exact Convex literals', async () => {
    const bad = sqlState(() => db`insert into positions (organization_id, code, label, category, active)
      values ('org', 'P-BAD', 'Bad', 'Leadership', true)`);
    expect(await bad).toBe('23514');
    const good = await db`insert into positions (organization_id, code, label, category, active)
      values ('org', 'P-OK', 'Ok', 'leadership', true) returning id`;
    expect(good.length).toBe(1);
  });

  test('UNIQUE rejects a duplicate natural key and a replayed idempotency key', async () => {
    await db`insert into positions (organization_id, code, label, category, active) values ('org', 'P-DUP', 'A', 'field', true)`;
    const dup = sqlState(() => db`insert into positions (organization_id, code, label, category, active)
      values ('org', 'P-DUP', 'B', 'field', true)`);
    expect(await dup).toBe('23505');
    const [cmd] = await db`insert into inventory_commands
      (organization_id, idempotency_key, command_type, schema_version, payload_hash, actor_subject, status)
      values ('org', 'K-1', 'receipt', 1, 'h', 'actor', 'posted') returning id`;
    expect(cmd.id).toBeTruthy();
    const replay = sqlState(() => db`insert into inventory_commands
      (organization_id, idempotency_key, command_type, schema_version, payload_hash, actor_subject, status)
      values ('org', 'K-1', 'receipt', 1, 'h2', 'actor', 'posted')`);
    expect(await replay).toBe('23505');
  });

  test('EXCLUDE rejects overlapping effective-dated assignments but allows adjacent ones', async () => {
    const [p] = await db`insert into profiles (name, email, role, status) values ('Ann', 'ann@example.test', 'sales', 'active') returning id`;
    const ins = (/** @type {string} */ from, /** @type {string | null} */ to) => db`
      insert into employee_assignments (profile_id, role, effective_from, effective_to, actor_subject, reason)
      values (${p.id}, 'sales', ${from}::timestamptz, ${to}::timestamptz, 'actor', 'test')`;
    await ins('2026-10-01T00:00:00Z', '2026-10-15T00:00:00Z');
    await ins('2026-10-15T00:00:00Z', null);
    expect(await sqlState(() => ins('2026-10-10T00:00:00Z', '2026-10-12T00:00:00Z'))).toBe('23P01');
    expect(await sqlState(() => ins('2026-11-01T00:00:00Z', null))).toBe('23P01');
    expect(await sqlState(() => ins('2026-10-20T00:00:00Z', '2026-10-10T00:00:00Z'))).toBe('23514');
  });

  test('synced tables bump change_seq on update; others keep updated_at', async () => {
    const [o] = await db`insert into org_units (organization_id, code, name, type_code, status, effective_from)
      values ('org', 'U-SEQ', 'Unit', 'region', 'active', now()) returning id, change_seq`;
    const [u] = await db`update org_units set name = 'Unit 2' where id = ${o.id} returning change_seq, deleted_at`;
    expect(BigInt(u.change_seq)).toBeGreaterThan(BigInt(o.change_seq));
    expect(u.deleted_at).toBeNull();
    const [t] = await db`insert into org_unit_types (organization_id, code, label, level, active)
      values ('org', 'T-UPD', 'T', 1, true) returning id, updated_at`;
    await Bun.sleep(5);
    const [t2] = await db`update org_unit_types set label = 'T2' where id = ${t.id} returning updated_at`;
    expect(new Date(t2.updated_at).getTime()).toBeGreaterThan(new Date(t.updated_at).getTime());
  });
});
