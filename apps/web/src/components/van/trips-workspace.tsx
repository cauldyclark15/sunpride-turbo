"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@heroui/react";
import { apiFetch, useApi, useLive } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import { VanCashApproval } from "../van-cash-approval";
import { VanStockApproval } from "../van-stock-approval";
import { VanVoidApproval } from "../van-void-approval";
import { VanDamageApprovals } from "../van-damage-approvals";
import type { TripSettlement, TripsDay } from "./model";
import { CashHandIn } from "./cash-hand-in";
import { frozenQuantity } from "./format";

export function pesos(value: number | null | undefined) {
  return value === null || value === undefined
    ? "Not counted"
    : new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
      }).format(value / 100);
}
export function settlementLabel(status: string) {
  return (
    (
      {
        planned: "Planned",
        loading: "Loading",
        loaded: "Ready to depart",
        active: "On the road",
        closing: "Closing",
        reconciling: "Counted · needs close",
        review_required: "Needs review",
        needs_review: "Needs review",
        closed: "Settled",
        settled: "Settled",
        cancelled: "Cancelled",
      } as Record<string, string>
    )[status] ?? "Needs review"
  );
}
export const hasVariance = (trip: TripSettlement) =>
  Boolean(
    trip.cash.varianceCentavos ||
    trip.cash.countVarianceCentavos ||
    trip.stockCount?.varianceLines,
  );
