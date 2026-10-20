"use client";

import { DormancyPanel } from "../../dormancy-panel";

import Link from "next/link";
import { OutletContextView } from "./tower";
import { useState } from "react";
import { csvHref, useAnalytics } from "../api";
import {
  formatCases,
  formatCount,
  formatDayTime,
  formatDelta,
  formatPhp,
  formatSince,
  humanize,
} from "../format";
import {
  CockpitPage,
  DrillTable,
  EmptyState,
  KpiGrid,
  PageData,
  Panel,
  PeriodScopeBar,
  StatusChip,
  TrendChart,
  type DrillColumn,
} from "../kit";
import type {
  StoreResponse,
  StoresResponse,
  StoreRow,
  StoreStatus,
} from "../types";
import { buttonClass, usePageQuery } from "./shared";

const TABS: Array<{ id: StoreStatus | null; label: string; kpi?: string }> = [
  { id: null, label: "All", kpi: "universe" },
  { id: "active", label: "Buying", kpi: "activeBuying" },
  { id: "dormant", label: "Dormant", kpi: "dormant" },
  { id: "new", label: "New", kpi: "newStores" },
  { id: "lost", label: "Lost", kpi: "lostStores" },
  { id: "never", label: "Never bought" },
];

export function storeColumns(now: number): DrillColumn<StoreRow>[] {
  return [
    {
      key: "name",
      label: "Store",
      render: (r) => (
        <span className="flex flex-col">
          <span>{r.name}</span>
          <span className="text-[12px] font-normal text-muted">
            {r.code} · {humanize(r.channel)} · {r.territory}
          </span>
        </span>
      ),
      sort: (r) => r.name,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusChip status={r.status} />,
      sort: (r) => r.status,
    },
    {
      key: "sales",
      label: "Sales",
      align: "right",
      render: (r) => formatPhp(r.salesPeriod),
      sort: (r) => r.salesPeriod,
    },
    {
      key: "delta",
      label: "vs prior",
      align: "right",
      render: (r) => {
        const d = formatDelta(r.deltaPct);
        return (
          <span
            className={
              d.direction === "down"
                ? "text-[#b4101f]"
                : d.direction === "up"
                  ? "text-[#1f7a43]"
                  : "text-muted"
            }
          >
            {d.direction === "none" ? "—" : d.text}
          </span>
        );
      },
      sort: (r) => r.deltaPct,
    },
    {
      key: "lastOrder",
      label: "Last order · visit",
      align: "right",
      render: (r) => (
        <span>
          {formatSince(r.lastOrderAt, now)}{" "}
          <span className="text-muted">
            · {formatSince(r.lastVisitAt, now)}
          </span>
        </span>
      ),
      sort: (r) => r.lastOrderAt,
    },
    {
      key: "skus",
      label: "Products",
      align: "right",
      render: (r) => formatCount(r.skuCount),
      sort: (r) => r.skuCount,
    },
    {
      key: "gaps",
      label: "Gaps",
      align: "right",
      render: (r) => (
        <span className={r.mustSellGaps ? "text-[#a15c07]" : "text-muted"}>
          {formatCount(r.mustSellGaps)}
        </span>
      ),
      sort: (r) => r.mustSellGaps,
    },
    {
      key: "ar",
      label: "Open balance",
      align: "right",
      render: (r) =>
        r.arBalance === null ? (
          <span className="text-muted">Cash</span>
        ) : (
          formatPhp(r.arBalance)
        ),
      sort: (r) => r.arBalance,
    },
  ];
}

