import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatIssueKey } from "../../apps/api/src/domains/issues/constants.js";
import { findIssue } from "../../apps/api/src/domains/issues/service.js";

export const HERMES_EMAIL = "hermes@system.sunpride.local";
export const HERMES_NAME = "Hermes (dev team)";

/** @param {Record<string,string|undefined>} env */
async function teamEmails(env) {
  const emails = new Set([HERMES_EMAIL]);
  try {
    const file =
      env.TEAM_EMAILS_FILE ?? join(homedir(), ".sunpride-keys/team-emails.txt");
    for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
      const email = line.trim().toLowerCase();
      if (email) emails.add(email);
    }
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
  }
  return emails;
}

/** @param {any} row */
function summary(row) {
  return {
    key: formatIssueKey(row.number),
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    area: row.area,
    priority: row.priority,
    external_ref: row.external_ref,
    milestone: row.milestone,
    assignee_label: row.assignee_label ?? null,
    comment_count: row.comment_count,
    last_comment_at: row.last_comment_at,
    last_comment_author_label: row.last_comment_at
      ? (row.last_comment_author_label ??
        row.last_comment_author_name ??
        "Agent")
      : null,
    updated_at: row.updated_at,
    created_at: row.created_at,
  };
}

/** @param {any} row @param {Set<string>} team */
function comment(row, team) {
  return {
    id: row.id,
    author_label: row.author_name,
    author_email: row.author_email ?? null,
    author_is_team: team.has(String(row.author_email ?? "").toLowerCase()),
    body: row.body,
    created_at: row.created_at,
  };
}

/** The HTTP board DTO uses different names/order and a display cap; read the same
 * tables without imposing that UI-only cap on an automation export.
 * @param {import('../../packages/db/src/client.js').Db} db
 * @param {ReturnType<import('./args.js').parseCommand>} input
 * @param {Record<string,string|undefined>} env */
export async function readBoard(db, input, env) {
  // Bind a scalar: Bun 1.3's raw JS-array binding is not a Postgres array.
  const statuses = input.statuses?.join(",") ?? null;
  if (input.command === "list") {
    const rows =
      await db`select i.*,a.name as assignee_label,c.name as last_comment_author_name
      from issues i left join profiles a on a.id=i.assignee_id
      left join profiles c on c.id=i.last_comment_author_id
      where not i.archived
      and (${statuses}::text is null or i.status=any(string_to_array(${statuses}::text,',')))
      and (${input.updatedSince}::timestamptz is null or i.updated_at>${input.updatedSince}::timestamptz)
      order by case i.priority when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,i.sort_order,i.number
      limit ${input.limit}`;
    return rows.map(summary);
  }
  const team = await teamEmails(env);
  if (input.command === "comments") {
    const rows =
      await db`select c.*,i.number,i.status,coalesce(c.author_label,p.name,'Agent') as author_name,p.email as author_email
      from issue_comments c join issues i on i.id=c.issue_id left join profiles p on p.id=c.author_id
      where not i.archived and c.deleted_at is null and c.created_at>${input.since}::timestamptz
      and (${statuses}::text is null or i.status=any(string_to_array(${statuses}::text,',')))
      order by c.created_at,c.id`;
    return rows.map((/** @type {any} */ row) => {
      const { id, ...fields } = comment(row, team);
      return {
        key: formatIssueKey(row.number),
        status: row.status,
        comment_id: id,
        ...fields,
      };
    });
  }
  const issue = await findIssue(db, input.key, false);
  const [row] =
    await db`select i.*,a.name as assignee_label,c.name as last_comment_author_name
    from issues i left join profiles a on a.id=i.assignee_id
    left join profiles c on c.id=i.last_comment_author_id where i.id=${issue.id}`;
  const comments =
    await db`select c.*,coalesce(c.author_label,p.name,'Agent') as author_name,p.email as author_email
    from issue_comments c left join profiles p on p.id=c.author_id
    where c.issue_id=${issue.id} and c.deleted_at is null order by c.created_at,c.id`;
  const attachments =
    await db`select a.id,a.file_name,f.status from issue_attachments a
    join issue_comments c on c.id=a.comment_id join files f on f.id=a.storage_id
    where a.issue_id=${issue.id} and c.deleted_at is null order by a.created_at,a.id`;
  return {
    ...summary(row),
    description: row.description,
    steps: row.steps,
    actual: row.actual,
    expected: row.expected,
    comments: comments.map((/** @type {any} */ row) => comment(row, team)),
    attachments: attachments.map((/** @type {any} */ row) => ({
      name: row.file_name,
      url:
        row.status === "stored"
          ? `/api/v1/issues/attachments/${row.id}/content`
          : null,
    })),
  };
}
