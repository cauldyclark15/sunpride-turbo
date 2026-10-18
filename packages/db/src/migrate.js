#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDb } from "./client.js";

/** @typedef {import('./client.js').Db} Db */

export const MIGRATIONS_DIR = resolve(import.meta.dir, "../migrations");

/**
 * Apply every `*.sql` file in `dir` in lexical order, once each, each inside its own
 * transaction, recording it in `schema_migrations`.
 * @param {Db} db
 * @param {string} [dir]
 * @returns {Promise<string[]>} names applied in this run
 */
export async function migrate(db, dir = MIGRATIONS_DIR) {
  await db`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  /** @type {string[]} */
  const applied = [];
  for (const name of names) {
    const done = await db`select 1 from schema_migrations where name = ${name}`;
    if (done.length) continue;
    const sql = await Bun.file(join(dir, name)).text();
    await db.begin(async (t) => {
      // Serialize concurrent runners; re-check inside the lock.
      await t`select pg_advisory_xact_lock(4310001)`;
      const again =
        await t`select 1 from schema_migrations where name = ${name}`;
      if (again.length) return;
      await t.unsafe(sql);
      await t`insert into schema_migrations (name) values (${name})`;
      applied.push(name);
    });
  }
  return applied;
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const dir = process.argv[2] ? resolve(process.argv[2]) : MIGRATIONS_DIR;
  const db = createDb(url, { max: 1 });
  try {
    const applied = await migrate(db, dir);
    console.log(
      applied.length ? `applied: ${applied.join(", ")}` : "up to date",
    );
  } catch (error) {
    console.error(
      "migration failed:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
