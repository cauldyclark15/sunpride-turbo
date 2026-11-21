import { requireNationalScope } from "../../core/capabilities.js";
import { canonicalJson } from "../../core/util.js";
import { required, rule, uuid } from "../org/model.js";

/** Record only actual changes, inside the caller's authorized transaction.
 * Snapshot the person's name so later renames never rewrite attribution.
 * @param {any} c @param {string} kind @param {string} key @param {string} label
 * @param {any} before @param {any} after @param {any} reason */
export async function logReferenceChange(
  c,
  kind,
  key,
  label,
  before,
  after,
  reason,
) {
  if (canonicalJson(before) === canonicalJson(after)) return;
  const why = required(reason, "Reason for this change", 500);
  const [person] =
    await c.db`select name from profiles where id=${c.actor.profileId}`;
  await c.db`insert into field_master_changes(kind,record_key,label,reason,actor_profile_id,actor_name,before_value,after_value)
    values(${kind},${key},${label},${why},${c.actor.profileId},${person.name},${before},${after})`;
}

/** National master changes must not disclose cross-branch stores to regional readers.
 * @param {any} c */
export async function referenceLog(c) {
  await requireNationalScope(c, ["admin"]);
  const q = c.url.searchParams;
  const kind = q.get("kind") ?? "";
  if (
    kind &&
    ![
      "customer_group",
      "group_store",
      "channel",
      "place",
      "territory",
      "stock_reason",
    ].includes(kind)
  )
    rule("Choose a change log section.");
  let at = null,
    id = null;
  const cursor = q.get("cursor");
  if (cursor) {
    const parts = cursor.split("|");
    if (
      parts.length !== 2 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parts[0]) ||
      !Number.isFinite(Date.parse(parts[0]))
    )
      rule("Invalid history page.");
    at = parts[0];
    id = uuid(parts[1]);
  }
  const rows =
    await c.db`select id,kind,label,reason,actor_name as "actorName",before_value as "before",after_value as "after",created_at as "createdAt",to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
    from field_master_changes where (${kind}='' or kind=${kind}) and (${at}::timestamptz is null or (created_at,id)<(${at}::timestamptz,${id}::uuid))
    order by created_at desc,id desc limit 26`;
  const visible = rows.slice(0, 25);
  const last = visible.at(-1);
  return {
    rows: visible,
    next: rows.length > 25 ? `${last.cursorAt}|${last.id}` : null,
  };
}
