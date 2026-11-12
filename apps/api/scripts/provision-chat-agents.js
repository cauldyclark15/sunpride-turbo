#!/usr/bin/env bun
// Phantasm AI developers as Messages AI users (the SP-0144 chat agents).
//
//   DATABASE_URL=... bun apps/api/scripts/provision-chat-agents.js --agents <agents.json> --token-dir <dir> --dry-run
//   DATABASE_URL=... bun apps/api/scripts/provision-chat-agents.js --agents <agents.json> --token-dir <dir> --yes
//   ... --yes --rotate <handle>        issue a new token for an existing agent (the old one stops working at once)
//
// <agents.json> = [{"handle":"mark","display_name":"Mark Aven"}, ...]. Agents are created through the same
// createAgent() the admin API uses, acting as an existing super admin (--actor, default jcing.jc@gmail.com).
// Idempotent: an active agent with that handle is left as it is and its token is not touched.
// A new token is written ONLY to <token-dir>/<handle>.token (mode 600) and is never printed.
// Output: one JSON summary (no tokens, no URLs). --dry-run writes nothing.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDb } from "@sunpride/db/client";
import { randomToken, sha256Hex } from "../src/core/util.js";
import { createAgent } from "../src/domains/messaging/agents.js";
import * as M from "../src/domains/messaging/model.js";

const args = process.argv.slice(2);
const flag = (/** @type {string} */ n) => args.includes(n);
const opt = (
  /** @type {string} */ n,
  /** @type {string|undefined} */ d = undefined,
) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

/**
 * @param {any} sql
 * @param {{agents:{handle:string,display_name:string}[], tokenDir:string, dryRun:boolean, actor?:string, rotate?:string|null}} o
 */
export async function provision(sql, o) {
  const actorEmail = (o.actor ?? "jcing.jc@gmail.com").toLowerCase();
  const [actor] =
    await sql`select u.id from users u join profiles p on p.user_id=u.id where lower(u.email)=${actorEmail} and u.disabled_at is null and p.role='super_admin' and p.status='active'`;
  if (!actor)
    throw new Error("The acting account is not an active super admin");
  /** @type {any[]} */ const out = [];
  for (const a of o.agents) {
    if (
      !/^[a-z][a-z0-9_-]{1,49}$/.test(a.handle) ||
      !a.display_name?.trim() ||
      a.display_name.length > 100
    )
      throw new Error(`Bad agent entry: ${a.handle}`);
    const [found] =
      await sql`select user_id,display_name,disabled_at from chat_agents where handle=${a.handle}`;
    const file = join(o.tokenDir, `${a.handle}.token`);
    if (found && found.disabled_at) {
      out.push({
        handle: a.handle,
        action: "skipped-disabled",
        user_id: found.user_id,
      });
      continue;
    }
    if (found && o.rotate !== a.handle) {
      out.push({ handle: a.handle, action: "exists", user_id: found.user_id });
      continue;
    }
    if (o.dryRun) {
      out.push({
        handle: a.handle,
        action: found ? "would-rotate" : "would-create",
      });
      continue;
    }
    /** @type {string} */ let id;
    /** @type {string} */ let token;
    if (found) {
      token = randomToken("spa_");
      await M.write(sql, async (/** @type {any} */ db) => {
        await db`update chat_agents set token_hash=${sha256Hex(token)} where user_id=${found.user_id}`;
      });
      id = found.user_id;
    } else {
      ({ id, token } = await createAgent(sql, {
        handle: a.handle,
        displayName: a.display_name,
        createdBy: actor.id,
      }));
    }
    mkdirSync(o.tokenDir, { recursive: true, mode: 0o700 });
    writeFileSync(file, token + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
    out.push({
      handle: a.handle,
      action: found ? "rotated" : "created",
      user_id: id,
      token_file: file,
    });
  }
  return out;
}

if (import.meta.main) {
  const dryRun = flag("--dry-run");
  if (dryRun === flag("--yes")) {
    console.error("Choose exactly one of --dry-run or --yes");
    process.exit(2);
  }
  const agentsFile = opt("--agents"),
    tokenDir = opt("--token-dir");
  if (!agentsFile || !tokenDir || !process.env.DATABASE_URL) {
    console.error("Need --agents <file>, --token-dir <dir> and DATABASE_URL");
    process.exit(2);
  }
  const sql = createDb(process.env.DATABASE_URL, { max: 2 });
  try {
    const result = await provision(sql, {
      agents: JSON.parse(readFileSync(agentsFile, "utf8")),
      tokenDir,
      dryRun,
      actor: opt("--actor"),
      rotate: opt("--rotate") ?? null,
    });
    console.log(JSON.stringify({ dry_run: dryRun, agents: result }, null, 1));
  } finally {
    await sql.close();
  }
}
