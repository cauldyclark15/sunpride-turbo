import { ApiError, invalid, forbidden } from "../../core/errors.js";
import { roleHas } from "../../core/capabilities.js";
import { isUuid } from "../../core/util.js";
import * as C from "./constants.js";

/** @typedef {import('@sunpride/db/client').Db} Db */
/** @typedef {import('../../core/context.js').Actor & {label?:string}} Actor */
/** @param {unknown} value @param {string} label */
export function uuid(value, label = "id") {
  if (!isUuid(value)) throw invalid(`Invalid ${label}`);
  return /** @type {string} */ (value);
}
/** @param {unknown} value @param {number} [max] @returns {string|null} */
export function text(value, max = C.MAX_TEXT_LENGTH) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalid("Text must be a string");
  const result = value.trim();
  if (result.length > max)
    throw invalid(`Text must be ${max} characters or fewer`);
  return result || null;
}
/** @param {unknown} value */
function title(value) {
  const result = text(
    typeof value === "string" ? value.replace(/\s+/g, " ") : value,
    C.MAX_TITLE_LENGTH,
  );
  if (!result) throw invalid("Title is required");
  return result;
}
/** @param {unknown} value */
function area(value) {
  const s = text(value, C.MAX_SHORT_LENGTH);
  if (!s) return C.DEFAULT_ISSUE_AREA;
  const found = C.ISSUE_AREAS.find((a) => a.toLowerCase() === s.toLowerCase());
  if (!found) throw invalid(`Unknown area: ${s}`);
  return found;
}
/** @param {unknown} value @param {readonly string[]} allowed @param {string} label */
export function enumValue(value, allowed, label) {
  if (typeof value !== "string" || !allowed.includes(value))
    throw invalid(`Invalid ${label}`);
  return value;
}
/** @param {Actor} actor */
export const videoLimit = (actor) =>
  actor.role === "super_admin"
    ? C.SUPERADMIN_VIDEO_UPLOAD_BYTES
    : C.DEFAULT_VIDEO_UPLOAD_BYTES;
/** @param {Db} db @param {Actor} actor @param {string} id @param {string} kind @param {any} [extra] */
export async function activity(db, actor, id, kind, extra = {}) {
  await db`insert into issue_activity (issue_id, actor_id, actor_label, kind, from_status, to_status, changes, note)
    values (${id}, ${actor.profileId}, ${actor.label ?? null}, ${kind}, ${extra.fromStatus ?? null}, ${extra.toStatus ?? null}, ${extra.changes ?? null}, ${extra.note ?? null})`;
}
/** @param {Db} db @param {unknown} ref @param {boolean} [active] */
export async function findIssue(db, ref, active = true) {
  let rows;
  if (isUuid(ref)) rows = await db`select * from issues where id = ${ref}`;
  else {
    if (typeof ref !== "string" && typeof ref !== "number")
      throw invalid("Issue number required");
    const n = C.parseIssueKey(ref);
    if (n === undefined) throw invalid(`Not an issue number: ${ref}`);
    rows = await db`select * from issues where number = ${n}`;
  }
  if (!rows[0] || (active && rows[0].archived))
    throw new ApiError("not_found", 404, "Active issue not found");
  return rows[0];
}
/** Field staff may read/discuss only feedback they reported; office access is unchanged.
 * @param {any} issue @param {Actor} actor */
