"use client";

import { useState, type FormEvent } from "react";
import { DocNumber, Peso } from "../ops";
import { money, type Movement } from "./store-day-model";

export const CASH_KIND_CHOICES = [
  {
    kind: "drop",
    label: "Cash drop",
    reasons: [
      ["till_limit", "Too much cash in the drawer"],
      ["safe_drop", "Move to the safe"],
      ["end_of_day", "End of day drop"],
    ],
  },
  {
    kind: "pickup",
    label: "Cash pickup",
    reasons: [
      ["bank_deposit", "For the bank"],
      ["owner_pickup", "Picked up by the owner or supervisor"],
    ],
  },
  {
    kind: "paid_out",
    label: "Paid out",
    reasons: [
      ["supplies", "Store supplies"],
      ["delivery_fee", "Delivery fee"],
      ["petty_cash", "Petty cash"],
      ["other", "Other (write why)"],
    ],
  },
  {
    kind: "paid_in",
    label: "Paid in",
    reasons: [
      ["change_fund", "Change fund returned"],
      ["correction", "Correction"],
      ["other", "Other (write why)"],
    ],
  },
  {
    kind: "float",
    label: "Add float",
    reasons: [
      ["top_up", "More change needed"],
      ["opening_correction", "Opening float was short"],
    ],
  },
  {
    kind: "no_sale",
    label: "No sale",
    reasons: [
      ["change_request", "Customer needs change"],
      ["drawer_check", "Checking the drawer"],
      ["other", "Other (write why)"],
    ],
  },
] as const;

/** Cash that went in or out of the drawer during the day, in the order it happened. */
export function MovementsList({ movements }: { movements: Movement[] }) {
  if (!movements.length)
    return (
      <p className="text-sm text-muted">
        No cash drops, pickups or paid-outs today.
      </p>
    );
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Cash movements</caption>
      <thead className="text-left text-xs uppercase text-muted">
        <tr>
          <th className="py-2 pr-3">What</th>
          <th className="py-2 pr-3">Why</th>
          <th className="py-2 pr-3">Approved by</th>
          <th className="py-2 pr-3">Slip</th>
          <th className="py-2 text-right">Drawer</th>
        </tr>
      </thead>
      <tbody>
        {movements.map((m) => (
          <tr key={m.id} className="border-t border-separator">
            <td className="py-2 pr-3">
              {m.label}
              <span className="block text-xs text-muted">
                {new Date(m.capturedAt).toLocaleTimeString("en-PH", {
                  hour: "numeric",
                  minute: "2-digit",
                })}{" "}
                · {m.recordedBy}
              </span>
            </td>
            <td className="py-2 pr-3">
              {m.reasonLabel}
              {m.note && (
                <span className="block text-xs text-muted">{m.note}</span>
              )}
            </td>
            <td className="py-2 pr-3">{m.supervisorName ?? "—"}</td>
            <td className="py-2 pr-3">
              <DocNumber value={m.slipNumber} />
            </td>
            <td className="py-2 text-right">
              {m.kind === "no_sale" ? (
                "Opened, no cash moved"
              ) : (
                <Peso
                  centavos={money(m.effectCentavos)}
                  negativeClassName="text-danger"
                />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Office-side cash movement for an OPEN session. The supervisor using this screen is the approver, so no PIN is
 * asked here (the PIN sheet is on the handheld). One primary action.
 */
export function CashMovementForm({
  sessions,
  onSubmit,
  busy = false,
}: {
  sessions: { id: string; cashier: string }[];
  onSubmit: (body: {
    sessionId: string;
    kind: string;
    amountCentavos: string;
    reasonCode: string;
    note: string | null;
  }) => void;
  busy?: boolean;
}) {
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? "");
  const [kind, setKind] = useState<string>("drop");
  const [reason, setReason] = useState<string>("till_limit");
  const [pesos, setPesos] = useState("");
  const [note, setNote] = useState("");
  const choice = CASH_KIND_CHOICES.find((c) => c.kind === kind)!;
  const amountOk = kind === "no_sale" || /^\d+(\.\d{1,2})?$/.test(pesos);
  const noteNeeded = reason === "other";
  const ready =
    Boolean(sessionId) && amountOk && (!noteNeeded || note.trim().length > 0);
  if (!sessions.length)
    return (
      <p className="text-sm text-muted">
        Cash movements need an open cashier session.
      </p>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    onSubmit({
      sessionId,
      kind,
      amountCentavos:
        kind === "no_sale" ? "0" : String(Math.round(Number(pesos) * 100)),
      reasonCode: reason,
      note: note.trim() || null,
    });
  };
  const field =
    "min-h-12 w-full rounded-lg border border-border bg-surface px-3 text-base";
  return (
    <form
      onSubmit={submit}
      className="grid max-w-md gap-3"
      aria-label="Record a cash movement"
    >
      <label className="grid gap-1 text-sm">
        Cashier session
        <select
          aria-label="Cashier session"
          className={field}
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.cashier}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        What happened
        <select
          aria-label="What happened"
          className={field}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setReason(
              CASH_KIND_CHOICES.find((c) => c.kind === e.target.value)!
                .reasons[0][0],
            );
          }}
        >
          {CASH_KIND_CHOICES.map((c) => (
            <option key={c.kind} value={c.kind}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {kind !== "no_sale" && (
        <label className="grid gap-1 text-sm">
          Amount (₱)
          <input
            aria-label="Amount in pesos"
            className={field}
            inputMode="decimal"
            value={pesos}
            onChange={(e) => setPesos(e.target.value)}
          />
          {!amountOk && pesos !== "" && (
            <span role="alert" className="text-danger">
              Enter pesos like 5000 or 5000.50
            </span>
          )}
        </label>
      )}
      <label className="grid gap-1 text-sm">
        Why
        <select
          aria-label="Why"
          className={field}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          {choice.reasons.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {noteNeeded && (
        <label className="grid gap-1 text-sm">
          Write why
          <input
            aria-label="Note"
            className={field}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      )}
      <button
        disabled={busy || !ready}
        className="min-h-12 rounded-xl bg-[#EF5706] px-4 text-base font-semibold text-white disabled:opacity-50"
      >
        Record {choice.label.toLowerCase()}
      </button>
    </form>
  );
}
