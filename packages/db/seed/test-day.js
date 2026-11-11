#!/usr/bin/env bun
/**
 * Test-day fixture kit for a LOCAL e2e lane (sunpride_lane_codex / sunpride_lane_fixture only).
 * Runs after reset-db.sh on the same Manila day and adds the current-day work the e2e packs need
 * (codex-e2e/scripts/test-day.sh wraps it). Every business write goes through the lane API as the
 * person the product expects (office admin, operations clerk, approver ...). The only direct SQL
 * writes are (a) short-lived web sessions for those sample people (deleted at the end) and
 * (b) clearly marked `sample_data_rows` fixture rows, via the seed `Dataset/persist` path, for
 * phone-originated records whose only writer is a signed device op (census captures, bad-order
 * lines, truck damage, per-diem packs). `resetDemo` removes those like any other sample row.
 *
 * Idempotent: every section first looks for its own fixture (deterministic names/keys per date)
 * and only creates what is missing; a rerun on the same day prints `kept` for each section.
 *
 * usage: DB_URL_FILE=... LANE_DB=... API_PORT=4720 bun packages/db/seed/test-day.js [--check] [--only a,b]
 * Prints names, counts and statuses only (never a URL, password, PIN or token).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { createDb } from "../src/client.js";
import { todayManila } from "./store.js";

const LANES = ["sunpride_lane_codex", "sunpride_lane_fixture"];
const LANE_DB = process.env.LANE_DB ?? "";
if (!LANES.includes(LANE_DB)) {
  console.error(`REFUSING: LANE_DB must be one of ${LANES.join(", ")}`);
  process.exit(3);
}
const url = readFileSync(String(process.env.DB_URL_FILE), "utf8").trim();
if (decodeURIComponent(new URL(url).pathname.slice(1)) !== LANE_DB) {
  console.error("REFUSING: DB_URL_FILE does not point at LANE_DB");
  process.exit(3);
}
const API = `http://127.0.0.1:${process.env.API_PORT ?? 4710}`;
const ORIGIN = `http://127.0.0.1:${process.env.WEB_PORT ?? 4711}`;
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const ONLY = args.includes("--only")
  ? String(args[args.indexOf("--only") + 1]).split(",")
  : null;
export const TODAY = process.env.TEST_DAY_DATE ?? todayManila();
export const TAG = `TD-${TODAY.replaceAll("-", "")}`; // fixture name prefix for today

export const db = createDb(url, { max: 2 });
/** @type {Map<string,{cookie:string,sessionId:string}>} */
const sessions = new Map();
const sha = (/** @type {string} */ s) =>
  createHash("sha256").update(s).digest("hex");
/** Deterministic idempotency key for (section, step) today. @param {string} s */
export const key = (s) => `td-${sha(`${TODAY}|${s}`).slice(0, 32)}`;
/** Same, shaped as a UUID for commands that require one. @param {string} s */
export const uid = (s) => {
  const h = sha(`${TODAY}|uuid|${s}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** A short-lived web session for a sample person (auth plumbing only). @param {string} email */
async function session(email) {
  const hit = sessions.get(email);
  if (hit) return hit.cookie;
  const [u] =
    await db`select u.id from users u join profiles p on p.user_id=u.id where lower(u.email)=${email} and p.status='active' and p.deleted_at is null limit 1`;
  if (!u) throw new Error(`no active sample login ${email}`);
  const token = `sps_${randomBytes(16).toString("hex")}`;
  const [s] =
    await db`insert into sessions (user_id,token_hash,app,expires_at) values (${u.id},${sha(token)},'web',now()+interval '30 minutes') returning id`;
  const cookie = `sp_session=${token}`;
  sessions.set(email, { cookie, sessionId: s.id });
  return cookie;
}
/** @param {string} email @param {string} path @param {any} [body] @param {{key?:string,method?:string}} [o] */
export async function api(email, path, body, o = {}) {
  const cookie = await session(email);
  const method = o.method ?? (body === undefined ? "GET" : "POST");
  const res = await fetch(API + path, {
    method,
    headers: {
      "content-type": "application/json",
      cookie,
      origin: ORIGIN,
      ...(o.key ? { "idempotency-key": o.key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    const msg =
      typeof json === "object"
        ? (json?.error?.message ??
          json?.message ??
          JSON.stringify(json).slice(0, 300))
        : String(json).slice(0, 300);
    const e = /** @type {any} */ (
      new Error(`${method} ${path} -> ${res.status}: ${msg}`)
    );
    e.status = res.status;
    e.body = json;
    throw e;
  }
  return json;
}
export const one = async (/** @type {any} */ q) => (await q)[0];

/** @type {{name:string,cases:string[],ensure:()=>Promise<string>,check:()=>Promise<Record<string,any>>}[]} */
export const sections = [];
/** @param {string} name @param {string[]} cases @param {()=>Promise<string>} ensure @param {()=>Promise<Record<string,any>>} check */
export function section(name, cases, ensure, check) {
  sections.push({ name, cases, ensure, check });
}

export async function main() {
  const [m] =
    await db`select a.details from audit_logs a join sample_data_rows m on m.row_id=a.id::text where m.key='audit_logs:manifest'`;
  const anchor = m ? JSON.parse(m.details).anchorDate : null;
  if (anchor !== TODAY) {
    console.error(
      `REFUSING: seed anchor is ${anchor ?? "missing"} but today (Manila) is ${TODAY}. Run reset-db.sh --yes first (seeded day work is anchored on the reset day).`,
    );
    return 4;
  }
  const report = [];
  let failed = 0;
  for (const s of sections) {
    if (ONLY && !ONLY.includes(s.name)) continue;
    let action = "checked";
    try {
      if (!CHECK) action = await s.ensure();
      const facts = await s.check();
      const ok = Object.values(facts).every(
        (v) => v !== false && v !== 0 && v !== null,
      );
      if (!ok) failed++;
      report.push({
        section: s.name,
        action,
        ok,
        facts,
        cases: s.cases.length,
      });
      console.log(
        `${ok ? "OK  " : "MISS"} ${s.name.padEnd(22)} ${action.padEnd(8)} ${JSON.stringify(facts)}`,
      );
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      report.push({ section: s.name, action: "error", ok: false, error: msg });
      console.log(`ERR  ${s.name.padEnd(22)} ${msg.slice(0, 400)}`);
    }
  }
  if (process.env.TEST_DAY_REPORT)
    writeFileSync(
      process.env.TEST_DAY_REPORT,
      JSON.stringify({ date: TODAY, lane: LANE_DB, failed, report }, null, 2),
    );
  return failed ? 1 : 0;
}

export async function cleanup() {
  for (const { sessionId } of sessions.values())
    await db`delete from sessions where id=${sessionId}`;
  await db.close();
}

if (import.meta.main) {
  await import("./test-day-fixtures.js");
  let code = 1;
  try {
    code = await main();
  } finally {
    await cleanup();
  }
  process.exit(code);
}
