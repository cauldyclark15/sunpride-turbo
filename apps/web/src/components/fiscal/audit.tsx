"use client";
import { formatDateTime } from "../../lib/format";
import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { readAuditArchive, type AuditPage } from "./audit-archive";

const displayFacts = (value: unknown) =>
  value && typeof value === "object"
    ? Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key]) =>
              key !== "id" && !key.endsWith("_id") && !key.endsWith("subject"),
          )
          .map(([key, v]) => [key.replaceAll("_", " "), v]),
      )
    : value;
const button =
  "rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50";
/** F-020: national authorized audit, searchable scan and non-destructive hashed archive. */
export function FiscalAudit({ allowed }: { allowed: boolean }) {
  const [filters, setFilters] = useState<URLSearchParams>(
    new URLSearchParams(),
  );
  const [page, setPage] = useState<AuditPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!allowed) return null;
  const fetchPage = (query: URLSearchParams) =>
    apiFetch<AuditPage>("/api/v1/fiscal/audit?" + query.toString());
  async function load(query: URLSearchParams) {
    setBusy(true);
    setMessage("");
    try {
      setPage(await fetchPage(query));
    } catch (e) {
      setPage(null);
      setMessage(e instanceof Error ? e.message : "Audit could not be loaded.");
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    setBusy(true);
    setMessage("");
    try {
      const result = await readAuditArchive(fetchPage, filters);
      const content = JSON.stringify(result.rows);
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(content),
          ),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      const archive = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        before: result.before,
        filters: result.filters,
        rowCount: result.rows.length,
        sha256: hash,
        hashContent: "JSON.stringify(rows), UTF-8",
        rows: result.rows,
      };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(archive, null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "Sunpride-audit-archive.json";
      a.click();
      URL.revokeObjectURL(url);
      setMessage(
        `Downloaded ${result.rows.length} events with their content hash. No entries were deleted.`,
      );
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : "Nothing was exported. Try a narrower period.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="grid gap-4 rounded-xl border border-border bg-surface p-5">
      <h2 className="font-semibold">Audit search & archive</h2>
      <p className="text-sm text-muted">
        National financial audit. Original before/after facts remain
        append-only. Download an archive for protected retention; this never
        deletes database history. A download is not an off-site backup.
      </p>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const q = new URLSearchParams();
          for (const name of ["table", "action"])
            if (f.get(name)) q.set(name, String(f.get(name)));
          if (f.get("from"))
            q.set("from", new Date(String(f.get("from"))).toISOString());
          q.set(
            "before",
            f.get("before")
              ? new Date(String(f.get("before"))).toISOString()
              : new Date().toISOString(),
          );
          setFilters(q);
          void load(q);
        }}
      >
        <label>
          From
          <input name="from" type="datetime-local" />
        </label>
        <label>
          Before
          <input name="before" type="datetime-local" />
        </label>
        <label>
          Record type
          <input
            name="table"
            placeholder="For example: orders"
            pattern="[a-z][a-z0-9_]{0,79}"
          />
        </label>
        <label>
          Change
          <select name="action">
            <option value="">All changes</option>
            <option value="INSERT">Created</option>
            <option value="UPDATE">Changed</option>
            <option value="DELETE">Removed</option>
          </select>
        </label>
        <button className={button} disabled={busy}>
          Search audit
        </button>
      </form>
      <button
        className={button}
        disabled={busy || !page}
        onClick={() => void archive()}
      >
        Download audit archive
      </button>
      {message ? <p role="status">{message}</p> : null}
      {page?.items.map((row) => (
        <details key={row.id} className="border-t border-border py-2 text-sm">
          <summary>
            {row.table_name.replaceAll("_", " ")} · {row.action.toLowerCase()} ·{" "}
            {formatDateTime(row.created_at)}
          </summary>
          <pre className="overflow-auto whitespace-pre-wrap">
            {JSON.stringify(
              {
                actor: row.actor_name ?? "System or former user",
                before: displayFacts(row.before_facts),
                after: displayFacts(row.after_facts),
              },
              null,
              2,
            )}
          </pre>
        </details>
      ))}
      {page && page.items.length === 0 ? (
        <p>No events match these filters.</p>
      ) : null}
      {page?.hasMore ? (
        <button
          className={button}
          disabled={busy}
          onClick={() => {
            const q = new URLSearchParams(filters);
            q.set("cursor", page.nextCursor!);
            void load(q);
          }}
        >
          Next audit events
        </button>
      ) : null}
    </section>
  );
}
