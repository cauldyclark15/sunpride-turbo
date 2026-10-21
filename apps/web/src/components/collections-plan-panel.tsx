"use client";
import { useRef, useState } from "react";
import { useApi, useLive, useMutate } from "../lib/api";
import { formatPhp } from "./cockpit/format";
import { CollectionEvidence } from "./collection-evidence";

type Item = {
  ref: string;
  invoiceDate: string;
  dueDate: string;
  remainingMinor: number;
};
type Customer = {
  customerCode: string;
  name: string;
  territory: string | null;
  arMinor: number;
  overdueMinor: number;
  asOfDate: string;
  openItems: Item[];
  promisedMinor: number;
};
type Action = {
  kind: string;
  customerCode: string;
  name?: string;
  amountMinor: number;
  on: string;
  id: string;
  next: string;
};
type Promise_ = {
  id: string;
  customerCode: string;
  name: string;
  openItemRef: string | null;
  openItemLabel: string | null;
  amountMinor: number;
  promisedOn: string;
  status: "open" | "kept" | "broken" | "cancelled";
  overdue: boolean;
  note: string;
  outcomeNote: string | null;
  createdBy: string;
};
type Cheque = {
  id: string;
  customerCode: string;
  name: string;
  chequeNumber: string;
  bank: string;
  amountMinor: number;
  chequeDate: string;
  postDated: boolean;
  status: "received" | "deposited" | "cleared" | "bounced" | "replaced";
  replacesId: string | null;
};
export type Collections = {
  asOf: string;
  source: string;
  routeDate: string;
  canPlan: boolean;
  summary: {
    arMinor: number | null;
    overdueMinor: number | null;
    openPromisesMinor: number;
    dueThisWeekMinor: number;
    overduePromises: number;
    keptLast28: number;
    brokenLast28: number;
    keptPrior28: number;
    brokenPrior28: number;
    postDatedMinor: number;
    bouncedOpen: number;
  };
  actions: Action[];
  actionsTotal: number;
  customers: Customer[];
  customersTotal: number;
  promises: Promise_[];
  cheques: Cheque[];
  routes: {
    collectorId: string;
    collector: string;
    stops: {
      sequence: number;
      customerCode: string;
      name: string;
      reason: string;
    }[];
  }[];
  collectors: { id: string; name: string }[];
};

const ACTION: Record<string, string> = {
  cheque_replacement: "Bounced cheque",
  promise_overdue: "Promise overdue",
  cheque_deposit: "Cheque ready to deposit",
  overdue_balance: "Over 60 days, no promise",
};
const REASON_FOR: Record<string, string> = {
  cheque_replacement: "cheque_replacement",
  promise_overdue: "promise_overdue",
  cheque_deposit: "cheque_pickup",
  overdue_balance: "overdue_balance",
};
const REASON: Record<string, string> = {
  promise_due: "Promise due",
  promise_overdue: "Promise overdue",
  cheque_pickup: "Cheque pickup",
  cheque_replacement: "Replace bounced cheque",
  overdue_balance: "Overdue balance",
  manual: "Planned visit",
};
const button =
  "min-h-10 rounded-[10px] border border-border px-3 py-2 text-sm disabled:opacity-40";
const card = "rounded-xl border border-border p-3";

/** F-613: kept rate over settled promises; null when nothing was settled. */
export function keptRate(kept: number, broken: number) {
  return kept + broken ? Math.round((kept / (kept + broken)) * 100) : null;
}
/** F-613: peso text to centavos. */
export function pesos(text: string) {
  const t = text.replace(/[,₱\s]/g, "");
  return /^\d+(\.\d{1,2})?$/.test(t) && Number(t) > 0
    ? Math.round(Number(t) * 100)
    : null;
}
/** F-613: suggested route stops from the exception list, one per customer, in priority order. */
export function suggestedStops(actions: Action[]) {
  const seen = new Set<string>();
  return actions
    .filter((a) =>
      seen.has(a.customerCode) ? false : (seen.add(a.customerCode), true),
    )
    .map((a) => ({
      customerCode: a.customerCode,
      name: a.name ?? a.customerCode,
      reason: REASON_FOR[a.kind] ?? "manual",
    }));
}

