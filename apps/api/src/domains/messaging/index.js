import { notFound, forbidden } from "../../core/errors.js";
import { registerTopic } from "../../core/hooks.js";
import { reply } from "../../core/router.js";
import * as M from "./model.js";
import { saveMentions } from "./tokens.js";
import { installDirectory } from "./directory.js";
import { installAttachments, bindAttachments } from "./attachments.js";
import { installPreviews, saveLinks } from "./previews.js";
import { installActions } from "./actions.js";
import { installAgents } from "./agents.js";
import { takeOrThrow } from "../../core/rate.js";

/** @param {import('../../core/router.js').Router} router @param {any} platform */
export function install(router, platform) {
  installDirectory(router);
  installActions(router);
  installAgents(router);
  installAttachments(router);
  installPreviews(platform, platform.messagingPreviewIO);
  for (const family of ["user", "conv"])
    registerTopic(`messaging.${family}`, async (a, t) => {
      if (!a.capabilities.has("messaging.use")) return false;
      try {
        await M.gate({ db: platform.db, actor: a });
        const id = t.slice(t.indexOf(":") + 1);
        M.uuid(id);
        if (family === "user") return id === a.userId;
        await M.member(platform.db, a, id);
        return true;
      } catch {
        return false;
      }
    });
  /** @param {string} method @param {string} path @param {(c:any)=>Promise<any>} fn */
  function route(method, path, fn) {
    router.add(method, `/api/v1/messaging${path}`, async (c) => {
      await M.gate(c);
      if (
        !["GET", "DELETE"].includes(method) &&
        (!c.body || typeof c.body !== "object" || Array.isArray(c.body))
      )
        throw M.invalid("JSON object required");
      return fn(c);
    });
  }
  route("GET", "/conversations", async (c) => {
    const cur = M.pageCursor(c.url.searchParams.get("cursor"));
    const rows =
      await c.db`select v.*,m.muted from chat_conversations v join chat_members m on m.conversation_id=v.id
      where m.user_id=${c.actor.userId} and m.left_at is null
      and (${cur?.at ?? null}::timestamptz is null or (v.updated_at,v.id)<(${cur?.at ?? null}::timestamptz,${cur?.id ?? null}::uuid))
      order by v.updated_at desc,v.id desc limit 51`;
    const page = rows.slice(0, 50),
      last = page.at(-1);
    return {
      items: await Promise.all(
        page.map((/** @type {any} */ v) =>
          M.renderConversation(c.db, c.actor, v),
        ),
      ),
      next_cursor:
        rows.length > 50
          ? M.cursor({ at: M.iso(last.updated_at), id: last.id })
          : null,
    };
  });
  route("POST", "/conversations", async (c) => {
    const b = c.body;
    if (!["dm", "group", "channel"].includes(b.kind))
      throw M.invalid("Invalid kind");
    if (
      b.is_private !== undefined &&
      (b.kind !== "channel" || typeof b.is_private !== "boolean")
    )
      throw M.invalid("Invalid privacy");
    if (b.title !== undefined) M.text(b.title, 200);
    if (b.topic !== undefined) M.text(b.topic, 1000, true);
    if (b.kind === "channel") M.text(b.title, 200);
    if (
      b.user_ids !== undefined &&
      (!Array.isArray(b.user_ids) || b.user_ids.length > 50)
    )
      throw M.invalid("Invalid members");
    if (b.kind === "channel" && b.user_ids !== undefined)
      throw M.invalid("Add channel members after creating it");
    if (b.kind !== "channel" && !Array.isArray(b.user_ids))
      throw M.invalid("Choose members");
    const ids = [...new Set([c.actor.userId, ...(b.user_ids ?? [])])];
    if (
      (b.kind === "dm" && (ids.length !== 2 || b.user_ids.length !== 1)) ||
      (b.kind === "group" && (ids.length < 3 || ids.length > 50))
    )
      throw M.invalid("Invalid member count");
    const id = await M.write(c.db, async (db) => {
      const users = await M.validUsers(db, ids);
      const key = b.kind === "dm" ? [...users].sort().join(":") : null;
      const [v] =
        await db`insert into chat_conversations(kind,title,topic,is_private,dm_key,created_by)
        values(${b.kind},${b.title ?? null},${b.topic ?? null},${b.is_private ?? false},${key},${c.actor.userId})
        on conflict(dm_key) do update set dm_key=excluded.dm_key returning *`;
      for (const user of users) {
        const added =
          await db`insert into chat_members(conversation_id,user_id,role) values(${v.id},${user},${user === c.actor.userId ? "owner" : "member"})
          on conflict(conversation_id,user_id) do update set left_at=null,joined_at=now()
          where chat_members.left_at is not null returning user_id`;
        if (added.length) await M.event(db, "member.added", v.id);
      }
      return v.id;
    });
    await M.changed(c, id);
    return M.renderConversation(
      c.db,
      c.actor,
      await M.member(c.db, c.actor, id),
    );
  });
  route("GET", "/conversations/:id", async (c) =>
    M.renderConversation(
      c.db,
      c.actor,
      await M.member(c.db, c.actor, c.params.id),
      true,
    ),
  );
  route("PATCH", "/conversations/:id", async (c) => {
    const b = c.body;
    if (b.title !== undefined) M.text(b.title, 200);
    if (b.topic !== undefined) M.text(b.topic, 1000, true);
    if (b.muted !== undefined && typeof b.muted !== "boolean")
      throw M.invalid("Invalid muted value");
    await M.write(c.db, async (db) => {
      const v = await M.member(db, c.actor, c.params.id);
      if (
        (b.title !== undefined || b.topic !== undefined) &&
        v.member_role !== "owner" &&
        v.kind !== "group"
      )
        throw forbidden();
      await db`update chat_conversations set title=coalesce(${b.title ?? null},title),topic=coalesce(${b.topic ?? null},topic) where id=${v.id}`;
      if (b.muted !== undefined)
        await db`update chat_members set muted=${b.muted} where conversation_id=${v.id} and user_id=${c.actor.userId}`;
    });
    await M.changed(c, c.params.id);
    return M.renderConversation(
      c.db,
      c.actor,
      await M.member(c.db, c.actor, c.params.id),
    );
  });
  route("GET", "/conversations/:id/messages", async (c) => {
    await M.member(c.db, c.actor, c.params.id);
    const p = c.url.searchParams,
      limit = M.integer(p.get("limit"), 50, 100);
    if (limit < 1) throw M.invalid("Invalid limit");
    const before = M.integer(
        p.get("before_seq"),
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      ),
      after = M.integer(p.get("after_seq"), 0, Number.MAX_SAFE_INTEGER),
      thread = p.get("thread");
    if (thread !== null) {
      const parent = await M.messageAccess(c.db, c.actor, thread);
      if (parent.conversation_id !== c.params.id || parent.parent_message_id)
        throw notFound();
    }
    const rows =
      await c.db`select * from chat_messages where conversation_id=${c.params.id} and seq<${before} and seq>${after}
      and parent_message_id is not distinct from ${thread}::uuid order by
      case when ${p.has("after_seq")} then seq end asc,seq desc limit ${limit + 1}`;
    return {
      items: await Promise.all(
        rows
          .slice(0, limit)
          .sort(
            (/** @type {any} */ a, /** @type {any} */ b) =>
              Number(a.seq) - Number(b.seq),
          )
          .map((/** @type {any} */ r) => M.renderMessage(c.db, c.actor, r)),
      ),
      has_more: rows.length > limit,
    };
  });
  route("POST", "/conversations/:id/messages", async (c) => {
    const b = c.body;
    M.text(b.client_msg_id, 200);
    M.text(b.body, 4000, true);
    if (
      b.attachment_ids !== undefined &&
      (!Array.isArray(b.attachment_ids) || b.attachment_ids.length > 10)
    )
      throw M.invalid("At most ten attachments");
    const result = await M.write(c.db, async (db) => {
      const v = await M.member(db, c.actor, c.params.id);
      const [prior] =
        await db`select * from chat_messages where author_user_id=${c.actor.userId} and client_msg_id=${b.client_msg_id}`;
      if (prior) {
        if (prior.conversation_id !== v.id) throw notFound();
        return { row: prior, replay: true };
      }
      if (v.archived_at) throw M.invalid("Conversation is archived");
      await takeOrThrow(db, `messaging.send:${c.actor.userId}`, {
        limit: 30,
        windowMs: 60000,
      });
      if (!b.body.trim() && !b.attachment_ids?.length)
        throw M.invalid("Message cannot be empty");
      let parent = null;
      if (b.parent_message_id) {
        parent = await M.messageAccess(db, c.actor, b.parent_message_id);
        if (
          parent.conversation_id !== v.id ||
          parent.parent_message_id ||
          parent.deleted_at
        )
          throw M.invalid("Choose a top-level message in this conversation");
      }
      const [seq] =
        await db`update chat_conversations set last_seq=last_seq+1 where id=${v.id} returning last_seq`;
      const [row] =
        await db`insert into chat_messages(conversation_id,seq,author_user_id,body,client_msg_id,parent_message_id)
        values(${v.id},${seq.last_seq},${c.actor.userId},${b.body},${b.client_msg_id},${parent?.id ?? null}) returning *`;
      await saveMentions(db, row);
      await saveLinks(db, row);
      await bindAttachments(db, row, b.attachment_ids ?? []);
      if (parent)
        await db`update chat_messages set reply_count=reply_count+1,last_reply_at=${row.created_at} where id=${parent.id}`;
      await M.event(db, "message.created", v.id, row.id);
      return { row, replay: false };
    });
    await M.changed(c, c.params.id);
    return reply(
      result.replay ? 200 : 201,
      await M.renderMessage(c.db, c.actor, result.row),
    );
  });
  route("POST", "/conversations/:id/read", async (c) => {
    const seq = M.integer(c.body.seq, -1, Number.MAX_SAFE_INTEGER);
    if (seq < 0) throw M.invalid("Invalid sequence");
    await M.write(c.db, async (db) => {
      const v = await M.member(db, c.actor, c.params.id);
      await db`update chat_members set last_read_seq=greatest(last_read_seq,least(${seq},${v.last_seq})) where conversation_id=${v.id} and user_id=${c.actor.userId}`;
    });
    await M.changed(c, c.params.id);
    return { ok: true };
  });
  route("GET", "/unread", async (c) => {
    const conversations = await M.unreadCounts(c.db, c.actor.userId);
    const self = await M.userLite(c.db, c.actor.userId);
    return {
      // The canonical chat identity of the caller (`users.id`), for clients.
      me: { id: self.id, display_name: self.display_name },
      total: conversations.reduce(
        (/** @type {number} */ n, /** @type {any} */ r) => n + r.unread_count,
        0,
      ),
      mentions: conversations.reduce(
        (/** @type {number} */ n, /** @type {any} */ r) => n + r.mention_count,
        0,
      ),
      conversations,
    };
  });
}
