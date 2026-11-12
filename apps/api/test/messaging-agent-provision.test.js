import { beforeAll, afterAll, test, expect } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarness } from "./harness.js";
import { tx } from "@sunpride/db/client";
import { install } from "../src/domains/messaging/index.js";
import { sha256Hex } from "../src/core/util.js";
import { provision } from "../scripts/provision-chat-agents.js";

/** @type {Awaited<ReturnType<typeof startHarness>>} */ let h;
/** @type {any} */ let person;
const dir = mkdtempSync(join(tmpdir(), "chat-agent-tokens-"));
const AGENTS = [
  { handle: "mark", display_name: "Mark Aven" },
  { handle: "aries", display_name: "Aries Go" },
];

beforeAll(async () => {
  h = await startHarness({
    installers: [
      (/** @type {any} */ router, /** @type {any} */ p) => install(router, p),
    ],
  });
  h.setHooks({
    loadProfile: async (/** @type {any} */ db, /** @type {any} */ user) => {
      const [p] = await tx(
        db,
        (t) => t`select * from profiles where user_id=${user}`,
      );
      return p
        ? {
            id: p.id,
            userId: user,
            name: p.name,
            role: p.role,
            orgUnitId: p.org_unit_id,
            status: p.status,
          }
        : null;
    },
  });
  const [admin] =
    await h.db`insert into users(email,password_hash) values('owner@example.test','unusable') returning id`;
  await h.db`insert into profiles(user_id,name,email,role,status) values(${admin.id},'Owner','owner@example.test','super_admin','active')`;
  const [u] =
    await h.db`insert into users(email,password_hash) values('staff@example.test','unusable') returning id`;
  await h.db`insert into profiles(user_id,name,email,role,status) values(${u.id},'Staff','staff@example.test','sales','active')`;
  const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
  await h.db`insert into sessions(user_id,app,token_hash,expires_at) values(${u.id},'web',${sha256Hex(token)},now()+interval '1 hour')`;
  person = { id: u.id, token };
}, 60000);
afterAll(async () => {
  await h?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** @param {string} bearer @param {string} path @param {string} [method] @param {any} [body] */
async function asAgent(bearer, path, method = "GET", body = undefined) {
  const res = await h.fetch(`/api/v1/messaging${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

test("dry run writes nothing; a real run creates AI users whose tokens live only in 0600 files", async () => {
  const dry = await provision(h.db, {
    agents: AGENTS,
    tokenDir: dir,
    dryRun: true,
    actor: "owner@example.test",
  });
  expect(dry.map((a) => a.action)).toEqual(["would-create", "would-create"]);
  expect((await h.db`select count(*)::int as n from chat_agents`)[0].n).toBe(0);

  const made = await provision(h.db, {
    agents: AGENTS,
    tokenDir: dir,
    dryRun: false,
    actor: "owner@example.test",
  });
  expect(made.map((a) => a.action)).toEqual(["created", "created"]);
  for (const a of made) {
    expect(JSON.stringify(a)).not.toContain("spa_");
    expect(statSync(a.token_file).mode & 0o777).toBe(0o600);
  }
  const token = readFileSync(join(dir, "mark.token"), "utf8").trim();
  const [row] =
    await h.db`select token_hash,display_name from chat_agents where handle='mark'`;
  expect(row.token_hash).toBe(sha256Hex(token));
  expect(row.display_name).toBe("Mark Aven");

  // the token is a chat-only identity: it can read its unread state, and a person can DM it
  const unread = await asAgent(token, "/unread");
  expect(unread.status).toBe(200);
  expect(unread.body.me.display_name).toBe("Mark Aven");
  const res = await h.fetch("/api/v1/messaging/conversations", {
    method: "POST",
    headers: {
      cookie: `sp_session=${person.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ kind: "dm", user_ids: [made[0].user_id] }),
  });
  expect([200, 201]).toContain(res.status);
  const dm = await res.json();
  const sent = await asAgent(
    token,
    `/conversations/${dm.id}/messages`,
    "POST",
    { client_msg_id: "hello-1", body: "Hi, I'm Mark." },
  );
  expect(sent.status).toBe(201);
  expect(sent.body.author.is_agent).toBe(true);
});

test("re-running is a no-op that keeps the token; --rotate replaces it and the old token stops working", async () => {
  const before = readFileSync(join(dir, "mark.token"), "utf8").trim();
  const again = await provision(h.db, {
    agents: AGENTS,
    tokenDir: dir,
    dryRun: false,
    actor: "owner@example.test",
  });
  expect(again.map((a) => a.action)).toEqual(["exists", "exists"]);
  expect(readFileSync(join(dir, "mark.token"), "utf8").trim()).toBe(before);

  const rotated = await provision(h.db, {
    agents: AGENTS,
    tokenDir: dir,
    dryRun: false,
    actor: "owner@example.test",
    rotate: "mark",
  });
  expect(rotated[0].action).toBe("rotated");
  const after = readFileSync(join(dir, "mark.token"), "utf8").trim();
  expect(after).not.toBe(before);
  expect((await asAgent(before, "/unread")).status).toBe(401);
  expect((await asAgent(after, "/unread")).status).toBe(200);
});

test("only an active super admin can be the acting account", async () => {
  await expect(
    provision(h.db, {
      agents: AGENTS,
      tokenDir: dir,
      dryRun: true,
      actor: "staff@example.test",
    }),
  ).rejects.toThrow("super admin");
  expect(existsSync(join(dir, "dominic.token"))).toBe(false);
});
