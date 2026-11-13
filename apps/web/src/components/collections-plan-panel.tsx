"use client";
import { useRef, useState, type ReactNode } from "react";
import { useApi, useLive, useMutate } from "../lib/api";
import { formatDate, formatPhp } from "./cockpit/format";
import { Drawer } from "./cockpit/kit/drawer";
import { useUrlState } from "./cockpit/use-url-state";
import { CollectionEvidence } from "./collection-evidence";
import { ListPage, PAGE_SIZE, readPage } from "./list-page/list-page";
import { UrlTabs } from "./url-tabs";

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

export type MoneyTab = "promises" | "cheques" | "route" | "overview";
export const MONEY_TABS: { id: MoneyTab; label: string }[] = [
  { id: "promises", label: "Promises" },
  { id: "cheques", label: "Cheques" },
  { id: "route", label: "Collector route" },
  { id: "overview", label: "Overview" },
];
/** ?tab= for Money; anything unknown is the promises list. */
export function readMoneyTab(params: URLSearchParams): MoneyTab {
  const t = params.get("tab");
  return MONEY_TABS.some((x) => x.id === t) ? (t as MoneyTab) : "promises";
}

/** WEB-062: a settled promise shows its outcome note next to the status. */
export function promiseStatusText(
  p: Pick<Promise_, "status" | "overdue" | "outcomeNote">,
): string {
  const note = p.status !== "open" ? p.outcomeNote?.trim() : "";
  return note ? `${promiseStatus(p)} · ${note}` : promiseStatus(p);
}

export function promiseStatus(p: Pick<Promise_, "status" | "overdue">) {
  if (p.status === "open") return p.overdue ? "Overdue" : "Open";
  return p.status[0]!.toUpperCase() + p.status.slice(1);
}
export function promiseFilter(p: Pick<Promise_, "status" | "overdue">) {
  return p.status === "open" && p.overdue ? "overdue" : p.status;
}
/** Search + filter + one page of rows, all on the client (the API returns the whole list). */
export function pageOf<T>(
  rows: T[],
  {
    q,
    filter,
    page,
    text,
    group,
  }: {
    q: string;
    filter: string | null;
    page: number;
    text: (r: T) => string;
    group: (r: T) => string;
  },
) {
  const needle = q.trim().toLowerCase();
  const hits = rows.filter(
    (r) =>
      (!filter || group(r) === filter) &&
      (!needle || text(r).toLowerCase().includes(needle)),
  );
  return {
    total: hits.length,
    rows: hits.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
  };
}
/** What can happen next to a cheque; empty means no Edit. */
export function chequeNext(q: Pick<Cheque, "status" | "postDated">) {
  if (q.status === "received" && !q.postDated) return ["deposited"] as const;
  if (q.status === "deposited") return ["cleared", "bounced"] as const;
  return [] as const;
}
const count = <T,>(rows: T[], group: (r: T) => string, id: string) =>
  rows.filter((r) => group(r) === id).length;

const field = "grid gap-1 text-sm";
const input =
  "min-h-10 w-full min-w-0 rounded-[10px] border border-border bg-surface px-3 py-2 text-sm";
const primary =
  "min-h-10 rounded-[10px] bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:opacity-40";
const editButton =
  "min-h-9 rounded-[10px] border border-border px-3 py-1.5 text-sm font-medium";

function FormBar({
  onCancel,
  disabled,
  why,
}: {
  onCancel: () => void;
  disabled: boolean;
  why?: string;
}) {
  return (
    <div className="sticky bottom-0 grid gap-1 border-t border-separator bg-surface pt-3">
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={disabled}>
          Save
        </button>
        <button type="button" className={button} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {disabled && why ? <p className="text-xs text-muted">{why}</p> : null}
    </div>
  );
}

