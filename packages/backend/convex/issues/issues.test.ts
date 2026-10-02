import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { AssignableRole } from "../lib/roles";
import schema from "../schema";
import { modules } from "../test.setup";
import { formatIssueKey, parseIssueKey, validateAttachment } from "./constants";

type Test = TestConvex<typeof schema>;

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({
    subject: "root",
    email: "jcing.jc@gmail.com",
    name: "JC",
  });
  await root.mutation(api.domains.profiles.ensure, {});
  async function person(email: string, role: AssignableRole) {
    await root.mutation(api.domains.profiles.invite, {
      email,
      name: email.split("@")[0],
      role,
    });
    const actor = t.withIdentity({
      subject: email,
      email,
      name: email.split("@")[0],
    });
    await actor.mutation(api.domains.profiles.ensure, {});
    const profile = (await actor.query(api.domains.profiles.current, {}))!;
    return { actor, id: profile._id };
  }
  return { t, root, person };
}

/**
 * convex-test records size and sha256 for a stored blob but not its content type,
 * which the real deployment takes from the upload's Content-Type header. Patch the
 * fake `_storage` row so the server-side type check sees what production would.
 */
async function storeFile(t: Test, type: string, bytes = 16) {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(
      new Blob([new Uint8Array(bytes)], { type }),
    );
    const db = ctx.db as unknown as {
      patch: (id: string, value: { contentType: string }) => Promise<void>;
    };
    await db.patch(storageId, { contentType: type });
    return storageId;
  });
}

describe("issue tracker constants", () => {
  it("formats and parses SP keys", () => {
    expect(formatIssueKey(7)).toBe("SP-0007");
    expect(formatIssueKey(12345)).toBe("SP-12345");
    expect(parseIssueKey("SP-0007")).toBe(7);
    expect(parseIssueKey("sp-12")).toBe(12);
    expect(parseIssueKey("12")).toBe(12);
    expect(parseIssueKey(3)).toBe(3);
    expect(parseIssueKey("ISS-1")).toBeUndefined();
    expect(parseIssueKey("0")).toBeUndefined();
  });

  it("applies the CMS attachment limits", () => {
    expect(
      validateAttachment({
        fileType: "image/png",
        fileSize: 1024,
        maxVideoBytes: 1,
      }),
    ).toBeUndefined();
    expect(
      validateAttachment({
        fileType: "image/png",
        fileSize: 11 * 1024 * 1024,
        maxVideoBytes: 1,
      }),
    ).toMatch(/Image must be 10 MB/);
    expect(
      validateAttachment({
        fileType: "application/zip",
        fileSize: 1,
        maxVideoBytes: 1,
      }),
    ).toMatch(/image, video, PDF or Word/);
  });
});

describe("issues access", () => {
  it("grants internal roles and refuses field sales and viewers", async () => {
    const { root, person } = await setup();
    const sales = await person("seller@sunpride.local", "sales");
    const viewer = await person("viewer@sunpride.local", "viewer");
    const analyst = await person("analyst@sunpride.local", "analyst");
    const ops = await person("ops@sunpride.local", "operations");

    for (const denied of [sales, viewer]) {
      await expect(
        denied.actor.query(api.issues.queries.board, { archived: false }),
      ).rejects.toThrow(/Insufficient permission/);
      await expect(
        denied.actor.mutation(api.issues.mutations.create, { title: "Nope" }),
      ).rejects.toThrow(/Insufficient permission/);
    }
    expect(await sales.actor.query(api.issues.queries.access, {})).toEqual({
      canRead: false,
      canWrite: false,
      canManage: false,
      maxVideoBytes: 75 * 1024 * 1024,
    });

    // Analyst reads cross-scope but never writes.
    await analyst.actor.query(api.issues.queries.board, { archived: false });
    await expect(
      analyst.actor.mutation(api.issues.mutations.create, { title: "Nope" }),
    ).rejects.toThrow(/Insufficient permission/);

    // Operations writes but cannot archive.
    const created = await ops.actor.mutation(api.issues.mutations.create, {
      title: "Stock card off by one",
    });
    await expect(
      ops.actor.mutation(api.issues.mutations.archive, {
        issueId: created.issueId,
      }),
    ).rejects.toThrow(/Insufficient permission/);
    await root.mutation(api.issues.mutations.archive, {
      issueId: created.issueId,
    });

    // An assignee must hold issue access.
    await expect(
      root.mutation(api.issues.mutations.create, {
        title: "Assign to seller",
        assigneeId: sales.id,
      }),
    ).rejects.toThrow(/Assignee must be an active person with issue access/);
  });
});

