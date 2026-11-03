import { forbidden, notFound } from "../../core/errors.js";
import * as M from "./model.js";
import { saveMentions } from "./tokens.js";
import { saveLinks } from "./previews.js";
import { takeOrThrow } from "../../core/rate.js";
/** Edits re-run mention/link fan-out, so they share the send budget's shape. */
const EDIT_RATE = { limit: 30, windowMs: 60000 };
/** Search hits with their conversation, hydrating each conversation once per page.
 * @param {any} db @param {any} actor @param {any[]} rows */
export async function searchItems(db, actor, rows) {
  /** @type {Map<string, Promise<{id:string,title:string,kind:string}>>} */
  const conversations = new Map();
  /** @param {string} id */
  const conversation = (id) => {
    let p = conversations.get(id);
    if (!p) {
      p = (async () => {
        const conv = await M.member(db, actor, id),
          view = await M.renderConversation(db, actor, conv);
        return { id: conv.id, title: view.title, kind: conv.kind };
      })();
      conversations.set(id, p);
    }
    return p;
  };
  return Promise.all(
    rows.map(async (/** @type {any} */ r) => ({
      ...(await M.renderMessage(db, actor, r)),
      conversation: await conversation(r.conversation_id),
    })),
  );
}
/** @param {any} v @param {any} a */
function manage(v, a) {
  if (
    v.member_role !== "owner" &&
    v.kind !== "group" &&
    !a.capabilities.has("messaging.admin")
  )
    throw forbidden();
}
/** @param {any} value */
function emoji(value) {
  M.text(value, 32);
  if (
    [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)]
      .length !== 1 ||
    !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value)
  )
    throw M.invalid("Choose one emoji");
  return value;
}
/** @param {import('../../core/router.js').Router} router */
export function installActions(router) {
  /** @param {string} method @param {string} path @param {(c:any)=>Promise<any>} fn */
  const route = (method, path, fn) =>
    router.add(method, `/api/v1/messaging${path}`, async (c) => {
      await M.gate(c);
      return fn(c);
    });
  route("POST", "/conversations/:id/members", async (c) => {
    const ids = c.body?.user_ids;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 50 ||
      new Set(ids).size !== ids.length
    )
      throw M.invalid("Choose at most 50 users");
    await M.write(c.db, async (db) => {
      const v = await M.member(db, c.actor, c.params.id);
      manage(v, c.actor);
      if (v.kind === "dm" || v.archived_at)
        throw M.invalid("Cannot add members here");
      await M.validUsers(db, ids);
      const [count] =
        await db`select count(*)::int as n from chat_members where conversation_id=${v.id} and left_at is null and not(user_id=any(${db.array(ids, "UUID")}))`;
      if (v.kind === "group" && count.n + ids.length > 50)
        throw M.invalid("A group has at most 50 members");
      for (const id of ids) {
        const rows =
          await db`insert into chat_members(conversation_id,user_id) values(${v.id},${id}) on conflict(conversation_id,user_id) do update set left_at=null,joined_at=now()
      where chat_members.left_at is not null returning user_id`;
        if (rows.length) await M.event(db, "member.added", v.id);
      }
      await db`update chat_conversations set updated_at=clock_timestamp() where id=${v.id}`;
    });
    await M.changed(c, c.params.id);
    return M.renderConversation(
      c.db,
      c.actor,
      await M.member(c.db, c.actor, c.params.id),
      true,
    );
  });
  route("DELETE", "/conversations/:id/members/:user_id", async (c) => {
    M.uuid(c.params.user_id);
    await M.write(c.db, async (db) => {
      const v = await M.member(db, c.actor, c.params.id);
      if (
        c.params.user_id !== c.actor.userId &&
        v.member_role !== "owner" &&
        !c.actor.capabilities.has("messaging.admin")
      )
        throw forbidden();
      const [target] =
        await db`select * from chat_members where conversation_id=${v.id} and user_id=${c.params.user_id} and left_at is null`;
      if (!target) throw notFound();
      if (target.role === "owner") {
        const [other] =
          await db`select user_id from chat_members where conversation_id=${v.id} and user_id<>${target.user_id} and left_at is null order by (role='owner') desc,joined_at,user_id limit 1`;
        if (other)
          await db`update chat_members set role='owner' where conversation_id=${v.id} and user_id=${other.user_id}`;
      }
      await db`update chat_members set left_at=now() where conversation_id=${v.id} and user_id=${target.user_id}`;
      await db`update chat_conversations set updated_at=clock_timestamp() where id=${v.id}`;
    });
    await M.changed(c, c.params.id, [c.params.user_id]);
    return { ok: true };
  });
  route("GET", "/channels/browse", async (c) => {
    const q = (c.url.searchParams.get("q") ?? "").slice(0, 200);
    const rows =
      await c.db`select v.*,(select count(*)::int from chat_members m where m.conversation_id=v.id and m.left_at is null) as member_count from chat_conversations v where v.kind='channel' and not v.is_private and v.archived_at is null
   and strpos(lower(coalesce(v.title,'')),lower(${q}))>0 and not exists(select 1 from chat_members m where m.conversation_id=v.id and m.user_id=${c.actor.userId} and m.left_at is null)
   order by v.title,v.id limit 100`;
    // Discovery exposes only public-channel metadata, never member/message content.
    return rows.map((/** @type {any} */ v) => ({
      id: v.id,
      kind: v.kind,
      title: v.title,
      topic: v.topic,
      is_private: false,
      members_preview: [],
      member_count: v.member_count,
      unread_count: 0,
      mention_count: 0,
      last_message: null,
      muted: false,
      updated_at: M.iso(v.updated_at),
    }));
  });
  route("POST", "/conversations/:id/join", async (c) => {
    M.uuid(c.params.id);
    await M.write(c.db, async (db) => {
      const [v] =
        await db`select * from chat_conversations where id=${c.params.id} and kind='channel' and not is_private and archived_at is null`;
      if (!v) throw notFound();
      const rows =
        await db`insert into chat_members(conversation_id,user_id,last_read_seq) values(${v.id},${c.actor.userId},${v.last_seq}) on conflict(conversation_id,user_id) do update
     set left_at=null,joined_at=now(),last_read_seq=greatest(chat_members.last_read_seq,excluded.last_read_seq) where chat_members.left_at is not null returning user_id`;
      if (rows.length) await M.event(db, "member.added", v.id);
    });
    await M.changed(c, c.params.id);
    return M.renderConversation(
      c.db,
      c.actor,
      await M.member(c.db, c.actor, c.params.id),
      true,
    );
  });
  route("POST", "/conversations/:id/archive", async (c) => {
    M.uuid(c.params.id);
    await M.write(c.db, async (db) => {
      if (!c.actor.capabilities.has("messaging.admin")) {
        const v = await M.member(db, c.actor, c.params.id);
        if (v.member_role !== "owner") throw forbidden();
      }
      const rows =
        await db`update chat_conversations set archived_at=coalesce(archived_at,now()) where id=${c.params.id} and kind='channel' returning id`;
      if (!rows.length) throw notFound();
    });
    await M.changed(c, c.params.id);
    return { ok: true };
  });
  for (const method of ["PATCH", "DELETE"])
    route(method, "/messages/:id", async (c) => {
      // Spend the edit budget before taking the chat write lock, so a flood of edits is
      // refused without queueing behind (or in front of) other conversations' writes.
      if (method === "PATCH")
        await takeOrThrow(c.db, `messaging.edit:${c.actor.userId}`, EDIT_RATE);
      const row = await M.write(c.db, async (db) => {
        // Moderation is the contract's explicit write-only admin exception.
        // GET, PATCH, search, attachments and subscriptions still require membership.
        const m =
          method === "DELETE" && c.actor.capabilities.has("messaging.admin")
            ? (
                await db`select * from chat_messages where id=${M.uuid(c.params.id)}`
              )[0]
            : await M.messageAccess(db, c.actor, c.params.id);
        if (!m) throw notFound();
        if (
          m.author_user_id !== c.actor.userId &&
          (method === "PATCH" || !c.actor.capabilities.has("messaging.admin"))
        )
          throw forbidden();
        if (m.deleted_at) {
          if (method === "PATCH") throw M.invalid("Message is deleted");
          return m;
        }
        let r;
        if (method === "PATCH") {
          M.text(c.body?.body, 4000, true);
          if (
            !c.body.body.trim() &&
            !(
              await db`select id from chat_attachments where message_id=${m.id} and role='file'`
            ).length
          )
            throw M.invalid("Message cannot be empty");
          [r] =
            await db`update chat_messages set body=${c.body.body},edited_at=now() where id=${m.id} returning *`;
          await saveMentions(db, r);
          await saveLinks(db, r);
        } else {
          [r] =
            await db`update chat_messages set body='',deleted_at=now() where id=${m.id} returning *`;
          await db`delete from chat_mentions where message_id=${m.id}`;
          await db`delete from chat_message_links where message_id=${m.id}`;
          await db`delete from chat_reactions where message_id=${m.id}`;
          if (m.parent_message_id)
            await db`update chat_messages set reply_count=greatest(reply_count-1,0),last_reply_at=(select max(created_at) from chat_messages where parent_message_id=${m.parent_message_id} and deleted_at is null) where id=${m.parent_message_id}`;
        }
        await db`update chat_conversations set updated_at=clock_timestamp() where id=${m.conversation_id}`;
        await M.event(
          db,
          method === "PATCH" ? "message.edited" : "message.deleted",
          m.conversation_id,
          m.id,
        );
        return r;
      });
      await M.changed(c, row.conversation_id);
      return M.renderMessage(c.db, c.actor, row);
    });
  for (const method of ["POST", "DELETE"])
    route(
      method,
      `/messages/:id/reactions${method === "DELETE" ? "/" + ":emoji" : ""}`,
      async (c) => {
        const reaction = emoji(
          method === "POST" ? c.body?.emoji : c.params.emoji,
        );
        const m = await M.write(c.db, async (db) => {
          const m = await M.messageAccess(db, c.actor, c.params.id);
          if (m.deleted_at) throw M.invalid("Message is deleted");
          if (method === "POST")
            await db`insert into chat_reactions(message_id,user_id,emoji) values(${m.id},${c.actor.userId},${reaction}) on conflict do nothing`;
          else
            await db`delete from chat_reactions where message_id=${m.id} and user_id=${c.actor.userId} and emoji=${reaction}`;
          return m;
        });
        await M.changed(c, m.conversation_id);
        return M.renderMessage(c.db, c.actor, m);
      },
    );
  route("GET", "/search", async (c) => {
    const q = c.url.searchParams.get("q") ?? "";
    M.text(q, 200, true);
    const cur = M.pageCursor(c.url.searchParams.get("cursor"));
    const rows =
      await c.db`select m.* from chat_messages m join chat_members cm on cm.conversation_id=m.conversation_id
   where cm.user_id=${c.actor.userId} and cm.left_at is null and m.deleted_at is null and m.search_vector@@websearch_to_tsquery('simple',${q})
   and (${cur?.at ?? null}::timestamptz is null or (m.created_at,m.id)<(${cur?.at ?? null}::timestamptz,${cur?.id ?? null}::uuid)) order by m.created_at desc,m.id desc limit 51`;
    const page = rows.slice(0, 50),
      last = page.at(-1);
    const items = await searchItems(c.db, c.actor, page);
    return {
      items,
      next_cursor:
        rows.length > 50
          ? M.cursor({ at: M.iso(last.created_at), id: last.id })
          : null,
    };
  });
}
