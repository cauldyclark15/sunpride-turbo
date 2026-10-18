import { tx } from "@sunpride/db/client";
import { actorFor } from "../../core/context.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { ApiError, invalid } from "../../core/errors.js";
import { canonicalJson, isPlainObject, sha256Hex } from "../../core/util.js";
import { recordChange } from "../../core/sync.js";
import * as C from "./constants.js";
import * as S from "./service.js";
import { board, detail } from "./queries.js";
import { installUploads } from "./uploads.js";

/** @typedef {import('../../core/context.js').Ctx} Ctx */
/** @param {import('../../core/router.js').Router} router @param {any} platform */
export function install(router, platform) {
  platform.registerTopic(
    "issues",
    (/** @type {any} */ a, /** @type {string} */ t) =>
      t === "issues" && roleHas(a.role, "issues.read"),
  );
  platform.registerTopic(
    "issue",
    (/** @type {any} */ a, /** @type {string} */ t) =>
      /^issue:[1-9]\d*$/.test(t) && roleHas(a.role, "issues.read"),
  );
  /** @param {string} path @param {(ctx:Ctx)=>Promise<any>} handler */
  function get(path, handler) {
    router.get(`/api/v1/issues/${path}`, async (ctx) => {
      ctx.v2 = false;
      await requireCapability(ctx, "issues.read");
      return handler(ctx);
    });
  }
  /** @param {string} path @param {string} cap @param {(db:import('@sunpride/db/client').Db,body:any,actor:S.Actor)=>Promise<any>} handler */
  function command(path, cap, handler) {
    router.post(`/api/v1/issues/${path}`, async (ctx) => {
      ctx.v2 = false;
      if (!isPlainObject(ctx.body)) throw invalid("JSON object required");
      const body = ctx.body;
      const actor = await requireCapability(ctx, cap);
      const key = ctx.req.headers.get("idempotency-key") ?? body.idempotencyKey;
      if (
        key !== undefined &&
        (typeof key !== "string" || !key.trim() || key.length > 200)
      )
        throw invalid("Invalid idempotency key");
      const hash = sha256Hex(canonicalJson({ path, body }));
      const result = await tx(ctx.db, async (db) => {
        await db`select pg_advisory_xact_lock(hashtext('sunpride:issues'))`;
        const fresh = await actorFor(db, actor.userId);
        await requireCapability({ db, actor: fresh }, cap);
        if (key) {
          const [prior] =
            await db`select * from issue_commands where user_id=${actor.userId} and command_key=${key}`;
          if (prior) {
            if (prior.payload_hash !== hash)
              throw new ApiError(
                "idempotency_conflict",
                409,
                "This request key was used for different content",
              );
            return prior.result;
          }
        }
        const label = path.startsWith("agent/")
          ? (S.text(body.actor, 80) ?? "Agent")
          : undefined;
        const output = await handler(db, body, {
          .../** @type {S.Actor} */ (fresh),
          label,
        });
        if (key)
          await db`insert into issue_commands (user_id,command_key,payload_hash,result) values (${actor.userId},${key},${hash},${output ?? null})`;
        return output;
      });
      // Re-publishing on command replay is harmless and repairs a lost post-commit publish.
      await ctx.publish("issues");
      const ids = Array.isArray(result) ? result : [result];
      const numbers = new Set(
        ids.flatMap((r) => (r?.number ? [r.number] : [])),
      );
      for (const number of numbers) await ctx.publish(`issue:${number}`);
      return result;
    });
  }
  /** @param {import('@sunpride/db/client').Db} db @param {any} issue */
  async function changed(db, issue) {
    await recordChange(db, {
      entity: "issue",
      entityId: issue.id,
      scopeKey: "issues",
      op: "upsert",
    });
    return {
      issueId: issue.id,
      number: issue.number,
      key: C.formatIssueKey(issue.number),
    };
  }
  get("access", async (ctx) => {
    const a = /** @type {S.Actor} */ (ctx.actor);
    return {
      canRead: true,
      canWrite: roleHas(a.role, "issues.write"),
      canTriage: roleHas(a.role, "issues.triage"),
      canManage: roleHas(a.role, "issues.manage"),
      maxVideoBytes: S.videoLimit(a),
    };
  });
  get("board", (ctx) =>
    board(ctx.db, Object.fromEntries(ctx.url.searchParams)),
  );
  get("assignees", async (ctx) => {
    const rows =
      await ctx.db`select id as _id,name,role from profiles where status='active' order by name,id`;
    return rows.filter((/** @type {any} */ r) =>
      roleHas(r.role, "issues.triage"),
    );
  });
  get("detail", async (ctx) => {
    let issue;
    try {
      issue = await S.findIssue(
        ctx.db,
        ctx.url.searchParams.get("number"),
        false,
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
    return detail(ctx.db, issue, /** @type {S.Actor} */ (ctx.actor));
  });
  get("agent/list", (ctx) =>
    board(ctx.db, Object.fromEntries(ctx.url.searchParams), true),
  );
  get("agent/get", async (ctx) =>
    detail(
      ctx.db,
      await S.findIssue(ctx.db, ctx.url.searchParams.get("number"), false),
      /** @type {S.Actor} */ (ctx.actor),
    ),
  );
  for (const path of ["create", "agent/create"])
    command(
      path,
      path.startsWith("agent/") ? "issues.triage" : "issues.write",
      async (db, b, a) => {
        const result = await S.createIssue(db, b, a);
        if (result.created)
          await changed(db, { id: result.issueId, number: result.number });
        return result;
      },
    );
  command("agent/bulkCreate", "issues.triage", async (db, b, a) => {
    if (!Array.isArray(b.issues) || b.issues.length > 100)
      throw invalid("Send at most 100 issues per call");
    const out = [];
    for (const input of b.issues) {
      if (!isPlainObject(input)) throw invalid("Invalid issue");
      const r = await S.createIssue(db, input, a);
      out.push(r);
    }
    // recordChange must be last in the transaction; lock held through all inserts.
    for (const r of out)
      if (r.created) await changed(db, { id: r.issueId, number: r.number });
    return out;
  });
  for (const path of ["update", "agent/update"])
    command(path, "issues.triage", async (db, b, a) => {
      const issue = await S.findIssue(db, b.issueId ?? b.number);
      const edited = await S.updateIssue(db, issue, b, a);
      const moved =
        b.status !== undefined
          ? await S.moveIssue(db, issue, b, a)
          : { changed: false };
      const comment = S.text(b.comment);
      if (comment)
        await S.addComment(db, { issueId: issue.id, body: comment }, a);
      return {
        ...(await changed(db, issue)),
        changed: edited.changed || moved.changed || Boolean(comment),
      };
    });
  command("move", "issues.triage", async (db, b, a) => {
    const i = await S.findIssue(db, b.issueId ?? b.number);
    const r = await S.moveIssue(db, i, b, a);
    return { ...(await changed(db, i)), ...r };
  });
  for (const restore of [false, true])
    command(
      restore ? "restore" : "archive",
      "issues.manage",
      async (db, b, a) => {
        const i = await S.findIssue(db, b.issueId ?? b.number, false);
        if (i.archived === !restore)
          return { ...(await changed(db, i)), changed: false };
        await db`update issues set archived=${!restore},archived_at=${restore ? null : new Date()},updated_by=${a.profileId} where id=${i.id}`;
        if (restore) {
          await db`update issues set sort_order=(select coalesce(max(sort_order),0)+1024 from issues where not archived and status=${i.status} and id<>${i.id}) where id=${i.id}`;
        }
        await S.activity(db, a, i.id, restore ? "restored" : "archived");
        return { ...(await changed(db, i)), changed: true };
      },
    );
  for (const path of ["addComment", "agent/comment"])
    command(
      path,
      path.startsWith("agent/") ? "issues.triage" : "issues.write",
      async (db, b, a) => {
        const r = await S.addComment(db, b, a);
        await changed(db, { id: r.issueId, number: r.number });
        return r;
      },
    );
  command("updateComment", "issues.write", async (db, b, a) => {
    const { comment: c, issue: i } = await S.ownComment(
      db,
      b.commentId,
      a,
      false,
    );
    const body = S.text(b.body) ?? "";
    if (
      !body &&
      !(await db`select id from issue_attachments where comment_id=${c.id}`)
        .length
    )
      throw invalid("Write a comment or attach a file");
    if (body !== c.body) {
      await db`update issue_comments set body=${body} where id=${c.id}`;
      await S.activity(db, a, i.id, "comment_updated");
      await S.refreshCounts(db, i.id, a);
    }
    return changed(db, i);
  });
  command("deleteComment", "issues.write", async (db, b, a) => {
    const { comment: c, issue: i } = await S.ownComment(
      db,
      b.commentId,
      a,
      true,
    );
    await db`delete from issue_attachments where comment_id=${c.id}`;
    await db`update issue_comments set deleted_at=now() where id=${c.id}`;
    await S.refreshCounts(db, i.id, a);
    await S.activity(db, a, i.id, "comment_deleted");
    return changed(db, i);
  });
  command("removeAttachment", "issues.write", async (db, b, a) => {
    const [f] =
      await db`select * from issue_attachments where id=${S.uuid(b.attachmentId)}`;
    if (!f) throw new ApiError("not_found", 404, "Attachment not found");
    const { issue: i } = await S.ownComment(db, f.comment_id, a, true);
    await db`delete from issue_attachments where id=${f.id}`;
    await S.refreshCounts(db, i.id, a);
    await S.activity(db, a, i.id, "attachment_removed", { note: f.file_name });
    return changed(db, i);
  });
  installUploads(router);
}
