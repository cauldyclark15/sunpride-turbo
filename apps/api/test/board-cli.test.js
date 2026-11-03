import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { join } from "node:path";
import { startHarness } from "./harness.js";
import { install } from "../src/domains/issues/index.js";
import { PgListener } from "../src/core/pglisten.js";
import { randomToken, sha256Hex } from "../src/core/util.js";
import { HERMES_EMAIL, HERMES_NAME } from "../../../scripts/board/read.js";
import { parseCommand } from "../../../scripts/board/args.js";
import { runBoard } from "../../../scripts/board/commands.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {string} */ let teamFile;
/** @type {string} */ let cookie;
/** @type {string} */ let outsiderCookie;
/** @type {string} */ let adminId;
const script = new URL("../../../scripts/board.js", import.meta.url).pathname;

/** @param {string} userId */
async function session(userId) {
  const token = randomToken("sps_");
  await h.db`insert into sessions(user_id,token_hash,app,expires_at)
    values(${userId},${sha256Hex(token)},'web',now()+interval '1 hour')`;
  return `sp_session=${token}`;
}

beforeAll(async () => {
  if (process.env.SP_LANE !== "opsboard")
    throw new Error("Run with SP_LANE=opsboard");
  h = await startHarness({ installers: [install] });
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
  teamFile = join(h.filesDir, "team-emails.txt");
  await Bun.write(teamFile, "  TEAM@BOARD.EXAMPLE.TEST  \r\n\n");
  for (const [email, name] of [
    ["team@board.example.test", "Developer"],
    ["tester@board.example.test", "Client tester"],
  ]) {
    const [u] =
      await h.db`insert into users(email,password_hash) values(${email},'') returning id`;
    const [p] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status)
      values(${u.id},${u.id},${name},${email},'admin','active') returning id`;
    const auth = await session(u.id);
    if (email.startsWith("team")) {
      cookie = auth;
      adminId = p.id;
    } else outsiderCookie = auth;
  }
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  // Only this harness's disposable database, never the lane base or dev database.
  await h.db`delete from issue_attachments`;
  await h.db`delete from issue_comments`;
  await h.db`delete from issue_activity`;
  await h.db`delete from issue_commands`;
  await h.db`delete from issues`;
  await h.db`delete from issue_counters`;
  await h.db`delete from change_log`;
});

/** @param {string[]} args @param {Record<string,string|undefined>} [overrides] */
async function cli(args, overrides = {}) {
  const proc = Bun.spawn([process.execPath, script, ...args], {
    cwd: new URL("../../../", import.meta.url).pathname,
    env: {
      ...process.env,
      DATABASE_URL: h.dbUrl,
      TEAM_EMAILS_FILE: teamFile,
      ...overrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}
/** @param {string[]} args @param {Record<string,string|undefined>} [overrides] @returns {Promise<any>} */
async function ok(args, overrides) {
  const result = await cli(args, overrides);
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(result.stdout);
}
/** @param {string} action @param {any} body @param {string} [auth] @returns {Promise<any>} */
async function post(action, body, auth = cookie) {
  const res = await h.fetch(`/api/v1/issues/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: auth },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json();
}
/** @param {string[]} [extra] */
const create = (extra = []) =>
  ok([
    "create",
    "--title",
    "Automation issue",
    "--area",
    "Issues",
    "--priority",
    "high",
    ...extra,
  ]);

const summaryKeys = [
  "key",
  "id",
  "number",
  "title",
  "status",
  "area",
  "priority",
  "external_ref",
  "milestone",
  "assignee_label",
  "comment_count",
  "last_comment_at",
  "last_comment_author_label",
  "updated_at",
  "created_at",
].sort();