/** F-613: Money → promises, cheques, collector route, and an Overview tab with the figures. */
export function CollectionsPlanPanel({ overview }: { overview?: ReactNode }) {
  const { params, set } = useUrlState();
  const tab = readMoneyTab(params);
  const [routeDate, setRouteDate] = useState("");
  const data = useApi<Collections>(
    ["money", "collections", routeDate],
    `/api/v1/money/collections${routeDate ? `?date=${routeDate}` : ""}`,
  );
  useLive(["analytics"], [["money"]]);
  const { mutate } = useMutate();
  const keys = useRef(new Map<string, string>());
  const [drawer, setDrawer] = useState<
    | { kind: "add-promise" }
    | { kind: "add-cheque" }
    | { kind: "edit-promise"; id: string }
    | { kind: "edit-cheque"; id: string }
    | null
  >(null);
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
    [outcome, setOutcome] = useState(""),
    [outcomeNote, setOutcomeNote] = useState(""),
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
  const open = (next: typeof drawer) => {
    setError("");
    setOutcome("");
    setOutcomeNote("");
    setDrawer(next);
  };
  const close = () => setDrawer(null);
  const q = params.get("q") ?? "";
  const filter = params.get("status");
  const page = readPage(params);
  const listProps = {
    page,
    onPage: (n: number) => set({ page: n > 1 ? String(n) : null }),
    q,
    onSearch: (v: string) =>
      set({ q: v || null, page: null }, { replace: true }),
    filter,
    onFilter: (id: string | null) => set({ status: id, page: null }),
  };
  const tabs = (
    <UrlTabs
      label="Money"
      tabs={MONEY_TABS}
      tab={tab}
      onTab={(t) =>
        set({
          tab: t === "promises" ? null : t,
          q: null,
          page: null,
          status: null,
        })
      }
    />
  );
  if (tab === "overview")
    return (
      <div className="grid gap-4">
        {tabs}
        {overview}
        {data.data ? <CollectionsSummary data={data.data} /> : null}
      </div>
    );
  if (data.error)
    return (
      <div className="grid gap-4">
        {tabs}
        <p role="alert">Money could not be loaded.</p>
      </div>
    );
  if (!data.data)
    return (
      <div className="grid gap-4">
        {tabs}
        <p>Loading…</p>
      </div>
    );
  const d = data.data;
  const chosen = d.customers.find((c) => c.customerCode === customer);
  const suggestions = suggestedStops(d.actions);
  const stops = (picked ?? suggestions.slice(0, 12).map((x) => x.customerCode))
    .map((code) => suggestions.find((x) => x.customerCode === code))
    .filter((x): x is NonNullable<typeof x> => !!x);
  const bounced = d.cheques.filter((x) => x.status === "bounced");
  const editingPromise =
    drawer?.kind === "edit-promise"
      ? d.promises.find((p) => p.id === drawer.id)
      : undefined;
  const editingCheque =
    drawer?.kind === "edit-cheque"
      ? d.cheques.find((x) => x.id === drawer.id)
      : undefined;
  const customerSelect = (
    <label className={field}>
      Store
      <select
        required
        className={input}
        value={customer}
        onChange={(e) => {
          setCustomer(e.target.value);
          setItem("");
        }}
      >
        <option value="">Choose store</option>
        {d.customers.map((c) => (
          <option key={c.customerCode} value={c.customerCode}>
            {c.name} — {formatPhp(c.arMinor)} owed
          </option>
        ))}
      </select>
    </label>
  );
  const promiseText = (p: Promise_) =>
    `${p.name} ${p.customerCode} ${p.openItemLabel ?? ""} ${p.note}`;
  const chequeText = (x: Cheque) =>
    `${x.name} ${x.customerCode} ${x.bank} ${x.chequeNumber}`;
  const chequeGroup = (x: Cheque) => x.status;
  return (
    <div className="grid gap-4">
      {tabs}
      {notice && !drawer ? <p role="status">{notice}</p> : null}
      {tab === "promises" ? (
        <ListPage<Promise_>
          {...listProps}
          {...pageOf(d.promises, {
            q,
            filter,
            page,
            text: promiseText,
            group: promiseFilter,
          })}
          noun={{ one: "promise", many: "promises" }}
          searchPlaceholder="Search by store"
          onAdd={d.canPlan ? () => open({ kind: "add-promise" }) : undefined}
          filters={(["open", "overdue", "kept", "broken"] as const).map(
            (id) => ({
              id,
              label: id[0]!.toUpperCase() + id.slice(1),
              count: count(d.promises, promiseFilter, id),
            }),
          )}
          rowKey={(p) => p.id}
          columns={[
            {
              key: "store",
              label: "Store",
              primary: true,
              render: (p) => p.name,
              text: (p) => p.name,
            },
            {
              key: "item",
              label: "For",
              render: (p) => p.openItemLabel ?? "Whole balance",
              text: (p) => p.openItemLabel ?? "Whole balance",
            },
            {
              key: "amount",
              label: "Amount",
              align: "right",
              render: (p) => formatPhp(p.amountMinor),
              text: (p) => (p.amountMinor / 100).toFixed(2),
            },
            {
              key: "on",
              label: "Pay by",
              render: (p) => formatDate(p.promisedOn),
              text: (p) => p.promisedOn,
            },
            {
              key: "status",
              label: "Status",
              render: (p) => promiseStatusText(p),
              text: (p) => promiseStatusText(p),
            },
            {
              key: "edit",
              label: "",
              align: "right",
              render: (p) =>
                d.canPlan && p.status === "open" ? (
                  <button
                    type="button"
                    className={editButton}
                    onClick={() => open({ kind: "edit-promise", id: p.id })}
                  >
                    Edit
                  </button>
                ) : null,
            },
          ]}
        />
      ) : tab === "cheques" ? (
        <ListPage<Cheque>
          {...listProps}
          {...pageOf(d.cheques, {
            q,
            filter,
            page,
            text: chequeText,
            group: chequeGroup,
          })}
          noun={{ one: "cheque", many: "cheques" }}
          searchPlaceholder="Search by store, bank or cheque number"
          onAdd={d.canPlan ? () => open({ kind: "add-cheque" }) : undefined}
          filters={(
            ["received", "deposited", "cleared", "bounced"] as const
          ).map((id) => ({
            id,
            label: id[0]!.toUpperCase() + id.slice(1),
            count: count(d.cheques, chequeGroup, id),
          }))}
          rowKey={(x) => x.id}
          columns={[
            {
              key: "store",
              label: "Store",
              primary: true,
              render: (x) => x.name,
              text: (x) => x.name,
            },
            {
              key: "cheque",
              label: "Cheque",
              render: (x) => `${x.bank} ${x.chequeNumber}`,
              text: (x) => `${x.bank} ${x.chequeNumber}`,
            },
            {
              key: "amount",
              label: "Amount",
              align: "right",
              render: (x) => formatPhp(x.amountMinor),
              text: (x) => (x.amountMinor / 100).toFixed(2),
            },
            {
              key: "date",
              label: "Date",
              render: (x) =>
                `${formatDate(x.chequeDate)}${x.postDated ? " · post-dated" : ""}`,
              text: (x) => x.chequeDate,
            },
            {
              key: "status",
              label: "Status",
              render: (x) => x.status[0]!.toUpperCase() + x.status.slice(1),
              text: (x) => x.status,
            },
            {
              key: "edit",
              label: "",
              align: "right",
              render: (x) =>
                d.canPlan && chequeNext(x).length ? (
                  <button
                    type="button"
                    className={editButton}
                    onClick={() => open({ kind: "edit-cheque", id: x.id })}
                  >
                    Edit
                  </button>
                ) : null,
            },
          ]}
        />
      ) : (
        <section aria-label="Collector route" className="grid gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className={field}>
              Day
              <input
                type="date"
                className={input}
                min={d.asOf}
                value={routeDate || d.routeDate}
                onChange={(e) => setRouteDate(e.target.value)}
              />
            </label>
            {d.canPlan && (
              <label className={field}>
                Collector
                <select
                  className={input}
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
          {error ? <p role="alert">{error}</p> : null}
          {d.routes.length === 0 ? (
            <p className="text-sm text-muted">
              No route for {formatDate(d.routeDate)}.
            </p>
          ) : null}
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
                Most urgent first. Untick to skip.
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
                className={primary}
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
                Save
              </button>
            </div>
          )}
        </section>
      )}
      <Drawer
        open={drawer?.kind === "add-promise"}
        title="Add promise"
        onClose={close}
      >
        <form
          aria-label="Add promise"
          className="grid gap-3"
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
                "Promise saved.",
                true,
              )
            ) {
              setAmount("");
              setNote("");
              close();
            }
          }}
        >
          {customerSelect}
          <label className={field}>
            For
            <select
              className={input}
              value={item}
              onChange={(e) => setItem(e.target.value)}
            >
              <option value="">Whole balance</option>
              {chosen?.openItems.map((i) => (
                <option key={i.ref} value={i.ref}>
                  Due {formatDate(i.dueDate)} — {formatPhp(i.remainingMinor)}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            Amount (₱)
            <input
              required
              className={input}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className={field}>
            Pay by
            <input
              required
              className={input}
              type="date"
              min={d.asOf}
              value={promisedOn}
              onChange={(e) => setPromisedOn(e.target.value)}
            />
          </label>
          <label className={field}>
            Note
            <input
              required
              className={input}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <FormBar
            onCancel={close}
            disabled={busy || !customer || pesos(amount) == null}
            why={!customer ? "Pick a store first" : "Type an amount"}
          />
        </form>
      </Drawer>
      <Drawer
        open={drawer?.kind === "add-cheque"}
        title="Add cheque"
        onClose={close}
      >
        <form
          aria-label="Add cheque"
          className="grid gap-3"
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
                "Cheque saved.",
                true,
              )
            ) {
              setCheque({
                number: "",
                bank: "",
                amount: "",
                date: "",
                replaces: "",
              });
              close();
            }
          }}
        >
          {customerSelect}
          <label className={field}>
            Bank
            <input
              required
              className={input}
              value={cheque.bank}
              onChange={(e) => setCheque({ ...cheque, bank: e.target.value })}
            />
          </label>
          <label className={field}>
            Cheque number
            <input
              required
              className={input}
              value={cheque.number}
              onChange={(e) => setCheque({ ...cheque, number: e.target.value })}
            />
          </label>
          <label className={field}>
            Amount (₱)
            <input
              required
              className={input}
              inputMode="decimal"
              value={cheque.amount}
              onChange={(e) => setCheque({ ...cheque, amount: e.target.value })}
            />
          </label>
          <label className={field}>
            Cheque date
            <input
              required
              className={input}
              type="date"
              value={cheque.date}
              onChange={(e) => setCheque({ ...cheque, date: e.target.value })}
            />
          </label>
          {bounced.some((x) => x.customerCode === customer) ? (
            <label className={field}>
              Replaces bounced
              <select
                className={input}
                value={cheque.replaces}
                onChange={(e) =>
                  setCheque({ ...cheque, replaces: e.target.value })
                }
              >
                <option value="">None</option>
                {bounced
                  .filter((x) => x.customerCode === customer)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.bank} {x.chequeNumber}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          <FormBar
            onCancel={close}
            disabled={busy || !customer}
            why="Pick a store first"
          />
        </form>
      </Drawer>
      <Drawer
        open={!!editingPromise}
        title={`Edit promise · ${editingPromise?.name ?? ""}`}
        onClose={close}
      >
        {editingPromise ? (
          <form
            aria-label="Edit promise"
            className="grid gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await post(
                  "promise/settle",
                  {
                    promiseId: editingPromise.id,
                    outcome,
                    note: outcomeNote,
                  },
                  "Promise saved.",
                )
              )
                close();
            }}
          >
            <p className="text-sm">
              {formatPhp(editingPromise.amountMinor)} by{" "}
              {formatDate(editingPromise.promisedOn)} ·{" "}
              {promiseStatus(editingPromise)}
            </p>
            <label className={field}>
              Outcome
              <select
                required
                className={input}
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              >
                <option value="">Choose</option>
                <option value="kept">Kept</option>
                {editingPromise.overdue ? (
                  <option value="broken">Broken</option>
                ) : null}
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            <label className={field}>
              Note
              <input
                required
                className={input}
                value={outcomeNote}
                onChange={(e) => setOutcomeNote(e.target.value)}
              />
            </label>
            {d.canPlan ? (
              <CollectionEvidence kind="promise" id={editingPromise.id} />
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
            <FormBar
              onCancel={close}
              disabled={busy || !outcome || !outcomeNote.trim()}
              why="Pick an outcome and add a note"
            />
          </form>
        ) : null}
      </Drawer>
      <Drawer
        open={!!editingCheque}
        title={`Edit cheque · ${editingCheque ? `${editingCheque.bank} ${editingCheque.chequeNumber}` : ""}`}
        onClose={close}
      >
        {editingCheque ? (
          <form
            aria-label="Edit cheque"
            className="grid gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await post(
                  "cheque/event",
                  {
                    chequeId: editingCheque.id,
                    kind: outcome,
                    ...(outcome === "bounced" ? { note: outcomeNote } : {}),
                  },
                  "Cheque saved.",
                )
              )
                close();
            }}
          >
            <p className="text-sm">
              {editingCheque.name} · {formatPhp(editingCheque.amountMinor)} ·{" "}
              {formatDate(editingCheque.chequeDate)}
            </p>
            <label className={field}>
              Status
              <select
                required
                className={input}
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              >
                <option value="">Choose</option>
                {chequeNext(editingCheque).map((k) => (
                  <option key={k} value={k}>
                    {k[0]!.toUpperCase() + k.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            {outcome === "bounced" ? (
              <label className={field}>
                Bounce reason
                <input
                  required
                  className={input}
                  value={outcomeNote}
                  onChange={(e) => setOutcomeNote(e.target.value)}
                />
              </label>
            ) : null}
            {d.canPlan ? (
              <CollectionEvidence kind="cheque" id={editingCheque.id} />
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
            <FormBar
              onCancel={close}
              disabled={
                busy ||
                !outcome ||
                (outcome === "bounced" && !outcomeNote.trim())
              }
              why={!outcome ? "Pick a status" : "Add the bounce reason"}
            />
          </form>
        ) : null}
      </Drawer>
    </div>
  );
}

/** Overview tab: collection figures and what needs action. */
export function CollectionsSummary({ data: d }: { data: Collections }) {
  const s = d.summary;
  const rate = keptRate(s.keptLast28, s.brokenLast28);
  return (
    <section aria-label="Collections" className="grid gap-4">
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
            `${formatPhp(s.dueThisWeekMinor)} due this week`,
          ],
          [
            "Promises kept, 28 days",
            rate == null ? "—" : `${rate}%`,
            `${s.keptLast28} kept, ${s.brokenLast28} broken`,
          ],
          ["Post-dated cheques", formatPhp(s.postDatedMinor), ""],
          ["Bounced, not replaced", String(s.bouncedOpen), ""],
        ].map(([label, value, sub]) => (
          <article key={label} className={card}>
            <p className="text-sm text-muted">{label}</p>
            <p className="text-xl font-medium tabular-nums">{value}</p>
            {sub ? <p className="text-xs text-muted">{sub}</p> : null}
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
              {a.name ?? a.customerCode} · {formatPhp(a.amountMinor)} ·{" "}
              {formatDate(a.on)}. {a.next}
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
