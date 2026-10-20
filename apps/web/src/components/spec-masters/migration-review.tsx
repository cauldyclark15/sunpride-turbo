"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import { Card } from "@sunpride/ui";
import { mutate, useApi, useLive } from "../../lib/api";
import { migrationPesos } from "./migration-model";

type Row = {
  id: string;
  kind: string;
  sourceReference: string;
  legacyId: string;
  sapId: string;
  rowNumber: number;
  name: string;
  payloadHash: string;
  candidates: { id: string; code?: string; name?: string }[];
  errors: { message: string }[];
};
/** F-022 nothing leaves staging until an explicit reviewed mapping/create decision.
 * Open AR remains a source replica, not a receipt or a stock/ledger posting. */
export function MigrationReview() {
  const data = useApi<{
    rows: Row[];
    totals: {
      kind: string;
      status: string;
      rows: number;
      open_centavos: string;
    }[];
    truncated: boolean;
  }>(["imports", "migration"], "/api/v1/imports/migration/queue");
  useLive(["imports"], [["imports", "migration"]]);
  return (
    <Card label="Cutover review">
      <div className="grid gap-4">
        <p className="text-sm text-muted">
          Which source records are ready? Review duplicate candidates before
          creating a master. Loading a file only stages it; reject or map each
          row here. Open AR is a read-only SAP/legacy snapshot, never a payment.
        </p>
        {data.error && <p role="alert">{data.error.message}</p>}
        <div className="flex flex-wrap gap-3">
          {data.data?.totals.map((t) => (
            <p
              className="rounded-lg border border-border px-3 py-2 text-xs"
              key={`${t.kind}:${t.status}`}
            >
              {t.kind.replaceAll("_", " ")} · {t.status}: {t.rows} rows
              {t.kind === "open_ar"
                ? ` · ${migrationPesos(t.open_centavos)}`
                : ""}
            </p>
          ))}
        </div>
        {data.data?.rows.length === 0 && (
          <p className="text-sm">No staged rows need review.</p>
        )}
        {data.data?.rows.map((row) => (
          <StagedRow key={row.id} row={row} />
        ))}
        {data.data?.truncated && (
          <p className="text-sm text-muted">
            Showing the first 100 pending rows. Review these to advance through
            the remaining queue.
          </p>
        )}
      </div>
    </Card>
  );
}
function StagedRow({ row }: { row: Row }) {
  const [action, setAction] = useState(""),
    [target, setTarget] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setMessage("");
    try {
      await mutate(
        "/api/v1/imports/migration/review",
        {
          stagingId: row.id,
          payloadHash: row.payloadHash,
          action,
          ...(action === "map" ? { targetId: target } : {}),
          reason: String(f.get("reason") ?? ""),
          confirmDistinct: f.get("distinct") === "on",
        },
        {
          idempotencyKey: crypto.randomUUID(),
          invalidate: [["imports"], ["masters"], ["org"]],
        },
      );
      setMessage("Review saved.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Review could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  const input = "rounded-lg border border-border bg-surface px-3 py-2 text-sm";
  return (
    <form
      onSubmit={submit}
      className="grid gap-3 rounded-xl border border-border p-4"
    >
      <div>
        <h3 className="text-sm font-medium">
          {row.name} · {row.kind.replaceAll("_", " ")}
        </h3>
        <p className="text-xs text-muted">
          {row.sourceReference} · row {row.rowNumber} · legacy {row.legacyId} ·
          SAP {row.sapId}
        </p>
      </div>
      {row.errors.map((e, i) => (
        <p className="text-sm" key={i}>
          {e.message}
        </p>
      ))}
      {row.candidates.length > 0 && (
        <p className="text-sm">
          {row.candidates.length} possible existing{" "}
          {row.candidates.length === 1 ? "record" : "records"}. Review and map
          instead of creating a duplicate.
        </p>
      )}
      <label className="grid gap-1 text-xs">
        Review decision
        <select
          className={input}
          required
          value={action}
          onChange={(e) => setAction(e.target.value)}
        >
          <option value="">Choose…</option>
          <option
            value="map"
            disabled={!row.candidates.length || !!row.errors.length}
          >
            Map to existing master
          </option>
          <option value="create" disabled={!!row.errors.length}>
            Create a distinct master / AR replica
          </option>
          <option value="reject">Reject source row</option>
        </select>
      </label>
      {action === "map" && (
        <label className="grid gap-1 text-xs">
          Existing record
          <select
            className={input}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            required
          >
            <option value="">Choose…</option>
            {row.candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code ?? "Existing record"} · {c.name ?? row.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {action === "create" && row.candidates.length > 0 && (
        <label className="flex gap-2 text-xs">
          <input type="checkbox" name="distinct" required />I checked the
          candidates; this is a different record.
        </label>
      )}
      <label className="grid gap-1 text-xs">
        Review reason
        <input name="reason" className={input} required maxLength={500} />
      </label>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <Button type="submit" isDisabled={busy || !action}>
        {busy ? "Saving…" : "Save reviewed decision"}
      </Button>
    </form>
  );
}
