"use client";

import { Button } from "@heroui/react";
import Link from "next/link";
import { Card, FormField, Pager, WorkspaceIcon } from "@sunpride/ui";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { apiFetch, mutate, useApi, useLive } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import { manilaToday } from "../../lib/outside-calls";
import {
  creditLabel,
  money,
  stage,
  type OrderDetail,
  type OrderPage,
} from "./model";

type TargetContext = {
  kpis: { key: string; value: number | null; target?: number | null }[];
};
type Options = Record<
  "people" | "customers" | "channels" | "territories",
  { value: string; label: string }[]
>;
type FieldReview = {
  rows: {
    id: string;
    storeName: string;
    salespersonName: string;
    serviceDate: string;
    status: string;
    reason: string;
  }[];
  total: number;
  truncated: boolean;
};
type Filters = {
  from: string;
  to: string;
  status: string;
  salesperson: string;
  customer: string;
  channel: string;
  territory: string;
  q: string;
  view: string;
};
const initial = (): Filters => ({
  from: `${manilaToday().slice(0, 7)}-01`,
  to: manilaToday(),
  status: "",
  salesperson: "",
  customer: "",
  channel: "",
  territory: "",
  q: "",
  view: "",
});
export const SAVED_VIEWS = [
  "Waiting for my approval",
  "Today",
  "Over credit",
  "Rejected this week",
] as const;
export function savedView(name: string): Partial<Filters> {
  const today = manilaToday();
  const monday = new Date(`${today}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  if (name === "Waiting for my approval")
    return { view: "waiting", status: "pending_approval" };
  if (name === "Today") return { view: "", from: today, to: today, status: "" };
  if (name === "Over credit") return { view: "over", status: "" };
  return {
    view: "rejected",
    status: "rejected",
    from: monday.toISOString().slice(0, 10),
    to: today,
  };
}
function queryFor(filters: Filters, cursor?: string) {
  return Object.fromEntries(
    Object.entries({ ...filters, cursor }).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].length > 0,
    ),
  );
}

/** Which orders need a decision, and what is keeping booked sales from moving? */
export function OrdersWorkspace({
  initialOrderId = null,
}: { initialOrderId?: string | null } = {}) {
  const { can } = usePermissions();
  const [filters, setFilters] = useState(initial);
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(initialOrderId);
  const closeDrawer = useCallback(() => setSelected(null), []);
  const params = queryFor(filters, cursors.at(-1));
  const list = useApi<OrderPage>(
    can("report.read") ? ["orders", "list", params] : null,
    ({ signal }) => apiFetch("/api/v1/orders/list", { query: params, signal }),
  );
  const wholeSalesView =
    !filters.status &&
    !filters.salesperson &&
    !filters.customer &&
    !filters.territory &&
    !filters.q &&
    !filters.view;
  const targetQuery = {
    from: filters.from,
    to: filters.to,
    channel: filters.channel || undefined,
    groupBy: "channel",
  };
  const targetContext = useApi<TargetContext>(
    can("report.read") && wholeSalesView
      ? ["orders", "target-context", targetQuery]
      : null,
    ({ signal }) =>
      apiFetch("/api/v1/analytics/sales", { query: targetQuery, signal }),
  );
  const options = useApi<Options>(
    can("report.read") ? ["orders", "filter-options"] : null,
    "/api/v1/orders/filter-options",
  );
  const review = useApi<FieldReview>(
    can("report.read") ? ["orders", "field-review"] : null,
    "/api/v1/orders/field-review",
  );
  const retryKeys = useRef(new Map<string, string>());
  const [retryError, setRetryError] = useState("");
  const [retryBusy, setRetryBusy] = useState<string | null>(null);
  async function retryField(id: string) {
    if (retryBusy) return;
    const key = retryKeys.current.get(id) ?? crypto.randomUUID();
    retryKeys.current.set(id, key);
    setRetryBusy(id);
    setRetryError("");
    try {
      await mutate(
        "/api/v1/orders/field-review/retry",
        { id, idempotencyKey: key },
        { invalidate: [["orders"]] },
      );
      retryKeys.current.delete(id);
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : "Retry was not queued");
    } finally {
      setRetryBusy(null);
    }
  }
  useLive(["orders", "analytics"], [["orders"]]);
  if (!can("report.read")) return null;
  const data = list.error ? undefined : list.data;
  const summary = data?.summary;
  const target = !targetContext.error
    ? (targetContext.data?.kpis.find((k) => k.key === "target")?.value ??
      targetContext.data?.kpis.find((k) => k.key === "sales")?.target ??
      null)
    : null;
  function apply(next: Filters) {
    setFilters(next);
    setCursors([]);
    setSelected(null);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?${new URLSearchParams(queryFor(next))}`,
    );
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const next = { ...filters, view: "" };
    for (const key of Object.keys(filters) as (keyof Filters)[])
      if (form.has(key)) next[key] = String(form.get(key) ?? "");
    apply(next);
  }
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted">
            Commercial control
          </p>
          <h2 className="text-xl font-semibold">Move booked orders forward</h2>
          <p className="text-sm text-muted">
            Approval holds and missing prices first. Captured orders are not
            invoiced revenue.
          </p>
        </div>
        <Link className="text-sm underline" href="/outside-calls">
          Encode an outside-call PO
        </Link>
      </header>
      {(review.error || options.error || retryError) && (
        <p role="alert">
          {retryError || review.error?.message || options.error?.message}
        </p>
      )}
      {!review.error && !!review.data?.total && (
        <section
          aria-label="Field order review"
          className="rounded-xl border border-border p-4"
        >
          <h3 className="font-medium">
            {review.data.total} captured phone orders waiting for commercial
            review
          </h3>
          <ul className="mt-2 grid gap-2">
            {review.data.rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap justify-between gap-2 text-sm"
              >
                <div>
                  <p>
                    {r.storeName} · {r.salespersonName} · {r.serviceDate}
                  </p>
                  <p className="text-xs text-muted">{r.reason}</p>
                </div>
                {r.status === "review" && can("order.encode") && (
                  <Button
                    variant="outline"
                    size="sm"
                    isDisabled={!!retryBusy}
                    onPress={() => void retryField(r.id)}
                  >
                    Retry after setup
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {review.data.truncated && (
            <p className="text-sm text-muted">
              Showing the first 100; remaining captured orders stay in the
              review queue.
            </p>
          )}
        </section>
      )}
      <div aria-label="Saved order views" className="flex flex-wrap gap-2">
        {SAVED_VIEWS.map((name) => (
          <Button
            key={name}
            variant="outline"
            size="sm"
            onPress={() => apply({ ...initial(), ...savedView(name) })}
          >
            {name}
          </Button>
        ))}
      </div>
      {list.error ? (
        <p role="alert">
          {list.error.message}{" "}
          <Button variant="outline" onPress={() => void list.refetch()}>
            Try again
          </Button>
        </p>
      ) : (
        <>
          <div
            className="grid gap-3 sm:grid-cols-4"
            aria-label="Order control summary"
          >
            <div className="rounded-xl border border-border p-4">
              <p className="text-sm text-muted">Booked value</p>
              <strong>
                {summary ? money(summary.totalCentavos) : "Loading…"}
              </strong>
              <p className="text-xs text-muted">
                Prior period:{" "}
                {summary ? money(summary.priorCentavos) : "Loading…"}
              </p>
              <p className="text-xs text-muted">
                {!wholeSalesView
                  ? "Targets apply to the unfiltered sales view."
                  : `Target: ${money(target)}`}
              </p>
              {wholeSalesView &&
                target !== null &&
                target > 0 &&
                summary?.totalCentavos != null && (
                  <p className="text-xs text-muted">
                    {((summary.totalCentavos / target) * 100).toFixed(1)}% of
                    period target
                  </p>
                )}
              <Link href="/sales-targets" className="text-xs underline">
                {target === null ? "Set target" : "Review target"}
              </Link>
            </div>
            <div className="rounded-xl border border-border p-4">
              <p className="text-sm text-muted">Waiting for approval</p>
              <strong>{summary?.waiting ?? "—"}</strong>
              <p className="text-xs text-muted">Open an order to decide</p>
            </div>
            <div className="rounded-xl border border-border p-4">
              <p className="text-sm text-muted">Over credit</p>
              <strong>{summary?.overCredit ?? "—"}</strong>
              <p className="text-xs text-muted">
                Review exposure and explain the decision
              </p>
            </div>
            <div className="rounded-xl border border-border p-4">
              <p className="text-sm text-muted">Missing prices</p>
              <strong>{summary?.unpriced ?? "—"}</strong>
              <Link href="/pricing" className="ml-2 text-xs underline">
                Fix channel prices
              </Link>
            </div>
          </div>
          {data && (
            <div className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-medium">
                Booked trend · {data.period.from} to {data.period.to}
              </h3>
              {data.trend.length ? (
                <ol
                  aria-label="Daily booked value"
                  className="mt-3 flex items-end gap-2 overflow-x-auto"
                >
                  {data.trend.map((d) => (
                    <li key={d.date} className="min-w-20 flex-1 text-xs">
                      <div
                        className="bg-foreground/15"
                        style={{
                          height: `${d.totalCentavos == null ? 2 : Math.max(2, (d.totalCentavos / Math.max(1, ...data.trend.map((x) => x.totalCentavos ?? 0))) * 70)}px`,
                        }}
                      />
                      <p>{d.date.slice(5)}</p>
                      <p>{money(d.totalCentavos)}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted">
                  No booked orders in this period. This is zero activity, not a
                  target result.
                </p>
              )}
            </div>
          )}
        </>
      )}
      <Card label="Orders" icon={<WorkspaceIcon name="commercial" />}>
        <form
          onSubmit={submit}
          className="grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-5"
          aria-label="Order filters"
          key={JSON.stringify(filters)}
        >
          <FormField label="From">
            <input
              type="date"
              name="from"
              defaultValue={filters.from}
              required
            />
          </FormField>
          <FormField label="To">
            <input type="date" name="to" defaultValue={filters.to} required />
          </FormField>
          <FormField label="Stage">
            <select name="status" defaultValue={filters.status}>
              <option value="">All stages</option>
              {[
                "draft",
                "submitted",
                "pending_approval",
                "approved",
                "posted",
                "fulfilled",
                "rejected",
                "voided",
              ].map((s) => (
                <option key={s} value={s}>
                  {stage(s)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Search">
            <input
              name="q"
              defaultValue={filters.q}
              placeholder="Order, account or person"
            />
          </FormField>
          {(
            [
              ["channel", "Channel", "channels"],
              ["salesperson", "Salesperson", "people"],
              ["customer", "Customer", "customers"],
              ["territory", "Territory", "territories"],
            ] as const
          ).map(([key, label, source]) => (
            <FormField key={key} label={label}>
              <select name={key} defaultValue={filters[key]}>
                <option value="">All</option>
                {options.data?.[source].map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </select>
            </FormField>
          ))}
          <div className="flex items-end gap-2">
            <Button type="submit">Apply filters</Button>
            <a
              className="text-sm underline"
              href={`/api/v1/orders/list?${new URLSearchParams({ ...queryFor(filters), format: "csv" })}`}
            >
              Export CSV
            </a>
          </div>
        </form>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {[
                  "Order / date",
                  "Customer",
                  "Salesperson / area",
                  "Stage",
                  "Booked value",
                  "Credit",
                ].map((s) => (
                  <th
                    key={s}
                    className="border-y border-border p-3 font-medium"
                  >
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!list.error &&
                data?.rows.map((r) => (
                  <tr key={r.id} className="border-b border-border">
                    <td className="p-3">
                      <button
                        className="underline"
                        onClick={() => setSelected(r.id)}
                      >
                        {r.orderNumber}
                      </button>
                      <p className="text-xs text-muted">{r.serviceDate}</p>
                    </td>
                    <td className="p-3">
                      {r.customerName}
                      <p className="text-xs text-muted">{r.customerCode}</p>
                    </td>
                    <td className="p-3">
                      {r.salespersonName}
                      <p className="text-xs text-muted">
                        {r.territoryName ?? "Area needs setup"} ·{" "}
                        {r.channel ?? "Channel needs setup"}
                      </p>
                    </td>
                    <td className="p-3">{stage(r.status)}</td>
                    <td className="p-3 tabular-nums">
                      {money(r.totalCentavos)}
                    </td>
                    <td className="p-3">{creditLabel(r.creditStatus)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!data && !list.error && (
          <p className="p-4 text-sm text-muted">Loading orders…</p>
        )}
        {data?.rows.length === 0 && !list.error && (
          <p className="p-4 text-sm text-muted">
            No orders match. Widen the period or encode a PO.
          </p>
        )}
        <div className="p-4">
          <Pager
            page={cursors.length + 1}
            canPrevious={cursors.length > 0}
            canNext={!!data?.next && !list.error}
            onPrevious={() => setCursors((x) => x.slice(0, -1))}
            onNext={() => data?.next && setCursors((x) => [...x, data.next!])}
            label="Order pages"
          />
        </div>
      </Card>
      {selected && <OrderDrawer id={selected} onClose={closeDrawer} />}
    </div>
  );
}

/** Escape, focus trap, visible close and focus restoration are part of the drawer contract. */
export function drawerKeys(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
  root: HTMLElement,
  close: () => void,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== "Tab") return;
  const controls = Array.from(
    root.querySelectorAll<HTMLElement>(
      "button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex='0']",
    ),
  );
  const first = controls[0],
    last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
export function OrderDrawer({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const result = useApi<OrderDetail>(["orders", "detail", id], ({ signal }) =>
    apiFetch("/api/v1/orders/detail", { query: { id }, signal }),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [financialNote, setFinancialNote] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const intent = useRef<{ hash: string; key: string } | null>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (e: KeyboardEvent) =>
      root.current && drawerKeys(e, root.current, onClose);
    document.addEventListener("keydown", keydown);
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = oldOverflow;
      prior?.focus();
    };
  }, [onClose]);
  async function decide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const action = String(form.get("decision"));
    const reason = String(form.get("reason") ?? "").trim();
    if (!reason) {
      setError("Add a reason for the decision.");
      return;
    }
    const hash = JSON.stringify([id, action, reason]);
    if (intent.current?.hash !== hash)
      intent.current = { hash, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      await mutate(
        `/api/v1/orders/${action}`,
        { id, reason, idempotencyKey: intent.current.key },
        { invalidate: [["orders"]] },
      );
      await result.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision was not saved");
    } finally {
      setBusy(false);
    }
  }
  const d = result.error ? undefined : result.data;
  return (
    <div className="fixed inset-0 z-50 bg-black/30">
      <aside
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label="Order detail"
        className="ml-auto h-full w-full max-w-2xl overflow-y-auto border-l border-border bg-surface p-6 shadow-xl"
      >
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-semibold">
            {d?.orderNumber ?? "Order detail"}
          </h2>
          <Button
            variant="outline"
            onPress={onClose}
            aria-label="Close order detail"
          >
            Close
          </Button>
        </div>
        {result.error ? (
          <p role="alert">{result.error.message}</p>
        ) : !d ? (
          <p>Loading detail…</p>
        ) : (
          <div className="mt-5 grid gap-5">
            <section>
              <p>
                {d.customerName} · {d.salespersonName}
              </p>
              <p className="text-sm text-muted">
                {d.serviceDate} · {stage(d.status)} · {d.source}
              </p>
              <p className="mt-3 text-2xl font-semibold">
                {money(d.totalCentavos)}
              </p>
            </section>
            <section
              aria-label="Credit review"
              className="rounded-xl border border-border p-4"
            >
              <h3>{creditLabel(d.credit.status)}</h3>
              <p className="text-sm">
                Limit {money(d.credit.limit)} · Exposure including this order{" "}
                {money(d.credit.exposure)}
              </p>
              <p className="text-xs text-muted">{d.credit.definition}</p>
            </section>
            <section>
              <h3 className="font-medium">Order lines</h3>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-left">Product</th>
                    <th>Quantity</th>
                    <th>Price</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {d.lines.map((l, i) => (
                    <tr
                      key={`${l.productCode}:${i}`}
                      className="border-b border-border"
                    >
                      <td className="py-3">
                        {l.description}
                        <p className="text-xs text-muted">{l.productCode}</p>
                      </td>
                      <td className="text-center">
                        {l.quantity} {l.uom}
                      </td>
                      <td className="text-right">
                        {money(l.unitPriceCentavos)}
                      </td>
                      <td className="text-right">
                        {money(l.lineTotalCentavos)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section>
              <h3 className="font-medium">Pricing source</h3>
              {d.pricing ? (
                <>
                  <p className="text-sm text-muted">
                    Frozen at capture; later master edits do not change this
                    order.
                  </p>
                  <ul className="text-sm">
                    {d.pricing.lines.map((l, i) => (
                      <li key={i}>
                        {l.productCode} ·{" "}
                        {l.source === "sample"
                          ? "Sample approved price"
                          : l.source === "office"
                            ? "Office channel price"
                            : l.source === "promotion"
                              ? "Promotion free goods"
                              : "Missing or ambiguous price"}
                        {l.priceListName
                          ? ` · ${l.priceListName} (${l.priceListCode})`
                          : ""}
                      </li>
                    ))}
                  </ul>
                  <h4 className="mt-3 text-sm font-medium">
                    Promotions applied
                  </h4>
                  {d.pricing.promotionsApplied.length ? (
                    d.pricing.promotionsApplied.map((p) => (
                      <p key={p.id} className="text-sm">
                        {p.name} · Discount {money(p.discountCentavos)}
                        {p.freeGoods.length
                          ? ` · ${p.freeGoods.map((g) => `${g.quantity} ${g.uom} ${g.productName ?? "goods"} free`).join(", ")}`
                          : ""}
                      </p>
                    ))
                  ) : (
                    <p className="text-sm text-muted">No promotion applied.</p>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted">
                  Historical pricing source unavailable.
                </p>
              )}
            </section>
            <section>
              <h3 className="font-medium">History</h3>
              <ol className="mt-2 grid gap-3">
                {d.history.map((h) => (
                  <li
                    key={h.id}
                    className="border-l border-border pl-3 text-sm"
                  >
                    <p>
                      {stage(h.to)} · {h.name}
                    </p>
                    <p className="text-xs text-muted">
                      {new Date(h.at).toLocaleString("en-PH", {
                        timeZone: "Asia/Manila",
                      })}
                    </p>
                    {h.reason && <p>{h.reason}</p>}
                  </li>
                ))}
              </ol>
            </section>
            {d.canDecide && d.status === "pending_approval" && (
              <section className="space-y-2 rounded-xl border border-border p-4">
                <h3>Price and discount authority</h3>
                <p className="text-sm text-muted">
                  Approval also checks the original requester's current role,
                  channel and value band. Send the frozen source to Finance if a
                  higher authority is needed.
                </p>
                <Button
                  variant="outline"
                  isDisabled={busy}
                  onPress={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const response = await mutate<{
                        requiresSecond: boolean;
                      }>(
                        "/api/v1/fiscal/commercial/request",
                        { orderId: id },
                        { invalidate: [["fiscal"]] },
                      );
                      setFinancialNote({
                        id,
                        message: response.requiresSecond
                          ? "Sent for independent Finance review. Return here after its decision."
                          : "Within the configured self limit; normal independent order approval still applies.",
                      });
                    } catch (e) {
                      setError(
                        e instanceof Error
                          ? e.message
                          : "Financial review was not requested",
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Request financial review
                </Button>
                {financialNote?.id === id && (
                  <p role="status">{financialNote.message}</p>
                )}
              </section>
            )}
            {d.canDecide && (
              <form
                onSubmit={decide}
                className="grid gap-3 rounded-xl border border-border p-4"
              >
                <FormField label="Decision">
                  <select name="decision">
                    <option value="approve">Approve</option>
                    <option value="reject">Reject</option>
                  </select>
                </FormField>
                <FormField label="Reason">
                  <textarea name="reason" required maxLength={500} />
                </FormField>
                <Button type="submit" isDisabled={busy}>
                  {busy ? "Saving…" : "Save decision"}
                </Button>
                {error && <p role="alert">{error}</p>}
              </form>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
