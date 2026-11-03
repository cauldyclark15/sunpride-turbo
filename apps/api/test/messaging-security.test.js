import { beforeAll, afterAll, test, expect } from "bun:test";
import { startHarness } from "./harness.js";
import { tx } from "@sunpride/db/client";
import { install } from "../src/domains/messaging/index.js";
import { sha256Hex } from "../src/core/util.js";
import { actorFor } from "../src/core/context.js";
import { searchType } from "../src/domains/messaging/refs/common.js";
import * as M from "../src/domains/messaging/model.js";

// SP-0148 security review regressions (C1, C3, C4, C5, S1, S2).

/** @type {Awaited<ReturnType<typeof startHarness>>} */ let h;
/** @type {any[]} */ const people = [];
/** @type {any} */ let dm;
/** @type {any} */ let other;
/** @param {number} who @param {string} path @param {string} [method] @param {any} [body] @param {RequestInit} [init] */
async function request(who, path, method = "GET", body = undefined, init = {}) {
  const res = await h.fetch(`/api/v1/messaging${path}`, {
    method,
    headers: {
      cookie: `sp_session=${people[who].token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...init,
  });
  return { status: res.status, body: await res.json() };
}
/** Counts tagged-template queries issued through a db handle. @param {any} db */
function counted(db) {
  const box = { n: 0 };
  const proxy = new Proxy(db, {
    apply(target, self, args) {
      if (Array.isArray(args[0]) && "raw" in args[0]) box.n++;
      return Reflect.apply(target, self, args);
    },
    get(target, key) {
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, box };
}
/** @param {Uint8Array|string} bytes @param {string} mime @param {string} name @param {number} [who] */
async function claimAndPut(bytes, mime, name, who = 0) {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const claim = await request(who, "/attachments/claim", "POST", {
    name,
    mime,
    bytes: data.length,
    sha256: sha256Hex(data),
    role: "file",
  });
  expect(claim.status).toBe(200);
  const put = await fetch(claim.body.upload_url, {
    method: "PUT",
    headers: { "content-type": mime },
    body: /** @type {any} */ (data),
  });
  return { id: claim.body.attachment_id, url: claim.body.upload_url, put };
}
/** Minimal stored (uncompressed) zip writer for container fixtures. @param {Record<string,string>} entries */
function zip(entries) {
  /** @type {Buffer[]} */ const local = [];
  /** @type {Buffer[]} */ const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const n = Buffer.from(name),
      d = Buffer.from(text),
      crc = Bun.hash.crc32(d);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(d.length, 18);
    lh.writeUInt32LE(d.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(d.length, 20);
    ch.writeUInt32LE(d.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    local.push(lh, n, d);
    central.push(ch, n);
    offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, end]));
}
beforeAll(async () => {
  h = await startHarness({
    installers: [
      (/** @type {any} */ router, /** @type {any} */ p) =>
        install(router, {
          ...p,
          messagingPreviewIO: {
            dns: async () => [{ address: "93.184.216.34", family: 4 }],
            fetch: async () =>
              new Response(
                '<title>Fixture</title><meta property="og:image" content="https://images.example/pixel.png">',
                { headers: { "content-type": "text/html" } },
              ),
          },
        }),
    ],
  });
  h.setHooks({
    loadProfile: async (db, user) => {
      const [p] = await tx(db, (t) => t`select * from profiles where user_id=${user}`);
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
  for (let i = 0; i < 6; i++) {
    const [u] =
      await h.db`insert into users(email,password_hash) values(${`sec${i}@example.test`},'unusable') returning id`;
    const [p] =
      await h.db`insert into profiles(user_id,name,email,role,status) values(${u.id},${`Person ${i}`},${`sec${i}@example.test`},${i === 0 ? "admin" : "sales"},'active') returning id`;
    const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
    await h.db`insert into sessions(user_id,app,token_hash,expires_at) values(${u.id},'web',${sha256Hex(token)},now()+interval '1 hour')`;
    people.push({ id: u.id, profile: p.id, token });
  }
  dm = (await request(0, "/conversations", "POST", { kind: "dm", user_ids: [people[1].id] })).body;
  other = (await request(2, "/conversations", "POST", { kind: "dm", user_ids: [people[3].id] })).body;
}, 60000);
afterAll(async () => {
  await h?.close();
});

test("C1: a paused upload stream holds no chat lock; binding never races the upload", async () => {
  const agent = await request(0, "/agents", "POST", { handle: "slowpoke", display_name: "Slow" });
  expect(agent.status).toBe(200);
  const bytes = new TextEncoder().encode("Slow upload body. ".repeat(100));
  const claim = await request(0, "/attachments/claim", "POST", {
    name: "slow.txt",
    mime: "text/plain",
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    role: "file",
  });
  /** @type {() => void} */ let release = () => {};
  const held = new Promise((r) => (release = () => r(undefined)));
  const body = new ReadableStream({
    async start(ctrl) {
      ctrl.enqueue(bytes.slice(0, 100));
      await held;
      ctrl.enqueue(bytes.slice(100));
      ctrl.close();
    },
  });
  const putting = fetch(claim.body.upload_url, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body,
    // @ts-ignore streaming request body
    duplex: "half",
  });
  await Bun.sleep(300);
  /** @param {Promise<any>} p */
  const soon = (p) =>
    Promise.race([p, Bun.sleep(3000).then(() => ({ status: "blocked" }))]);
  const send = await soon(
    request(2, `/conversations/${other.id}/messages`, "POST", { client_msg_id: "c1-send", body: "Still moving" }),
  );
  expect(send.status).toBe(201);
  const disable = await soon(request(0, `/agents/${agent.body.agent.id}`, "DELETE"));
  expect(disable.status).toBe(200);
  // The body is still incomplete: the attachment cannot be bound yet.
  const early = await request(0, `/conversations/${dm.id}/messages`, "POST", {
    client_msg_id: "c1-early",
    body: "",
    attachment_ids: [claim.body.attachment_id],
  });
  expect(early.status).toBe(422);
  release();
  expect((await putting).status).toBe(200);
  const sent = await request(0, `/conversations/${dm.id}/messages`, "POST", {
    client_msg_id: "c1-bound",
    body: "",
    attachment_ids: [claim.body.attachment_id],
  });
  expect(sent.status).toBe(201);
  // Committed content cannot be replaced afterwards.
  const again = await fetch(claim.body.upload_url, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: bytes,
  });
  expect(again.status).toBe(401);
  const download = await h.fetch(`/api/v1/messaging/attachments/${claim.body.attachment_id}`, {
    headers: { cookie: `sp_session=${people[1].token}` },
  });
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
});

test("C1: bytes stored by the uploader but not yet finished under the lock cannot be bound", async () => {
  // Simulate the window between the core uploader marking the blob stored and the
  // messaging finish step (content checks, spending the link).
  const bytes = new TextEncoder().encode("window");
  const claim = await request(0, "/attachments/claim", "POST", {
    name: "window.txt",
    mime: "text/plain",
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    role: "file",
  });
  await h.db`update files set status='stored',path='xx/window',stored_at=now() where id=(select blob_id from chat_attachments where id=${claim.body.attachment_id})`;
  const bind = await request(0, `/conversations/${dm.id}/messages`, "POST", {
    client_msg_id: "c1-window",
    body: "",
    attachment_ids: [claim.body.attachment_id],
  });
  expect(bind.status).toBe(422);
  const [row] = await h.db`select message_id from chat_attachments where id=${claim.body.attachment_id}`;
  expect(row.message_id).toBeNull();
});

test("C5: stored file content must match its declared type", async () => {
  const html = "<!doctype html><script>alert(1)</script>";
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const pptx = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const types = { "[Content_Types].xml": "<Types/>" };
  const bad = [
    ["fake.png", "image/png", html],
    ["fake.jpg", "image/jpeg", png],
    ["fake.gif", "image/gif", "GIF00a-not-a-gif"],
    ["fake.webp", "image/webp", "RIFF\x10\x00\x00\x00WAVEfmt "],
    ["fake.pdf", "application/pdf", html],
    ["fake.docx", docx, zip({ ...types, "xl/workbook.xml": "<w/>" })],
    ["fake.xlsx", xlsx, html],
    ["fake.pptx", pptx, zip({ "ppt/presentation.xml": "<p/>" })],
    ["fake.zip", "application/zip", html],
    ["bad.txt", "text/plain", new Uint8Array([0x41, 0xff, 0xfe, 0x41])],
    ["nul.csv", "text/csv", "a,b\u0000,c"],
  ];
  for (const [name, mime, bytes] of bad) {
    const { id, put } = await claimAndPut(/** @type {any} */ (bytes), String(mime), String(name));
    expect([name, put.status]).toEqual([name, 422]);
    const [f] = await h.db`select f.status from chat_attachments a join files f on f.id=a.blob_id where a.id=${id}`;
    expect(f.status).not.toBe("stored");
    const bind = await request(0, `/conversations/${dm.id}/messages`, "POST", {
      client_msg_id: `c5-${name}`,
      body: "",
      attachment_ids: [id],
    });
    expect([name, bind.status]).toEqual([name, 422]);
  }
  const good = [
    ["ok.png", "image/png", png],
    ["ok.jpg", "image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70])],
    ["ok.gif", "image/gif", "GIF89a\x01\x00\x01\x00"],
    ["ok.webp", "image/webp", "RIFF\x10\x00\x00\x00WEBPVP8 "],
    ["ok.pdf", "application/pdf", "%PDF-1.4\n%%EOF\n"],
    ["ok.docx", docx, zip({ ...types, "word/document.xml": "<d/>" })],
    ["ok.xlsx", xlsx, zip({ ...types, "xl/workbook.xml": "<w/>" })],
    ["ok.pptx", pptx, zip({ ...types, "ppt/presentation.xml": "<p/>" })],
    ["ok.zip", "application/zip", zip({ "notes.txt": "hello" })],
    ["ok.txt", "text/plain", "Héllo, Sunpride ✓"],
    ["ok.csv", "text/csv", "code,name\nA1,Sari-sari\n"],
  ];
  const ids = [];
  for (const [name, mime, bytes] of good) {
    const { id, put } = await claimAndPut(/** @type {any} */ (bytes), String(mime), String(name));
    expect([name, put.status]).toEqual([name, 200]);
    ids.push(id);
  }
  const sent = await request(0, `/conversations/${dm.id}/messages`, "POST", {
    client_msg_id: "c5-good",
    body: "",
    attachment_ids: ids.slice(0, 10),
  });
  expect(sent.status).toBe(201);
});

test("C3: ref search skips types the actor cannot read and bounds candidate work", async () => {
  const [unit] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','SEC-FAR','Far unit','branch','active',now()) returning id`;
  const [mine] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','SEC-MINE','My unit','branch','active',now()) returning id`;
  /** @param {number} from @param {number} n @param {string} owner @param {string} label */
  const seed = (from, n, owner, label) =>
    h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by)
      select 'sunpride','SEC-'||${label}||'-'||g,${label}||' store '||g,'active',${owner},${people[0].id} from generate_series(${from},${from + n - 1}) g`;
  await seed(1, 5, mine.id, "Reachable");
  // A messaging-only agent has no outlet.read: no query at all.
  const agent = { userId: people[5].id, role: "viewer", orgUnitId: null, capabilities: new Set(["messaging.use"]) };
  let probe = counted(h.db);
  expect(await searchType(probe.db, agent, "", 1, "outlet")).toEqual([]);
  expect(probe.box.n).toBe(0);
  const scoped = /** @type {any} */ (await actorFor(h.db, people[1].id));
  scoped.orgUnitId = mine.id;
  // Accessible matches are still found.
  const found = await searchType(h.db, scoped, "Reachable", 20, "outlet");
  expect(found.map((r) => r.title).sort()).toEqual(
    [1, 2, 3, 4, 5].map((i) => `Reachable store ${i}`),
  );
  await seed(1, 300, unit.id, "Hidden");
  probe = counted(h.db);
  expect(await searchType(probe.db, scoped, "Hidden", 1, "outlet")).toEqual([]);
  const small = probe.box.n;
  await seed(301, 300, unit.id, "Hidden");
  probe = counted(h.db);
  expect(await searchType(probe.db, scoped, "Hidden", 1, "outlet")).toEqual([]);
  // Work is bounded independently of how many inaccessible rows match.
  expect(probe.box.n).toBe(small);
}, 30000);

test("C4: previews, member hydration, channel mentions and fan-out stay bounded", async () => {
  const channel = (await request(0, "/conversations", "POST", { kind: "channel", title: "everyone" })).body;
  await h.db`insert into chat_members(conversation_id,user_id) values(${channel.id},${people[1].id})`;
  const bulk = await h.db`with u as (insert into users(email,password_hash) select 'bulk'||g||'@example.test','unusable' from generate_series(1,600) g returning id)
    insert into profiles(user_id,name,email,role,status) select id,'Bulk '||id,id||'@bulk.test','sales','active' from u returning user_id`;
  await h.db`insert into chat_members(conversation_id,user_id) select ${channel.id},user_id from profiles where email like '%@bulk.test'`;
  expect(bulk.length).toBe(600);
  const actor = /** @type {any} */ (await actorFor(h.db, people[0].id));
  const big = await M.member(h.db, actor, channel.id);
  const tiny = (await request(0, "/conversations", "POST", { kind: "channel", title: "tiny" })).body;
  const smallConv = await M.member(h.db, actor, tiny.id);
  let probe = counted(h.db);
  const rendered = await M.renderConversation(probe.db, actor, big);
  const bigCount = probe.box.n;
  probe = counted(h.db);
  await M.renderConversation(probe.db, actor, smallConv);
  expect(bigCount).toBe(probe.box.n);
  expect(rendered.members_preview.length).toBe(5);
  expect(rendered.member_count).toBe(602);
  probe = counted(h.db);
  const detail = /** @type {any} */ (await M.renderConversation(probe.db, actor, big, true));
  expect(detail.members.length).toBe(602);
  expect(probe.box.n).toBeLessThanOrEqual(bigCount + 1);

  // <!channel> in an oversized channel is a notify-all flag, not 602 mention rows.
  const shout = await request(0, `/conversations/${channel.id}/messages`, "POST", {
    client_msg_id: "c4-channel",
    body: "<!channel> stock count tonight",
  });
  expect(shout.status).toBe(201);
  const [rows] = await h.db`select count(*)::int as n from chat_mentions where message_id=${shout.body.id}`;
  expect(rows.n).toBe(0);
  const page = await request(1, `/conversations/${channel.id}/messages`);
  expect(page.body.items.find((/** @type {any} */ m) => m.id === shout.body.id).mentions_me).toBe(true);
  const unread = await request(1, "/unread");
  expect(unread.body.conversations.find((/** @type {any} */ c) => c.id === channel.id).mention_count).toBe(1);
  // A small conversation still materializes the mention.
  const small = await request(0, `/conversations/${dm.id}/messages`, "POST", {
    client_msg_id: "c4-small",
    body: "<!channel> hello",
  });
  const [smallRows] = await h.db`select count(*)::int as n from chat_mentions where message_id=${small.body.id}`;
  expect(smallRows.n).toBe(2);

  // Fan-out after a change: constant queries and publishes, not one per member.
  let publishes = 0;
  probe = counted(h.db);
  await M.changed({ db: probe.db, publish: async () => void publishes++ }, channel.id);
  expect(probe.box.n + publishes).toBeLessThanOrEqual(3);

  // Search hydrates each conversation once, not once per hit.
  for (let i = 0; i < 6; i++)
    await request(0, `/conversations/${channel.id}/messages`, "POST", { client_msg_id: `c4-needle-${i}`, body: `needle ${i}` });
  const hits = await h.db`select * from chat_messages where conversation_id=${channel.id} and body like 'needle%' order by seq`;
  probe = counted(h.db);
  await M.renderMessage(probe.db, actor, hits[0]);
  const perMessage = probe.box.n;
  probe = counted(h.db);
  await M.renderConversation(probe.db, actor, await M.member(probe.db, actor, channel.id));
  const perConversation = probe.box.n;
  const { searchItems } = /** @type {any} */ (await import("../src/domains/messaging/actions.js"));
  probe = counted(h.db);
  const items = await searchItems(probe.db, actor, hits);
  expect(items.length).toBe(6);
  expect(items[0].conversation).toEqual({ id: channel.id, title: "everyone", kind: "channel" });
  expect(probe.box.n).toBeLessThanOrEqual(6 * perMessage + perConversation);
}, 30000);

test("C4: edits are rate limited like sends", async () => {
  const m = await request(4, "/conversations", "POST", { kind: "dm", user_ids: [people[5].id] });
  const msg = await request(4, `/conversations/${m.body.id}/messages`, "POST", { client_msg_id: "edit-me", body: "v0" });
  const statuses = [];
  for (let i = 1; i <= 31; i++)
    statuses.push((await request(4, `/messages/${msg.body.id}`, "PATCH", { body: `v${i}` })).status);
  expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
  expect(statuses[30]).toBe(429);
  // An unrelated conversation is unaffected.
  expect(
    (await request(2, `/conversations/${other.id}/messages`, "POST", { client_msg_id: "after-edits", body: "fine" })).status,
  ).toBe(201);
}, 30000);

test("S1: remote og:image URLs are never handed to clients", async () => {
  const sent = await request(2, `/conversations/${other.id}/messages`, "POST", {
    client_msg_id: "s1",
    body: "see https://news.example/story",
  });
  expect(sent.status).toBe(201);
  const { runDueJobs } = await import("../src/core/jobs.js");
  for (let i = 0; i < 20; i++) {
    await runDueJobs(h.db);
    const [p] = await h.db`select status from chat_link_previews where url='https://news.example/story'`;
    if (p.status !== "pending") break;
    await Bun.sleep(50);
  }
  // Even a row stored by older code is not served.
  await h.db`update chat_link_previews set image_url='https://images.example/old.png' where url='https://news.example/story'`;
  const page = await request(3, `/conversations/${other.id}/messages`);
  const link = page.body.items.find((/** @type {any} */ m) => m.id === sent.body.id).links[0];
  expect(link.status).toBe("ready");
  expect(link.title).toBe("Fixture");
  expect(link.image_url).toBeNull();
});

test("S2: concurrent event polls are capped per identity and released on abort", async () => {
  // Catch up first, so the polls below really wait.
  let cursor = "";
  for (;;) {
    const r = await request(3, `/events?wait=0${cursor ? `&after=${cursor}` : ""}`);
    cursor = r.body.cursor;
    if (!r.body.events.length) break;
  }
  const controllers = [0, 1, 2].map(() => new AbortController());
  const open = controllers.map((c) =>
    h
      .fetch(`/api/v1/messaging/events?wait=5&after=${cursor}`, {
        headers: { cookie: `sp_session=${people[3].token}` },
        signal: c.signal,
      })
      .catch(() => null),
  );
  await Bun.sleep(300);
  const started = Date.now();
  const excess = await request(3, `/events?wait=5&after=${cursor}`);
  expect(excess.status).toBe(429);
  expect(Date.now() - started).toBeLessThan(2000);
  // Another identity is not affected.
  expect((await request(1, "/events?wait=0")).status).toBe(200);
  controllers[0].abort();
  await open[0];
  await Bun.sleep(600);
  const freed = await request(3, `/events?wait=1&after=${cursor}`);
  expect(freed.status).toBe(200);
  for (const c of controllers) c.abort();
  await Promise.all(open);
  // Let the server notice the aborts before the harness closes its database.
  await Bun.sleep(600);
}, 20000);
