"use client";
import { formatDate, formatDay } from "../lib/format";
import { useRef, useState } from "react";
import { useApi, useLive, useMutate } from "../lib/api";
import { currentManilaDate } from "../lib/coverage-calendar";

type Action = {
  kind: string;
  note: string;
  dueOn: string | null;
  actor: string;
  at: number;
};
export type DormancyCase = {
  id: string;
  storeId: string;
  name: string;
  code: string;
  territory: string;
  status: "open" | "recovered" | "closed";
  lastPurchaseOn: string;
  missedCycles: number;
  thresholdCycles: number;
  cycleDays: number;
  cycleSource: string;
  detectedOn: string;
  recoveredOn: string | null;
  recoveryPurchaseOn: string | null;
  closedReason: string | null;
  nextVisit: string | null;
  policyVersion: number;
  actions: Action[];
};
type Policy = {
  id: string;
  unitName: string;
  version: number;
  label: string;
  sourceRef: string;
  missedCycles: number;
  fallbackCycleDays: number;
  from: number;
  to: number | null;
  author: string;
};
export type Dormancy = {
  asOf: string;
  canAct: boolean;
  canConfigure: boolean;
  summary: {
    open: number;
    openedLast28: number;
    openedPrior28: number;
    recoveredLast28: number;
    recoveredPrior28: number;
    withoutAction: number;
  };
  trend: { weekStart: string; opened: number; recovered: number }[];
  cases: DormancyCase[];
  policies: Policy[];
  units: { id: string; name: string }[];
};

const ACTION: Record<string, string> = {
  recovery_visit: "Recovery visit",
  win_back_offer: "Win-back offer",
  owner_review: "Owner review",
  close: "Closed",
};
const button =
  "min-h-10 rounded-[10px] border border-border px-3 py-2 text-sm disabled:opacity-40";
const card = "rounded-xl border border-border p-4";

