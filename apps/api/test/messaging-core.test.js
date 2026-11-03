import { beforeAll, afterAll, test, expect } from "bun:test";
import { startHarness } from "./harness.js";
import { install } from "../src/domains/messaging/index.js";
import { sha256Hex } from "../src/core/util.js";
import { canSubscribe } from "../src/core/hooks.js";
import { actorFor } from "../src/core/context.js";
import { runDueJobs } from "../src/core/jobs.js";
import jpeg from "jpeg-js";

/** @type {Awaited<ReturnType<typeof startHarness>>} */ let h;
/** @type {any[]} */ const people = [];
/** @type {any} */ let dm;
/** @type {any} */ let sent;
/** @param {number} who @param {string} path @param {string} [method] @param {any} [body] */
async function request(who, path, method = "GET", body = undefined) {
  const res = await h.fetch(`/api/v1/messaging${path}`, {
    method,
    headers: {
      cookie: `sp_session=${people[who].token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
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
              new Response("<title>Fixture preview</title>", {
                headers: { "content-type": "text/html" },
              }),
          },
        }),
    ],
  });
  h.setHooks({
    loadProfile: async (db, user) => {
      const [p] = await db`select * from profiles where user_id=${user}`;
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
  for (let i = 0; i < 4; i++) {
    const [u] =
      await h.db`insert into users(email,password_hash) values(${`chat${i}@example.test`},'unusable') returning id`;
    const [p] =
      await h.db`insert into profiles(user_id,name,email,role,status) values(${u.id},${`Person ${i}`},${`chat${i}@example.test`},${i === 0 ? "admin" : "sales"},'active') returning id`;
    const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
    await h.db`insert into sessions(user_id,app,token_hash,expires_at) values(${u.id},'web',${sha256Hex(token)},now()+interval '1 hour')`;
    people.push({ id: u.id, profile: p.id, token });
  }
}, 60000);
afterAll(async () => {
  await h?.close();
});
test("DM is idempotent and conversation wire shape has ISO times", async () => {
  const r = await request(0, "/conversations", "POST", {
    kind: "dm",
    user_ids: [people[1].id],
  });
  expect(r.status).toBe(200);
  dm = r.body;
  expect(dm.member_count).toBe(2);
  expect(dm.updated_at).toMatch(/Z$/);
  const again = await request(1, "/conversations", "POST", {
    kind: "dm",
    user_ids: [people[0].id],
  });
  expect(again.body.id).toBe(dm.id);
  const upper = await request(1, "/conversations", "POST", {
    kind: "dm",
    user_ids: [people[0].id.toUpperCase()],
  });
  // The platform UUID validator intentionally requires canonical lowercase IDs.
  expect(upper.status).toBe(422);
  expect(upper.body.error.code).toBe("invalid");
});
test("send, concurrent replay, gap-free sequence, unread and monotonic read", async () => {
  const body = { client_msg_id: "first", body: "Hello Sunpride" };
  const results = await Promise.all([
    request(0, `/conversations/${dm.id}/messages`, "POST", body),
    request(0, `/conversations/${dm.id}/messages`, "POST", body),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
  expect(results[0].body.id).toBe(results[1].body.id);
  sent = results[0].body;
  const [count] =
    await h.db`select count(*)::integer as n from chat_messages where conversation_id=${dm.id}`;
  expect(count.n).toBe(1);
  expect(sent.seq).toBe(1);
  expect((await request(1, "/unread")).body.total).toBe(1);
  expect(
    (await request(1, `/conversations/${dm.id}/read`, "POST", { seq: 1 }))
      .status,
  ).toBe(200);
  await request(1, `/conversations/${dm.id}/read`, "POST", { seq: 0 });
  expect((await request(1, "/unread")).body.total).toBe(0);
});
test("non-member cannot read conversation or messages and cannot write/read state", async () => {
  for (const path of [
    `/conversations/${dm.id}`,
    `/conversations/${dm.id}/messages`,
    `/conversations/${dm.id}/messages?thread=${sent.id}`,
  ]) {
    const r = await request(2, path);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not_found");
  }
  expect(
    (await request(2, `/conversations/${dm.id}/read`, "POST", { seq: 1 }))
      .status,
  ).toBe(404);
  expect(
    (
      await request(2, `/conversations/${dm.id}/messages`, "POST", {
        client_msg_id: "nope",
        body: "No",
      })
    ).status,
  ).toBe(404);
  expect((await request(2, "/conversations")).body.items).toEqual([]);
  expect((await request(2, "/unread")).body.total).toBe(0);
});
test("canonical tokens validate existence, mentions, and reader-specific restricted references", async () => {
  const [unit] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','CHAT','Chat unit','branch','active',now()) returning id`;
  const [outlet] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values('sunpride','CHAT-STORE','Private store','active',${unit.id},${people[0].id}) returning id`;
  const ref = { type: "outlet", id: outlet.id };
  const r = await request(1, "/refs/resolve", "POST", { refs: [ref] });
  expect(r.status).toBe(200);
  expect(r.body[0]).toEqual({
    ...ref,
    title: "Restricted item",
    subtitle: null,
    thumb_url: null,
    href: null,
    access: "restricted",
  });
  expect(
    (await request(1, "/refs/search?types=outlet&q=Private")).body,
  ).toEqual([]);
  const body = `Hello <@user:${people[1].id}> <#outlet:${outlet.id}> <!channel>`;
  const m = await request(0, `/conversations/${dm.id}/messages`, "POST", {
    body,
    client_msg_id: "mentions",
  });
  expect(m.status).toBe(201);
  expect(m.body.body).toBe(body);
  const messages = await request(1, `/conversations/${dm.id}/messages`);
  const mine = messages.body.items.find(
    (/** @type {any} */ x) => x.id === m.body.id,
  );
  expect(mine.mentions_me).toBe(true);
  expect(mine.refs[0].access).toBe("restricted");
  expect((await request(1, "/unread")).body.mentions).toBe(1);
  for (const token of [
    "<#unknown:abc>",
    "<@user:nope>",
    "<#outlet:",
    "<@user:00000000-0000-4000-8000-000000000000>",
  ]) {
    const bad = await request(0, `/conversations/${dm.id}/messages`, "POST", {
      body: token,
      client_msg_id: `bad-${token}`,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("invalid");
  }
  for (const type of [
    "user",
    "outlet",
    "product",
    "customer",
    "issue",
    "order",
    "visit",
    "territory",
    "route",
    "van_trip",
  ]) {
    const missing = await request(1, "/refs/resolve", "POST", {
      refs: [{ type, id: crypto.randomUUID() }],
    });
    expect(missing.status).toBe(200);
    expect(missing.body[0].access).toBe("missing");
    expect(
      (await request(1, `/refs/search?types=${type}&q=unfindable`)).status,
    ).toBe(200);
  }
  expect((await request(1, "/users/search?q=Person")).body.length).toBe(4);
});
test("attachments reuse core blobs, check digests, bind once, and deny every non-member download", async () => {
  const bytes = new TextEncoder().encode("Chat attachment");
  const claim = await request(0, "/attachments/claim", "POST", {
    name: "notes.txt",
    mime: "text/plain",
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    role: "file",
  });
  expect(claim.status).toBe(200);
  const a = claim.body;
  const upload = await fetch(a.upload_url, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: bytes,
  });
  expect(upload.status).toBe(200);
  const download = await h.fetch(
    `/api/v1/messaging/attachments/${a.attachment_id}`,
    { headers: { cookie: `sp_session=${people[0].token}` } },
  );
  expect(download.status).toBe(200);
  expect(await download.text()).toBe("Chat attachment");
  expect((await request(1, `/attachments/${a.attachment_id}`)).status).toBe(
    404,
  );
  const pixels = { data: Buffer.alloc(4 * 4 * 4, 255), width: 4, height: 4 };
  const thumb = jpeg.encode(pixels).data;
  const thumbClaim = await request(0, "/attachments/claim", "POST", {
    name: "thumb.jpg",
    mime: "image/jpeg",
    bytes: thumb.length,
    sha256: sha256Hex(thumb),
    role: "thumb",
    of_attachment_id: a.attachment_id,
  });
  expect(thumbClaim.status).toBe(200);
  expect(
    (
      await fetch(thumbClaim.body.upload_url, {
        method: "PUT",
        headers: { "content-type": "image/jpeg" },
        body: new Uint8Array(thumb),
      })
    ).status,
  ).toBe(200);
  const sentFile = await request(
    0,
    `/conversations/${dm.id}/messages`,
    "POST",
    {
      client_msg_id: "attachment",
      body: "",
      attachment_ids: [a.attachment_id],
    },
  );
  expect(sentFile.status).toBe(201);
  expect(sentFile.body.attachments[0].kind).toBe("file");
  expect((await request(2, `/attachments/${a.attachment_id}`)).status).toBe(
    404,
  );
  expect(
    (await request(2, `/attachments/${a.attachment_id}/thumb`)).status,
  ).toBe(404);
  const thumbnail = await h.fetch(
    `/api/v1/messaging/attachments/${a.attachment_id}/thumb`,
    { headers: { cookie: `sp_session=${people[1].token}` } },
  );
  expect(thumbnail.status).toBe(200);
  expect(new Uint8Array(await thumbnail.arrayBuffer())).toEqual(
    new Uint8Array(thumb),
  );
  expect(
    (await request(2, `/attachments/${thumbClaim.body.attachment_id}`)).status,
  ).toBe(404);
  const memberDownload = await h.fetch(
    `/api/v1/messaging/attachments/${a.attachment_id}`,
    { headers: { cookie: `sp_session=${people[1].token}` } },
  );
  expect(memberDownload.status).toBe(200);
  expect(await memberDownload.text()).toBe("Chat attachment");
  expect(
    (
      await fetch(a.upload_url, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: bytes,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await request(0, `/conversations/${dm.id}/messages`, "POST", {
        client_msg_id: "double-file",
        body: "reuse",
        attachment_ids: [a.attachment_id],
      })
    ).status,
  ).toBe(422);
  for (const patch of [
    { mime: "text/html" },
    { bytes: 25 * 1024 * 1024 + 1 },
    {
      role: "thumb",
      mime: "image/jpeg",
      bytes: 1024 * 1024 + 1,
      of_attachment_id: a.attachment_id,
    },
  ])
    expect(
      (
        await request(0, "/attachments/claim", "POST", {
          name: "bad.txt",
          mime: "text/plain",
          bytes: 1,
          sha256: sha256Hex("x"),
          role: "file",
          ...patch,
        })
      ).status,
    ).toBe(422);
  const bad = await request(0, "/attachments/claim", "POST", {
    name: "checksum.txt",
    mime: "text/plain",
    bytes: 1,
    sha256: sha256Hex("x"),
    role: "file",
  });
  expect(
    (
      await fetch(bad.body.upload_url, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "y",
      })
    ).status,
  ).toBe(400);
});
test("25 MB file boundary is supported by the streaming uploader", async () => {
  const bytes = new Uint8Array(25 * 1024 * 1024);
  bytes.fill(65);
  const claim = await request(0, "/attachments/claim", "POST", {
    name: "large.txt",
    mime: "text/plain",
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    role: "file",
  });
  expect(claim.status).toBe(200);
  const uploaded = await fetch(claim.body.upload_url, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: bytes,
  });
  expect(uploaded.status).toBe(200);
}, 15000);
test("threads, edit/delete and idempotent reactions remain membership-gated", async () => {
  const reply = await request(1, `/conversations/${dm.id}/messages`, "POST", {
    client_msg_id: "thread",
    body: "Thread searchable",
    parent_message_id: sent.id,
  });
  expect(reply.status).toBe(201);
  expect(reply.body.parent_message_id).toBe(sent.id);
  const main = await request(0, `/conversations/${dm.id}/messages`);
  expect(
    main.body.items.some((/** @type {any} */ m) => m.id === reply.body.id),
  ).toBe(false);
  expect(
    main.body.items.find((/** @type {any} */ m) => m.id === sent.id)
      .reply_count,
  ).toBe(1);
  const thread = await request(
    0,
    `/conversations/${dm.id}/messages?thread=${sent.id}`,
  );
  expect(thread.body.items.map((/** @type {any} */ m) => m.id)).toEqual([
    reply.body.id,
  ]);
  expect(
    (
      await request(0, `/conversations/${dm.id}/messages`, "POST", {
        client_msg_id: "nested",
        body: "Nested",
        parent_message_id: reply.body.id,
      })
    ).status,
  ).toBe(422);
  for (const [
    method,
    path,
    body,
  ] of /** @type {Array<[string,string,any]>} */ ([
    ["PATCH", `/messages/${reply.body.id}`, { body: "Edit" }],
    ["DELETE", `/messages/${reply.body.id}`, undefined],
    ["POST", `/messages/${reply.body.id}/reactions`, { emoji: "👍" }],
    ["DELETE", `/messages/${reply.body.id}/reactions/👍`, undefined],
  ]))
    expect((await request(2, path, method, body)).status).toBe(404);
  expect(
    (
      await request(0, `/messages/${reply.body.id}`, "PATCH", {
        body: "Not mine",
      })
    ).status,
  ).toBe(403);
  const edit = await request(1, `/messages/${reply.body.id}`, "PATCH", {
    body: `Revised <@user:${people[0].id}>`,
  });
  expect(edit.status).toBe(200);
  expect(edit.body.edited).toBe(true);
  const reaction = await request(
    0,
    `/messages/${reply.body.id}/reactions`,
    "POST",
    { emoji: "👍" },
  );
  expect(reaction.body.reactions).toEqual([
    { emoji: "👍", count: 1, mine: true },
  ]);
  const again = await request(
    0,
    `/messages/${reply.body.id}/reactions`,
    "POST",
    { emoji: "👍" },
  );
  expect(again.body.reactions[0].count).toBe(1);
  const other = await request(
    1,
    `/messages/${reply.body.id}/reactions`,
    "POST",
    { emoji: "👍" },
  );
  expect(other.body.reactions[0]).toEqual({
    emoji: "👍",
    count: 2,
    mine: true,
  });
  expect(
    (await request(0, `/messages/${reply.body.id}/reactions/👍`, "DELETE")).body
      .reactions[0],
  ).toEqual({ emoji: "👍", count: 1, mine: false });
  const deleted = await request(0, `/messages/${reply.body.id}`, "DELETE");
  expect(deleted.status).toBe(200);
  expect(deleted.body.deleted).toBe(true);
  expect(deleted.body.body).toBe("");
  expect(deleted.body.refs).toEqual([]);
  const after = await request(0, `/conversations/${dm.id}/messages`);
  expect(
    after.body.items.find((/** @type {any} */ m) => m.id === sent.id)
      .reply_count,
  ).toBe(0);
});
test("full-text search returns member hits only, including threads but not deleted bodies", async () => {
  expect(
    (await request(0, "/search?q=Sunpride")).body.items[0].conversation.id,
  ).toBe(dm.id);
  expect((await request(2, "/search?q=Sunpride")).body.items).toEqual([]);
  expect((await request(0, "/search?q=Revised")).body.items).toEqual([]);
  expect((await request(0, "/search?q=Sunpride&cursor=bad")).status).toBe(422);
  for (const at of [1, "1", "2026-02-30T00:00:00.000Z"]) {
    const malformed = Buffer.from(JSON.stringify({ at, id: sent.id })).toString(
      "base64url",
    );
    expect(
      (await request(0, `/search?q=Sunpride&cursor=${malformed}`)).status,
    ).toBe(422);
    expect(
      (await request(0, `/conversations?cursor=${malformed}`)).status,
    ).toBe(422);
  }
});
test("channels browse/join, private channels, groups, membership removal and archive", async () => {
  const pub = await request(0, "/conversations", "POST", {
    kind: "channel",
    title: "Public chat",
    topic: "Business",
  });
  const priv = await request(0, "/conversations", "POST", {
    kind: "channel",
    title: "Private chat",
    is_private: true,
  });
  expect(pub.status).toBe(200);
  expect(priv.status).toBe(200);
  const browse = await request(2, "/channels/browse?q=chat");
  expect(browse.body.map((/** @type {any} */ v) => v.id)).toContain(
    pub.body.id,
  );
  expect(browse.body.map((/** @type {any} */ v) => v.id)).not.toContain(
    priv.body.id,
  );
  expect((await request(2, `/conversations/${pub.body.id}`)).status).toBe(404);
  expect(
    (await request(2, `/conversations/${priv.body.id}/join`, "POST", {}))
      .status,
  ).toBe(404);
  expect(
    (await request(2, `/conversations/${pub.body.id}/join`, "POST", {})).status,
  ).toBe(200);
  expect(
    (
      await request(2, `/conversations/${pub.body.id}`, "PATCH", {
        topic: "No",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(2, `/conversations/${pub.body.id}`, "PATCH", {
        muted: true,
      })
    ).body.muted,
  ).toBe(true);
  expect((await request(0, `/conversations/${pub.body.id}`)).body.muted).toBe(
    false,
  );
  expect(
    (
      await request(0, `/conversations/${priv.body.id}/members`, "POST", {
        user_ids: [people[2].id],
      })
    ).body.member_count,
  ).toBe(2);
  expect(
    (
      await request(
        0,
        `/conversations/${priv.body.id}/members/${people[2].id}`,
        "DELETE",
      )
    ).status,
  ).toBe(200);
  expect((await request(2, `/conversations/${priv.body.id}`)).status).toBe(404);
  expect(
    (
      await request(0, `/conversations/${dm.id}/members`, "POST", {
        user_ids: [people[2].id],
      })
    ).status,
  ).toBe(422);
  const group = await request(0, "/conversations", "POST", {
    kind: "group",
    user_ids: [people[1].id, people[2].id],
  });
  expect(group.body.member_count).toBe(3);
  expect(
    (
      await request(1, `/conversations/${group.body.id}`, "PATCH", {
        title: "Renamed",
      })
    ).body.title,
  ).toBe("Renamed");
  expect(
    (await request(0, `/conversations/${pub.body.id}/archive`, "POST", {}))
      .status,
  ).toBe(200);
  expect(
    (
      await request(2, `/conversations/${pub.body.id}/messages`, "POST", {
        client_msg_id: "archived",
        body: "No",
      })
    ).status,
  ).toBe(422);
});
test("durable link jobs extract three URLs, cache previews and keep network injected", async () => {
  const r = await request(0, `/conversations/${dm.id}/messages`, "POST", {
    client_msg_id: "links",
    body: "https://one.example/news https://two.example/news https://three.example/news https://four.example/news",
  });
  expect(r.status).toBe(201);
  expect(r.body.links.length).toBe(3);
  expect(
    r.body.links.every((/** @type {any} */ l) => l.status === "pending"),
  ).toBe(true);
  expect(await runDueJobs(h.db)).toBe(3);
  const list = await request(1, `/conversations/${dm.id}/messages`);
  const m = list.body.items.find((/** @type {any} */ x) => x.id === r.body.id);
  expect(
    m.links.every(
      (/** @type {any} */ l) =>
        l.status === "ready" && l.title === "Fixture preview",
    ),
  ).toBe(true);
});
test("admin may moderate any message without gaining conversation read access", async () => {
  const privateDm = await request(1, "/conversations", "POST", {
    kind: "dm",
    user_ids: [people[2].id],
  });
  const message = await request(
    1,
    `/conversations/${privateDm.body.id}/messages`,
    "POST",
    { client_msg_id: "moderation", body: "Moderate this message" },
  );
  expect(message.status).toBe(201);
  expect((await request(0, `/conversations/${privateDm.body.id}`)).status).toBe(
    404,
  );
  expect(
    (await request(0, `/conversations/${privateDm.body.id}/messages`)).status,
  ).toBe(404);
  expect(
    (
      await request(0, `/messages/${message.body.id}`, "PATCH", {
        body: "No edit authority",
      })
    ).status,
  ).toBe(404);
  const removed = await request(0, `/messages/${message.body.id}`, "DELETE");
  expect(removed.status).toBe(200);
  expect(removed.body.deleted).toBe(true);
  expect(removed.body.body).toBe("");
  expect(removed.body.attachments).toEqual([]);
  expect((await request(0, `/conversations/${privateDm.body.id}`)).status).toBe(
    404,
  );
});
test("AI tokens are hashed, chat-only, membership-gated, and revoked on disable", async () => {
  expect(
    (
      await request(1, "/agents", "POST", {
        handle: "nope",
        display_name: "Nope",
      })
    ).status,
  ).toBe(403);
  const created = await request(0, "/agents", "POST", {
    handle: "phantasm",
    display_name: "Phantasm",
  });
  expect(created.status).toBe(200);
  expect(created.body.agent.is_agent).toBe(true);
  expect(created.body.token).toMatch(/^spa_/);
  const { agent, token } = created.body;
  const [stored] =
    await h.db`select token_hash from chat_agents where user_id=${agent.id}`;
  expect(stored.token_hash).toBe(sha256Hex(token));
  expect(stored.token_hash).not.toBe(token);
  /** @param {string} path @param {string} [method] @param {any} [body] */
  const asAgent = async (path, method = "GET", body = undefined) => {
    const res = await h.fetch(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() };
  };
  expect((await asAgent("/api/v1/messaging/unread")).status).toBe(200);
  expect((await asAgent("/api/me")).status).toBe(401);
  expect(
    (await asAgent(`/api/v1/messaging/conversations/${dm.id}/messages`)).status,
  ).toBe(404);
  expect(
    (
      await asAgent("/api/v1/messaging/agents", "POST", {
        handle: "escalate",
        display_name: "Escalate",
      })
    ).status,
  ).toBe(403);
  const chat = await request(0, "/conversations", "POST", {
    kind: "dm",
    user_ids: [agent.id],
  });
  expect(chat.status).toBe(200);
  const send = await asAgent(
    `/api/v1/messaging/conversations/${chat.body.id}/messages`,
    "POST",
    { client_msg_id: "ai-first", body: "An agent speaks" },
  );
  expect(send.status).toBe(201);
  expect(send.body.author.is_agent).toBe(true);
  const events = await asAgent("/api/v1/messaging/events?wait=0");
  expect(events.status).toBe(200);
  expect(
    events.body.events.some(
      (/** @type {any} */ e) => e.message?.id === send.body.id,
    ),
  ).toBe(true);
  expect(
    events.body.events.every(
      (/** @type {any} */ e) => e.conversation_id === chat.body.id,
    ),
  ).toBe(true);
  const empty = await asAgent(
    `/api/v1/messaging/events?wait=0&after=${events.body.cursor}`,
  );
  expect(empty.body.events).toEqual([]);
  const poll = asAgent(
    `/api/v1/messaging/events?wait=2&after=${empty.body.cursor}`,
  );
  await Bun.sleep(100);
  const reply = await request(
    0,
    `/conversations/${chat.body.id}/messages`,
    "POST",
    { client_msg_id: "to-agent", body: "Hello agent" },
  );
  expect(
    (await poll).body.events.some(
      (/** @type {any} */ e) => e.message?.id === reply.body.id,
    ),
  ).toBe(true);
  expect((await request(0, `/agents/${agent.id}`, "DELETE")).status).toBe(200);
  expect((await asAgent("/api/v1/messaging/unread")).status).toBe(401);
  expect(
    (await request(0, "/agents")).body.some(
      (/** @type {any} */ a) => a.id === agent.id,
    ),
  ).toBe(false);
});
test("30 sends per minute; replay bypasses rate spending and rejected sends leave no sequence gap", async () => {
  const conv = await request(3, "/conversations", "POST", {
    kind: "dm",
    user_ids: [people[0].id],
  });
  expect(conv.status).toBe(200);
  const results = await Promise.all(
    Array.from({ length: 31 }, (_, i) =>
      request(3, `/conversations/${conv.body.id}/messages`, "POST", {
        client_msg_id: `rate-${i}`,
        body: "Rate fixture",
      }),
    ),
  );
  expect(results.filter((r) => r.status === 201).length).toBe(30);
  expect(results.filter((r) => r.status === 429).length).toBe(1);
  const ok = results.find((r) => r.status === 201);
  const [original] =
    await h.db`select client_msg_id from chat_messages where id=${ok?.body.id}`;
  expect(
    (
      await request(3, `/conversations/${conv.body.id}/messages`, "POST", {
        client_msg_id: original.client_msg_id,
        body: "Rate fixture",
      })
    ).status,
  ).toBe(200);
  const [count] =
    await h.db`select count(*)::int as n,min(seq)::int as first,max(seq)::int as last from chat_messages where conversation_id=${conv.body.id}`;
  expect(count).toEqual({ n: 30, first: 1, last: 30 });
});
test("partner identities are excluded even when their persisted role is internal sales", async () => {
  const [unit] = await h.db`select id from org_units where code='CHAT'`;
  const [partner] =
    await h.db`insert into distributors(code,name,org_unit_id,status,source,partner_kind,effective_from) values('CHAT-AGENCY','Chat agency',${unit.id},'accredited','sample','agency',now()-interval '1 day') returning id`;
  await h.db`insert into distributor_users(distributor_id,profile_id,grants,effective_from) values(${partner.id},${people[2].profile},${h.db.array(["field"], "TEXT")},now()-interval '1 day')`;
  expect((await request(2, "/conversations")).status).toBe(403);
  expect((await request(2, "/unread")).status).toBe(403);
  expect(
    (await request(0, "/users/search?q=Person")).body.some(
      (/** @type {any} */ p) => p.id === people[2].id,
    ),
  ).toBe(false);
  await h.db`delete from distributor_users where profile_id=${people[2].profile}`;
});
test("websocket refuses member-only and foreign user subscriptions without disclosing existence", async () => {
  const ws = new WebSocket(
    h.origin.replace("http", "ws") + "/ws",
    /** @type {any} */ ({
      headers: { cookie: `sp_session=${people[2].token}` },
    }),
  );
  /** @type {any[]} */ const inbox = [];
  const finished = new Promise((resolve, reject) => {
    ws.addEventListener("open", () =>
      ws.send(
        JSON.stringify({
          type: "subscribe",
          topics: [
            `messaging.conv:${dm.id}`,
            `messaging.conv:${crypto.randomUUID()}`,
            `messaging.user:${people[0].id}`,
          ],
        }),
      ),
    );
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data));
      inbox.push(m);
      if (m.type === "subscribed") resolve(undefined);
    });
    ws.addEventListener("error", () => reject(Error("Websocket failed")));
  });
  try {
    await finished;
    expect(inbox.filter((m) => m.type === "error").map((m) => m.code)).toEqual([
      "forbidden",
      "forbidden",
      "forbidden",
    ]);
    expect(inbox.find((m) => m.type === "subscribed").topics).toEqual([]);
  } finally {
    ws.close();
  }
});
test("realtime topics are self/member only and recheck membership", async () => {
  const a = await actorFor(h.db, people[0].id),
    b = await actorFor(h.db, people[2].id);
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  if (!a || !b) throw Error("actors missing");
  expect(await canSubscribe(a, `messaging.conv:${dm.id}`)).toBe(true);
  expect(await canSubscribe(b, `messaging.conv:${dm.id}`)).toBe(false);
  expect(await canSubscribe(a, `messaging.user:${people[1].id}`)).toBe(false);
  expect(await canSubscribe(a, `messaging.user:${people[0].id}`)).toBe(true);
  await h.db`update chat_members set left_at=now() where conversation_id=${dm.id} and user_id=${people[0].id}`;
  expect(await canSubscribe(a, `messaging.conv:${dm.id}`)).toBe(false);
  await h.db`update chat_members set left_at=null where conversation_id=${dm.id} and user_id=${people[0].id}`;
});
