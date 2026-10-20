import { createHash } from "node:crypto";
import { tx } from "../src/client.js";

export const BATCH = "sunpride-demo-v2";
export const ORGANIZATION = "sunpride";
export const ACTOR = "system:sample";
/** @typedef {import('../src/client.js').Db} Db */
/** @typedef {Record<string, any> & {id:string}} Row */

/** Stable UUIDs deliberately do not depend on insertion order or Postgres sequences.
 * @param {string} table @param {string} key
 */
export function rowId(table, key) {
  const h = createHash("sha256")
    .update(`${BATCH}|${table}|${key}`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Identifiers come from our generated map or pg_catalog, never CLI values.
 * @param {string} name */
export function ident(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name))
    throw new Error("Invalid SQL identifier");
  return `"${name}"`;
}
/** @param {string} day @param {number} [minutes] */
export const at = (day, minutes = 0) =>
  new Date(`${day}T00:00:00+08:00`).getTime() + minutes * 60_000;
/** @param {string} day @param {number} days */
export const plusDays = (day, days) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
export const todayManila = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
/** @param {string} day */
export const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
/** @param {string} month */
export const nextMonth = (month) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1))
    .toISOString()
    .slice(0, 7);
/** Fixed Mulberry32 PRNG. No Math.random, wall-clock sampling, or nondeterministic ids.
 * @param {number} [seed] */
export function random(seed = 20260120) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Dataset {
  /** @param {string} anchorDate @param {number} days */
  constructor(anchorDate, days) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate) ||
      !Number.isFinite(at(anchorDate)) ||
      plusDays(anchorDate, 0) !== anchorDate
    )
      throw new Error("anchorDate must be a real YYYY-MM-DD Manila date");
    if (!Number.isInteger(days) || days < 1 || days > 366)
      throw new Error("days must be between 1 and 366");
    this.anchorDate = anchorDate;
    this.days = days;
    this.start = plusDays(anchorDate, 1 - days);
    this.epoch = new Date(at(this.start)).toISOString();
    this.noon = new Date(at(anchorDate, 12 * 60)).toISOString();
    this.rng = random();
    /** @type {Map<string, Row[]>} */
    this.tables = new Map();
    /** @type {Row[]} */
    this.markers = [];
    /** @type {Set<string>} */
    this.keys = new Set();
  }
  /** @param {string} table @param {string} key @param {Record<string, any>} data @param {string|number} [time] @returns {Row} */
  add(table, key, data, time = this.epoch) {
    const markerKey = `${table}:${key}`;
    if (this.keys.has(markerKey))
      throw new Error(`Duplicate seed key: ${markerKey}`);
    this.keys.add(markerKey);
    const stamp = new Date(time).toISOString();
    const row = {
      id: rowId(table, key),
      created_at: stamp,
      updated_at: stamp,
      ...data,
    };
    const rows = this.tables.get(table) ?? [];
    rows.push(row);
    this.tables.set(table, rows);
    this.markers.push({
      id: rowId("sample_data_rows", markerKey),
      batch: BATCH,
      table_name: table,
      row_id: row.id,
      key: markerKey,
      created_at: stamp,
      updated_at: stamp,
    });
    return row;
  }
  /** @param {string} table */
  rows(table) {
    return this.tables.get(table) ?? [];
  }
  /** @param {string} kind @param {string} key @param {Record<string, any>} details @param {string|number} [time] */
  event(kind, key, details, time = this.noon) {
    return this.add(
      "audit_logs",
      key,
      {
        subject: ACTOR,
        action: `sample.${kind}`,
        entity_type: "sample",
        entity_id: key,
        details: JSON.stringify({ source: "sample", ...details }),
      },
      time,
    );
  }
}

/** @param {Db} db */
export async function foreignKeys(db) {
  return db`select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
    a.attname as column_name, b.attname as parent_column
    from pg_constraint c
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
    join pg_attribute b on b.attrelid=c.confrelid and b.attnum=c.confkey[1]
    where c.contype='f' and c.connamespace='public'::regnamespace`;
}
/** Topological table order. Self references are inserted together in a single statement.
 * @param {string[]} names @param {any[]} fks */
