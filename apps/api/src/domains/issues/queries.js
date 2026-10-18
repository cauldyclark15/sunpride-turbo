import { invalid } from "../../core/errors.js";
import { roleHas } from "../../core/capabilities.js";
import * as C from "./constants.js";
import { enumValue, uuid } from "./service.js";
/** @typedef {import('@sunpride/db/client').Db} Db */
/** @param {any} v */
const ms = (v) => (v == null ? undefined : new Date(v).getTime());
/** @param {any} r */
export function issueDto(r) {
  return {
    _id: r.id,
    number: r.number,
    key: C.formatIssueKey(r.number),
    title: r.title,
    description: r.description ?? undefined,
    steps: r.steps ?? undefined,
    actual: r.actual ?? undefined,
    expected: r.expected ?? undefined,
    area: r.area,
    priority: r.priority,
    status: r.status,
    order: r.sort_order,
    assigneeId: r.assignee_id ?? undefined,
    reporterId: r.reporter_id ?? undefined,
    externalRef: r.external_ref ?? undefined,
    milestone: r.milestone ?? undefined,
    archived: r.archived,
    archivedAt: ms(r.archived_at),
    commentCount: r.comment_count,
    attachmentCount: r.attachment_count,
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
    lastCommentAt: ms(r.last_comment_at),
    backup: {
      summaryOnly: r.backup_summary_only,
      missingComments: r.backup_missing_comments,
      missingAttachments: r.backup_missing_attachments,
    },
  };
}
/** @param {Db} db @param {any} filters @param {boolean} [agent] */
export async function board(db, filters, agent = false) {
  const archived = filters.archived === true || filters.archived === "true";
  if (
    filters.archived !== undefined &&
    ![true, false, "true", "false"].includes(filters.archived)
  )
    throw invalid("Invalid archived filter");
  const attention =
    filters.attention == null
      ? null
      : enumValue(
          filters.attention,
          ["urgent", "unassigned", "retest"],
          "attention filter",
        );
  const status =
    filters.status == null
      ? null
      : enumValue(filters.status, C.ISSUE_STATUSES, "status");
  const priority =
    filters.priority == null
      ? null
      : enumValue(filters.priority, C.ISSUE_PRIORITIES, "priority");
  const assigneeId =
    filters.assigneeId == null || filters.assigneeId === "unassigned"
      ? (filters.assigneeId ?? null)
      : uuid(filters.assigneeId);
  const reporterId =
    filters.reporterId == null ? null : uuid(filters.reporterId);
  const search = String(filters.search ?? "")
    .trim()
    .toLowerCase();
  if (search.length > 200) throw invalid("Search is too long");
  // Filter BEFORE applying the display bound; counts cover every matching source row.
  const rows =
    await db`select i.*,coalesce(i.reporter_label,r.name,'Agent') as reporter_name,a.name as assignee_name,coalesce(i.last_comment_author_label,c.name,'Agent') as last_comment_author_name
    from issues i left join profiles r on r.id=i.reporter_id left join profiles a on a.id=i.assignee_id left join profiles c on c.id=i.last_comment_author_id
    where i.archived=${archived}
    and (${filters.area ?? null}::text is null or i.area=${filters.area ?? null})
    and (${priority}::text is null or i.priority=${priority})
    and (${filters.milestone ?? null}::text is null or i.milestone=${filters.milestone ?? null})
    and (${reporterId}::uuid is null or i.reporter_id=${reporterId})
    and (${assigneeId}::text is null or (${assigneeId}='unassigned' and i.assignee_id is null) or i.assignee_id::text=${assigneeId})
    and (${search}='' or position(${search} in i.search_text)>0)
    and (${attention}::text is null or (${attention}='urgent' and i.status<>'completed' and i.priority in ('high','critical')) or (${attention}='unassigned' and i.status<>'completed' and i.assignee_id is null) or (${attention}='retest' and i.status='for_retest'))
    order by i.updated_at desc,i.number desc`;
  /** @type {Record<string,number>} */ const counts = Object.fromEntries(
    C.ISSUE_STATUSES.map((s) => [s, 0]),
  );
  for (const r of rows) counts[r.status]++;
  let matching = rows.filter(
    (/** @type {any} */ r) => !status || r.status === status,
  );
  if (agent)
    matching.sort(
      (/** @type {any} */ a, /** @type {any} */ b) => a.number - b.number,
    );
  const limit = agent ? Number(filters.limit ?? 100) : C.ISSUE_BOARD_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw invalid("Limit must be between 1 and 500");
  const issues = matching.slice(0, limit).map((/** @type {any} */ r) => ({
    ...issueDto(r),
    reporterName: r.reporter_name,
    assigneeName: r.assignee_name ?? undefined,
    lastCommentAuthorName: r.last_comment_at
      ? r.last_comment_author_name
      : undefined,
  }));
  const open = rows.filter((/** @type {any} */ r) => r.status !== "completed");
  const history =
    await db`select a.kind,a.to_status,a.created_at from issue_activity a join issues i on i.id=a.issue_id where i.archived=${archived} and a.created_at >= now()-interval '14 days'
    and (${filters.area ?? null}::text is null or i.area=${filters.area ?? null})
    and (${priority}::text is null or i.priority=${priority})
    and (${filters.milestone ?? null}::text is null or i.milestone=${filters.milestone ?? null})
    and (${reporterId}::uuid is null or i.reporter_id=${reporterId})
    and (${assigneeId}::text is null or (${assigneeId}='unassigned' and i.assignee_id is null) or i.assignee_id::text=${assigneeId})
    and (${search}='' or position(${search} in i.search_text)>0)
    and (${attention}::text is null or (${attention}='urgent' and i.status<>'completed' and i.priority in ('high','critical')) or (${attention}='unassigned' and i.status<>'completed' and i.assignee_id is null) or (${attention}='retest' and i.status='for_retest'))`;
  const date = (/** @type {Date|number} */ value) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  const [installed] =
    await db`select applied_at from schema_migrations where name='0290_issues.sql'`;
  const historySince = installed
    ? new Date(installed.applied_at).getTime()
    : Date.now();
  const today = date(Date.now());
  const trend = Array.from({ length: 14 }, (_, n) => ({
    date: date(
      new Date(`${today}T00:00:00+08:00`).getTime() - (13 - n) * 86400000,
    ),
    opened: 0,
    completed: 0,
    known:
      date(
        new Date(`${today}T00:00:00+08:00`).getTime() - (13 - n) * 86400000,
      ) >= date(historySince),
  }));
  for (const h of history) {
    const day = trend.find((d) => d.date === date(h.created_at));
    if (!day) continue;
    if (h.kind === "created") day.opened++;
    if (h.kind === "status_changed" && h.to_status === "completed")
      day.completed++;
  }
  return {
    issues,
    counts,
    total: matching.length,
    truncated: matching.length > limit,
    milestones: [
      ...new Set(
        rows.flatMap((/** @type {any} */ r) =>
          r.milestone ? [r.milestone] : [],
        ),
      ),
    ].sort(),
    summary: {
      open: open.length,
      urgent: open.filter((/** @type {any} */ r) =>
        ["critical", "high"].includes(r.priority),
      ).length,
      unassigned: open.filter((/** @type {any} */ r) => !r.assignee_id).length,
      readyForRetest: counts.for_retest,
      completedThisWeek: trend.slice(7).reduce((s, d) => s + d.completed, 0),
      completedPriorWeek:
        new Date(`${trend[0].date}T00:00:00+08:00`).getTime() >= historySince
          ? trend.slice(0, 7).reduce((s, d) => s + d.completed, 0)
          : null,
    },
    trend,
    historySince,
    historyNote:
      "Activity recorded in v2 only; the restored backup has no historical activity.",
  };
}
/** @param {Db} db @param {any} issue @param {import('../../core/context.js').Actor} actor */
export async function detail(db, issue, actor) {
  const names =
    await db`select id,name from profiles where id in ${db([issue.reporter_id, issue.assignee_id].filter(Boolean).length ? [issue.reporter_id, issue.assignee_id].filter(Boolean) : ["00000000-0000-0000-0000-000000000000"])}`;
  const name = (
    /** @type {string} */ id,
    /** @type {string|null} */ label = null,
  ) =>
    label ??
    names.find((/** @type {any} */ p) => p.id === id)?.name ??
    "Former user";
  // Read complete conversation and activity, not silently truncated prefixes.
  const comments =
    await db`select c.*,coalesce(c.author_label,p.name,'Agent') as author_name from issue_comments c left join profiles p on p.id=c.author_id where c.issue_id=${issue.id} and c.deleted_at is null order by c.created_at,c.id`;
  const attachments =
    await db`select a.*,f.status from issue_attachments a join files f on f.id=a.storage_id where a.issue_id=${issue.id}`;
  const activity =
    await db`select a.*,coalesce(a.actor_label,p.name,'Agent') as actor_name from issue_activity a left join profiles p on p.id=a.actor_id where a.issue_id=${issue.id} order by a.created_at desc,a.id desc`;
  return {
    issue: issueDto(issue),
    key: C.formatIssueKey(issue.number),
    reporterName: name(issue.reporter_id, issue.reporter_label),
    assigneeName: issue.assignee_id ? name(issue.assignee_id) : undefined,
    comments: comments.map((/** @type {any} */ c) => ({
      _id: c.id,
      authorId: c.author_id ?? undefined,
      authorName: c.author_name,
      body: c.body,
      createdAt: ms(c.created_at),
      updatedAt:
        new Date(c.updated_at).getTime() > new Date(c.created_at).getTime()
          ? ms(c.updated_at)
          : undefined,
      canEdit: !issue.archived && c.author_id === actor.profileId,
      canDelete:
        !issue.archived &&
        (c.author_id === actor.profileId ||
          roleHas(actor.role, "issues.manage")),
      attachments: attachments
        .filter((/** @type {any} */ a) => a.comment_id === c.id)
        .map((/** @type {any} */ a) => ({
          _id: a.id,
          fileName: a.file_name,
          fileType: a.file_type,
          fileSize: Number(a.file_size),
          kind: C.attachmentKind(a.file_type) ?? "document",
          url:
            a.status === "stored"
              ? `/api/v1/issues/attachments/${a.id}/content`
              : null,
        })),
    })),
    activity: activity.map((/** @type {any} */ a) => ({
      _id: a.id,
      kind: a.kind,
      actorName: a.actor_name,
      fromStatus: a.from_status ?? undefined,
      toStatus: a.to_status ?? undefined,
      changes: a.changes ?? undefined,
      note: a.note ?? undefined,
      createdAt: ms(a.created_at),
    })),
  };
}