export function StoresView({
  data,
  status,
  q,
  csv,
  now: nowProp,
  link = (href) => href,
  onStatus,
  onSearch,
  onMore,
}: {
  data: StoresResponse;
  status: StoreStatus | null;
  q: string;
  csv: string;
  now?: number;
  link?: (href: string) => string;
  onStatus?: (status: StoreStatus | null) => void;
  onSearch?: (q: string) => void;
  onMore?: () => void;
}) {
  const now = nowProp ?? data.freshness.asOf;
  const [text, setText] = useState(q);
  const kpiValue = (key?: string) =>
    data.kpis.find((k) => k.key === key)?.value ?? null;
  return (
    <div className="grid gap-4">
      <KpiGrid kpis={data.kpis} />
      <Panel
        title="Buying stores by week"
        question="Unique stores that ordered each week."
      >
        <TrendChart
          label="Buying stores by week"
          unit="count"
          height={170}
          dates={data.uboTrend.map((w) => w.weekStart)}
          series={[
            {
              key: "ubo",
              label: "Buying stores",
              kind: "bar",
              values: data.uboTrend.map((w) => w.ubo),
            },
          ]}
        />
      </Panel>
      <Panel
        csvHref={csv}
        title="Stores"
        question="Click a store for everything about it."
        flush
        actions={
          <form
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              onSearch?.(text.trim());
            }}
          >
            <input
              type="search"
              aria-label="Search stores"
              placeholder="Find a store"
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="!min-h-11 h-11 w-44 !rounded-lg !text-[16px] lg:!min-h-8 lg:h-8 lg:!text-[13px]"
            />
          </form>
        }
      >
        <div
          role="tablist"
          aria-label="Store status"
          className="flex gap-1 overflow-x-auto px-4 pb-3 sm:px-5"
        >
          {TABS.map((tab) => {
            const on = status === tab.id;
            const count = kpiValue(tab.kpi);
            return (
              <button
                key={tab.label}
                role="tab"
                type="button"
                aria-selected={on}
                onClick={() => onStatus?.(tab.id)}
                className={`h-8 shrink-0 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium ${on ? "bg-foreground text-background" : "border border-border text-muted hover:text-foreground"}`}
              >
                {tab.label}
                {count !== null ? (
                  <span className="ml-1.5 tabular-nums opacity-70">
                    {formatCount(count)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <DrillTable
          label="Stores"
          columns={storeColumns(now)}
          rows={data.rows}
          rowKey={(r) => r.storeId}
          rowHref={(r) =>
            link(`/stores/store?storeId=${encodeURIComponent(r.storeId)}`)
          }
          empty={
            q ? (
              <EmptyState variant="zero" title={`No store matches “${q}”`} />
            ) : (
              <EmptyState
                variant="zero"
                title={`No ${status ? humanize(status).toLowerCase() : ""} stores in this period`}
              />
            )
          }
          footer={
            data.next ? (
              <div className="ck-noprint flex justify-center px-4 py-3">
                <button type="button" className={buttonClass} onClick={onMore}>
                  Show more stores
                </button>
              </div>
            ) : null
          }
        />
      </Panel>
    </div>
  );
}

export function StoresPage() {
  const { query, params, link, set } = usePageQuery(["status", "q", "limit"]);
  const status = (
    TABS.some((t) => t.id === params.get("status"))
      ? params.get("status")
      : null
  ) as StoreStatus | null;
  const result = useAnalytics("stores", query);
  return (
    <CockpitPage
      title="Stores"
      question="Where is distribution weak?"
      header={result.data}
      bar={<PeriodScopeBar scopeLabel={result.data?.scope.label} />}
    >
      <PageData result={result} label="store figures">
        {(data) => (
          <StoresView
            data={data}
            status={status}
            q={params.get("q") ?? ""}
            csv={csvHref("stores", query)}
            link={link}
            onStatus={(s) => set({ status: s, limit: null })}
            onSearch={(q) => set({ q: q || null, limit: null })}
            onMore={() =>
              set(
                { limit: String(Number(params.get("limit") || 50) + 50) },
                { replace: true },
              )
            }
          />
        )}
      </PageData>
      <div className="mt-6">
        <DormancyPanel />
      </div>
    </CockpitPage>
  );
}

// ---------- Outlet 360 ----------

/** Four execution facts derived from the store read: how often, how recent, which way, what was missed. */
export function customerExecutionFacts(data: StoreResponse, now: number) {
  const visits = [...data.visits].sort((a, b) => b.at - a.at);
  const gaps = visits
    .slice(1)
    .map((v, i) => (visits[i]!.at - v.at) / 86_400_000);
  const every = gaps.length
    ? Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length)
    : null;
  const lastOrder = data.orders.reduce<number | null>(
    (m, o) => (m === null || o.at > m ? o.at : m),
    null,
  );
  const weeks = data.salesTrend.map((w) => w.sales);
  const last4 = weeks.slice(-4).reduce((s, v) => s + v, 0);
  const prior4 = weeks.slice(-8, -4).reduce((s, v) => s + v, 0);
  return {
    regularity:
      every === null ? null : every <= 1 ? "Every day" : `Every ${every} days`,
    daysSinceOrder:
      lastOrder === null
        ? null
        : Math.max(0, Math.floor((now - lastOrder) / 86_400_000)),
    trendPct:
      weeks.length >= 8 && prior4 > 0
        ? Math.round(((last4 - prior4) / prior4) * 1000) / 10
        : null,
    last4,
  };
}

function CustomerExecution({
  data,
  now,
}: {
  data: StoreResponse;
  now: number;
}) {
  const facts = customerExecutionFacts(data, now);
  const trend = formatDelta(facts.trendPct);
  return (
    <Panel
      title="Customer execution"
      question="How well this store is being served."
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
        <div>
          <dt className="text-[12px] text-muted">Visit regularity</dt>
          <dd className="text-[15px] font-semibold text-foreground">
            {facts.regularity ?? "Not visited yet"}
          </dd>
        </div>
        <div>
          <dt className="text-[12px] text-muted">Days since last order</dt>
          <dd className="text-[15px] font-semibold tabular-nums text-foreground">
            {facts.daysSinceOrder === null
              ? "No order yet"
              : facts.daysSinceOrder === 0
                ? "Today"
                : facts.daysSinceOrder === 1
                  ? "1 day"
                  : `${facts.daysSinceOrder} days`}
          </dd>
        </div>
        <div>
          <dt className="text-[12px] text-muted">Order trend (last 4 weeks)</dt>
          <dd
            className={`text-[15px] font-semibold tabular-nums ${trend.direction === "down" ? "text-[#b4101f]" : trend.direction === "up" ? "text-[#1f7a43]" : "text-foreground"}`}
          >
            {formatPhp(facts.last4)}{" "}
            <span className="text-[12px] font-medium">
              {trend.direction === "none" ? "" : trend.text}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-[12px] text-muted">Missed planned calls</dt>
          <dd className="text-[13px] text-muted">
            {data.context?.coverage
              ? `${data.context.coverage.missed} of ${data.context.coverage.planned} planned calls`
              : "Not measured yet for one store"}
          </dd>
        </div>
      </dl>
    </Panel>
  );
}

export function OnShelf({ value }: { value: boolean | null }) {
  if (value === null) return <span className="text-muted">Not checked</span>;
  return value ? (
    <StatusChip status="ok" label="On shelf" />
  ) : (
    <StatusChip status="behind" label="Missing" />
  );
}

export function StoreView({
  data,
  now: nowProp,
  link = (href) => href,
}: {
  data: StoreResponse;
  now?: number;
  link?: (href: string) => string;
}) {
  const now = nowProp ?? data.freshness.asOf;
  const s = data.store;
  const names = new Map(data.assortment.map((a) => [a.productId, a.name]));
  return (
    <div className="grid gap-4">
      <section className="rounded-2xl border border-border bg-surface px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-foreground">
                {s.name}
              </h2>
              {s.status ? <StatusChip status={s.status} /> : null}
            </div>
            <p className="text-[13px] text-muted">
              {[
                s.code,
                humanize(s.channel),
                s.territory,
                s.agent ? `Served by ${s.agent}` : null,
                s.address,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={link("/stores")} className={buttonClass}>
              All stores
            </Link>
            {/* MOUNT: OrdersWorkspace (@/components/orders) should accept ?store=<storeId> to start an order. */}
            <Link
              href={link(`/orders?store=${encodeURIComponent(s.storeId)}`)}
              className={buttonClass}
            >
              Start an order
            </Link>
          </div>
        </div>
      </section>
      <KpiGrid kpis={data.kpis} />
      <CustomerExecution data={data} now={now} />
      {data.context ? <OutletContextView data={data.context} /> : null}
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <Panel
          title="Week by week"
          question="Sales for the last twelve weeks. The last bar is the week so far."
          className="lg:col-span-2"
        >
          <TrendChart
            label="Store sales by week"
            height={170}
            dates={data.salesTrend.map((w) => w.weekStart)}
            series={[
              {
                key: "sales",
                label: "Sales",
                kind: "bar",
                values: data.salesTrend.map((w) => w.sales),
              },
            ]}
          />
        </Panel>
        <Panel
          title="Suggested order"
          question="What to offer on the next visit."
        >
          {data.suggestedOrder.length ? (
            <ul className="grid max-h-96 gap-2 overflow-y-auto pr-1">
              {data.suggestedOrder.map((item) => (
                <li
                  key={item.productId}
                  className="flex items-baseline justify-between gap-3 text-[13px]"
                >
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">
                      {names.get(item.productId) ?? "Product"}
                    </span>
                    <span className="block text-[12px] text-muted">
                      {item.reason}
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-foreground">
                    {item.quantityDisplay ?? formatCases(item.qtyCases)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState variant="zero" title="Nothing to suggest">
              Every must-sell product was bought and on the shelf.
            </EmptyState>
          )}
        </Panel>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Panel title="Last visits" flush>
          <DrillTable
            label="Last visits"
            rows={data.visits}
            rowKey={(v) => String(v.at)}
            columns={[
              { key: "at", label: "When", render: (v) => formatDayTime(v.at) },
              { key: "agent", label: "By", render: (v) => v.agent },
              {
                key: "outcome",
                label: "Outcome",
                wrap: true,
                render: (v) => (
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusChip
                      status={v.productive ? "ok" : "neutral"}
                      label={v.productive ? "Productive" : "Not productive"}
                    />
                    <span className="text-muted">{v.outcome}</span>
                  </span>
                ),
              },
              {
                key: "plan",
                label: "Plan",
                render: (v) =>
                  v.onPlan === false ? (
                    <span className="text-[#a15c07]">Off plan</span>
                  ) : v.onPlan ? (
                    "On plan"
                  ) : (
                    "—"
                  ),
              },
            ]}
            empty={<EmptyState variant="zero" title="No visits recorded" />}
          />
        </Panel>
        <Panel title="Last orders" flush>
          <DrillTable
            label="Last orders"
            rows={data.orders}
            rowKey={(o) => o.orderId}
            columns={[
              { key: "number", label: "Order", render: (o) => o.number },
              {
                key: "at",
                label: "When",
                render: (o) => formatSince(o.at, now),
              },
              {
                key: "status",
                label: "Status",
                render: (o) => (
                  <StatusChip
                    status={
                      o.status === "pending_approval"
                        ? "watch"
                        : o.status === "posted"
                          ? "ok"
                          : "neutral"
                    }
                    label={
                      o.status === "pending_approval"
                        ? "Waiting approval"
                        : humanize(o.status)
                    }
                  />
                ),
              },
              {
                key: "total",
                label: "Total",
                align: "right",
                render: (o) => (
                  <span className="flex flex-col items-end">
                    {formatPhp(o.totalCentavos)}
                    <span className="text-[12px] text-muted">
                      {formatCount(o.lines)} lines
                    </span>
                  </span>
                ),
              },
            ]}
            empty={
              <EmptyState variant="zero" title="No orders in the last visits" />
            }
          />
        </Panel>
      </div>
      <Panel
        title="Assortment and distribution"
        question="Must-sell products: last bought and seen on the shelf."
        flush
      >
        <DrillTable
          label="Assortment"
          rows={data.assortment}
          rowKey={(a) => a.productId}
          initialSort={{ key: "last", dir: "asc" }}
          columns={[
            {
              key: "name",
              label: "Product",
              render: (a) => (
                <span className="flex flex-col">
                  <span>{a.name}</span>
                  <span className="text-[12px] font-normal text-muted">
                    {a.code}
                  </span>
                </span>
              ),
              sort: (a) => a.name,
            },
            {
              key: "last",
              label: "Last bought",
              align: "right",
              render: (a) => formatSince(a.lastBoughtAt, now),
              sort: (a) => a.lastBoughtAt,
            },
            {
              key: "shelf",
              label: "Shelf",
              render: (a) => <OnShelf value={a.onShelf} />,
            },
          ]}
        />
      </Panel>
    </div>
  );
}

export function StorePage() {
  const { query, link } = usePageQuery(["storeId"]);
  const result = useAnalytics("store", query.storeId ? query : null);
  return (
    <CockpitPage
      title={result.data?.store.name ?? "Store"}
      question="Everything about this store."
      header={result.data}
      bar={
        <PeriodScopeBar
          showChannel={false}
          scopeLabel={result.data?.scope.label}
        />
      }
    >
      {query.storeId ? (
        <PageData result={result} label="this store">
          {(data) => <StoreView data={data} link={link} />}
        </PageData>
      ) : (
        <EmptyState
          variant="zero"
          title="Pick a store"
          action={{ label: "Open Stores", href: link("/stores") }}
        />
      )}
    </CockpitPage>
  );
}