export function dependencyOrder(names, fks) {
  /** @type {string[]} */
  const order = [];
  const pending = new Set(names);
  while (pending.size) {
    const ready = [...pending].filter(
      (name) =>
        !fks.some(
          (f) => f.child === name && f.parent !== name && pending.has(f.parent),
        ),
    );
    if (!ready.length)
      throw new Error("Seed tables contain a foreign key cycle");
    for (const name of ready.sort()) {
      pending.delete(name);
      order.push(name);
    }
  }
  return order;
}
/** @param {Db} db @param {string} table @param {Row[]} rows */
export async function insertRows(db, table, rows) {
  if (!rows.length) return;
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const cols = columns.map(ident).join(",");
  for (let i = 0; i < rows.length; i += 1000) {
    // Force a text parameter: Bun otherwise JSON-encodes this serialized JSON again.
    await db.unsafe(
      `insert into ${ident(table)} (${cols}) select ${cols} from jsonb_populate_recordset(null::${ident(table)}, $1::text::jsonb)${table === "order_intent_queue" ? " on conflict(activity_id) do update set id=excluded.id,status=excluded.status,created_at=excluded.created_at,updated_at=excluded.updated_at" : ""}`,
      [JSON.stringify(rows.slice(i, i + 1000))],
    );
  }
}
/** Atomic insertion of the whole demonstration and its ownership markers.
 * Caller holds the batch advisory lock in the same transaction.
 * @param {Db} db @param {Dataset} data */
export async function persist(db, data) {
  const metadata =
    await db`select table_name,column_name,is_nullable,column_default,is_generated from information_schema.columns where table_schema='public'`;
  for (const [table, rows] of data.tables) {
    const columns = metadata.filter(
      (/** @type {any} */ c) => c.table_name === table,
    );
    if (!columns.length) throw new Error(`Missing seed table: ${table}`);
    for (const row of rows) {
      for (const key of Object.keys(row))
        if (!columns.some((/** @type {any} */ c) => c.column_name === key))
          throw new Error(`Unknown seed column: ${table}.${key}`);
      for (const col of columns)
        if (
          col.is_nullable === "NO" &&
          !col.column_default &&
          col.is_generated === "NEVER" &&
          row[col.column_name] == null
        )
          throw new Error(`Missing seed column: ${table}.${col.column_name}`);
    }
  }
  const order = dependencyOrder([...data.tables.keys()], await foreignKeys(db));
  for (const table of order) await insertRows(db, table, data.rows(table));
  await insertRows(db, "sample_data_rows", data.markers);
}

/**
 * Delete only verified ownership markers, child before parent. Refuse rather than cascade
 * into non-sample data, including sessions created by signing in to a sample account.
 * @param {Db} db
 */
