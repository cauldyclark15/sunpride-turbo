export type AuditRow = {
  id: string;
  table_name: string;
  row_id: string;
  action: string;
  actor_subject: string;
  actor_name?: string | null;
  created_at: string;
  before_facts: unknown;
  after_facts: unknown;
};
export type AuditPage = {
  items: AuditRow[];
  hasMore: boolean;
  nextCursor: string | null;
};
/** F-020: fail instead of exporting a silently truncated or looping audit archive. */
export async function readAuditArchive(
  fetchPage: (query: URLSearchParams) => Promise<AuditPage>,
  filters: URLSearchParams,
) {
  const rows: AuditRow[] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  const query = new URLSearchParams(filters);
  query.delete("cursor");
  if (!query.has("before")) query.set("before", new Date().toISOString());
  for (let page = 0; page < 50; page++) {
    const result = await fetchPage(query);
    for (const row of result.items) {
      if (ids.has(row.id))
        throw Error("Audit changed while paging. Refresh and try again.");
      ids.add(row.id);
      rows.push(row);
    }
    if (!result.hasMore)
      return {
        rows,
        filters: Object.fromEntries(new URLSearchParams(filters)),
        before: query.get("before"),
      };
    if (!result.nextCursor || cursors.has(result.nextCursor))
      throw Error("Audit continuation is invalid. Nothing was exported.");
    cursors.add(result.nextCursor);
    query.set("cursor", result.nextCursor);
  }
  throw Error(
    "More than 5,000 events match. Narrow the dates or record type; nothing was exported.",
  );
}
