import { expect, it } from "vitest";
import { readAuditArchive, type AuditRow } from "./audit-archive";
const row = (id: string): AuditRow => ({
  id,
  table_name: "orders",
  row_id: "source",
  action: "INSERT",
  actor_subject: "sample",
  created_at: "2026-01-01T00:00:00Z",
  before_facts: null,
  after_facts: { status: "captured" },
});
it("F-020 archive fetches every selected page with one upper date bound", async () => {
  const queries: URLSearchParams[] = [];
  const result = await readAuditArchive(
    async (q) => {
      queries.push(new URLSearchParams(q));
      return q.has("cursor")
        ? { items: [row("2")], hasMore: false, nextCursor: null }
        : { items: [row("1")], hasMore: true, nextCursor: "next" };
    },
    new URLSearchParams({ table: "orders" }),
  );
  expect(result.rows.map((r) => r.id)).toEqual(["1", "2"]);
  expect(queries[0]!.get("before")).toBe(queries[1]!.get("before"));
  expect(queries[1]!.get("table")).toBe("orders");
});
it("F-020 archive refuses missing or repeating cursors and duplicates instead of exporting partial facts", async () => {
  await expect(
    readAuditArchive(
      async () => ({ items: [], hasMore: true, nextCursor: null }),
      new URLSearchParams(),
    ),
  ).rejects.toThrow("continuation");
  await expect(
    readAuditArchive(
      async () => ({ items: [row("1")], hasMore: true, nextCursor: "same" }),
      new URLSearchParams(),
    ),
  ).rejects.toThrow("changed while paging");
});