describe("board CLI contract", () => {
  test("concurrent --ref creates, including the web path, bootstrap one un-sign-in-able Hermes", async () => {
    const args = [
      "--ref",
      "OPS-280",
      "--description",
      "Description",
      "--steps",
      "Steps",
      "--actual",
      "Actual",
      "--expected",
      "Expected",
      "--milestone",
      "Automation",
      "--status",
      "draft",
    ];
    const [a, b, web] = await Promise.all([
      create(args),
      create(args),
      post("create", {
        title: "Web race",
        externalRef: "OPS-280",
        area: "Issues",
        priority: "high",
      }),
    ]);
    expect(a.number).toBe(b.number);
    expect(a.number).toBe(web.number);
    expect(
      Number(!a.existing) + Number(!b.existing) + Number(web.created),
    ).toBe(1);
    const replay = await create(["--ref", "OPS-280"]);
    expect(replay).toEqual({ key: a.key, number: a.number, existing: true });
    const [counts] =
      await h.db`select (select count(*)::int from issues) as issues,(select count(*)::int from issue_activity) as activities,(select count(*)::int from change_log) as changes`;
    expect(counts).toEqual({ issues: 1, activities: 1, changes: 1 });
    const actors =
      await h.db`select u.id,u.password_hash,u.disabled_at,p.name,p.email,p.role,p.status,p.auth_subject from users u join profiles p on p.user_id=u.id where u.email=${HERMES_EMAIL}`;
    expect(actors).toHaveLength(1);
    const actor = actors[0];
    expect(actor).toMatchObject({
      name: HERMES_NAME,
      email: HERMES_EMAIL,
      role: "super_admin",
      status: "active",
      disabled_at: null,
      password_hash: "",
    });
    expect(actor.auth_subject).toBe(actor.id);
    for (const password of [
      "",
      "Hermes",
      "correct horse battery",
      "x".repeat(256),
    ])
      expect(await Bun.password.verify(password, actor.password_hash)).toBe(
        false,
      );
    const signIn = await h.fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: HERMES_EMAIL,
        password: "not-a-system-password",
      }),
    });
    expect(signIn.status).toBe(401);
    expect(await signIn.json()).toMatchObject({
      error: { code: "invalid_credentials" },
    });
  });

  test("list filters before limit and orders by priority then sort_order", async () => {
    const highA = await post("create", { title: "High A", priority: "high" });
    const medium = await post("create", {
      title: "Medium",
      priority: "medium",
      status: "ongoing_test",
    });
    const [{ cutoff }] = await h.db`select clock_timestamp()::text as cutoff`;
    const highB = await post("create", {
      title: "High B",
      priority: "high",
      status: "for_retest",
    });
    const critical = await post("create", {
      title: "Critical",
      priority: "critical",
      status: "for_retest",
      assigneeId: adminId,
    });
    const archived = await post("create", {
      title: "Archived",
      priority: "critical",
    });
    await post("archive", { number: archived.number });
    await h.db`update issues set sort_order=300 where number=${highA.number}`;
    await h.db`update issues set sort_order=100 where number=${highB.number}`;
    const all = await ok(["list"]);
    expect(all.map((/** @type {any} */ r) => r.number)).toEqual([
      critical.number,
      highB.number,
      highA.number,
      medium.number,
    ]);
    expect(Object.keys(all[0]).sort()).toEqual(summaryKeys);
    expect(all[0]).toMatchObject({
      assignee_label: "Developer",
      comment_count: 0,
      last_comment_at: null,
      last_comment_author_label: null,
      external_ref: null,
      milestone: null,
    });
    expect(all[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    const filtered = await ok([
      "list",
      "--status",
      "ongoing_test,for_retest",
      "--limit",
      "2",
    ]);
    expect(filtered.map((/** @type {any} */ r) => r.number)).toEqual([
      critical.number,
      highB.number,
    ]);
    // The cutoff is from Postgres; convert its explicit UTC timezone to ISO syntax.
    const since = new Date(cutoff).toISOString();
    const updated = await ok([
      "list",
      "--updated-since",
      since,
      "--status",
      "for_retest",
    ]);
    expect(updated.map((/** @type {any} */ r) => r.number)).toEqual([
      critical.number,
      highB.number,
    ]);
    expect(
      await ok(["list", "--updated-since", "9999-01-01T00:00:00Z"]),
    ).toEqual([]);
  });

  test("show returns full fields, email-based team flags and web attachment URLs", async () => {
    const i = await create([
      "--description",
      "Body",
      "--steps",
      "Reproduce",
      "--actual",
      "Broken",
      "--expected",
      "Working",
      "--ref",
      "SHOW",
      "--milestone",
      "M1",
    ]);
    const own = await ok(["comment", i.key, "--body", "Builder response"]);
    const bytes = new TextEncoder().encode("board evidence");
    const claim = await post("uploads/claim", {
      mime: "image/png",
      size: bytes.length,
      sha256: sha256Hex(bytes),
    });
    const uploaded = await h.fetch(claim.uploadUrl, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${claim.uploadToken}`,
        "content-type": "image/png",
      },
      body: bytes,
    });
    expect(uploaded.status).toBe(200);
    const team = await post("addComment", {
      number: i.number,
      body: "Team evidence",
      uploads: [{ storageId: claim.uploadId, fileName: "evidence.png" }],
    });
    const other = await post(
      "addComment",
      { number: i.number, body: "Client response" },
      outsiderCookie,
    );
    // An author label must not impersonate the system/team classification.
    await h.db`update issue_comments set author_label=${HERMES_NAME} where id=${other.commentId}`;
    const removed = await post("addComment", {
      number: i.number,
      body: "Deleted",
    });
    await post("deleteComment", { commentId: removed.commentId });
    const show = await ok(["show", i.key]);
    expect(Object.keys(show).sort()).toEqual(
      [
        ...summaryKeys,
        "description",
        "steps",
        "actual",
        "expected",
        "comments",
        "attachments",
      ].sort(),
    );
    expect(show).toMatchObject({
      description: "Body",
      steps: "Reproduce",
      actual: "Broken",
      expected: "Working",
      external_ref: "SHOW",
      milestone: "M1",
      comment_count: 3,
      last_comment_author_label: HERMES_NAME,
    });
    expect(show.comments).toEqual([
      {
        id: own.comment_id,
        author_label: HERMES_NAME,
        author_email: HERMES_EMAIL,
        author_is_team: true,
        body: "Builder response",
        created_at: expect.any(String),
      },
      {
        id: team.commentId,
        author_label: "Developer",
        author_email: "team@board.example.test",
        author_is_team: true,
        body: "Team evidence",
        created_at: expect.any(String),
      },
      {
        id: other.commentId,
        author_label: HERMES_NAME,
        author_email: "tester@board.example.test",
        author_is_team: false,
        body: "Client response",
        created_at: expect.any(String),
      },
    ]);
    expect(show.attachments).toHaveLength(1);
    expect(show.attachments[0]).toEqual({
      name: "evidence.png",
      url: expect.stringMatching(
        /^\/api\/v1\/issues\/attachments\/[\da-f-]+\/content$/,
      ),
    });
    expect(
      (await h.fetch(show.attachments[0].url, { headers: { cookie } })).status,
    ).toBe(200);
    const missing = await ok(["show", i.key], {
      TEAM_EMAILS_FILE: join(h.filesDir, "missing.txt"),
    });
    expect(
      missing.comments.map((/** @type {any} */ c) => c.author_is_team),
    ).toEqual([true, false, false]);
  });

  test("comments --since is strict, ascending, status-filtered and excludes deleted/archived", async () => {
    const i = await create(["--status", "for_retest"]);
    const old = await ok(["comment", i.key, "--body", "Old"]);
    const equal = await post("addComment", {
      number: i.number,
      body: "At boundary",
    });
    const later = await ok(["comment", i.key, "--body", "Later"]);
    const last = await post("addComment", { number: i.number, body: "Last" });
    await h.db`update issue_comments set created_at='2025-01-01T00:00:00Z' where id=${old.comment_id}`;
    await h.db`update issue_comments set created_at='2025-01-02T00:00:00Z' where id=${equal.commentId}`;
    await h.db`update issue_comments set created_at='2025-01-03T00:00:00Z' where id=${later.comment_id}`;
    await h.db`update issue_comments set created_at='2025-01-04T00:00:00Z' where id=${last.commentId}`;
    const draft = await create();
    await ok(["comment", draft.key, "--body", "Wrong status"]);
    const archived = await create();
    await ok(["comment", archived.key, "--body", "Archived"]);
    await post("archive", { number: archived.number });
    const deleted = await post("addComment", {
      number: i.number,
      body: "Deleted",
    });
    await post("deleteComment", { commentId: deleted.commentId });
    const result = await ok([
      "comments",
      "--since",
      "2025-01-02T00:00:00Z",
      "--status",
      "for_retest,ongoing_test",
    ]);
    expect(result).toEqual([
      {
        key: i.key,
        status: "for_retest",
        comment_id: later.comment_id,
        author_label: HERMES_NAME,
        author_email: HERMES_EMAIL,
        author_is_team: true,
        body: "Later",
        created_at: "2025-01-03T00:00:00.000Z",
      },
      {
        key: i.key,
        status: "for_retest",
        comment_id: last.commentId,
        author_label: "Developer",
        author_email: "team@board.example.test",
        author_is_team: true,
        body: "Last",
        created_at: "2025-01-04T00:00:00.000Z",
      },
    ]);
    const all = await ok(["comments", "--since", "2025-01-02T00:00:00Z"]);
    expect(all.map((/** @type {any} */ c) => c.body)).toEqual([
      "Later",
      "Last",
      "Wrong status",
    ]);
    expect(await ok(["comments", "--since", "9999-01-01T00:00:00Z"])).toEqual(
      [],
    );
  });

  test("move records status_changed and optional comment atomically; same status is a no-op", async () => {
    const i = await create();
    expect(
      await ok([
        "move",
        i.key,
        "--status",
        "dev_work_ongoing",
        "--comment",
        "Picked up",
      ]),
    ).toEqual({ key: i.key, from: "draft", to: "dev_work_ongoing" });
    const activity =
      await h.db`select kind,from_status,to_status from issue_activity where kind='status_changed'`;
    expect(activity).toEqual([
      {
        kind: "status_changed",
        from_status: "draft",
        to_status: "dev_work_ongoing",
      },
    ]);
    const before =
      await h.db`select status,sort_order,comment_count,updated_at from issues where number=${i.number}`;
    const logBefore =
      await h.db`select kind,from_status,to_status,note from issue_activity order by kind`;
    const changesBefore = await h.db`select * from change_log`;
    expect(before[0]).toMatchObject({
      status: "dev_work_ongoing",
      comment_count: 1,
    });
    expect(
      await ok([
        "move",
        i.key,
        "--status",
        "dev_work_ongoing",
        "--comment",
        "Must not duplicate",
      ]),
    ).toEqual({ key: i.key, from: "dev_work_ongoing", to: "dev_work_ongoing" });
    expect(
      await h.db`select status,sort_order,comment_count,updated_at from issues where number=${i.number}`,
    ).toEqual(before);
    expect(
      await h.db`select kind,from_status,to_status,note from issue_activity order by kind`,
    ).toEqual(logBefore);
    expect(await h.db`select * from change_log`).toEqual(changesBefore);
    const bad = await cli([
      "move",
      i.key,
      "--status",
      "completed",
      "--comment",
      "x".repeat(20_001),
    ]);
    expect(bad.code).toBe(2);
    expect((await ok(["show", i.key])).status).toBe("dev_work_ongoing");
  });

  test("comment increments counts, stores Hermes attribution and creates commented activity", async () => {
    const i = await create();
    const result = await ok([
      "comment",
      i.key,
      "--body",
      "  Ready for review  ",
    ]);
    expect(Object.keys(result).sort()).toEqual(["comment_id", "key"]);
    const [stored] =
      await h.db`select c.id,c.body,p.name from issue_comments c join profiles p on p.id=c.author_id where c.id=${result.comment_id}`;
    expect(stored).toEqual({
      id: result.comment_id,
      body: "Ready for review",
      name: HERMES_NAME,
    });
    const detail = await ok(["show", i.key]);
    expect(detail).toMatchObject({
      comment_count: 1,
      last_comment_author_label: HERMES_NAME,
    });
    expect(detail.last_comment_at).toBe(detail.comments[0].created_at);
    const [activity] =
      await h.db`select kind,from_status,to_status,changes,note,actor_label from issue_activity where kind='commented'`;
    expect(activity).toEqual({
      kind: "commented",
      from_status: null,
      to_status: null,
      changes: null,
      note: null,
      actor_label: null,
    });
  });

  test("CLI and actual HTTP writes have identical activity shapes and sync facts", async () => {
    const a = await create();
    const b = await post("create", {
      title: "Web issue",
      area: "Issues",
      priority: "high",
    });
    await ok(["move", a.key, "--status", "ongoing_test"]);
    await post("move", { number: b.number, status: "ongoing_test" });
    await ok(["comment", a.key, "--body", "Verified"]);
    await post("addComment", { number: b.number, body: "Verified" });
    /** @param {number} number @param {string} key */
    async function facts(number, key) {
      const rows =
        await h.db`select a.* from issue_activity a join issues i on i.id=a.issue_id where i.number=${number} order by a.created_at,a.id`;
      return rows.map((/** @type {any} */ r) => {
        expect(r.id).toMatch(/^[\da-f-]{36}$/);
        expect(r.issue_id).toMatch(/^[\da-f-]{36}$/);
        expect(r.actor_id).toMatch(/^[\da-f-]{36}$/);
        expect(r.created_at).toBeInstanceOf(Date);
        expect(r.updated_at).toBeInstanceOf(Date);
        return {
          fields: Object.keys(r).sort(),
          kind: r.kind,
          actor_label: r.actor_label,
          from_status: r.from_status,
          to_status: r.to_status,
          changes: r.changes,
          note: r.note === key ? "<issue key>" : r.note,
        };
      });
    }
    const cliFacts = await facts(a.number, a.key);
    expect(cliFacts.map((/** @type {any} */ r) => r.kind)).toEqual([
      "created",
      "status_changed",
      "commented",
    ]);
    expect(cliFacts).toEqual(await facts(b.number, b.key));
    const changes =
      await h.db`select i.number,c.entity,c.scope_key,c.op,count(*)::int as count from change_log c join issues i on i.id::text=c.entity_id group by i.number,c.entity,c.scope_key,c.op order by i.number`;
    expect(
      changes.map((/** @type {any} */ r) => ({ ...r, number: 0 })),
    ).toEqual(
      Array(2).fill({
        number: 0,
        entity: "issue",
        scope_key: "issues",
        op: "upsert",
        count: 3,
      }),
    );
    expect((await ok(["show", a.key])).comment_count).toBe(1);
    expect((await ok(["show", b.key])).comment_count).toBe(1);
  });

  test("publishes both topics after committed create/replay/move/comment", async () => {
    /** @type {any[]} */ const events = [];
    const listener = new PgListener(h.dbUrl, "sp_events", async (payload) => {
      const event = JSON.parse(payload);
      const rows = await h.db`select number,status,comment_count from issues`;
      events.push({ ...event, rows });
    });
    /** @param {number} number */
    async function notifications(number) {
      for (let n = 0; n < 100; n++) {
        if (
          ["issues", `issue:${number}`].every((topic) =>
            events.some((e) => e.topic === topic),
          )
        )
          return events.splice(0);
        await Bun.sleep(20);
      }
      throw new Error("Missing committed board notification");
    }
    await listener.start();
    try {
      const i = await create(["--ref", "NOTIFY"]);
      const created = await notifications(i.number);
      for (const event of created)
        expect(event.rows).toEqual([
          { number: i.number, status: "draft", comment_count: 0 },
        ]);
      await create(["--ref", "NOTIFY"]);
      await notifications(i.number);
      await ok(["move", i.key, "--status", "for_retest"]);
      for (const event of await notifications(i.number))
        expect(event.rows[0].status).toBe("for_retest");
      await ok(["comment", i.key, "--body", "Retest"]);
      for (const event of await notifications(i.number))
        expect(event.rows[0].comment_count).toBe(1);
    } finally {
      await listener.close();
    }
  });

  test("a service failure rolls back its move, comment and sync facts", async () => {
    const i = await create();
    // Bypass only argument parsing to force the real service's validation failure
    // after moveIssue has already written inside the command transaction.
    const input = parseCommand([
      "move",
      i.key,
      "--status",
      "completed",
      "--comment",
      "Valid",
    ]);
    input.values.comment = "x".repeat(20_001);
    await expect(runBoard(h.db, input)).rejects.toThrow("characters or fewer");
    const detail = await ok(["show", i.key]);
    expect(detail).toMatchObject({ status: "draft", comment_count: 0 });
    const activity = await h.db`select kind from issue_activity`;
    expect(Array.from(activity)).toEqual([{ kind: "created" }]);
    expect((await h.db`select * from change_log`).length).toBe(1);
  });

  test("disabled or demoted Hermes is not silently re-enabled", async () => {
    const i = await create();
    for (const [role, status] of [
      ["super_admin", "disabled"],
      ["sales", "active"],
    ]) {
      await h.db`update profiles set role=${role},status=${status} where email=${HERMES_EMAIL}`;
      try {
        const result = await cli(["comment", i.key, "--body", "Refused"]);
        expect(result).toMatchObject({ code: 1, stdout: "" });
        expect(JSON.parse(result.stderr)).toMatchObject({ error: "forbidden" });
        const [p] =
          await h.db`select role,status from profiles where email=${HERMES_EMAIL}`;
        expect(p).toEqual({ role, status });
      } finally {
        await h.db`update profiles set role='super_admin',status='active' where email=${HERMES_EMAIL}`;
      }
    }
    expect((await ok(["show", i.key])).comment_count).toBe(0);
  });

  // Keep each CLI process under the existing test timeout, rather than putting
  // every usage case in one sequential, host-contention-sensitive test.
  for (const args of [
    [],
    ["unknown"],
    ["list", "extra"],
    ["list", "--wat", "x"],
    ["list", "--limit", "0"],
    ["list", "--limit", "1.5"],
    ["list", "--limit", "2", "--limit", "3"],
    ["list", "--status", "draft,unknown"],
    ["list", "--updated-since", "yesterday"],
    ["list", "--updated-since", "2025-02-30T00:00:00Z"],
    ["list", "--updated-since", "2025-01-01T00:00:00"],
    ["comments"],
    ["comments", "--since", ""],
    ["show"],
    ["show", "SP-0"],
    ["show", "sp-0001"],
    ["show", "1"],
    ["create", "--title", "T"],
    ["create", "--title", "T", "--area", "No area", "--priority", "high"],
    ["create", "--title", "T", "--area", "Issues", "--priority", "unknown"],
    ["move", "SP-0001", "--status", "wrong"],
    ["comment", "SP-0001", "--body", " "],
  ])
    test(`usage error returns 2 on stderr: ${JSON.stringify(args)}`, async () => {
      const result = await cli(args, { DATABASE_URL: "" });
      expect(result).toMatchObject({ code: 2, stdout: "" });
      expect(JSON.parse(result.stderr)).toEqual({
        error: "invalid_request",
        message: expect.any(String),
      });
    });

  test("not-found returns 3 and configuration errors return 1, all on stderr", async () => {
    for (const args of [
      ["show", "SP-999999999"],
      ["move", "SP-999999999", "--status", "completed"],
      ["comment", "SP-999999999", "--body", "Missing"],
    ]) {
      const result = await cli(args);
      expect(result).toMatchObject({ code: 3, stdout: "" });
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: "not_found",
        message: expect.any(String),
      });
    }
    const result = await cli(["list"], { DATABASE_URL: "" });
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(JSON.parse(result.stderr)).toEqual({
      error: "configuration",
      message: "DATABASE_URL is required",
    });
  });
});