/** F-613: Money → Collections plan. */
export function CollectionsPlanPanel() {
  const [routeDate, setRouteDate] = useState("");
  const data = useApi<Collections>(
    ["money", "collections", routeDate],
    `/api/v1/money/collections${routeDate ? `?date=${routeDate}` : ""}`,
  );
  useLive(["analytics"], [["money"]]);
  const { mutate } = useMutate();
  const keys = useRef(new Map<string, string>());
  const [customer, setCustomer] = useState(""),
    [item, setItem] = useState(""),
    [amount, setAmount] = useState(""),
    [promisedOn, setPromisedOn] = useState(""),
    [note, setNote] = useState(""),
    [cheque, setCheque] = useState({
      number: "",
      bank: "",
      amount: "",
      date: "",
      replaces: "",
    }),
    [outcomeNote, setOutcomeNote] = useState<Record<string, string>>({}),
    [collector, setCollector] = useState(""),
    [picked, setPicked] = useState<string[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function post(
    path: string,
    body: object,
    message: string,
    keyed = false,
  ) {
    let payload: object = body;
    if (keyed) {
      const intent = JSON.stringify({ path, body });
      let key = keys.current.get(intent);
      if (!key) {
        key = crypto.randomUUID();
        keys.current.set(intent, key);
      }
      payload = { ...body, idempotencyKey: key };
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await mutate(`/api/v1/money/collections/${path}`, payload, {
        invalidate: [["money"]],
      });
      setNotice(message);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (data.error)
    return <p role="alert">The collections plan could not be loaded.</p>;
  if (!data.data) return <p>Loading the collections plan…</p>;
  const d = data.data,
    s = d.summary;
  const rate = keptRate(s.keptLast28, s.brokenLast28),
    prior = keptRate(s.keptPrior28, s.brokenPrior28);
  const chosen = d.customers.find((c) => c.customerCode === customer);
  const suggestions = suggestedStops(d.actions);
  const stops = (picked ?? suggestions.slice(0, 12).map((x) => x.customerCode))
    .map((code) => suggestions.find((x) => x.customerCode === code))
    .filter((x): x is NonNullable<typeof x> => !!x);
  const bounced = d.cheques.filter((q) => q.status === "bounced");
  return (
    <section
      aria-label="Collections plan"
      className="grid gap-4 rounded-xl border border-border p-4"
    >
      <header>
        <h2 className="text-lg font-medium">
          Are we collecting what customers owe, and who goes where?
        </h2>
        <p className="text-sm text-muted">
          {d.source} as of {d.asOf}. Promises, cheques and routes plan the work;
          they never change the balance.
        </p>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="grid gap-3 md:grid-cols-5">
        {[
          [
            "Overdue",
            formatPhp(s.overdueMinor),
            `of ${formatPhp(s.arMinor)} owed`,
          ],
          [
            "Promised to pay",
            formatPhp(s.openPromisesMinor),
            `${formatPhp(s.dueThisWeekMinor)} due this week; ${s.overduePromises} overdue`,
          ],
          [
            "Promises kept, 28 days",
            rate == null ? "—" : `${rate}%`,
            `${s.keptLast28} kept, ${s.brokenLast28} broken; prior 28 days ${prior == null ? "none settled" : `${prior}%`}`,
          ],
          [
            "Post-dated cheques held",
            formatPhp(s.postDatedMinor),
            "Deposit each on its date",
          ],
          ["Bounced, awaiting replacement", String(s.bouncedOpen), "Target 0"],
        ].map(([label, value, sub]) => (
          <article key={label} className={card}>
            <p className="text-sm text-muted">{label}</p>
            <p className="text-xl font-medium tabular-nums">{value}</p>
            <p className="text-xs text-muted">{sub}</p>
          </article>
        ))}
      </div>
      <section aria-label="Needs action" className="grid gap-2">
        <h3 className="font-medium">Needs action ({d.actionsTotal})</h3>
        {d.actions.length === 0 && <p className="text-sm">Nothing overdue.</p>}
        <ul className="grid gap-1 text-sm">
          {d.actions.slice(0, 20).map((a) => (
            <li key={a.kind + a.id}>
              <span className="font-medium">{ACTION[a.kind]}</span> ·{" "}
              {a.name ?? a.customerCode} · {formatPhp(a.amountMinor)} · {a.on}.{" "}
              {a.next}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Promises to pay" className="grid gap-2">
        <h3 className="font-medium">Promises to pay</h3>
        <table className="w-full text-sm [&_td]:px-2 [&_td]:py-1 [&_th]:px-2 [&_th]:py-1">
          <thead>
            <tr>
              <th className="text-left">Customer</th>
              <th className="text-left">Open item</th>
              <th className="text-right">Amount</th>
              <th className="text-left">Promised day</th>
              <th className="text-left">Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.promises.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.name}
                  {d.canPlan && <CollectionEvidence kind="promise" id={p.id} />}
                </td>
                <td>{p.openItemLabel ?? "Whole balance"}</td>
                <td className="text-right tabular-nums">
                  {formatPhp(p.amountMinor)}
                </td>
                <td>{p.promisedOn}</td>
                <td>
                  {p.status === "open"
                    ? p.overdue
                      ? "Overdue"
                      : "Open"
                    : `${p.status[0]!.toUpperCase()}${p.status.slice(1)}: ${p.outcomeNote}`}
                </td>
                <td>
                  {d.canPlan && p.status === "open" && (
                    <div className="flex flex-wrap items-center gap-1">
                      <input
                        aria-label={`Outcome note for ${p.name}`}
                        placeholder="Outcome note"
                        value={outcomeNote[p.id] ?? ""}
                        onChange={(e) =>
                          setOutcomeNote({
                            ...outcomeNote,
                            [p.id]: e.target.value,
                          })
                        }
                      />
                      {(
                        [
                          "kept",
                          ...(p.overdue ? ["broken"] : []),
                          "cancelled",
                        ] as const
                      ).map((o) => (
                        <button
                          key={o}
                          className={button}
                          disabled={busy || !(outcomeNote[p.id] ?? "").trim()}
                          onClick={() =>
                            post(
                              "promise/settle",
                              {
                                promiseId: p.id,
                                outcome: o,
                                note: outcomeNote[p.id],
                              },
                              "Promise updated.",
                            )
                          }
                        >
                          {o === "kept"
                            ? "Kept"
                            : o === "broken"
                              ? "Broken"
                              : "Cancel"}
                        </button>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.canPlan && (
          <form
            aria-label="Record a promise"
            className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 [&_input]:w-full [&_input]:min-w-0 [&_select]:w-full [&_select]:min-w-0"
            onSubmit={async (e) => {
              e.preventDefault();
              const minor = pesos(amount);
              if (minor == null) return;
              if (
                await post(
                  "promise",
                  {
                    customerCode: customer,
                    openItemRef: item || undefined,
                    amountMinor: minor,
                    promisedOn,
                    note,
                  },
                  "Promise recorded.",
                  true,
                )
              ) {
                setAmount("");
                setNote("");
              }
            }}
          >
            <label className="grid gap-1 text-sm">
              Customer
              <select
                required
                value={customer}
                onChange={(e) => {
                  setCustomer(e.target.value);
                  setItem("");
                }}
              >
                <option value="">Choose customer</option>
                {d.customers.map((c) => (
                  <option key={c.customerCode} value={c.customerCode}>
                    {c.name} — {formatPhp(c.arMinor)} owed
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Open item
              <select value={item} onChange={(e) => setItem(e.target.value)}>
                <option value="">Whole balance</option>
                {chosen?.openItems.map((i) => (
                  <option key={i.ref} value={i.ref}>
                    Due {i.dueDate} — {formatPhp(i.remainingMinor)}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Amount (₱)
              <input
                required
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Promised day
              <input
                required
                type="date"
                min={d.asOf}
                value={promisedOn}
                onChange={(e) => setPromisedOn(e.target.value)}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Note
              <input
                required
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <button
              className={button}
              disabled={busy || !customer || pesos(amount) == null}
            >
              Record promise
            </button>
          </form>
        )}
      </section>
      <section aria-label="Cheques" className="grid gap-2">
        <h3 className="font-medium">Cheques</h3>
        <table className="w-full text-sm [&_td]:px-2 [&_td]:py-1 [&_th]:px-2 [&_th]:py-1">
          <thead>
            <tr>
              <th className="text-left">Customer</th>
              <th className="text-left">Cheque</th>
              <th className="text-right">Amount</th>
              <th className="text-left">Cheque date</th>
              <th className="text-left">Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.cheques.map((q) => (
              <tr key={q.id}>
                <td>
                  {q.name}
                  {d.canPlan && <CollectionEvidence kind="cheque" id={q.id} />}
                </td>
                <td>
                  {q.bank} {q.chequeNumber}
                </td>
                <td className="text-right tabular-nums">
                  {formatPhp(q.amountMinor)}
                </td>
                <td>
                  {q.chequeDate}
                  {q.postDated ? " (post-dated)" : ""}
                </td>
                <td>{q.status[0]!.toUpperCase() + q.status.slice(1)}</td>
                <td>
                  {d.canPlan && q.status === "received" && !q.postDated && (
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() =>
                        post(
                          "cheque/event",
                          { chequeId: q.id, kind: "deposited" },
                          "Marked deposited.",
                        )
                      }
                    >
                      Deposited
                    </button>
                  )}
                  {d.canPlan && q.status === "deposited" && (
                    <div className="flex flex-wrap items-center gap-1">
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() =>
                          post(
                            "cheque/event",
                            { chequeId: q.id, kind: "cleared" },
                            "Marked cleared.",
                          )
                        }
                      >
                        Cleared
                      </button>
                      <input
                        aria-label={`Bounce reason for ${q.bank} ${q.chequeNumber}`}
                        placeholder="Bounce reason"
                        value={outcomeNote[q.id] ?? ""}
                        onChange={(e) =>
                          setOutcomeNote({
                            ...outcomeNote,
                            [q.id]: e.target.value,
                          })
                        }
                      />
                      <button
                        className={button}
                        disabled={busy || !(outcomeNote[q.id] ?? "").trim()}
                        onClick={() =>
                          post(
                            "cheque/event",
                            {
                              chequeId: q.id,
                              kind: "bounced",
                              note: outcomeNote[q.id],
                            },
                            "Marked bounced.",
                          )
                        }
                      >
                        Bounced
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.canPlan && (
          <form
            aria-label="Record a cheque"
            className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 [&_input]:w-full [&_input]:min-w-0 [&_select]:w-full [&_select]:min-w-0"
            onSubmit={async (e) => {
              e.preventDefault();
              const minor = pesos(cheque.amount);
              if (minor == null) return;
              if (
                await post(
                  "cheque",
                  {
                    customerCode: customer,
                    chequeNumber: cheque.number,
                    bank: cheque.bank,
                    amountMinor: minor,
                    chequeDate: cheque.date,
                    replacesId: cheque.replaces || undefined,
                  },
                  "Cheque recorded.",
                  true,
                )
              )
                setCheque({
                  number: "",
                  bank: "",
                  amount: "",
                  date: "",
                  replaces: "",
                });
            }}
          >
            <p className="text-sm sm:col-span-2 lg:col-span-3">
              Records a cheque for the customer chosen above.
            </p>
            <label className="grid gap-1 text-sm">
              Bank
              <input
                required
                value={cheque.bank}
                onChange={(e) => setCheque({ ...cheque, bank: e.target.value })}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Cheque number
              <input
                required
                value={cheque.number}
                onChange={(e) =>
                  setCheque({ ...cheque, number: e.target.value })
                }
              />
            </label>
            <label className="grid gap-1 text-sm">
              Amount (₱)
              <input
                required
                inputMode="decimal"
                value={cheque.amount}
                onChange={(e) =>
                  setCheque({ ...cheque, amount: e.target.value })
                }
              />
            </label>
            <label className="grid gap-1 text-sm">
              Cheque date
              <input
                required
                type="date"
                value={cheque.date}
                onChange={(e) => setCheque({ ...cheque, date: e.target.value })}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Replaces bounced
              <select
                value={cheque.replaces}
                onChange={(e) =>
                  setCheque({ ...cheque, replaces: e.target.value })
                }
              >
                <option value="">None</option>
                {bounced
                  .filter((q) => q.customerCode === customer)
                  .map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.bank} {q.chequeNumber}
                    </option>
                  ))}
              </select>
            </label>
            <button className={button} disabled={busy || !customer}>
              Record cheque
            </button>
          </form>
        )}
      </section>
      <section aria-label="Collector route" className="grid gap-2">
        <h3 className="font-medium">Collector route for {d.routeDate}</h3>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm">
            Day
            <input
              type="date"
              min={d.asOf}
              value={routeDate || d.routeDate}
              onChange={(e) => setRouteDate(e.target.value)}
            />
          </label>
          {d.canPlan && (
            <label className="grid gap-1 text-sm">
              Collector
              <select
                value={collector}
                onChange={(e) => setCollector(e.target.value)}
              >
                <option value="">Choose collector</option>
                {d.collectors.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {d.routes.map((r) => (
          <article key={r.collectorId} className={card}>
            <p className="text-sm font-medium">{r.collector}</p>
            <ol className="list-decimal pl-5 text-sm">
              {r.stops.map((x) => (
                <li key={x.sequence}>
                  {x.name} — {REASON[x.reason]}
                </li>
              ))}
            </ol>
          </article>
        ))}
        {d.canPlan && collector && (
          <div className="grid gap-2">
            <p className="text-sm text-muted">
              Suggested from the list above, most urgent first. Untick to drop a
              stop; order is the visiting order (no road-travel engine yet).
            </p>
            <ul className="grid gap-1 text-sm">
              {suggestions.slice(0, 30).map((x) => (
                <li key={x.customerCode}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={stops.some(
                        (y) => y.customerCode === x.customerCode,
                      )}
                      onChange={(e) => {
                        const base = stops.map((y) => y.customerCode);
                        setPicked(
                          e.target.checked
                            ? [...base, x.customerCode]
                            : base.filter((c) => c !== x.customerCode),
                        );
                      }}
                    />
                    {x.name} — {REASON[x.reason]}
                  </label>
                </li>
              ))}
            </ul>
            <button
              className={button}
              disabled={busy || stops.length === 0}
              onClick={() =>
                post(
                  "route",
                  {
                    routeDate: routeDate || d.routeDate,
                    collectorProfileId: collector,
                    stops: stops.map((x) => ({
                      customerCode: x.customerCode,
                      reason: x.reason,
                    })),
                  },
                  "Route saved.",
                )
              }
            >
              Save route ({stops.length} {stops.length === 1 ? "stop" : "stops"}
              )
            </button>
          </div>
        )}
      </section>
    </section>
  );
}