export function requireIssueAccess(issue, actor) {
  if (actor.role === "sales" && issue.reporter_id !== actor.profileId)
    throw new ApiError("not_found", 404, "Issue not found");
}
/** @param {Db} db @param {string} status */
async function bottom(db, status) {
  const [r] =
    await db`select coalesce(max(sort_order),0) + ${C.SPARSE_RANK_GAP} as rank from issues where not archived and status = ${status}`;
  return Number(r.rank);
}
/** @param {Db} db @param {unknown} id */
async function assignee(db, id) {
  if (id == null) return null;
  const [p] =
    await db`select id, role, status from profiles where id = ${uuid(id, "assignee")}`;
  if (!p || p.status !== "active" || !roleHas(p.role, "issues.triage"))
    throw invalid("Assignee must be an active person with issue access");
  return p.id;
}
/** @param {Db} db @param {any} input */
export async function resolveAssignee(db, input) {
  if (input.assigneeEmail === undefined) return input;
  if (input.assigneeEmail === null) return { ...input, assigneeId: null };
  const email = text(input.assigneeEmail, 254)?.toLowerCase();
  const [p] = await db`select id from profiles where lower(email) = ${email}`;
  if (!p) throw invalid(`No profile for ${email}`);
  return { ...input, assigneeId: p.id };
}
/** @param {any} i */
function searchText(i) {
  return [
    C.formatIssueKey(i.number),
    i.number,
    i.title,
    i.description,
    i.steps,
    i.actual,
    i.expected,
    i.externalRef,
    i.milestone,
  ]
    .filter((v) => v != null)
    .join(" ")
    .toLowerCase();
}
/** @param {Db} db @param {any} input @param {Actor} actor */
export async function createIssue(db, input, actor) {
  input = await resolveAssignee(db, input);
  if (
    (input.assigneeId || (input.status && input.status !== "draft")) &&
    !roleHas(actor.role, "issues.triage")
  )
    throw forbidden("Only issue triagers can assign or move an issue");
  const ref = text(input.externalRef, C.MAX_SHORT_LENGTH);
  if (ref) {
    const [existing] =
      await db`select id,number,reporter_id from issues where external_ref = ${ref}`;
    if (existing) {
      requireIssueAccess(existing, actor);
      return {
        issueId: existing.id,
        number: existing.number,
        key: C.formatIssueKey(existing.number),
        created: false,
        externalRef: ref,
      };
    }
  }
  const fields = {
    title: title(input.title),
    description: text(input.description),
    steps: text(input.steps),
    actual: text(input.actual),
    expected: text(input.expected),
    externalRef: ref,
    milestone: text(input.milestone, C.MAX_SHORT_LENGTH),
  };
  const status = enumValue(input.status ?? "draft", C.ISSUE_STATUSES, "status");
  const priority = enumValue(
    input.priority ?? "medium",
    C.ISSUE_PRIORITIES,
    "priority",
  );
  const a = area(input.area);
  const aid = await assignee(db, input.assigneeId);
  // The caller holds the board advisory lock, including first creation and seed.
  const [counter] = await db`insert into issue_counters (key,last_number)
    values ('issueNumber', (select coalesce(max(number),0)+1 from issues))
    on conflict (key) do update set last_number = greatest(issue_counters.last_number,(select coalesce(max(number),0) from issues))+1
    returning last_number`;
  const number = Number(counter.last_number);
  const rank = await bottom(db, status);
  const [issue] =
    await db`insert into issues (number,title,description,steps,actual,expected,area,priority,status,sort_order,assignee_id,reporter_id,reporter_label,external_ref,milestone,archived,search_text,comment_count,attachment_count,updated_by)
    values (${number},${fields.title},${fields.description},${fields.steps},${fields.actual},${fields.expected},${a},${priority},${status},${rank},${aid},${actor.profileId},${actor.label ?? null},${ref},${fields.milestone},false,${searchText({ ...fields, number })},0,0,${actor.profileId}) returning *`;
  await activity(db, actor, issue.id, "created", {
    note: C.formatIssueKey(number),
  });
  if (input.uploads?.length)
    await addComment(
      db,
      {
        issueId: issue.id,
        body: "Attachments added when the issue was created.",
        uploads: input.uploads,
      },
      actor,
    );
  return {
    issueId: issue.id,
    number,
    key: C.formatIssueKey(number),
    created: true,
    externalRef: ref,
  };
}
/** @param {Db} db @param {any} issue @param {any} input @param {Actor} actor */
export async function updateIssue(db, issue, input, actor) {
  input = await resolveAssignee(db, input);
  const next = {
    title: input.title === undefined ? issue.title : title(input.title),
    area: input.area === undefined ? issue.area : area(input.area),
    priority:
      input.priority === undefined
        ? issue.priority
        : enumValue(input.priority, C.ISSUE_PRIORITIES, "priority"),
    assigneeId:
      input.assigneeId === undefined
        ? issue.assignee_id
        : await assignee(db, input.assigneeId),
    description:
      input.description === undefined
        ? issue.description
        : text(input.description),
    steps: input.steps === undefined ? issue.steps : text(input.steps),
    actual: input.actual === undefined ? issue.actual : text(input.actual),
    expected:
      input.expected === undefined ? issue.expected : text(input.expected),
    externalRef:
      input.externalRef === undefined
        ? issue.external_ref
        : text(input.externalRef, C.MAX_SHORT_LENGTH),
    milestone:
      input.milestone === undefined
        ? issue.milestone
        : text(input.milestone, C.MAX_SHORT_LENGTH),
  };
  /** @type {Array<{field:string,from:string|null,to:string|null}>} */
  const changes = [];
  for (const [field, value] of Object.entries(next)) {
    const column = field.replace(/[A-Z]/g, (v) => `_${v.toLowerCase()}`);
    if (issue[column] === value) continue;
    if (field === "assigneeId") {
      const name = async (/** @type {string|null} */ id) =>
        id
          ? ((await db`select name from profiles where id = ${id}`)[0]?.name ??
            "Former user")
          : null;
      changes.push({
        field: "assignee",
        from: await name(issue.assignee_id),
        to: await name(value),
      });
    } else changes.push({ field, from: issue[column] ?? null, to: value });
  }
  if (!changes.length) return { changed: false };
  if (
    next.externalRef &&
    (
      await db`select id from issues where external_ref=${next.externalRef} and id<>${issue.id}`
    ).length
  )
    throw new ApiError(
      "conflict",
      409,
      "That external reference already belongs to another issue",
    );
  await db`update issues set title=${next.title},description=${next.description},steps=${next.steps},actual=${next.actual},expected=${next.expected},area=${next.area},priority=${next.priority},assignee_id=${next.assigneeId},external_ref=${next.externalRef},milestone=${next.milestone},search_text=${searchText({ ...next, number: issue.number })},updated_by=${actor.profileId} where id=${issue.id}`;
  await activity(db, actor, issue.id, "updated", { changes });
  return { changed: true };
}
/** @param {Db} db @param {any} issue @param {any} input @param {Actor} actor */
export async function moveIssue(db, issue, input, actor) {
  const status = enumValue(input.status, C.ISSUE_STATUSES, "status");
  for (const id of [input.beforeId, input.afterId])
    if (id !== undefined) uuid(id, "anchor");
  if (input.beforeId === issue.id || input.afterId === issue.id)
    throw invalid("An issue cannot anchor itself");
  if (status === issue.status && !input.beforeId && !input.afterId)
    return { changed: false };
  let rank;
  if (!input.beforeId && !input.afterId) rank = await bottom(db, status);
  else {
    const cards =
      await db`select id,sort_order from issues where not archived and status=${status} and id<>${issue.id} order by sort_order,number limit 2001`;
    if (cards.length > 2000)
      throw invalid("This column is too large to reorder");
    const lo = input.beforeId
      ? cards.findIndex((/** @type {any} */ c) => c.id === input.beforeId)
      : -1;
    const hi = input.afterId
      ? cards.findIndex((/** @type {any} */ c) => c.id === input.afterId)
      : cards.length;
    if (
      (input.beforeId && lo < 0) ||
      (input.afterId && hi === -1) ||
      hi !== lo + 1
    )
      throw new ApiError(
        "conflict",
        409,
        "Cards changed. Refresh and try again.",
      );
    let lower = lo >= 0 ? cards[lo].sort_order : null;
    let upper = hi < cards.length ? cards[hi].sort_order : null;
    if (lower !== null && upper !== null && upper - lower <= 1) {
      for (let n = 0; n < cards.length; n++)
        await db`update issues set sort_order=${(n + 1) * C.SPARSE_RANK_GAP} where id=${cards[n].id}`;
      lower = (lo + 1) * C.SPARSE_RANK_GAP;
      upper = (hi + 1) * C.SPARSE_RANK_GAP;
    }
    rank =
      lower === null
        ? (upper ?? C.SPARSE_RANK_GAP) - C.SPARSE_RANK_GAP
        : upper === null
          ? lower + C.SPARSE_RANK_GAP
          : Math.floor((lower + upper) / 2);
  }
  await db`update issues set status=${status},sort_order=${rank},updated_by=${actor.profileId} where id=${issue.id}`;
  if (status !== issue.status)
    await activity(db, actor, issue.id, "status_changed", {
      fromStatus: issue.status,
      toStatus: status,
    });
  return { changed: true };
}
/** @param {Db} db @param {any} input @param {Actor} actor */
export async function addComment(db, input, actor) {
  const issue = await findIssue(db, input.issueId ?? input.number);
  requireIssueAccess(issue, actor);
  const body = text(input.body) ?? "";
  if (input.uploads !== undefined && !Array.isArray(input.uploads))
    throw invalid("Invalid uploads");
  const uploads = input.uploads ?? [];
  if (uploads.length > C.MAX_ATTACHMENTS_PER_COMMENT)
    throw invalid("A comment can carry at most 5 attachments");
  /** @type {any[]} */ const files = [];
  const seen = new Set();
  for (const u of uploads) {
    const id = uuid(u?.storageId, "file");
    if (seen.has(id)) throw invalid("Duplicate attachment");
    seen.add(id);
    const fileName = text(u.fileName, 200);
    if (!fileName) throw invalid("Every attachment needs a file name");
    const [f] = await db`select * from files where id=${id} for update`;
    if (
      !f ||
      f.status !== "stored" ||
      f.purpose !== "issue-attachment" ||
      f.created_by !== actor.userId ||
      (f.owner_id && f.owner_id !== issue.id)
    )
      throw forbidden("Upload not found or not yours");
    const problem = C.validateAttachment({
      fileType: f.mime,
      fileSize: Number(f.size),
      maxVideoBytes: videoLimit(actor),
    });
    if (problem) throw invalid(problem);
    if (
      (await db`select id from issue_attachments where storage_id=${id}`).length
    )
      throw invalid("That file is already attached");
    files.push({ ...f, fileName });
  }
  if (!body && !files.length) throw invalid("Write a comment or attach a file");
  const [comment] =
    await db`insert into issue_comments (issue_id,author_id,author_label,body) values (${issue.id},${actor.profileId},${actor.label ?? null},${body}) returning id,created_at`;
  for (const f of files) {
    await db`insert into issue_attachments (issue_id,comment_id,storage_id,file_name,file_type,file_size,uploaded_by) values (${issue.id},${comment.id},${f.id},${f.fileName},${f.mime},${f.size},${actor.profileId})`;
    await db`update files set upload_token_hash=null,upload_expires_at=null where id=${f.id}`;
  }
  await db`update issues set comment_count=comment_count+1,attachment_count=attachment_count+${files.length},last_comment_at=${comment.created_at},last_comment_author_id=${actor.profileId},last_comment_author_label=${actor.label ?? null},updated_by=${actor.profileId} where id=${issue.id}`;
  await activity(db, actor, issue.id, "commented", {
    note: files.length ? `${files.length} attachment(s)` : null,
  });
  return {
    commentId: comment.id,
    issueId: issue.id,
    number: issue.number,
    key: C.formatIssueKey(issue.number),
  };
}
/** @param {Db} db @param {unknown} id @param {Actor} actor @param {boolean} moderate */
export async function ownComment(db, id, actor, moderate) {
  const [c] =
    await db`select * from issue_comments where id=${uuid(id, "comment")} and deleted_at is null`;
  if (!c) throw new ApiError("not_found", 404, "Comment not found");
  if (
    c.author_id !== actor.profileId &&
    !(moderate && roleHas(actor.role, "issues.manage"))
  )
    throw forbidden("Only the author can change this comment");
  const issue = await findIssue(db, c.issue_id);
  requireIssueAccess(issue, actor);
  return { comment: c, issue };
}
/** @param {Db} db @param {string} id @param {Actor} actor */
export async function refreshCounts(db, id, actor) {
  const [last] =
    await db`select * from issue_comments where issue_id=${id} and deleted_at is null order by created_at desc,id desc limit 1`;
  await db`update issues set comment_count=(select count(*) from issue_comments where issue_id=${id} and deleted_at is null),attachment_count=(select count(*) from issue_attachments where issue_id=${id}),last_comment_at=${last?.created_at ?? null},last_comment_author_id=${last?.author_id ?? null},last_comment_author_label=${last?.author_label ?? null},updated_by=${actor.profileId} where id=${id}`;
}
