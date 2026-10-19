import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { startHarness } from "../../../test/harness.js";
import { randomToken, sha256Hex } from "../../core/util.js";
import { install } from "./index.js";
import { seedIssues } from "../../../../../packages/db/seed/issues.js";
import { CHUNK_BYTES } from "./uploads.js";

/** @type {import('../../../test/harness.js').Harness} */ let h;
/** @type {Record<string,{id:string,userId:string,cookie:string,access:string,email:string}>} */ const users =
  {};
beforeAll(async () => {
  h = await startHarness({ installers: [install], listen: true });
  h.setHooks({
    loadProfile: async (db, userId) => {
      const [p] = await db`select * from profiles where user_id=${userId}`;
      return p
        ? {
            id: p.id,
            userId: p.user_id,
            name: p.name,
            role: p.role,
            status: p.status,
            orgUnitId: p.org_unit_id,
          }
        : null;
    },
  });
  for (const role of [
    "super_admin",
    "admin",
    "operations",
    "manager",
    "approver",
    "sales",
    "analyst",
    "viewer",
  ]) {
    const email = `${role}@issues.example.test`;
    const [u] =
      await h.db`insert into users (email,password_hash) values (${email},'fixture-only') returning id`;
    const [p] =
      await h.db`insert into profiles (user_id,name,email,role,status) values (${u.id},${role},${email},${role},'active') returning id`;
    const token = randomToken("sps_"),
      access = randomToken("spa_");
    const [session] =
      await h.db`insert into sessions (user_id,token_hash,app,expires_at) values (${u.id},${sha256Hex(token)},'web',now()+interval '1 hour') returning id`;
    await h.db`insert into access_tokens (token_hash,session_id,expires_at) values (${sha256Hex(access)},${session.id},now()+interval '1 hour')`;
    users[role] = {
      id: p.id,
      userId: u.id,
      email,
      cookie: `sp_session=${token}`,
      access,
    };
  }
});
afterAll(async () => {
  await h?.close();
});
/** @param {string} action @param {any} body @param {string|null} [role] @param {string} [key] */
async function post(action, body, role = "admin", key) {
  const res = await h.fetch(`/api/v1/issues/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(role ? { cookie: users[role].cookie } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} action @param {string|null} [role] */
async function get(action, role = "admin") {
  const res = await h.fetch(`/api/v1/issues/${action}`, {
    headers: role ? { cookie: users[role].cookie } : {},
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} [role] @param {any} [extra] */
async function create(role = "admin", extra = {}) {
  const r = await post(
    "create",
    { title: `Issue ${crypto.randomUUID()}`, ...extra },
    role,
  );
  expect(r.status).toBe(200);
  return r.body;
}

describe("issue permissions and transactions", () => {
  test("field feedback is reporter-only across board, filters, detail and comments; office is unchanged", async () => {
    const own = await create("sales", { title: "Own field feedback" });
    const foreign = await create("admin", {
      title: "Internal office feedback",
    });
    for (const path of [
      "board",
      "agent/list",
      "board?reporterId=" + users.admin.id,
      "board?search=Internal office feedback",
    ]) {
      const r = await get(path, "sales");
      expect(r.status).toBe(200);
      expect(
        r.body.issues.every(
          (/** @type {any} */ i) => i.reporterId === users.sales.id,
        ),
      ).toBe(true);
      expect(
        r.body.issues.some(
          (/** @type {any} */ i) => i.number === foreign.number,
        ),
      ).toBe(false);
    }
    expect((await get(`detail?number=${own.number}`, "sales")).status).toBe(
      200,
    );
    for (const path of ["detail", "agent/get"])
      expect(
        (await get(`${path}?number=${foreign.number}`, "sales")).status,
      ).toBe(404);
    expect(
      (
        await post(
          "addComment",
          { number: foreign.number, body: "Not mine" },
          "sales",
        )
      ).status,
    ).toBe(404);
    for (const role of [
      "admin",
      "manager",
      "operations",
      "approver",
      "analyst",
      "viewer",
    ])
      expect((await get(`detail?number=${foreign.number}`, role)).status).toBe(
        200,
      );
  });
  test("anonymous cannot read, create, comment, move, or archive", async () => {
    expect((await get("board", null)).status).toBe(401);
    for (const action of ["create", "addComment", "move", "archive"])
      expect(
        (
          await post(
            action,
            { title: "No", number: 1, status: "completed", body: "No" },
            null,
          )
        ).status,
      ).toBe(401);
  });
  for (const role of [
    "super_admin",
    "admin",
    "operations",
    "manager",
    "approver",
    "sales",
    "analyst",
    "viewer",
  ])
    test(`${role} can file and comment without organizational scope`, async () => {
      const i = await create(role, {
        area: "Visits",
        description: "Tester feedback",
      });
      const c = await post(
        "addComment",
        { issueId: i.issueId, body: "A comment" },
        role,
      );
      expect(c.status).toBe(200);
      const d = await get(`detail?number=${i.number}`, role);
      expect(d.body.comments[0].body).toBe("A comment");
      expect(d.body.issue.commentCount).toBe(1);
      expect(d.body.activity.map((/** @type {any} */ a) => a.kind)).toContain(
        "created",
      );
    });
  for (const role of [
    "super_admin",
    "admin",
    "operations",
    "manager",
    "approver",
  ])
    test(`${role} can edit and move issues`, async () => {
      const i = await create();
      expect(
        (
          await post(
            "update",
            {
              issueId: i.issueId,
              title: "Updated",
              assigneeId: users.manager.id,
            },
            role,
          )
        ).status,
      ).toBe(200);
      expect(
        (await post("move", { issueId: i.issueId, status: "for_retest" }, role))
          .status,
      ).toBe(200);
      const d = (await get(`detail?number=${i.number}`)).body;
      expect(d.issue.status).toBe("for_retest");
      expect(d.assigneeName).toBe("manager");
      expect(
        d.activity.find((/** @type {any} */ a) => a.kind === "updated").changes,
      ).toContainEqual({ field: "assignee", from: null, to: "manager" });
    });
  for (const role of ["sales", "analyst", "viewer"])
    test(`${role} cannot edit, assign, or move`, async () => {
      const i = await create(role);
      expect(
        (await post("update", { issueId: i.issueId, title: "No" }, role))
          .status,
      ).toBe(403);
      expect(
        (await post("move", { issueId: i.issueId, status: "completed" }, role))
          .status,
      ).toBe(403);
      expect(
        (
          await post(
            "create",
            { title: "No", assigneeId: users.admin.id },
            role,
          )
        ).status,
      ).toBe(403);
      expect(
        (await post("create", { title: "No", status: "completed" }, role))
          .status,
      ).toBe(403);
    });
  for (const role of [
    "operations",
    "manager",
    "approver",
    "sales",
    "analyst",
    "viewer",
  ])
    test(`${role} cannot archive or restore`, async () => {
      const i = await create();
      expect((await post("archive", { issueId: i.issueId }, role)).status).toBe(
        403,
      );
      expect((await post("restore", { issueId: i.issueId }, role)).status).toBe(
        403,
      );
    });
  for (const role of ["super_admin", "admin"])
    test(`${role} can archive, read frozen discussion and restore`, async () => {
      const i = await create("sales");
      await post(
        "addComment",
        { issueId: i.issueId, body: "Keep me" },
        "sales",
      );
      expect((await post("archive", { issueId: i.issueId }, role)).status).toBe(
        200,
      );
      const d = (await get(`detail?number=${i.number}`)).body;
      expect(d.issue.archived).toBe(true);
      expect(d.comments[0].canEdit).toBe(false);
      expect(d.comments[0].canDelete).toBe(false);
      expect(
        (await post("addComment", { issueId: i.issueId, body: "No" }, "sales"))
          .status,
      ).toBe(404);
      expect((await post("restore", { issueId: i.issueId }, role)).status).toBe(
        200,
      );
      expect((await get(`detail?number=${i.number}`)).body.issue.archived).toBe(
        false,
      );
    });
  test("comment author can edit; administrators moderate but cannot rewrite another author's words", async () => {
    const i = await create("sales");
    const c = await post(
      "addComment",
      { issueId: i.issueId, body: "Original" },
      "sales",
    );
    expect(
      (
        await post(
          "updateComment",
          { commentId: c.body.commentId, body: "Edited" },
          "sales",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          "updateComment",
          { commentId: c.body.commentId, body: "No" },
          "admin",
        )
      ).status,
    ).toBe(403);
    expect(
      (await post("deleteComment", { commentId: c.body.commentId }, "manager"))
        .status,
    ).toBe(403);
    expect(
      (await post("deleteComment", { commentId: c.body.commentId }, "admin"))
        .status,
    ).toBe(200);
    const d = (await get(`detail?number=${i.number}`)).body;
    expect(d.comments).toEqual([]);
    expect(d.issue.commentCount).toBe(0);
    expect(d.issue.lastCommentAt).toBeUndefined();
  });
  test("two concurrent creates reserve distinct consecutive numbers", async () => {
    const [a, b] = await Promise.all([create(), create()]);
    expect(a.number).not.toBe(b.number);
    expect(Math.abs(a.number - b.number)).toBe(1);
  });
  test("concurrent external-reference creates are idempotent", async () => {
    const ref = `REF-${crypto.randomUUID()}`;
    const [a, b] = await Promise.all([
      create("admin", { externalRef: ref }),
      create("admin", { externalRef: ref }),
    ]);
    expect(a.number).toBe(b.number);
    expect([a.created, b.created].sort()).toEqual([false, true]);
  });
  test("replay key preserves create/comment results and rejects changed content", async () => {
    const key = crypto.randomUUID(),
      input = { title: "Replay" };
    const a = await post("create", input, "sales", key);
    expect(await post("create", input, "sales", key)).toEqual(a);
    expect(
      (await post("create", { title: "Different" }, "sales", key)).status,
    ).toBe(409);
    const ck = crypto.randomUUID(),
      c = { issueId: a.body.issueId, body: "Once" };
    expect(await post("addComment", c, "sales", ck)).toEqual(
      await post("addComment", c, "sales", ck),
    );
    expect(
      (await get(`detail?number=${a.body.number}`)).body.comments.length,
    ).toBe(1);
  });
  test("invalid inputs and a failed atomic agent update leave no partial edit", async () => {
    for (const body of [
      { title: "" },
      { title: "x", area: "not an area" },
      { title: "x", priority: "extreme" },
    ])
      expect((await post("create", body)).status).toBe(400);
    const i = await create("admin", { title: "Before" });
    expect(
      (
        await post("agent/update", {
          number: i.number,
          title: "Should roll back",
          status: "not a status",
        })
      ).status,
    ).toBe(400);
    expect((await get(`detail?number=${i.number}`)).body.issue.title).toBe(
      "Before",
    );
    expect((await get("agent/get?number=SP-0")).status).toBe(400);
    expect((await get("agent/get?number=SP-999999999")).status).toBe(404);
  });
  test("board ranks reorder and reject stale or self anchors", async () => {
    const a = await create(),
      b = await create(),
      c = await create();
    for (const i of [a, b, c])
      await post("move", { issueId: i.issueId, status: "ongoing_test" });
    expect(
      (
        await post("move", {
          issueId: c.issueId,
          status: "ongoing_test",
          beforeId: a.issueId,
          afterId: b.issueId,
        })
      ).status,
    ).toBe(200);
    let rows = (await get("board?status=ongoing_test")).body.issues
      .filter((/** @type {any} */ r) =>
        [a.issueId, b.issueId, c.issueId].includes(r._id),
      )
      .sort((/** @type {any} */ a, /** @type {any} */ b) => a.order - b.order);
    expect(rows.map((/** @type {any} */ r) => r._id)).toEqual([
      a.issueId,
      c.issueId,
      b.issueId,
    ]);
    expect(
      (
        await post("move", {
          issueId: c.issueId,
          status: "ongoing_test",
          beforeId: c.issueId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("move", {
          issueId: c.issueId,
          status: "draft",
          afterId: a.issueId,
        })
      ).status,
    ).toBe(409);
    // Force a dense gap and exercise the respace branch.
    await h.db`update issues set sort_order=100 where id=${a.issueId}`;
    await h.db`update issues set sort_order=101 where id=${b.issueId}`;
    expect(
      (
        await post("move", {
          issueId: c.issueId,
          status: "ongoing_test",
          beforeId: a.issueId,
          afterId: b.issueId,
        })
      ).status,
    ).toBe(200);
    rows = (await get("board?status=ongoing_test")).body.issues.sort(
      (/** @type {any} */ a, /** @type {any} */ b) => a.order - b.order,
    );
    expect(rows.findIndex((/** @type {any} */ r) => r._id === c.issueId)).toBe(
      rows.findIndex((/** @type {any} */ r) => r._id === a.issueId) + 1,
    );
  });
  test("withdrawn staff permission cannot replay a previously successful command", async () => {
    const key = crypto.randomUUID(),
      payload = { title: "Previously allowed" };
    const first = await post("agent/create", payload, "operations", key);
    expect(first.status).toBe(200);
    await h.db`update profiles set role='sales' where id=${users.operations.id}`;
    try {
      expect(
        (await post("agent/create", payload, "operations", key)).status,
      ).toBe(403);
    } finally {
      await h.db`update profiles set role='operations' where id=${users.operations.id}`;
    }
    await h.db`update profiles set status='disabled' where id=${users.viewer.id}`;
    try {
      expect((await get("board", "viewer")).status).toBe(401);
      expect((await post("create", { title: "No" }, "viewer")).status).toBe(
        401,
      );
    } finally {
      await h.db`update profiles set status='active' where id=${users.viewer.id}`;
    }
  });
  test("concurrent comments reconcile counts and attention queues use complete history", async () => {
    const i = await create("sales", {
      externalRef: "concurrent-comments",
      priority: "critical",
    });
    const results = await Promise.all([
      post("addComment", { issueId: i.issueId, body: "one" }, "sales"),
      post("addComment", { issueId: i.issueId, body: "two" }, "viewer"),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const d = (await get(`detail?number=${i.number}`)).body;
    expect(d.issue.commentCount).toBe(2);
    expect(d.comments.length).toBe(2);
    const b = (await get("board?attention=urgent&search=concurrent-comments"))
      .body;
    expect(b.issues.map((/** @type {any} */ r) => r._id)).toEqual([i.issueId]);
    expect(b.summary.completedPriorWeek).toBeNull();
    expect(
      b.trend.filter((/** @type {any} */ r) => r.known === false).length,
    ).toBeGreaterThan(0);
  });
  test("board filters and counts match; assignees exclude testers and disabled staff", async () => {
    await create("admin", {
      title: "Find apostrophe's % issue",
      area: "Issues",
      priority: "critical",
      milestone: "Test filter",
    });
    const b = (
      await get("board?search=%25&milestone=Test%20filter&status=draft")
    ).body;
    expect(b.issues.length).toBe(1);
    expect(b.total).toBe(1);
    expect(b.counts.draft).toBe(1);
    expect(b.summary.urgent).toBe(1);
    const names = (await get("assignees")).body.map(
      (/** @type {any} */ p) => p.name,
    );
    expect(names).toContain("manager");
    expect(names).not.toContain("sales");
    const i = await create();
    expect(
      (await post("update", { issueId: i.issueId, assigneeId: users.sales.id }))
        .status,
    ).toBe(400);
  });
});

describe("issue files", () => {
  /** @param {Uint8Array} bytes @param {string} [role] @param {string|null} [ownerId] @param {string} [mime] */
  async function claim(
    bytes,
    role = "sales",
    ownerId = null,
    mime = "image/png",
  ) {
    const c = await post(
      "uploads/claim",
      { mime, size: bytes.length, sha256: sha256Hex(bytes), ownerId },
      role,
    );
    expect(c.status).toBe(200);
    return c.body;
  }
  /** @param {any} c @param {Uint8Array} bytes @param {string} [mime] */
  async function upload(c, bytes, mime = "image/png") {
    return h.fetch(c.uploadUrl, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${c.uploadToken}`,
        "content-type": mime,
      },
      body: /** @type {BodyInit} */ (bytes),
    });
  }
  test("claim → core upload → attach → authenticated bytes; owner and consumption checked", async () => {
    const i = await create("sales"),
      bytes = new TextEncoder().encode("png fixture"),
      c = await claim(bytes, "sales", i.issueId);
    expect((await upload(c, bytes)).status).toBe(200);
    expect(
      (
        await post(
          "addComment",
          {
            issueId: i.issueId,
            body: "Evidence",
            uploads: [{ storageId: c.uploadId, fileName: "evidence.png" }],
          },
          "viewer",
        )
      ).status,
    ).toBe(403);
    const r = await post(
      "addComment",
      {
        issueId: i.issueId,
        body: "Evidence",
        uploads: [{ storageId: c.uploadId, fileName: "evidence.png" }],
      },
      "sales",
    );
    expect(r.status).toBe(200);
    const d = (await get(`detail?number=${i.number}`)).body,
      f = d.comments[0].attachments[0];
    expect(f.fileSize).toBe(bytes.length);
    expect(d.issue.attachmentCount).toBe(1);
    expect((await h.fetch(f.url)).status).toBe(401);
    const content = await h.fetch(f.url, {
      headers: { cookie: users.sales.cookie },
    });
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("png fixture");
    const partial = await h.fetch(f.url, {
      headers: { cookie: users.sales.cookie, range: "bytes=0-2" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(
      `bytes 0-2/${bytes.length}`,
    );
    expect(await partial.text()).toBe("png");
    expect(
      (
        await h.fetch(f.url, {
          headers: { cookie: users.sales.cookie, range: "bytes=999999-" },
        })
      ).status,
    ).toBe(416);
    expect(
      (
        await post(
          "addComment",
          {
            issueId: i.issueId,
            body: "Duplicate",
            uploads: [{ storageId: c.uploadId, fileName: "evidence.png" }],
          },
          "sales",
        )
      ).status,
    ).toBe(400);
    expect(
      (await post("removeAttachment", { attachmentId: f._id }, "manager"))
        .status,
    ).toBe(403);
    expect(
      (await post("removeAttachment", { attachmentId: f._id }, "admin")).status,
    ).toBe(200);
    expect(
      (await h.fetch(f.url, { headers: { cookie: users.sales.cookie } }))
        .status,
    ).toBe(404);
  });
  test("pending, foreign-owner, duplicate and unsupported files cannot be attached", async () => {
    const a = await create("sales"),
      b = await create("sales"),
      bytes = new TextEncoder().encode("pending fixture"),
      c = await claim(bytes, "sales", a.issueId);
    const input = {
      issueId: a.issueId,
      body: "",
      uploads: [{ storageId: c.uploadId, fileName: "pending.png" }],
    };
    expect((await post("addComment", input, "sales")).status).toBe(403);
    await upload(c, bytes);
    expect(
      (await post("addComment", { ...input, issueId: b.issueId }, "sales"))
        .status,
    ).toBe(403);
    expect(
      (
        await post(
          "addComment",
          { ...input, uploads: [...input.uploads, ...input.uploads] },
          "sales",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post("uploads/claim", {
          mime: "text/html",
          size: 1,
          sha256: sha256Hex("x"),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          "uploads/claim",
          { mime: "video/mp4", size: 76 * 1024 * 1024, sha256: sha256Hex("x") },
          "sales",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          "uploads/claim",
          {
            mime: "video/mp4",
            size: 150 * 1024 * 1024,
            sha256: sha256Hex("x"),
          },
          "super_admin",
        )
      ).status,
    ).toBe(200);
  });
  test("checksum, size and token failures never store bytes", async () => {
    const bytes = new TextEncoder().encode("good"),
      c = await claim(bytes);
    expect((await upload(c, new TextEncoder().encode("evil"))).status).toBe(
      400,
    );
    expect((await upload(c, new TextEncoder().encode("xx"))).status).toBe(400);
    expect(
      (await upload({ ...c, uploadToken: "spu_wrongtoken" }, bytes)).status,
    ).toBe(401);
    const [f] = await h.db`select status from files where id=${c.uploadId}`;
    expect(f.status).toBe("pending");
  });
  test("large video chunks use platform files; chunk retry and completed retry are stable", async () => {
    const bytes = new Uint8Array(CHUNK_BYTES * 2 + 7);
    bytes.fill(42);
    const c = await claim(bytes, "sales", null, "video/mp4");
    for (let n = 0; n < 3; n++) {
      const slice = bytes.slice(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES);
      const put = () =>
        h.fetch(`${c.chunkUrl}/${n}`, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${c.uploadToken}`,
            "content-type": "video/mp4",
          },
          body: slice,
        });
      const first = await put();
      expect(first.status).toBe(200);
      const result = await first.json();
      expect(await (await put()).json()).toEqual(result);
    }
    const [f] = await h.db`select * from files where id=${c.uploadId}`;
    expect(f.status).toBe("stored");
    expect(
      sha256Hex(
        new Uint8Array(await Bun.file(join(h.filesDir, f.path)).arrayBuffer()),
      ),
    ).toBe(sha256Hex(bytes));
  });
});

describe("backup and agent API", () => {
  test("display cap retains full counts and filters before limiting", async () => {
    await h.db`insert into issues(number,title,area,priority,status,sort_order,archived,search_text,comment_count,attachment_count,milestone)
      select 100000+n,'Bound fixture '||n,'Issues','medium','draft',n*1024,false,'bound fixture '||n,0,0,'bound-fixture' from generate_series(1,510) n`;
    const b = (await get("board?milestone=bound-fixture")).body;
    expect(b.total).toBe(510);
    expect(b.issues.length).toBe(500);
    expect(b.counts.draft).toBe(510);
    expect(b.truncated).toBe(true);
    const late = (
      await get("board?milestone=bound-fixture&search=fixture%20510")
    ).body;
    expect(late.total).toBe(1);
    expect(late.issues[0].number).toBe(100510);
  });
  test("seed is idempotent by number and preserves provided bodies/comments/times, not attachments", async () => {
    const dir = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "issues-seed-"),
    );
    try {
      const file = join(dir, "backup.json"),
        at = Date.UTC(2025, 0, 1);
      await Bun.write(
        file,
        JSON.stringify({
          issues: [
            {
              number: 9001,
              title: "Fixture summary",
              status: "draft",
              priority: "medium",
              area: "Others",
              order: 1024,
              createdAt: at,
              updatedAt: at,
              commentCount: 3,
              attachmentCount: 1,
              externalRef: "TEST-BACKUP",
            },
            {
              number: 9002,
              title: "Fixture detail",
              description: "Saved body",
              steps: "Steps",
              actual: "Actual",
              expected: "Expected",
              status: "for_retest",
              priority: "high",
              area: "Issues",
              createdAt: at,
              updatedAt: at,
              commentCount: 1,
              comments: [
                {
                  _id: "old-comment",
                  authorName: "Tester",
                  body: "Saved comment",
                  createdAt: at + 1,
                  attachments: [{ fileName: "missing.png" }],
                },
              ],
            },
          ],
          truncated: false,
        }),
      );
      const first = await seedIssues(h.db, { file });
      expect(first.created).toBe(2);
      expect(first.comments).toBe(1);
      const again = await seedIssues(h.db, { file });
      expect(again.created).toBe(0);
      expect(again.skipped).toBe(2);
      const d = (await get("detail?number=9002")).body;
      expect(d.issue.description).toBe("Saved body");
      expect(d.comments[0].body).toBe("Saved comment");
      expect(d.issue.createdAt).toBe(at);
      expect(d.issue.updatedAt).toBe(at);
      expect(d.issue.backup.missingAttachments).toBe(1);
      expect(d.issue.attachmentCount).toBe(0);
      const summary = (await get("detail?number=9001")).body;
      expect(summary.issue.commentCount).toBe(0);
      expect(summary.issue.backup.missingComments).toBe(3);
      expect(summary.issue.backup.summaryOnly).toBe(true);
      expect((await create()).number).toBeGreaterThan(9002);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("agent bulk and update are atomic; reference replay and bearer access work", async () => {
    const ref = crypto.randomUUID(),
      payload = {
        issues: [
          { title: "Bulk one", externalRef: ref },
          { title: "Bulk two", externalRef: `${ref}-2` },
        ],
      };
    const first = await post("agent/bulkCreate", payload);
    expect(first.status).toBe(200);
    const second = await post("agent/bulkCreate", payload);
    expect(second.body.map((/** @type {any} */ r) => r.created)).toEqual([
      false,
      false,
    ]);
    const failed = await post("agent/bulkCreate", {
      issues: [
        { title: "Rollback", externalRef: `${ref}-rollback` },
        { title: "" },
      ],
    });
    expect(failed.status).toBe(400);
    expect(
      (await get(`agent/list?search=${ref}-rollback`)).body.issues,
    ).toEqual([]);
    const i = first.body[0];
    expect(
      (
        await post("agent/update", {
          number: i.number,
          status: "dev_work_ongoing",
          assigneeEmail: users.manager.email,
          comment: "Claimed",
          actor: "Lane test",
        })
      ).status,
    ).toBe(200);
    const res = await h.fetch(`/api/v1/issues/agent/get?number=${i.number}`, {
      headers: { authorization: `Bearer ${users.admin.access}` },
    });
    expect(res.status).toBe(200);
    const d = /** @type {any} */ (await res.json());
    expect(d.assigneeName).toBe("manager");
    expect(d.comments[0].authorName).toBe("Lane test");
    expect(
      (
        await post(
          "agent/create",
          { title: "No bypass", actor: "Admin" },
          "sales",
        )
      ).status,
    ).toBe(403);
  });
  test("CLI retains list/get/create/claim/comment/close/bulk flags over HTTP", async () => {
    const home = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "issues-cli-"),
    );
    try {
      await mkdir(join(home, ".sunpride-keys"));
      await Bun.write(
        join(home, ".sunpride-keys/v2-issues-token"),
        users.admin.access,
      );
      const script = new URL(
        "../../../../../scripts/issues.ts",
        import.meta.url,
      ).pathname;
      const run = async (/** @type {string[]} */ args) => {
        const proc = Bun.spawn([process.execPath, script, ...args], {
          env: { ...process.env, HOME: home, SUNPRIDE_API_URL: h.origin },
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await new Response(proc.stdout).text(),
          err = await new Response(proc.stderr).text();
        expect(await proc.exited).toBe(0);
        expect(err).toBe("");
        return JSON.parse(out);
      };
      const ref = crypto.randomUUID();
      const c = await run([
        "create",
        "--title",
        "CLI issue",
        "--description",
        "Body",
        "--area",
        "Issues",
        "--priority",
        "high",
        "--ref",
        ref,
        "--actor",
        "CLI test",
      ]);
      expect(
        (await run(["list", "--search", ref, "--json"])).issues[0].number,
      ).toBe(c.number);
      await run([
        "claim",
        c.key,
        "--assignee",
        users.manager.email,
        "--comment",
        "Started",
      ]);
      await run(["comment", c.key, "Retested"]);
      await run(["close", c.key, "--done"]);
      const d = await run(["get", c.key, "--json"]);
      expect(d.issue.status).toBe("completed");
      expect(d.issue.description).toBe("Body");
      expect(d.comments.length).toBe(2);
      const bulk = join(home, "bulk.json");
      await Bun.write(
        bulk,
        JSON.stringify([{ title: "CLI bulk", externalRef: `${ref}-bulk` }]),
      );
      expect((await run(["bulk", bulk]))[0].created).toBe(true);
      // UTF-8 byte-aware grouping stays below core's 1 MiB JSON cap.
      await Bun.write(
        bulk,
        JSON.stringify(
          Array.from({ length: 20 }, (_, n) => ({
            title: `Large CLI bulk ${n}`,
            externalRef: `${ref}-large-${n}`,
            description: "x".repeat(20_000),
            steps: "y".repeat(20_000),
            actual: "z".repeat(20_000),
          })),
        ),
      );
      const large = await run(["bulk", bulk]);
      expect(large).toHaveLength(20);
      expect(large.every((/** @type {any} */ r) => r.created)).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  test("board and detail subscriptions receive move and comment invalidations", async () => {
    const i = await create("sales");
    const ws = new WebSocket(
      h.origin.replace("http", "ws") + "/ws",
      /** @type {any} */ ({ headers: { cookie: users.viewer.cookie } }),
    );
    /** @type {any[]} */ const messages = [];
    ws.addEventListener("message", (e) =>
      messages.push(JSON.parse(String(e.data))),
    );
    const wait = async (/** @type {(m:any)=>boolean} */ pred) => {
      for (let n = 0; n < 100; n++) {
        const at = messages.findIndex(pred);
        if (at >= 0) return messages.splice(at, 1)[0];
        await Bun.sleep(20);
      }
      throw new Error("No websocket event");
    };
    try {
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", () => resolve(undefined));
        ws.addEventListener("error", () =>
          reject(new Error("websocket failed")),
        );
      });
      ws.send(
        JSON.stringify({
          type: "subscribe",
          topics: ["issues", `issue:${i.number}`, "issue:not-a-number"],
        }),
      );
      expect((await wait((m) => m.type === "subscribed")).topics).toEqual([
        "issues",
        `issue:${i.number}`,
      ]);
      messages.length = 0;
      await post("move", { issueId: i.issueId, status: "for_retest" });
      expect(
        (await wait((m) => m.type === "invalidate" && m.topic === "issues"))
          .seq,
      ).toBeGreaterThan(0);
      await wait(
        (m) => m.type === "invalidate" && m.topic === `issue:${i.number}`,
      );
      messages.length = 0;
      await post(
        "addComment",
        { issueId: i.issueId, body: "Live comment" },
        "sales",
      );
      await wait(
        (m) => m.type === "invalidate" && m.topic === `issue:${i.number}`,
      );
      expect(
        (await get(`detail?number=${i.number}`, "viewer")).body.comments[0]
          .body,
      ).toBe("Live comment");
    } finally {
      ws.close();
    }
  });
});