export async function resetDemo(db) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(4310090)`;
    await t`set local jit=off`;
    await t`set local plan_cache_mode=force_custom_plan`;
    // Fresh bulk inserts otherwise leave the trigger planner with empty-table
    // estimates, turning each immutable-row ownership check into a full scan.
    await t`analyze sample_data_rows`;
    const markers =
      await t`select * from sample_data_rows where batch=${BATCH}`;
    if (!markers.length) return { deleted: 0 };
    // Production posting uses random UUIDs and its sync feed uses numeric sequences.
    // These explicit markers still bind table + exact identity, never a name prefix.
    const nativeTables = new Set([
      "inventory_movements",
      "inventory_movement_lines",
      "inventory_allocations",
      "inventory_ledger_entries",
      "inventory_commands",
      "inventory_balances",
      "inventory_lot_balances",
      "audit_logs",
      "integration_events",
      "integration_resolution_events",
      "change_log",
    ]);
    const tables = new Set(
      markers
        .filter((/** @type {any} */ m) => m.table_name !== "change_log")
        .map((/** @type {any} */ m) => String(m.table_name)),
    );
    for (const m of markers) {
      const key = String(m.key);
      ident(m.table_name);
      if (
        !key.startsWith(`${m.table_name}:`) ||
        (rowId(m.table_name, key.slice(m.table_name.length + 1)) !== m.row_id &&
          !(
            nativeTables.has(m.table_name) &&
            key === `${m.table_name}:daily-native:${m.row_id}` &&
            (m.table_name === "change_log"
              ? /^[1-9][0-9]*$/.test(m.row_id)
              : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                  m.row_id,
                ))
          )) ||
        rowId("sample_data_rows", key) !== m.id
      )
        throw new Error("Invalid sample ownership marker; reset refused");
    }
    await t`create temporary table seed_owned_reset (table_name text not null, row_id uuid not null, primary key(table_name,row_id)) on commit drop`;
    await t`insert into seed_owned_reset select table_name,row_id::uuid from sample_data_rows where batch=${BATCH} and table_name<>'change_log'`;
    await t`analyze seed_owned_reset`;
    const fks = await foreignKeys(t);
    // Frozen legacy tables also retain business references as codes/subjects rather
    // than declared FKs. Preserve outside rows that still depend on those masters.
    const legacyRefs = [
      ["orders", "customer_code", "customers", "code"],
      ["order_lines", "product_code", "products", "code"],
      ["inventory_balances", "product_code", "products", "code"],
      ["inventory_balances", "warehouse_code", "inventory_locations", "code"],
      ["visits", "customer_code", "customers", "code"],
      ["orders", "salesperson_subject", "profiles", "auth_subject"],
      ["visits", "salesperson_subject", "profiles", "auth_subject"],
      ["sales_assignments", "salesperson_subject", "profiles", "auth_subject"],
      ["sales_assignments", "customer_code", "customers", "code"],
      ["daily_sku_metrics", "product_code", "products", "code"],
      ["daily_customer_metrics", "customer_code", "customers", "code"],
      ["rollup_contribution_skus", "product_code", "products", "code"],
      ["rollup_contributions", "customer_code", "customers", "code"],
    ].map(([child, column_name, parent, parent_column]) => ({
      child,
      column_name,
      parent,
      parent_column,
    }));
    const refs = [...fks, ...legacyRefs];
    // Take table locks before the preflight so a concurrent writer cannot add a dependency
    // between inspection and deletion. No constraints/triggers are disabled.
    const locked = new Set([
      ...tables,
      ...refs
        .filter((/** @type {any} */ f) => tables.has(f.parent))
        .map((/** @type {any} */ f) => String(f.child)),
    ]);
    for (const table of [...locked].sort())
      await t.unsafe(`lock table ${ident(table)} in share row exclusive mode`);
    for (const f of refs) {
      if (!tables.has(f.parent)) continue;
      const [external] = await t.unsafe(
        `select 1 from ${ident(f.child)} c
        join ${ident(f.parent)} p on c.${ident(f.column_name)}=p.${ident(f.parent_column)}
        join seed_owned_reset owned on owned.table_name=$1 and owned.row_id=p.id
        left join seed_owned_reset mine on mine.table_name=$2 and mine.row_id=(to_jsonb(c)->>'id')::uuid
        where mine.row_id is null limit 1`,
        [f.parent, f.child],
      );
      if (external)
        throw new Error(
          `Reset refused: non-sample ${f.child} references sample ${f.parent}`,
        );
    }
    await t`select set_config('sunpride.seed_reset',${BATCH},true)`;
    let deleted = 0;
    for (const table of dependencyOrder([...tables], fks).reverse()) {
      const result = await t.unsafe(
        `delete from ${ident(table)} r using seed_owned_reset m where m.table_name=$1 and r.id=m.row_id returning r.id`,
        [table],
      );
      deleted += result.length;
    }
    const feed =
      await t`delete from change_log r using sample_data_rows m where m.batch=${BATCH} and m.table_name='change_log' and r.seq=m.row_id::bigint returning r.seq`;
    deleted += feed.length;
    await t`delete from sample_data_rows where batch=${BATCH}`;
    return { deleted };
  });
}
