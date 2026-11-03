import { resolveRefs } from "./refs/common.js";
import { attachments } from "./attachments.js";
import { links } from "./previews.js";
import {
  ApiError,
  forbidden,
  notFound,
  unauthenticated,
} from "../../core/errors.js";
import { isUuid } from "../../core/util.js";
import { partnerContext } from "../partners/boundary.js";

/** @param {string} message */
export const invalid = (message = "Invalid request") =>
  new ApiError("invalid", 422, message);
/** @param {any} value */
export function uuid(value) {
  if (!isUuid(value)) throw invalid("Invalid identifier");
  return value;
}
/** @param {any} value @param {number} max @param {boolean} [empty] */
export function text(value, max, empty = false) {
  if (
    typeof value !== "string" ||
    [...value].length > max ||
    (!empty && !value.trim())
  )
    throw invalid("Invalid text");
  return value;
}
/** @param {any} n @param {number} fallback @param {number} max */
export function integer(n, fallback, max) {
  if (n == null) return fallback;
  if (
    !/^\d+$/.test(String(n)) ||
    !Number.isSafeInteger(Number(n)) ||
    Number(n) > max
  )
    throw invalid("Invalid number");
  return Number(n);
}
/** @param {any} ctx @param {boolean} [admin] */
export async function gate(ctx, admin = false) {
  ctx.v2 = false;
  if (!ctx.actor) throw unauthenticated();
  if (
    !ctx.actor.capabilities.has(admin ? "messaging.admin" : "messaging.use") ||
    (await partnerContext(ctx.db, ctx.actor))
  )
    throw forbidden();
  return ctx.actor;
}
/** @param {any} db @param {any} actor @param {string} id */
export async function member(db, actor, id) {
  uuid(id);
  const [row] =
    await db`select c.*,m.role as member_role,m.last_read_seq,m.muted from chat_conversations c
    join chat_members m on m.conversation_id=c.id where c.id=${id} and m.user_id=${actor.userId} and m.left_at is null`;
  if (!row) throw notFound();
  return row;
}
/** @param {any} db @param {any} actor @param {string} id */
export async function messageAccess(db, actor, id) {
  uuid(id);
  const [row] =
    await db`select m.* from chat_messages m join chat_members cm on cm.conversation_id=m.conversation_id
    where m.id=${id} and cm.user_id=${actor.userId} and cm.left_at is null`;
  if (!row) throw notFound();
  return row;
}
/** @param {any} db @param {string} id */
export async function userLite(db, id) {
  const [row] =
    await db`select u.id,coalesce(a.display_name,p.name,'Former user') as display_name,
    (a.user_id is not null) as is_agent,a.avatar_blob_id from users u left join profiles p on p.user_id=u.id left join chat_agents a on a.user_id=u.id where u.id=${id}`;
  return {
    id: row.id,
    display_name: row.display_name,
    is_agent: row.is_agent,
    avatar_url: row.avatar_blob_id
      ? `/api/v1/messaging/refs/user/${id}/thumb`
      : null,
  };
}
/** @param {any} db @param {string[]} ids */
export async function validUsers(db, ids) {
  for (const id of ids) uuid(id);
  const rows =
    await db`select u.id from users u join profiles p on p.user_id=u.id left join chat_agents a on a.user_id=u.id
    where u.id=any(${db.array(ids, "UUID")}::uuid[]) and u.disabled_at is null and p.status='active' and p.deleted_at is null
    and p.role in ('super_admin','admin','operations','manager','approver','sales','analyst','viewer')
    and (a.user_id is null or a.disabled_at is null) and not exists(select 1 from distributor_users d where d.profile_id=p.id)`;
  if (rows.length !== ids.length) throw invalid("Choose active internal users");
  return rows.map((/** @type {any} */ row) => String(row.id));
}
/** @param {any} db @param {string} type @param {string} conv @param {string|null} [message] */
export async function event(db, type, conv, message = null) {
  await db`insert into chat_events(type,conversation_id,message_id) values(${type},${conv},${message})`;
}
/** Serialize chat mutations; event ids then reflect commit order (also across API processes).
 * @param {any} db @param {(db:any)=>Promise<any>} fn */
export const write = (db, fn) =>
  db.begin(async (/** @type {any} */ t) => {
    await t`select pg_advisory_xact_lock(hashtext('sunpride:messaging:write'))`;
    return fn(t);
  });
