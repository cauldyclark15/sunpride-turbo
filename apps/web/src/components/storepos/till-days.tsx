"use client";

import { useState, type FormEvent } from "react";
import { apiFetch, mutate, useApi, useLive } from "../../lib/api";
import { DocNumber, Peso, StatusPill } from "../ops";
import { MovementsList, CashMovementForm } from "./cash-movements";
import { OverridesList } from "./overrides-review";
import { ReadingSheet, ZHistoryList } from "./reading-sheet";
import {
  dayNextStep,
  dayStatusWords,
  money,
  sessionStatusWords,
  type DayDetail,
  type PrintModel,
  type SessionRow,
  type TillDaySummary,
  type ZSummary,
} from "./store-day-model";

const primary =
  "min-h-12 rounded-xl bg-[#EF5706] px-5 text-base font-semibold text-white disabled:opacity-50";
const secondary = "min-h-12 rounded-xl border border-border px-4 text-base";

const dayPill = (status: string) =>
  status === "z_done" || status === "closed_no_z"
    ? "closed"
    : status === "closing"
      ? "needs_review"
      : "open";

/** Registers at a glance: one card per register with its latest day and the one next step. */
export function RegistersBoard({
  days,
  onOpen,
}: {
  days: TillDaySummary[];
  onOpen: (day: TillDaySummary) => void;
}) {
  const latest = new Map<string, TillDaySummary>();
  for (const d of days) {
    const have = latest.get(d.registerId);
    if (!have || d.businessDate > have.businessDate)
      latest.set(d.registerId, d);
  }
  if (!latest.size)
    return (
      <p className="text-sm text-muted">No register has opened a day yet.</p>
    );
  return (
    <ul className="grid gap-3 md:grid-cols-2" aria-label="Registers">
      {[...latest.values()].map((d) => (
        <li
          key={d.registerId}
          className="grid gap-2 rounded-2xl border border-border bg-surface p-4"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-base font-semibold">{d.registerName}</p>
              <p className="text-sm text-muted">
                {d.storeName} · {d.terminal}
              </p>
            </div>
            <StatusPill state={dayPill(d.status)}>
              {dayStatusWords(d.status)}
            </StatusPill>
          </div>
          <p className="text-sm">
            {d.businessDate} · {d.sessions} cashier session
            {d.sessions === 1 ? "" : "s"}
            {d.openSessions > 0 ? `, ${d.openSessions} open` : ""}
          </p>
          <p className="text-2xl font-semibold tabular-nums">
            <Peso centavos={money(d.netSalesCentavos)} />
          </p>
          <button type="button" className={secondary} onClick={() => onOpen(d)}>
            {d.canZ ? "Ready for Z reading" : "Open this day"}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Today's till days, newest first. Days that need attention come first (queue-first). */
export function TillDaysList({
  days,
  onOpen,
}: {
  days: TillDaySummary[];
  onOpen: (day: TillDaySummary) => void;
}) {
  const rank = (d: TillDaySummary) =>
    d.canZ ? 0 : d.status === "open" ? 1 : d.status === "closing" ? 2 : 3;
  const sorted = [...days].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.businessDate.localeCompare(a.businessDate) ||
      a.registerName.localeCompare(b.registerName),
  );
  if (!sorted.length)
    return <p className="text-sm text-muted">No till days in this period.</p>;
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Till days</caption>
      <thead className="text-left text-xs uppercase text-muted">
        <tr>
          <th className="py-2 pr-3">Day</th>
          <th className="py-2 pr-3">Register</th>
          <th className="py-2 pr-3">Status</th>
          <th className="py-2 pr-3">Sessions</th>
          <th className="py-2 pr-3 text-right">Sales</th>
          <th className="py-2 pr-3">Z reading</th>
          <th className="py-2" />
        </tr>
      </thead>
      <tbody>
        {sorted.map((d) => (
          <tr key={d.id} className="border-t border-separator">
            <td className="py-2 pr-3">
              {d.businessDate}
              <span className="block text-xs">
                <DocNumber value={d.number} />
              </span>
            </td>
            <td className="py-2 pr-3">
              {d.registerName}
              <span className="block text-xs text-muted">{d.storeName}</span>
            </td>
            <td className="py-2 pr-3">
              <StatusPill state={dayPill(d.status)}>
                {dayStatusWords(d.status)}
              </StatusPill>
            </td>
            <td className="py-2 pr-3">
              {d.sessions}
              {d.openSessions ? ` (${d.openSessions} open)` : ""}
            </td>
            <td className="py-2 pr-3 text-right">
              <Peso centavos={money(d.netSalesCentavos)} />
            </td>
            <td className="py-2 pr-3">
              {d.zCounter != null ? `Z no. ${d.zCounter}` : "—"}
            </td>
            <td className="py-2 text-right">
              <button
                type="button"
                className={d.canZ ? primary : secondary}
                onClick={() => onOpen(d)}
              >
                {d.canZ ? "Run Z reading" : "Open"}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Close one session from the office when its cashier cannot (sick, phone lost). A reason is required. */
export function ForceCloseForm({
  session,
  onSubmit,
}: {
  session: SessionRow;
  onSubmit: (sessionId: string, reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim()) onSubmit(session.id, reason.trim());
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-end gap-2"
      aria-label={`Close ${session.cashier}'s session from the office`}
    >
      <label className="grid gap-1 text-xs">
        Why is the office closing it?
        <input
          aria-label="Reason"
          className="min-h-12 rounded-lg border border-border bg-surface px-3 text-base"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <button disabled={!reason.trim()} className={secondary}>
        Close from the office
      </button>
    </form>
  );
}

/** Sessions with expected, counted and variance. The cashier being counted never sees expected (blind). */
export function SessionsTable({
  sessions,
  onForceClose,
}: {
  sessions: SessionRow[];
  onForceClose?: (sessionId: string, reason: string) => void;
}) {
  if (!sessions.length)
    return (
      <p className="text-sm text-muted">
        No cashier has opened a session on this day.
      </p>
    );
  return (
    <div className="grid gap-3">
      <table className="w-full text-sm">
        <caption className="sr-only">Cashier sessions</caption>
        <thead className="text-left text-xs uppercase text-muted">
          <tr>
            <th className="py-2 pr-3">Cashier</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3 text-right">Opening float</th>
            <th className="py-2 pr-3 text-right">Cash sales</th>
            <th className="py-2 pr-3 text-right">Drops and pickups</th>
            <th className="py-2 pr-3 text-right">Should be in drawer</th>
            <th className="py-2 pr-3 text-right">Counted</th>
            <th className="py-2 text-right">Over / short</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id} className="border-t border-separator align-top">
              <td className="py-2 pr-3">
                {s.cashier}
                <span className="block text-xs">
                  <DocNumber value={s.number} />
                </span>
              </td>
              <td className="py-2 pr-3">
                <StatusPill
                  state={
                    s.status === "open"
                      ? "open"
                      : s.status === "force_closed" ||
                          s.status === "needs_review" ||
                          s.status === "suspended"
                        ? "needs_review"
                        : "closed"
                  }
                >
                  {sessionStatusWords(s.status)}
                </StatusPill>
              </td>
              <td className="py-2 pr-3 text-right">
                <Peso centavos={money(s.openingFloat)} />
              </td>
              <td className="py-2 pr-3 text-right">
                <Peso centavos={money(s.cashSales)} />
              </td>
              <td className="py-2 pr-3 text-right">
                <Peso
                  centavos={
                    -(Number(s.drops) + Number(s.pickups) + Number(s.paidOut)) +
                    Number(s.floatIn) +
                    Number(s.paidIn)
                  }
                />
              </td>
              <td className="py-2 pr-3 text-right">
                {s.expected == null ? (
                  <span className="text-muted">
                    Hidden until you are counted
                  </span>
                ) : (
                  <Peso centavos={money(s.expected)} />
                )}
              </td>
              <td className="py-2 pr-3 text-right">
                {s.declared == null ? (
                  "—"
                ) : (
                  <Peso centavos={money(s.declared)} />
                )}
              </td>
              <td className="py-2 text-right">
                {s.variance == null ? (
                  "—"
                ) : Number(s.variance) === 0 ? (
                  "Exact"
                ) : (
                  <Peso
                    centavos={money(s.variance)}
                    negativeClassName="text-danger font-semibold"
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {onForceClose &&
        sessions
          .filter((s) => s.status === "open" || s.status === "suspended")
          .map((s) => (
            <ForceCloseForm key={s.id} session={s} onSubmit={onForceClose} />
          ))}
    </div>
  );
}

/** One day: the next step on top, then sessions, cash, the printed reading and the supervisor approvals. */
export function TillDayDetailView({
  detail,
  onZ,
  onStartClosing,
  onReopen,
  onForceClose,
  onCashMovement,
  onPrint,
  busy = false,
}: {
  detail: DayDetail;
  onZ?: () => void;
  onStartClosing?: () => void;
  onReopen?: () => void;
  onForceClose?: (sessionId: string, reason: string) => void;
  onCashMovement?: (body: {
    sessionId: string;
    kind: string;
    amountCentavos: string;
    reasonCode: string;
    note: string | null;
  }) => void;
  onPrint?: (model: PrintModel) => void;
  busy?: boolean;
}) {
  const next = dayNextStep(detail);
  const open = detail.reading.sessions.filter((s) => s.status === "open");
  const tone =
    next.tone === "warning"
      ? "border-warning bg-warning-soft"
      : next.tone === "success"
        ? "border-success bg-success-soft"
        : "border-border bg-surface";
  return (
    <article
      className="grid gap-5"
      aria-label={`Till day ${detail.day.businessDate}`}
    >
      <header className="grid gap-1">
        <h2 className="text-xl font-semibold">
          {detail.reading.register} · {detail.day.businessDate}
        </h2>
        <p className="text-sm text-muted">
          {detail.reading.store} · <DocNumber value={detail.day.number} /> ·{" "}
          {dayStatusWords(detail.day.status)}
        </p>
      </header>
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 ${tone}`}
        role="status"
      >
        <p className="min-w-0 flex-1 text-base">{next.text}</p>
        {next.action === "z" && onZ && (
          <div className="flex gap-2">
            <button
              type="button"
              className={primary}
              disabled={busy || !detail.day.canZ}
              onClick={onZ}
            >
              {next.actionLabel}
            </button>
            {detail.day.status === "open" && onStartClosing && (
              <button
                type="button"
                className={secondary}
                disabled={busy}
                onClick={onStartClosing}
              >
                Stop new sessions
              </button>
            )}
          </div>
        )}
        {detail.day.status === "closing" && onReopen && (
          <button
            type="button"
            className={secondary}
            disabled={busy}
            onClick={onReopen}
          >
            Reopen the day
          </button>
        )}
      </div>
      <section aria-label="Cashier sessions" className="grid gap-2">
        <h3 className="text-base font-semibold">Cashier sessions</h3>
        <SessionsTable
          sessions={detail.reading.sessions}
          onForceClose={
            detail.day.status === "z_done" ||
            detail.day.status === "closed_no_z"
              ? undefined
              : onForceClose
          }
        />
      </section>
      <section aria-label="Cash movements" className="grid gap-2">
        <h3 className="text-base font-semibold">
          Cash drops, pickups and paid-outs
        </h3>
        <MovementsList movements={detail.movements} />
        {onCashMovement &&
          detail.day.status !== "z_done" &&
          detail.day.status !== "closed_no_z" && (
            <details>
              <summary className="min-h-12 cursor-pointer py-3 text-sm font-medium">
                Add cash movement
              </summary>
              <CashMovementForm
                sessions={open.map((s) => ({ id: s.id, cashier: s.cashier }))}
                onSubmit={onCashMovement}
                busy={busy}
              />
            </details>
          )}
      </section>
      <section aria-label="X and Z readings" className="grid gap-2">
        <h3 className="text-base font-semibold">
          {detail.day.status === "z_done"
            ? "Z reading"
            : "X reading (as of now, nothing is closed)"}
        </h3>
        <ReadingSheet
          model={detail.printModel}
          onPrint={onPrint ? () => onPrint(detail.printModel) : undefined}
        />
        {detail.xReads.length > 0 && (
          <p className="text-sm text-muted">
            {detail.xReads.length} X reading
            {detail.xReads.length > 1 ? "s were" : " was"} printed at the till
            today.
          </p>
        )}
      </section>
      <section aria-label="Supervisor approvals" className="grid gap-2">
        <h3 className="text-base font-semibold">
          Supervisor approvals on this day
        </h3>
        <OverridesList rows={detail.overrides} />
      </section>
    </article>
  );
}

const daysKey = ["storepos", "days"] as const;

/** Container: today's till days, pick one, act. Exported, not mounted (NAV lane mounts it). */
export function TillDaysScreen() {
  const list = useApi<{ days: TillDaySummary[] }>(
    daysKey,
    "/api/v1/storepos/days",
  );
  useLive(["storepos"], [daysKey]);
  const [selected, setSelected] = useState<string | null>(null);
  const detailKey = ["storepos", "day", selected ?? "none"] as const;
  const detail = useApi<DayDetail>(
    detailKey,
    selected
      ? `/api/v1/storepos/days/${selected}`
      : "/api/v1/storepos/days/none",
  );
  useLive(["storepos"], [detailKey]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [printing, setPrinting] = useState<PrintModel | null>(null);
  async function act(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setNotice("");
    try {
      const res = await mutate<{ printModel?: PrintModel }>(
        `/api/v1/storepos/${path}`,
        { ...body, requestKey: crypto.randomUUID() },
        { invalidate: [daysKey, detailKey] },
      );
      if (res?.printModel) setPrinting(res.printModel);
      setNotice("Done.");
    } catch (e) {
      setNotice(
        e instanceof Error ? e.message : "Could not do that. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (list.error)
    return (
      <p role="alert" className="text-sm">
        Could not load till days. Try again.
      </p>
    );
  if (!list.data) return <p className="text-sm">Loading till days…</p>;
  if (selected && detail.data)
    return (
      <div className="grid gap-4">
        <button
          type="button"
          className={`${secondary} w-fit`}
          onClick={() => setSelected(null)}
        >
          ← All till days
        </button>
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        <TillDayDetailView
          detail={detail.data}
          busy={busy}
          onZ={() => void act(`days/${selected}/z`, {})}
          onStartClosing={() => void act(`days/${selected}/start-closing`, {})}
          onReopen={() =>
            void act(`days/${selected}/reopen`, {
              reason: "Reopened by supervisor",
            })
          }
          onForceClose={(sessionId, reason) =>
            void act("sessions/force-close", { sessionId, reason })
          }
          onCashMovement={(b) => void act("cash-movements", b)}
          onPrint={(m) => {
            setPrinting(m);
            if (typeof window !== "undefined") window.print();
          }}
        />
        {printing && printing !== detail.data.printModel && (
          <ReadingSheet model={printing} />
        )}
      </div>
    );
  return (
    <section aria-label="Till days" className="grid gap-4">
      <h1 className="text-xl font-semibold">Till days</h1>
      <RegistersBoard days={list.data.days} onOpen={(d) => setSelected(d.id)} />
      <TillDaysList days={list.data.days} onOpen={(d) => setSelected(d.id)} />
    </section>
  );
}

/** X and Z history for a register (or all): reprint any Z as a copy. */
export function ZHistoryScreen() {
  const key = ["storepos", "z-readings"] as const;
  const list = useApi<{ readings: ZSummary[]; legacy: ZSummary[] }>(
    key,
    "/api/v1/storepos/z-readings",
  );
  useLive(["storepos"], [key]);
  const [sheet, setSheet] = useState<PrintModel | null>(null);
  if (list.error)
    return (
      <p role="alert" className="text-sm">
        Could not load Z readings. Try again.
      </p>
    );
  if (!list.data) return <p className="text-sm">Loading Z readings…</p>;
  const all = [
    ...list.data.readings,
    ...list.data.legacy.map((z) => ({ ...z, legacy: true })),
  ];
  return (
    <section aria-label="Z reading history" className="grid gap-4">
      <h1 className="text-xl font-semibold">Z readings</h1>
      <ZHistoryList
        readings={all}
        onOpen={async (z) => {
          const res = await apiFetch<{ printModel: PrintModel }>(
            `/api/v1/storepos/z-readings/${z.id}`,
          ).catch(() => null);
          if (res) setSheet(res.printModel);
        }}
      />
      {sheet && <ReadingSheet model={sheet} onPrint={() => window.print()} />}
    </section>
  );
}
