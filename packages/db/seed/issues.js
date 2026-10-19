import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { tx } from "../src/client.js";

export const DEFAULT_ISSUES_FILE = join(
  homedir(),
  "cnc/_backups/sunpride-convex-20261019/issues.json",
);
/**
 * Restore only facts present in the backup. The supplied archive contains board
 * summaries, not bodies or comment text; completeness is persisted separately.
 * Existing numbers are NEVER overwritten. No attachment bytes or claims imported.
 * @param {import('../src/client.js').Db} db
 * @param {{file?:string}} [options]
 */
export async function seedIssues(db, { file = DEFAULT_ISSUES_FILE } = {}) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  const entries = Array.isArray(parsed) ? parsed : parsed.issues;
  if (!Array.isArray(entries) || parsed.truncated === true)
    throw new Error("Expected a complete issue backup");
  /** @type {Array<{number:number,missingComments:number,missingAttachments:number,summaryOnly:boolean}>} */ const missing =
    [];
  const seen = new Set();
  for (const entry of entries) {
    const i = entry.issue ?? entry;
    if (
      !Number.isInteger(i.number) ||
      i.number < 1 ||
      typeof i.title !== "string" ||
      !i.title ||
      seen.has(i.number)
    )
      throw new Error("Invalid or duplicate issue number");
    seen.add(i.number);
  }
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(hashtext('sunpride:issues'))`;
    let created = 0,
      skipped = 0,
      comments = 0;
    for (const entry of entries) {
      const i = entry.issue ?? entry;
      const storedComments = entry.comments ?? i.comments ?? [];
      if (!Array.isArray(storedComments))
        throw new Error("Invalid backup comments");
      const live = storedComments.filter(
        (/** @type {any} */ c) => !c.deletedAt,
      );
      const missingComments = Math.max(0, (i.commentCount ?? 0) - live.length);
      const missingAttachments = Math.max(
        i.attachmentCount ?? 0,
        (entry.attachments ?? i.attachments ?? []).length,
        storedComments.reduce(
          (/** @type {number} */ n, /** @type {any} */ c) =>
            n + (c.attachments?.length ?? 0),
          0,
        ),
      );
      const summaryOnly = ![
        "description",
        "body",
        "steps",
        "actual",
        "expected",
      ].some((k) => Object.hasOwn(i, k));
      if (missingComments || missingAttachments || summaryOnly)
        missing.push({
          number: i.number,
          missingComments,
          missingAttachments,
          summaryOnly,
        });
      const createdAt = new Date(i.createdAt ?? i._creationTime);
      const updatedAt = new Date(i.updatedAt ?? i.createdAt ?? i._creationTime);
      if (
        !Number.isFinite(createdAt.getTime()) ||
        !Number.isFinite(updatedAt.getTime())
      )
        throw new Error(`Missing creation time for issue ${i.number}`);
      const description = i.description ?? i.body ?? null;
      const search = [
        `SP-${String(i.number).padStart(4, "0")}`,
        i.number,
        i.title,
        description,
        i.steps,
        i.actual,
        i.expected,
        i.externalRef,
        i.milestone,
      ]
        .filter((v) => v != null)
        .join(" ")
        .toLowerCase();
      const last = live
        .slice()
        .sort(
          (/** @type {any} */ a, /** @type {any} */ b) =>
            new Date(b.createdAt ?? b._creationTime).getTime() -
            new Date(a.createdAt ?? a._creationTime).getTime(),
        )[0];
      const [row] =
        await t`insert into issues (number,title,description,steps,actual,expected,area,priority,status,sort_order,reporter_label,external_ref,milestone,archived,archived_at,search_text,comment_count,attachment_count,created_at,updated_at,backup_missing_comments,backup_missing_attachments,backup_summary_only,last_comment_at,last_comment_author_label)
        values (${i.number},${i.title},${description},${i.steps ?? null},${i.actual ?? null},${i.expected ?? null},${i.area ?? "Others"},${i.priority ?? "medium"},${i.status ?? "draft"},${i.order ?? i.number * 1024},${entry.reporterName ?? i.reporterName ?? i.reporterLabel ?? "Imported reporter"},${i.externalRef ?? null},${i.milestone ?? null},${i.archived ?? false},${i.archivedAt ? new Date(i.archivedAt) : null},${search},${live.length},0,${createdAt},${updatedAt},${missingComments},${missingAttachments},${summaryOnly},${last ? new Date(last.createdAt ?? last._creationTime) : null},${last ? (last.authorName ?? last.authorLabel ?? "Imported author") : null})
        on conflict (number) do nothing returning id`;
      if (!row) {
        skipped++;
        continue;
      }
      created++;
      for (let n = 0; n < storedComments.length; n++) {
        const c = storedComments[n];
        if (typeof c.body !== "string")
          throw new Error(`Missing comment body for issue ${i.number}`);
        const at = new Date(c.createdAt ?? c._creationTime);
        if (!Number.isFinite(at.getTime()))
          throw new Error("Missing comment creation time");
        await t`insert into issue_comments (issue_id,author_label,body,deleted_at,created_at,updated_at,backup_key)
          values (${row.id},${c.authorName ?? c.authorLabel ?? "Imported author"},${c.body},${c.deletedAt ? new Date(c.deletedAt) : null},${at},${new Date(c.updatedAt ?? at)},${String(c._id ?? c.id ?? n)})`;
        comments++;
      }
    }
    await t`insert into issue_counters (key,last_number) values ('issueNumber',(select coalesce(max(number),0) from issues))
      on conflict (key) do update set last_number=greatest(issue_counters.last_number,excluded.last_number)`;
    return { created, skipped, comments, total: entries.length, missing };
  });
}