/** @param {any} ctx @param {string} id @param {string[]} [extra] */
export async function changed(ctx, id, extra = []) {
  await ctx.publish(`messaging.conv:${id}`);
  const rows =
    await ctx.db`select user_id from chat_members where conversation_id=${id} and left_at is null`;
  for (const user of new Set([
    ...rows.map((/** @type {any} */ r) => r.user_id),
    ...extra,
  ]))
    await ctx.publish(`messaging.user:${user}`);
}
/** @param {any} value */
export const iso = (value) =>
  value == null ? null : new Date(value).toISOString();
/** @param {any} value */
export const cursor = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
/** @param {string|null} value @returns {any} */
export function decode(value) {
  if (!value) return null;
  try {
    if (!/^[\w-]{1,1000}$/.test(value)) throw 0;
    return JSON.parse(Buffer.from(value, "base64url").toString());
  } catch {
    throw invalid("Invalid cursor");
  }
}
/** @param {string|null} value @returns {any} */
export function pageCursor(value) {
  const cur = decode(value);
  if (cur === null) return null;
  if (
    !cur ||
    typeof cur !== "object" ||
    typeof cur.at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cur.at) ||
    !Number.isFinite(Date.parse(cur.at)) ||
    new Date(cur.at).toISOString() !== cur.at
  )
    throw invalid("Invalid cursor");
  uuid(cur.id);
  return cur;
}
/** @param {any} db @param {any} actor @param {any} row */
export async function renderMessage(db, actor, row) {
  const mentions = row.deleted_at
    ? []
    : await db`select * from chat_mentions where message_id=${row.id} order by id`;
  const reactions = row.deleted_at
    ? []
    : await db`select emoji,count(*)::int as count,bool_or(user_id=${actor.userId}) as mine from chat_reactions where message_id=${row.id} group by emoji order by emoji`;
  const refs = await resolveRefs(
    db,
    actor,
    mentions
      .filter((/** @type {any} */ r) => r.kind === "object")
      .map((/** @type {any} */ r) => ({ type: r.ref_type, id: r.ref_id })),
  );
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    seq: Number(row.seq),
    author: await userLite(db, row.author_user_id),
    body: row.deleted_at ? "" : row.body,
    parent_message_id: row.parent_message_id,
    reply_count: row.reply_count,
    last_reply_at: iso(row.last_reply_at),
    attachments: row.deleted_at ? [] : await attachments(db, row.id),
    refs,
    mentions_me: mentions.some(
      (/** @type {any} */ r) => r.user_id === actor.userId,
    ),
    reactions,
    links: row.deleted_at ? [] : await links(db, row.id),
    edited: !!row.edited_at,
    deleted: !!row.deleted_at,
    created_at: iso(row.created_at),
  };
}
/** @param {any} db @param {any} actor @param {any} c @param {boolean} [detail] */
export async function renderConversation(db, actor, c, detail = false) {
  const rows =
    await db`select user_id,role,last_read_seq from chat_members where conversation_id=${c.id} and left_at is null order by joined_at,user_id`;
  const members = await Promise.all(
    rows.map(async (/** @type {any} */ r) => ({
      ...(await userLite(db, r.user_id)),
      role: r.role,
      last_read_seq: Number(r.last_read_seq),
    })),
  );
  const [last] =
    await db`select * from chat_messages where conversation_id=${c.id} order by seq desc limit 1`;
  const counts = await unreadCounts(db, actor.userId, c.id);
  const result = {
    id: c.id,
    kind: c.kind,
    title:
      c.title ??
      members
        .filter((/** @type {any} */ m) => m.id !== actor.userId)
        .map((/** @type {any} */ m) => m.display_name)
        .join(", "),
    topic: c.topic,
    is_private: c.is_private,
    members_preview: members
      .slice(0, 5)
      .map(({ role: _, last_read_seq: __, ...u }) => u),
    member_count: members.length,
    unread_count: counts[0]?.unread_count ?? 0,
    mention_count: counts[0]?.mention_count ?? 0,
    last_message: last ? await renderMessage(db, actor, last) : null,
    muted: c.muted ?? false,
    updated_at: iso(c.updated_at),
  };
  return detail ? { ...result, members } : result;
}
/** @param {any} db @param {string} user @param {string|null} [conv] */
export async function unreadCounts(db, user, conv = null) {
  const rows =
    await db`select cm.conversation_id as id,count(m.id)::integer as unread_count,
    count(m.id) filter(where exists(select 1 from chat_mentions x where x.message_id=m.id and x.user_id=${user}))::integer as mention_count
    from chat_members cm left join chat_messages m on m.conversation_id=cm.conversation_id and m.seq>cm.last_read_seq
      and m.author_user_id<>${user} and m.deleted_at is null
    where cm.user_id=${user} and cm.left_at is null and (${conv}::uuid is null or cm.conversation_id=${conv}) group by cm.conversation_id`;
  return rows;
}