/** F-210: the day the threshold was crossed, independent of when the daily job first saw it. */
export function crossedOn(c: DormancyCase) {
  const t =
    Date.parse(c.lastPurchaseOn + "T00:00:00Z") +
    c.thresholdCycles * c.cycleDays * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** WEB-171: one plain line per Win-back row; the rule, its version and the cycle source stay in Settings. */
export function caseLine(c: DormancyCase) {
  const cycles = `${c.missedCycles} cycle${c.missedCycles === 1 ? "" : "s"} without an order`;
  return c.status === "open"
    ? `Last bought ${shortDate(c.lastPurchaseOn)} · ${cycles} · dormant since ${shortDate(crossedOn(c))}.`
    : `Was dormant from ${shortDate(crossedOn(c))} after ${cycles}.`;
}

/** F-210: the owner's next step for one case, exceptions first. */
export function nextStep(c: DormancyCase) {
  if (c.status === "recovered")
    return `Recovered: bought again on ${formatDate(c.recoveryPurchaseOn)}.`;
  if (c.status === "closed") return `Closed: ${c.closedReason}`;
  if (!c.actions.length)
    return c.nextVisit
      ? `Brief the rep for the ${c.nextVisit} visit or record a win-back offer.`
      : "No visit is planned: plan a recovery visit.";
  const last = c.actions[c.actions.length - 1]!;
  return last.dueOn
    ? `${ACTION[last.kind]} due ${formatDate(last.dueOn)}; close the case with a reason if it will not recover.`
    : `${ACTION[last.kind]} recorded; follow it through.`;
}

const delta = (now: number, prior: number) =>
  now === prior
    ? "same as"
    : now > prior
      ? `${now - prior} more than`
      : `${prior - now} fewer than`;

/** F-210: which stores stopped buying for N of their own cycles, and who is winning them back. */
/** `part`: "cases" = dormant stores + weekly table (Win-back tab); "rules" = the rules (Settings tab). */
export function DormancyPanel({
  part = "all",
}: { part?: "all" | "cases" | "rules" } = {}) {
  const data = useApi<Dormancy>(
    ["coverage", "dormancy"],
    "/api/v1/coverage/dormancy",
  );
  useLive(["coverage"], [["coverage"]]);
  const { mutate } = useMutate();
  const keys = useRef(new Map<string, string>());
  const [open, setOpen] = useState(""),
    [kind, setKind] = useState("recovery_visit"),
    [note, setNote] = useState(""),
    [dueOn, setDueOn] = useState(currentManilaDate()),
    [unit, setUnit] = useState(""),
    [label, setLabel] = useState("Dormancy rule"),
    [source, setSource] = useState("Office"),
    [missed, setMissed] = useState(3),
    [fallback, setFallback] = useState(28),
    [from, setFrom] = useState(currentManilaDate()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function send(path: string, body: object, message: string) {
    const intent = JSON.stringify({ path, body });
    let key = keys.current.get(intent);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(intent, key);
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await mutate(
        `/api/v1/coverage/dormancy/${path}`,
        { ...body, idempotencyKey: key },
        { invalidate: [["coverage"]] },
      );
      keys.current.delete(intent);
      setNotice(message);
      setNote("");
      setOpen("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }
  if (data.error)
    return <p role="alert">Dormant stores could not be loaded.</p>;
  if (!data.data) return <p>Loading dormant stores…</p>;
  const d = data.data,
    s = d.summary,
    openCases = d.cases.filter((c) => c.status === "open");
  return (
    <section id="dormancy" aria-label="Dormant stores" className="grid gap-4">
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {part !== "rules" ? (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            {[
              [
                "Open dormant stores",
                String(s.open),
                `${s.withoutAction} without any action yet`,
              ],
              [
                "Newly detected, 28 days",
                String(s.openedLast28),
                `${delta(s.openedLast28, s.openedPrior28)} the prior 28 days (${s.openedPrior28})`,
              ],
              [
                "Recovered, 28 days",
                String(s.recoveredLast28),
                `${delta(s.recoveredLast28, s.recoveredPrior28)} the prior 28 days (${s.recoveredPrior28})`,
              ],
              ["Target", "0 without action", "Each needs a step or a reason."],
            ].map(([name, value, note]) => (
              <article key={name} className={card}>
                <p className="text-sm text-muted">{name}</p>
                <p className="text-xl font-medium">{value}</p>
                <p className="text-xs text-muted">{note}</p>
              </article>
            ))}
          </div>
          <table aria-label="Dormancy trend" className="text-sm">
            <thead>
              <tr>
                <th className="text-left">Week</th>
                <th className="text-right">Detected dormant</th>
                <th className="text-right">Recovered</th>
              </tr>
            </thead>
            <tbody>
              {d.trend.map((w) => (
                <tr key={w.weekStart}>
                  <td>{shortDate(w.weekStart)}</td>
                  <td className="text-right tabular-nums">{w.opened}</td>
                  <td className="text-right tabular-nums">{w.recovered}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.cases.length === 0 && <p>No dormant stores in your area.</p>}
          {[
            ...openCases.filter((c) => !c.actions.length),
            ...openCases.filter((c) => c.actions.length),
            ...d.cases.filter((c) => c.status !== "open"),
          ].map((c) => (
            <article key={c.id} className={card}>
              <h3 className="font-medium">
                <a
                  href={`/customers/customer?storeId=${c.storeId}`}
                  className="underline"
                >
                  {c.name}
                </a>{" "}
                · {c.code} · {c.territory}
              </h3>
              <p className="text-sm">{caseLine(c)}</p>
              <p className="text-sm font-medium">Next: {nextStep(c)}</p>
              {c.actions.length > 0 && (
                <ul className="mt-2 text-sm">
                  {c.actions.map((a, i) => (
                    <li key={i}>
                      {ACTION[a.kind]} by {a.actor}
                      {a.dueOn ? `, due ${formatDate(a.dueOn)}` : ""}: {a.note}
                    </li>
                  ))}
                </ul>
              )}
              {d.canAct && c.status === "open" && (
                <div className="mt-3">
                  {open === c.id ? (
                    <form
                      aria-label={`Act on ${c.name}`}
                      className="grid gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void send(
                          "action",
                          {
                            caseId: c.id,
                            kind,
                            note,
                            dueOn:
                              kind === "recovery_visit" ||
                              kind === "win_back_offer"
                                ? dueOn
                                : null,
                          },
                          kind === "close"
                            ? "Case closed with your reason."
                            : "Win-back action recorded.",
                        );
                      }}
                    >
                      <label className="grid gap-1 text-sm">
                        Action
                        <select
                          value={kind}
                          onChange={(e) => setKind(e.target.value)}
                        >
                          <option value="recovery_visit">
                            Plan a recovery visit
                          </option>
                          <option value="win_back_offer">
                            Make a win-back offer
                          </option>
                          <option value="owner_review">
                            Owner review note
                          </option>
                          <option value="close">Close with a reason</option>
                        </select>
                      </label>
                      {(kind === "recovery_visit" ||
                        kind === "win_back_offer") && (
                        <label className="grid gap-1 text-sm">
                          Due day
                          <input
                            type="date"
                            required
                            value={dueOn}
                            onChange={(e) => setDueOn(e.target.value)}
                          />
                        </label>
                      )}
                      <label className="grid gap-1 text-sm">
                        Note
                        <textarea
                          required
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                        />
                      </label>
                      <button
                        className={button}
                        disabled={busy || !note.trim()}
                      >
                        Save action
                      </button>
                    </form>
                  ) : (
                    <button className={button} onClick={() => setOpen(c.id)}>
                      Record win-back step
                    </button>
                  )}
                </div>
              )}
            </article>
          ))}
        </>
      ) : null}
      {part !== "cases" ? (
        <section aria-label="Dormancy rules" className="grid gap-2">
          <h3 className="font-medium">Dormancy rules</h3>
          {d.policies.map((p) => (
            <p key={p.id} className="text-sm">
              {p.unitName}: {p.label} · version {p.version} · {p.missedCycles}{" "}
              missed cycles · fallback {p.fallbackCycleDays} days ·{" "}
              {p.sourceRef} · prepared by {p.author}
            </p>
          ))}
          {d.canConfigure && (
            <form
              aria-label="Configure dormancy rule"
              className={card + " grid gap-2 sm:grid-cols-2"}
              onSubmit={(e) => {
                e.preventDefault();
                void send(
                  "policy",
                  {
                    orgUnitId: unit,
                    label,
                    sourceRef: source,
                    missedCycles: missed,
                    fallbackCycleDays: fallback,
                    fromDate: from,
                  },
                  "Dormancy rule saved. It applies from the chosen day.",
                );
              }}
            >
              <label className="grid gap-1 text-sm">
                Team
                <select
                  required
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                >
                  <option value="">Choose team</option>
                  {d.units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Rule label
                <input
                  required
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              <label className="grid gap-1 text-sm">
                Missed purchase cycles before dormant
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={missed}
                  onChange={(e) => setMissed(Number(e.target.value))}
                />
              </label>
              <label className="grid gap-1 text-sm">
                Fallback cycle, days (when no class or outlet cadence)
                <input
                  type="number"
                  min={7}
                  max={120}
                  value={fallback}
                  onChange={(e) => setFallback(Number(e.target.value))}
                />
              </label>
              <label className="grid gap-1 text-sm">
                Effective from
                <input
                  type="date"
                  required
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label className="grid gap-1 text-sm">
                Source / assumption
                <input
                  required
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                />
              </label>
              <button className={button} disabled={busy || !unit}>
                Save dormancy rule
              </button>
            </form>
          )}
        </section>
      ) : null}
    </section>
  );
}

/** "2026-09-15" → "Sep 15". */
export function shortDate(iso: string) {
  return formatDay(iso);
}