describe("issues create, list and update", () => {
  it("numbers issues SP-0001 onwards and defaults area, priority and status", async () => {
    const { root, person } = await setup();
    const ops = await person("ops@sunpride.local", "operations");
    const first = await root.mutation(api.issues.mutations.create, {
      title: "  Orders list   freezes ",
      description: "Scrolling stops.",
      steps: "1. Open orders",
      actual: "Freezes",
      expected: "Scrolls",
      externalRef: "#123",
      milestone: "10 · Supervision and the memo's reports",
      assigneeId: ops.id,
    });
    const second = await ops.actor.mutation(api.issues.mutations.create, {
      title: "Imports preview",
      area: "imports",
      priority: "high",
    });
    expect(first.key).toBe("SP-0001");
    expect(second.key).toBe("SP-0002");

    const detail = await root.query(api.issues.queries.detail, {
      number: "SP-0001",
    });
    expect(detail?.issue).toMatchObject({
      title: "Orders list freezes",
      area: "Others",
      priority: "medium",
      status: "draft",
      archived: false,
      externalRef: "#123",
      milestone: "10 · Supervision and the memo's reports",
    });
    expect(detail?.reporterName).toBe("JC");
    expect(detail?.assigneeName).toBe("ops");
    expect(detail?.activity.map((entry) => entry.kind)).toEqual(["created"]);

    const board = await ops.actor.query(api.issues.queries.board, {
      archived: false,
    });
    expect(board.issues.map((issue) => issue.key)).toEqual([
      "SP-0002",
      "SP-0001",
    ]);
    expect(board.counts.draft).toBe(2);
    expect(board.milestones).toEqual([
      "10 · Supervision and the memo's reports",
    ]);
    expect(board.issues[0]).toMatchObject({
      area: "Imports",
      priority: "high",
      reporterName: "ops",
    });

    const filtered = await ops.actor.query(api.issues.queries.board, {
      archived: false,
      assigneeId: "unassigned",
    });
    expect(filtered.issues.map((issue) => issue.number)).toEqual([2]);
    const byArea = await ops.actor.query(api.issues.queries.board, {
      archived: false,
      area: "Imports",
      status: "completed",
    });
    expect(byArea.issues).toEqual([]);
    expect(byArea.counts.draft).toBe(1);

    await expect(
      root.mutation(api.issues.mutations.create, {
        title: "x",
        area: "Payroll",
      }),
    ).rejects.toThrow(/Unknown area/);
    await expect(
      root.mutation(api.issues.mutations.create, { title: "   " }),
    ).rejects.toThrow(/Title is required/);
  });

  it("searches by key and text", async () => {
    const { root } = await setup();
    await root.mutation(api.issues.mutations.create, {
      title: "Coverage map pins drift",
    });
    await root.mutation(api.issues.mutations.create, {
      title: "Receipt totals",
    });
    const hits = await root.query(api.issues.queries.board, {
      archived: false,
      search: "pins",
    });
    expect(hits.issues.map((issue) => issue.key)).toEqual(["SP-0001"]);
  });

  it("records field changes and status moves in the activity log", async () => {
    const { root, person } = await setup();
    const manager = await person("manager@sunpride.local", "manager");
    const { issueId } = await root.mutation(api.issues.mutations.create, {
      title: "Visit check-in",
      description: "Old text",
    });
    expect(
      await manager.actor.mutation(api.issues.mutations.update, {
        issueId,
        priority: "critical",
        description: null,
        assigneeId: manager.id,
        milestone: "08 · Field apps",
      }),
    ).toEqual({ changed: true });
    expect(
      await manager.actor.mutation(api.issues.mutations.update, {
        issueId,
        priority: "critical",
      }),
    ).toEqual({ changed: false });
    await manager.actor.mutation(api.issues.mutations.move, {
      issueId,
      status: "dev_work_ongoing",
    });

    const detail = await root.query(api.issues.queries.detail, { number: 1 });
    expect(detail?.issue).toMatchObject({
      priority: "critical",
      status: "dev_work_ongoing",
      assigneeId: manager.id,
      milestone: "08 · Field apps",
    });
    expect(detail?.issue.description).toBeUndefined();
    expect(detail?.activity.map((entry) => entry.kind)).toEqual([
      "status_changed",
      "updated",
      "created",
    ]);
    expect(detail?.activity[0]).toMatchObject({
      actorName: "manager",
      fromStatus: "draft",
      toStatus: "dev_work_ongoing",
    });
    expect(
      detail?.activity[1]?.changes?.map((change) => change.field).sort(),
    ).toEqual(["assignee", "description", "milestone", "priority"]);
    expect(
      detail?.activity[1]?.changes?.find(
        (change) => change.field === "assignee",
      ),
    ).toEqual({ field: "assignee", from: null, to: "manager" });
  });

  it("orders cards inside a column with before/after anchors", async () => {
    const { root } = await setup();
    const ids: Id<"issues">[] = [];
    for (const title of ["A", "B", "C"])
      ids.push(
        (await root.mutation(api.issues.mutations.create, { title })).issueId,
      );
    // Move C between A and B.
    await root.mutation(api.issues.mutations.move, {
      issueId: ids[2]!,
      status: "draft",
      beforeId: ids[0],
      afterId: ids[1],
    });
    const board = await root.query(api.issues.queries.board, {
      archived: false,
    });
    const column = board.issues
      .filter((issue) => issue.status === "draft")
      .sort((a, b) => a.order - b.order)
      .map((issue) => issue.title);
    expect(column).toEqual(["A", "C", "B"]);
    await expect(
      root.mutation(api.issues.mutations.move, {
        issueId: ids[0]!,
        status: "draft",
        beforeId: ids[0],
      }),
    ).rejects.toThrow(/cannot anchor itself/);
  });

  it("archives out of the active board and restores", async () => {
    const { root } = await setup();
    const { issueId } = await root.mutation(api.issues.mutations.create, {
      title: "Old",
    });
    await root.mutation(api.issues.mutations.archive, { issueId });
    expect(
      (await root.query(api.issues.queries.board, { archived: false })).issues,
    ).toEqual([]);
    expect(
      (await root.query(api.issues.queries.board, { archived: true })).issues,
    ).toHaveLength(1);
    await expect(
      root.mutation(api.issues.mutations.update, { issueId, title: "x" }),
    ).rejects.toThrow(/Active issue not found/);
    await root.mutation(api.issues.mutations.restore, { issueId });
    const detail = await root.query(api.issues.queries.detail, { number: 1 });
    expect(detail?.issue.archived).toBe(false);
    expect(detail?.activity.map((entry) => entry.kind)).toEqual([
      "restored",
      "archived",
      "created",
    ]);
  });
});

