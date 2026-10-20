"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import { Card, Notice } from "@sunpride/ui";
import { mutate, useApi } from "../../lib/api";
type Choice = { id: string; label: string; channelId?: string };
type Unknown = {
  id: string;
  kind: "outlet" | "customer";
  code: string;
  name: string;
  legacyKey: string;
  currentChannelId: string | null;
};
type Preview = {
  allowed: boolean;
  previewHash?: string;
  readyOutlets?: number;
  readyCustomers?: number;
  unknown?: Unknown[];
  channels?: Choice[];
  subchannels?: Choice[];
};
const input =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm";
/** F-013 reviewed cutover for retained client records, not just the sample seed. */
export function TaxonomyMigration() {
  const data = useApi<Preview>(
    ["masters", "taxonomy-migration"],
    "/api/v1/masters/taxonomy-migration",
  );
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [page, setPage] = useState(0);
  if (data.error) return <Notice title={data.error.message} tone="warning" />;
  if (!data.data)
    return <Card label="Legacy channel cutover">Loading mapping review…</Card>;
  const p = data.data;
  if (!p.allowed)
    return (
      <Notice
        title="National office handles legacy channel cutover"
        tone="warning"
      />
    );
  const unknown = p.unknown ?? [],
    pages = Math.max(1, Math.ceil(unknown.length / 10)),
    current = Math.min(page, pages - 1);
  async function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get("reason") ?? "");
    setBusy(true);
    setMessage("");
    try {
      const result = await mutate<{
        outlets: number;
        customers: number;
        unknown: number;
      }>(
        "/api/v1/masters/taxonomy-migration/apply",
        { previewHash: p.previewHash, reason },
        { idempotencyKey: crypto.randomUUID(), invalidate: [["masters"]] },
      );
      setMessage(
        `Mapped ${result.outlets} stores and ${result.customers} accounting customers. ${result.unknown} still need individual review.`,
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Mapping could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card label="Legacy channel cutover">
      <div className="grid gap-4">
        <p className="text-sm text-muted">
          Move existing source keys to the one governed channel and sub-channel
          list. Original keys stay intact. Existing governed assignments are
          never overwritten.
        </p>
        <p className="text-sm">
          Ready to map: {p.readyOutlets ?? 0} stores · {p.readyCustomers ?? 0}{" "}
          accounting customers. Individual review: {unknown.length}.
        </p>
        {(p.readyOutlets ?? 0) + (p.readyCustomers ?? 0) > 0 ? (
          <form onSubmit={apply} className="flex flex-wrap items-end gap-3">
            <label className="grid flex-1 gap-1 text-sm">
              Cutover review reason
              <input name="reason" required maxLength={500} className={input} />
            </label>
            <Button type="submit" isDisabled={busy}>
              {busy ? "Applying…" : "Apply reviewed known-key mappings"}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted">
            No known-key mappings are waiting. Resolve any unknown records
            below; source strings are never guessed.
          </p>
        )}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
        {unknown.slice(current * 10, (current + 1) * 10).map((row) => (
          <Resolve
            key={`${row.kind}:${row.id}`}
            row={row}
            channels={p.channels ?? []}
            subs={p.subchannels ?? []}
          />
        ))}
        {pages > 1 && (
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              isDisabled={current === 0}
              onPress={() => setPage(current - 1)}
            >
              Previous
            </Button>
            <span className="text-sm">
              Page {current + 1} of {pages} · {unknown.length} records
            </span>
            <Button
              variant="outline"
              isDisabled={current + 1 >= pages}
              onPress={() => setPage(current + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
function Resolve({
  row,
  channels,
  subs,
}: {
  row: Unknown;
  channels: Choice[];
  subs: Choice[];
}) {
  const [channel, setChannel] = useState(row.currentChannelId ?? ""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setMessage("");
    try {
      await mutate(
        "/api/v1/masters/taxonomy-migration/assign",
        {
          id: row.id,
          kind: row.kind,
          channelId: channel,
          subchannelId: String(f.get("subchannelId") ?? ""),
          reason: String(f.get("reason") ?? ""),
        },
        { idempotencyKey: crypto.randomUUID(), invalidate: [["masters"]] },
      );
      setMessage("Governed mapping saved.");
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Mapping could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={save}
      className="grid gap-3 rounded-lg border border-border p-4"
    >
      <p className="text-sm font-medium">
        {row.name} · {row.code}
      </p>
      <p className="text-xs text-muted">
        {row.kind === "outlet" ? "Store" : "Accounting customer"} · Original
        key: {row.legacyKey}
      </p>
      <label className="grid gap-1 text-sm">
        Reviewed channel
        <select
          className={input}
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          required
        >
          <option value="">Choose…</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {row.kind === "outlet" && (
        <label className="grid gap-1 text-sm">
          Reviewed sub-channel
          <select key={channel} name="subchannelId" className={input} required>
            <option value="">Choose…</option>
            {subs
              .filter((c) => c.channelId === channel)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
          </select>
        </label>
      )}
      <label className="grid gap-1 text-sm">
        Mapping reason
        <input className={input} name="reason" required maxLength={500} />
      </label>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <Button type="submit" isDisabled={busy}>
        Save reviewed mapping
      </Button>
    </form>
  );
}