export function tripCsv(trip: TripSettlement) {
  const rows: unknown[][] = [
    ["Trip", trip.tripNumber, "Truck", trip.truck, "Seller", trip.seller],
    [
      "Product",
      "Loaded",
      "Sold",
      "Voided",
      "Customer returns",
      "Damaged",
      "Expected on truck",
      "Counted",
      "Variance",
      "Variance centavos",
    ],
    ...trip.stock.map((r) => [
      r.name,
      r.loaded.display,
      r.sold.display,
      r.voided.display,
      r.returned.display,
      r.damaged.display,
      r.expected.display,
      r.counted?.display ?? "Not counted",
      r.variance?.display ?? "Not counted",
      r.varianceCentavos ?? "Unknown value",
    ]),
    [],
    ["Cash expected centavos", trip.cash.expectedCentavos],
    ["Cash remitted centavos", trip.cash.remittedCentavos ?? "Not counted"],
    ["Cash variance centavos", trip.cash.varianceCentavos ?? "Not counted"],
    ["Cash approved by", trip.cash.approvedBy ?? "No approval required"],
    [],
    ["Receipt", "Amount centavos", "Voided", "Reason", "Approved by"],
    ...trip.sales.map((s) => [
      s.receiptNumber,
      s.totalCentavos,
      s.voided ? "Yes" : "No",
      s.voidReason,
      s.approvedBy,
    ]),
  ];
  const cell = (v: unknown) =>
    `"${String(v ?? "")
      .replace(/^[=+\-@\t\r]/, "'$&")
      .replaceAll('"', '""')}"`;
  return (
    "\ufeff" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"
  );
}
function downloadTrip(trip: TripSettlement) {
  const url = URL.createObjectURL(
    new Blob([tripCsv(trip)], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${trip.tripNumber}-settlement.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
const tableClass =
  "w-full text-left text-sm [&_th]:px-3 [&_th]:py-3 [&_th]:font-medium [&_td]:px-3 [&_td]:py-3 [&_tr]:border-b [&_tr]:border-separator";

export function VanTripDetail({ trip }: { trip: TripSettlement }) {
  return (
    <article
      aria-label="Trip settlement"
      className="grid gap-6 rounded-xl border border-separator bg-surface p-5 print:border-0"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted">
            {trip.date} · {trip.unit} · {trip.route}
          </p>
          <h2 className="text-xl font-semibold">
            {trip.truck} · {trip.tripNumber}
          </h2>
          <p className="text-sm text-muted">
            {trip.seller} · {trip.plateNumber} · {settlementLabel(trip.status)}
          </p>
        </div>
        <div className="flex gap-2 print:hidden">
          <Button variant="outline" onPress={() => downloadTrip(trip)}>
            Export trip CSV
          </Button>
          <Button variant="outline" onPress={() => window.print()}>
            Print settlement
          </Button>
        </div>
      </header>
      <p
        className={
          hasVariance(trip)
            ? "rounded-lg border border-warning p-3 text-sm"
            : "text-sm text-muted"
        }
      >
        {trip.nextAction}
      </p>
      <section aria-label="Stock settlement" className="overflow-auto">
        <h3 className="mb-2 font-medium">Load → sales → returns → count</h3>
        <table className={tableClass}>
          <thead>
            <tr>
              {[
                "Product",
                "Loaded",
                "Sold",
                "Voided",
                "Returned",
                "Damaged",
                "Expected",
                "Counted",
                "Variance",
                "Value",
              ].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trip.stock.map((r) => (
              <tr
                key={r.productId}
                className={
                  r.variance?.base !== "0" && r.variance ? "bg-warning/5" : ""
                }
              >
                <td>
                  <strong>{r.name}</strong>
                  <small className="block text-muted">{r.code}</small>
                </td>
                <td>{r.loaded.display}</td>
                <td>{r.sold.display}</td>
                <td>{r.voided.display}</td>
                <td>{r.returned.display}</td>
                <td>{r.damaged.display}</td>
                <td>
                  {r.expected.display}
                  <small className="block text-muted">
                    Sellable {r.expectedAvailable.display} · Damaged{" "}
                    {r.expectedDamaged.display}
                  </small>
                </td>
                <td>{r.counted?.display ?? "Not counted"}</td>
                <td>{r.variance?.display ?? "Not counted"}</td>
                <td>
                  {r.varianceCentavos === null
                    ? "Cost not set"
                    : pesos(r.varianceCentavos)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-label="Cash settlement">
        <h3 className="mb-2 font-medium">
          Cash sales + collections − refunds → cash hand-in
        </h3>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {[
            ["Cash sales", trip.cash.cashSalesCentavos],
            ["Collections", trip.cash.collectionsCentavos],
            ["Refunds", trip.cash.refundsCentavos],
            ["Expected", trip.cash.expectedCentavos],
            ["Seller counted", trip.cash.declaredCentavos ?? null],
            ["Remitted", trip.cash.remittedCentavos],
            ["Variance", trip.cash.varianceCentavos],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="text-lg tabular-nums">
                {pesos(value as number | null)}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-sm text-muted">
          {trip.cash.approvedBy
            ? `Cash difference approved by ${trip.cash.approvedBy}.`
            : trip.cash.countedAt === null
              ? "Cash has not been counted."
              : "Cash count recorded."}{" "}
          {trip.stockCount?.approvedBy
            ? `Stock difference approved by ${trip.stockCount.approvedBy}.`
            : ""}
        </p>
        {trip.cash.receivedBy && (
          <p className="text-xs text-muted">
            Cash received by {trip.cash.receivedBy}.
          </p>
        )}
        <CashHandIn trip={trip} />
      </section>
      <section aria-label="Receipts and voids">
        <h3 className="font-medium">Sales, voids & discounts</h3>
        <p className="text-sm text-muted">
          Net sales {pesos(trip.salesCentavos)} · Discounts{" "}
          {pesos(trip.discountsCentavos)}. Receipts keep their original
          sale-time facts.
        </p>
        <table className={tableClass}>
          <thead>
            <tr>
              <th>Receipt</th>
              <th>Store</th>
              <th>Total</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {trip.sales.map((s) => (
              <tr key={s.saleId}>
                <td>
                  <details>
                    <summary>{s.receiptNumber}</summary>
                    <ul>
                      {s.receipt.lines.map((l, i) => (
                        <li key={i}>
                          {l.name} · {frozenQuantity(l)} ·{" "}
                          {pesos(Number(l.totalMinor))}
                        </li>
                      ))}
                    </ul>
                  </details>
                </td>
                <td>{s.receipt.customer.name}</td>
                <td>{pesos(s.totalCentavos)}</td>
                <td>
                  {s.voided
                    ? `Voided · ${s.approvedBy ?? "Approval missing"}`
                    : "Recorded"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-label="Customer returns">
        <h3 className="font-medium">Customer returns</h3>
        {trip.returns.length === 0 ? (
          <p className="text-sm text-muted">No customer returns recorded</p>
        ) : (
          <ul>
            {trip.returns.map((r) => (
              <li
                key={r.returnId}
                className="border-b border-separator py-2 text-sm"
              >
                {r.returnNumber} · {r.lines.length} returned{" "}
                {r.lines.length === 1 ? "line" : "lines"}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="text-xs text-muted">
        Expected stock is loaded − sold + voided + customer returns, before the
        count adjustment and depot hand-in. Damage stays on the truck in a
        separate stock status.
      </p>
    </article>
  );
}

export function VanTripsView({
  data,
  selected,
  onSelect,
}: {
  data: TripsDay;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const sales = data.rows.reduce((n, r) => n + r.salesCentavos, 0),
    open = data.rows.filter((r) => r.unclosed).length,
    exceptions = data.rows.filter(hasVariance);
  const sorted = [...data.rows].sort(
    (a, b) =>
      Number(hasVariance(b)) - Number(hasVariance(a)) ||
      Number(b.unclosed) - Number(a.unclosed),
  );
  const max = Math.max(1, ...data.trend.map((t) => t.salesCentavos));
  return (
    <div className="grid gap-6">
      {exceptions.length > 0 && (
        <aside className="rounded-xl border border-warning p-4">
          <strong>
            {exceptions.length}{" "}
            {exceptions.length === 1 ? "trip needs" : "trips need"} a variance
            review
          </strong>
          <p className="text-sm text-muted">
            Start with the highlighted truck. Check the count and approval
            before closing.
          </p>
        </aside>
      )}
      <section
        aria-label="Day settlement summary"
        className="grid gap-4 sm:grid-cols-4"
      >
        {[
          ["Sales", pesos(sales)],
          ["Prior day", pesos(data.priorSalesCentavos)],
          ["Open trips", String(open)],
          [
            "Sales target",
            data.targetCentavos === null
              ? "Needs setup"
              : pesos(data.targetCentavos),
          ],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-separator p-4">
            <p className="text-xs text-muted">{label}</p>
            <p className="mt-2 text-xl tabular-nums">{value}</p>
            {label === "Sales target" && data.targetCentavos === null && (
              <Link href="/sales-targets" className="text-xs underline">
                Set targets
              </Link>
            )}
          </div>
        ))}
      </section>
      <section
        aria-label="Sales trend"
        className="rounded-xl border border-separator p-4"
      >
        <h2 className="text-sm font-medium">Last 14 days · net van sales</h2>
        {data.trend.length === 0 ? (
          <p className="text-sm text-muted">No trips in this period</p>
        ) : (
          <ol className="mt-3 flex h-28 items-end gap-2">
            {data.trend.map((t) => (
              <li
                key={t.date}
                className="flex min-w-0 flex-1 flex-col items-center gap-1 text-[10px] text-muted"
              >
                <span>{pesos(t.salesCentavos)}</span>
                <span
                  className="w-full rounded-t bg-foreground/70"
                  style={{
                    height: `${Math.max(2, (t.salesCentavos / max) * 70)}px`,
                  }}
                />
                <span>{t.date.slice(5)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section
        aria-label="Trips for the day"
        className="overflow-auto rounded-xl border border-separator"
      >
        <table className={tableClass}>
          <thead>
            <tr>
              {[
                "Truck / seller",
                "Status",
                "Sales",
                "Expected cash",
                "Remitted",
                "Difference",
                "Next action",
              ].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.tripId}
                aria-selected={selected === r.tripId}
                className={hasVariance(r) ? "bg-warning/5" : ""}
              >
                <td>
                  <button
                    className="text-left underline underline-offset-4"
                    onClick={() => onSelect(r.tripId)}
                  >
                    {r.truck}
                    <small className="block text-muted">
                      {r.seller} · {r.tripNumber}
                    </small>
                  </button>
                </td>
                <td>{settlementLabel(r.settlementStatus)}</td>
                <td>{pesos(r.salesCentavos)}</td>
                <td>{pesos(r.cash.expectedCentavos)}</td>
                <td>{pesos(r.cash.remittedCentavos)}</td>
                <td>
                  {pesos(r.cash.varianceCentavos)}
                  {Boolean(r.stockCount?.varianceLines) && (
                    <small className="block">Stock count differs</small>
                  )}
                </td>
                <td>{r.nextAction}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.rows.length === 0 && (
          <p className="p-5 text-sm text-muted">
            No trips planned for this day. Plan a truck day in the office before
            loading.
          </p>
        )}
      </section>
      <p className="text-xs text-muted">
        Server-authorized snapshot ·{" "}
        {new Intl.DateTimeFormat("en-PH", {
          timeZone: "Asia/Manila",
          dateStyle: "medium",
          timeStyle: "short",
        }).format(data.asOf)}
        . Unsynced handheld work is not included.
      </p>
    </div>
  );
}

/** Mount under Vans & cash; approvals retain their existing workflow exports. */
export function VanTripsWorkspace({
  initialDate,
  initialTripId = null,
}: { initialDate?: string; initialTripId?: string | null } = {}) {
  const permissions = usePermissions();
  const [date, setDate] = useState(
    initialDate ??
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
  );
  const [selected, setSelected] = useState<string | null>(initialTripId);
  const day = useApi<TripsDay>(
    permissions.can("van.read") ? ["van", "trips", date] : null,
    ({ signal }) => apiFetch("/api/v1/van/trips", { query: { date }, signal }),
  );
  const detail = useApi<TripSettlement>(
    permissions.can("van.read") && selected ? ["van", "trip", selected] : null,
    ({ signal }) =>
      apiFetch("/api/v1/van/trip", { query: { tripId: selected }, signal }),
  );
  useLive(["van"], [["van"]]);
  function navigate(nextDate: string, id: string | null) {
    setDate(nextDate);
    setSelected(id);
    const url = new URL(window.location.href);
    url.searchParams.set("date", nextDate);
    if (id) url.searchParams.set("tripId", id);
    else url.searchParams.delete("tripId");
    window.history.replaceState(null, "", url);
  }
  if (!permissions.can("van.read"))
    return <p>Van settlement is not available for this account.</p>;
  return (
    <main className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4 print:hidden">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted">
            Vans & cash
          </p>
          <h1 className="text-2xl font-semibold">
            Is every truck accounted for?
          </h1>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs">
            Manila day
            <input
              aria-label="Trip date"
              type="date"
              value={date}
              onChange={(e) => navigate(e.target.value, null)}
            />
          </label>
          <a
            className="text-sm underline"
            href={`/api/v1/van/trips?date=${date}&format=csv`}
          >
            Export day CSV
          </a>
          <Button variant="outline" onPress={() => window.print()}>
            Print day
          </Button>
        </div>
      </header>
      {day.error ? (
        <p role="alert">
          {day.error.message}{" "}
          <button onClick={() => void day.refetch()}>Try again</button>
        </p>
      ) : day.data ? (
        <VanTripsView
          data={day.data}
          selected={selected}
          onSelect={(id) => navigate(date, id)}
        />
      ) : (
        <p role="status">Loading truck settlements…</p>
      )}
      {selected &&
        (detail.error ? (
          <p role="alert">{detail.error.message}</p>
        ) : detail.data ? (
          <VanTripDetail trip={detail.data} />
        ) : (
          <p role="status">Loading trip detail…</p>
        ))}
      <div className="grid gap-5 print:hidden">
        <VanDamageApprovals />
        <VanVoidApproval />
        <VanStockApproval />
        <VanCashApproval />
      </div>
    </main>
  );
}
