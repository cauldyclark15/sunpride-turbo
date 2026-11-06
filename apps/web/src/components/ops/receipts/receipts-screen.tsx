"use client";

import { useState } from "react";
import { mutate, useApi } from "@/lib/api";
import { Peso } from "../peso";
import { ReceiptPreview } from "./receipt-preview";
import type { JournalEntry, ReceiptModel, ReceiptRow } from "./receipt-types";

export const REPRINT_REASONS = [
  "Customer asked for a copy",
  "Printer jammed",
  "Paper ran out",
  "Print was faint or cut off",
  "Other",
] as const;

const PRIVILEGE_WORDS: Record<string, string> = {
  senior: "Senior citizen",
  pwd: "PWD",
  solo_parent: "Solo parent",
  athlete: "Athlete",
  uniformed: "Uniformed",
};
const when = (iso: string) =>
  new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(new Date(iso));

/** What the e-journal says happened, in plain words. */
export function journalWords(e: JournalEntry): string {
  switch (e.entry_kind) {
    case "printed":
      return "Printed";
    case "reprinted":
      return `Reprinted (copy ${e.copy_number})`;
    case "voided":
      return "Voided";
    default:
      return "Spoiled";
  }
}

/** Queue first: newest receipts, search by number or buyer. */
export function ReceiptList({
  rows,
  selectedId,
  onSelect,
  query,
  onQuery,
}: {
  rows: ReceiptRow[];
  selectedId: string | null;
  onSelect: (row: ReceiptRow) => void;
  query: string;
  onQuery: (q: string) => void;
}) {
  return (
    <section aria-label="Receipts" className="grid content-start gap-3">
      <label className="grid gap-1">
        <span className="text-xs font-medium uppercase text-muted">
          Find a receipt
        </span>
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Invoice number or buyer"
          className="min-h-12 rounded-[10px] border border-field-border bg-field-background px-3 text-base"
        />
      </label>
      {rows.length === 0 ? (
        <p className="rounded-2xl bg-white p-4 text-muted">
          No receipts yet for this search.
        </p>
      ) : (
        <ul className="grid gap-2">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onSelect(r)}
                aria-current={r.id === selectedId}
                className={`grid min-h-16 w-full gap-1 rounded-2xl border bg-white p-3 text-left ${
                  r.id === selectedId ? "border-accent" : "border-field-border"
                }`}
              >
                <span className="flex justify-between gap-3 font-medium">
                  <span>{r.documentNumber}</span>
                  <Peso centavos={Number(r.totalDueMinor ?? 0)} />
                </span>
                <span className="flex flex-wrap gap-2 text-sm text-muted">
                  <span>{r.buyerName ?? "No buyer name"}</span>
                  <span>{when(r.issuedAt)}</span>
                  {r.privilegeType ? (
                    <span className="rounded-full bg-blue-100 px-2">
                      {PRIVILEGE_WORDS[r.privilegeType] ?? r.privilegeType}{" "}
                      discount
                    </span>
                  ) : null}
                  {r.voided ? (
                    <span className="rounded-full bg-danger-soft px-2">
                      Voided
                    </span>
                  ) : null}
                  {r.reprints > 0 ? <span>Reprinted {r.reprints}×</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One primary action: Reprint. Every reprint needs a reason and is written to the e-journal. */
export function ReprintPanel({
  model,
  journal,
  busy,
  message,
  onReprint,
}: {
  model: ReceiptModel;
  journal: JournalEntry[];
  busy: boolean;
  message: string;
  onReprint: (reason: string) => void;
}) {
  const [choice, setChoice] = useState<string>(REPRINT_REASONS[0]);
  const [note, setNote] = useState("");
  const other = choice === "Other";
  const reason = other ? note.trim() : choice;
  const blocked = model.status === "voided";
  return (
    <section
      aria-label="Reprint"
      className="grid gap-3 rounded-2xl bg-white p-4"
    >
      <h2 className="text-lg font-bold">Reprint this receipt</h2>
      {blocked ? (
        <p className="rounded-lg bg-danger-soft p-2">
          This receipt was voided. A voided receipt can be shown but not
          reprinted as valid.
        </p>
      ) : null}
      <label className="grid gap-1">
        <span className="text-xs font-medium uppercase text-muted">
          Why are you printing it again?
        </span>
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          className="min-h-12 rounded-[10px] border border-field-border bg-field-background px-3 text-base"
        >
          {REPRINT_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      {other ? (
        <label className="grid gap-1">
          <span className="text-xs font-medium uppercase text-muted">
            Write the reason
          </span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="min-h-12 rounded-[10px] border border-field-border bg-field-background px-3 text-base"
          />
        </label>
      ) : null}
      {other && !reason ? (
        <p role="alert" className="text-danger">
          Write the reason first.
        </p>
      ) : null}
      <button
        type="button"
        disabled={busy || blocked || !reason}
        onClick={() => onReprint(reason)}
        className="min-h-14 rounded-2xl bg-[#EF5706] px-6 text-lg font-bold text-white disabled:opacity-50"
      >
        {busy ? "Printing…" : "Reprint copy"}
      </button>
      {message ? <p role="status">{message}</p> : null}
      <div>
        <h3 className="text-xs font-medium uppercase text-muted">
          E-journal for this receipt
        </h3>
        {journal.length === 0 ? (
          <p className="text-muted">Nothing printed or reprinted yet.</p>
        ) : (
          <ol className="grid gap-1">
            {journal.map((e) => (
              <li key={e.seq} className="flex flex-wrap gap-2">
                <span className="font-medium">{journalWords(e)}</span>
                <span className="text-muted">{when(e.occurred_at)}</span>
                {e.actor_name ? <span>{e.actor_name}</span> : null}
                {e.reason ? (
                  <span className="text-muted">— {e.reason}</span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

type PrintResponse = { model: ReceiptModel; journal: JournalEntry[] };
type ReprintResponse = PrintResponse & { eventId: string };

/** Receipts: find a receipt, see it exactly as printed, reprint with a reason. Exported, not mounted (NAV lane mounts it). */
export function ReceiptsScreen({
  onPrint = () => window.print(),
}: {
  onPrint?: (model: ReceiptModel) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReceiptRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const list = useApi<{ receipts: ReceiptRow[]; hasMore: boolean }>(
    ["fiscal", "receipts", { q: query }],
    `/api/v1/fiscal/receipts${query ? `?q=${encodeURIComponent(query)}` : ""}`,
  );
  const detail = useApi<PrintResponse>(
    selected ? ["fiscal", "receipt", selected.id] : null,
    selected ? `/api/v1/fiscal/receipts/${selected.id}/print-model` : "",
  );
  async function reprint(reason: string) {
    if (!selected) return;
    setBusy(true);
    setMessage("");
    try {
      const done = await mutate<ReprintResponse>(
        `/api/v1/fiscal/receipts/${selected.id}/reprint`,
        { reason },
        {
          invalidate: [
            ["fiscal", "receipt", selected.id],
            ["fiscal", "receipts"],
          ],
        },
      );
      setMessage(`${done.model.copy.label} saved in the e-journal.`);
      onPrint(done.model);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not reprint. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (list.error)
    return <p role="alert">Receipts could not load. {list.error.message}</p>;
  return (
    <div className="grid gap-4 bg-[#F5F6F8] p-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <ReceiptList
        rows={list.data?.receipts ?? []}
        selectedId={selected?.id ?? null}
        onSelect={setSelected}
        query={query}
        onQuery={setQuery}
      />
      <div className="grid content-start gap-4">
        {!selected ? (
          <p className="rounded-2xl bg-white p-6 text-muted">
            Pick a receipt on the left to see it as printed.
          </p>
        ) : detail.error ? (
          <p role="alert">
            Could not open this receipt. {detail.error.message}
          </p>
        ) : !detail.data ? (
          <p>Opening receipt…</p>
        ) : (
          <>
            <ReceiptPreview model={detail.data.model} />
            <ReprintPanel
              model={detail.data.model}
              journal={detail.data.journal}
              busy={busy}
              message={message}
              onReprint={reprint}
            />
          </>
        )}
      </div>
    </div>
  );
}