describe("issue comments and attachments", () => {
  it("comments, edits only own comments, and lets a manager remove any", async () => {
    const { root, person } = await setup();
    const ops = await person("ops@sunpride.local", "operations");
    const { issueId } = await root.mutation(api.issues.mutations.create, {
      title: "Comment me",
    });
    const commentId = await ops.actor.mutation(
      api.issues.mutations.addComment,
      { issueId, body: "Seen on staging" },
    );
    await expect(
      root.mutation(api.issues.mutations.updateComment, {
        commentId,
        body: "hijack",
      }),
    ).rejects.toThrow(/Only the author/);
    await ops.actor.mutation(api.issues.mutations.updateComment, {
      commentId,
      body: "Seen on DEV",
    });
    await expect(
      ops.actor.mutation(api.issues.mutations.addComment, {
        issueId,
        body: "   ",
      }),
    ).rejects.toThrow(/Write a comment or attach a file/);

    let detail = await ops.actor.query(api.issues.queries.detail, {
      number: 1,
    });
    expect(detail?.comments).toHaveLength(1);
    expect(detail?.comments[0]).toMatchObject({
      authorName: "ops",
      body: "Seen on DEV",
      canEdit: true,
      canDelete: true,
    });
    const asRoot = await root.query(api.issues.queries.detail, { number: 1 });
    expect(asRoot?.comments[0]).toMatchObject({
      canEdit: false,
      canDelete: true,
    });

    await root.mutation(api.issues.mutations.deleteComment, { commentId });
    detail = await ops.actor.query(api.issues.queries.detail, { number: 1 });
    expect(detail?.comments).toEqual([]);
    expect(detail?.issue.commentCount).toBe(0);
  });

  it("attaches validated uploads on create and refuses reuse", async () => {
    const { t, root } = await setup();
    const png = await storeFile(t, "image/png");
    const zip = await storeFile(t, "application/zip");
    await expect(
      root.mutation(api.issues.mutations.create, {
        title: "Bad upload",
        uploads: [{ storageId: zip, fileName: "logs.zip" }],
      }),
    ).rejects.toThrow(/logs.zip: Use an image, video, PDF or Word file/);

    await root.mutation(api.issues.mutations.create, {
      title: "Screenshot",
      uploads: [{ storageId: png, fileName: "screen.png" }],
    });
    // The rejected create rolled back, so it did not consume a number.
    const detail = await root.query(api.issues.queries.detail, {
      number: "SP-0001",
    });
    expect(detail?.issue).toMatchObject({
      commentCount: 1,
      attachmentCount: 1,
    });
    expect(detail?.comments[0]?.body).toBe(
      "Attachments added when the issue was created.",
    );
    expect(detail?.comments[0]?.attachments[0]).toMatchObject({
      fileName: "screen.png",
      fileType: "image/png",
      fileSize: 16,
      kind: "image",
    });

    await expect(
      root.mutation(api.issues.mutations.addComment, {
        issueId: detail!.issue._id,
        body: "again",
        uploads: [{ storageId: png, fileName: "screen.png" }],
      }),
    ).rejects.toThrow(/already attached/);

    await root.mutation(api.issues.mutations.removeAttachment, {
      attachmentId: detail!.comments[0]!.attachments[0]!._id,
    });
    const after = await root.query(api.issues.queries.detail, { number: 1 });
    expect(after?.issue.attachmentCount).toBe(0);
    expect(after?.activity[0]).toMatchObject({
      kind: "attachment_removed",
      note: "screen.png",
    });
  });

  it("caps attachments per comment at five", async () => {
    const { t, root } = await setup();
    const uploads = [];
    for (let index = 0; index < 6; index += 1)
      uploads.push({
        storageId: await storeFile(t, "image/png"),
        fileName: `${index}.png`,
      });
    await expect(
      root.mutation(api.issues.mutations.create, { title: "Many", uploads }),
    ).rejects.toThrow(/at most 5 attachments/);
  });
});

describe("issues agent functions", () => {
  it("creates, lists, updates and comments without a browser session", async () => {
    const { t, person } = await setup();
    await person("dev@sunpride.local", "operations");
    const created = await t.mutation(internal.issues.agent.create, {
      title: "Agent finding",
      area: "Coverage",
      milestone: "05 · Coverage",
      actor: "Agent · codex",
    });
    expect(created).toMatchObject({ key: "SP-0001", created: true });

    const listed = await t.query(internal.issues.agent.list, {
      milestone: "05 · Coverage",
    });
    expect(listed.issues).toHaveLength(1);
    expect(listed.issues[0]).toMatchObject({
      reporterName: "Agent · codex",
      area: "Coverage",
    });

    const updated = await t.mutation(internal.issues.agent.update, {
      number: "SP-0001",
      status: "dev_work_ongoing",
      assigneeEmail: "DEV@sunpride.local",
      comment: "Claimed by codex",
      actor: "Agent · codex",
    });
    expect(updated).toEqual({ key: "SP-0001", changed: true });
    await t.mutation(internal.issues.agent.comment, {
      number: 1,
      body: "Fixed in abc123",
    });

    const detail = await t.query(internal.issues.agent.get, { number: 1 });
    expect(detail.issue.status).toBe("dev_work_ongoing");
    expect(detail.assigneeName).toBe("dev");
    expect(detail.comments.map((comment) => comment.authorName)).toEqual([
      "Agent · codex",
      "Agent",
    ]);
    expect(
      (
        await t.query(internal.issues.agent.list, {
          status: "dev_work_ongoing",
        })
      ).issues,
    ).toHaveLength(1);

    await expect(
      t.query(internal.issues.agent.get, { number: "SP-0099" }),
    ).rejects.toThrow(/SP-0099 not found/);
    await expect(
      t.mutation(internal.issues.agent.update, {
        number: 1,
        assigneeEmail: "nobody@sunpride.local",
      }),
    ).rejects.toThrow(/No profile/);
  });

  it("bulkCreate is idempotent on externalRef", async () => {
    const { t } = await setup();
    const batch = [
      { title: "SOP four", externalRef: "SOP-004" },
      { title: "GitHub issue", externalRef: "#123" },
      { title: "No reference" },
    ];
    const first = await t.mutation(internal.issues.agent.bulkCreate, {
      issues: batch,
    });
    expect(first.map((row) => [row.key, row.created])).toEqual([
      ["SP-0001", true],
      ["SP-0002", true],
      ["SP-0003", true],
    ]);
    const second = await t.mutation(internal.issues.agent.bulkCreate, {
      issues: batch.slice(0, 2),
    });
    expect(second.map((row) => [row.key, row.created])).toEqual([
      ["SP-0001", false],
      ["SP-0002", false],
    ]);
    const all = await t.query(internal.issues.agent.list, {});
    expect(all.issues).toHaveLength(3);
    await expect(
      t.mutation(internal.issues.agent.bulkCreate, {
        issues: Array.from({ length: 101 }, (_, i) => ({ title: `T${i}` })),
      }),
    ).rejects.toThrow(/at most 100/);
  });
});
