"use client";

import { RetailWorkspace } from "../../storepos/retail-workspace";
import { DormancyPanel } from "../../dormancy-panel";
import { useWaitingCount } from "../../store-gathering/tab";
import { StoreGatheringReview } from "../../store-gathering/review";
import { LocationCoverage } from "../../store-gathering/location-coverage";
import {
  CustomerEditor,
  useCustomerReference,
} from "../../customers/customer-editor";
import {
  CustomerListView,
  FILTER_DEPENDENTS,
  useCustomerList,
  type CustomerFilters,
} from "../../customers/customer-list";
import { LIST_FILTER_KEYS, type CustomerStatus } from "../../customers/model";
import { CustomerUpload } from "../../customer-upload/customer-upload";
import { usePermissions } from "../../../lib/auth";
import { Drawer } from "../kit/drawer";
import {
  StoresTabs,
  editButtonClass,
  readPage,
  readStoresTab,
  type StoresTab,
} from "./stores-list";

import Link from "next/link";
import { OutletContextView } from "./tower";
import { useCallback, useState } from "react";
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
import type { StoreResponse, StoresResponse, StoreRow } from "../types";
import { buttonClass, usePageQuery } from "./shared";

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

/** Performance tab: period figures, the weekly chart and a sales table. Finding and editing stores is the Customers list. */
export function StoresView({
  data,
  csv,
  now: nowProp,
  link = (href) => href,
}: {
  data: StoresResponse;
  csv: string;
  now?: number;
  link?: (href: string) => string;
}) {
  const now = nowProp ?? data.freshness.asOf;
  return (
    <div className="grid gap-4">
      <KpiGrid kpis={data.kpis} />
      <Panel title="Buying stores by week">
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
      <Panel csvHref={csv} title="Sales by store" flush>
        <DrillTable
          label="Sales by store"
          initialSort={{ key: "sales", dir: "desc" }}
          columns={storeColumns(now)}
          rows={data.rows}
          rowKey={(r) => r.storeId}
          rowHref={(r) =>
            link(`/customers/customer?storeId=${encodeURIComponent(r.storeId)}`)
          }
          empty={
            <EmptyState variant="zero" title="No store sales in this period" />
          }
        />
      </Panel>
    </div>
  );
}

const CUSTOMER_STATUSES: CustomerStatus[] = ["prospect", "active", "inactive"];

/** ?status= as a customer status; anything else means every status. */
export function readCustomerStatus(
  params: URLSearchParams,
): CustomerStatus | null {
  const s = params.get("status");
  return CUSTOMER_STATUSES.includes(s as CustomerStatus)
    ? (s as CustomerStatus)
    : null;
}

/** /customers (SP-0170: customer = store). */
export function StoresPage() {
  const { params, link, set, hrefWith } = usePageQuery([
    "status",
    "q",
    ...LIST_FILTER_KEYS,
  ]);
  const { can } = usePermissions();
  const hidden: StoresTab[] = can("masterdata.manage") ? [] : ["settings"];
  const tab = readStoresTab(params, hidden);
  const canAdd = can("outlet.manage");
  const [adding, setAdding] = useState<string | null>(null);
  const canUpload = can("masterdata.manage");
  const [uploading, setUploading] = useState(false);
  const editing = tab === "list" || tab === "new" ? params.get("edit") : null;
  const waiting = useWaitingCount();
  const go = (next: StoresTab) =>
    set(
      next === "list"
        ? { tab: null }
        : {
            tab: next,
            page: null,
            q: null,
            status: null,
            edit: null,
            ...Object.fromEntries(LIST_FILTER_KEYS.map((k) => [k, null])),
          },
    );
  return (
    <div className="ck-page grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[26px] font-semibold tracking-tight text-foreground">
          Customers
        </h1>
        {canUpload ? (
          <button
            type="button"
            className={editButtonClass}
            onClick={() => setUploading(true)}
          >
            Upload customers
          </button>
        ) : null}
      </div>
      <StoresTabs
        tab={tab}
        onTab={go}
        hrefFor={(t) => hrefWith(t === "list" ? { tab: null } : { tab: t })}
        badges={{ new: waiting }}
        hidden={hidden}
      />
      {tab === "list" ? (
        <CustomersListTab
          params={params}
          set={set}
          link={link}
          canAdd={canAdd}
          onAdd={(name) => setAdding(name)}
          onEdit={canAdd ? (id) => set({ edit: id }) : undefined}
        />
      ) : tab === "new" ? (
        <div className="grid gap-8">
          <section className="grid gap-3">
            <h2 className="text-[17px] font-semibold text-foreground">
              Prospects to complete and approve
            </h2>
            <CustomersListTab
              params={params}
              set={set}
              link={link}
              canAdd={false}
              awaitingApproval
              onAdd={() => undefined}
              onEdit={canAdd ? (id) => set({ edit: id }) : undefined}
            />
          </section>
          <StoreGatheringReview />
        </div>
      ) : tab === "map" ? (
        <LocationCoverage />
      ) : tab === "winback" ? (
        <DormancyPanel part="cases" />
      ) : tab === "settings" ? (
        <DormancyPanel part="rules" />
      ) : (
        <PerformanceTab />
      )}
      <Drawer
        open={adding !== null}
        title="Add a customer"
        wide
        onClose={() => setAdding(null)}
      >
        {adding !== null ? (
          <CustomerEditor
            key={adding}
            initialName={adding}
            onDone={(c) => {
              setAdding(null);
              set({ edit: c.id });
            }}
          />
        ) : null}
      </Drawer>
      <Drawer
        open={uploading}
        title="Upload customers"
        wide
        onClose={() => setUploading(false)}
      >
        {uploading ? <CustomerUpload compact /> : null}
      </Drawer>
      <Drawer
        open={!!editing}
        title="Customer"
        wide
        onClose={() => set({ edit: null })}
      >
        {editing ? <CustomerEditor key={editing} customerId={editing} /> : null}
      </Drawer>
    </div>
  );
}

function CustomersListTab({
  params,
  set,
  link,
  canAdd,
  onAdd,
  onEdit,
  awaitingApproval = false,
}: {
  params: URLSearchParams;
  set: ReturnType<typeof usePageQuery>["set"];
  link: (href: string) => string;
  canAdd: boolean;
  onAdd: (name: string) => void;
  onEdit?: (customerId: string) => void;
  /** The approval queue: prospects and provisional field captures, whatever their status. */
  awaitingApproval?: boolean;
}) {
  const page = readPage(params);
  const status = awaitingApproval ? null : readCustomerStatus(params);
  const q = params.get("q") ?? "";
  const filters: CustomerFilters = {};
  for (const k of LIST_FILTER_KEYS) {
    const v = params.get(k);
    if (v) filters[k] = v;
  }
  const { index } = useCustomerReference();
  const result = useCustomerList(q, status, filters, page, awaitingApproval);
  const onSearch = useCallback(
    (next: string) => set({ q: next || null, page: null }, { replace: true }),
    [set],
  );
  return (
    <CustomerListView
      index={index}
      rows={result.data?.rows ?? (result.error ? [] : null)}
      statusCounts={result.data?.statusCounts ?? null}
      total={
        result.data ? (result.data.total ?? result.data.rows.length) : null
      }
      page={page}
      q={q}
      status={status}
      filters={filters}
      loading={result.data === undefined && !result.error}
      canAdd={canAdd}
      onSearch={onSearch}
      onPage={(n) => set({ page: n > 1 ? String(n) : null })}
      onAdd={onAdd}
      onStatus={(next) =>
        awaitingApproval ? undefined : set({ status: next, page: null })
      }
      onFilter={(key, value) =>
        set({
          [key]: value,
          page: null,
          ...Object.fromEntries(
            (FILTER_DEPENDENTS[key] ?? []).map((k) => [k, null]),
          ),
        })
      }
      onEdit={onEdit ? (r) => onEdit(r.id) : undefined}
      customerHref={(r) =>
        link(`/customers/customer?storeId=${encodeURIComponent(r.id)}`)
      }
    />
  );
}

/** Figures for the period: the only tab with the period filter. */
function PerformanceTab() {
  const [view, setView] = useState<"distribution" | "retail">("distribution");
  const { query, link } = usePageQuery([]);
  // The top 200 stores (API limit) are enough for a ranked sales table.
  const result = useAnalytics("stores", { ...query, limit: "200" });
  return (
    <div className="grid gap-4">
      <PeriodScopeBar scopeLabel={result.data?.scope.label} />
      <div role="tablist" aria-label="Store channel" className="flex gap-2">
        <button
          role="tab"
          aria-selected={view === "distribution"}
          className={buttonClass}
          onClick={() => setView("distribution")}
        >
          Distribution
        </button>
        <button
          role="tab"
          aria-selected={view === "retail"}
          className={buttonClass}
          onClick={() => setView("retail")}
        >
          Retail POS
        </button>
      </div>
      {view === "retail" ? (
        <RetailWorkspace />
      ) : (
        <PageData result={result} label="store figures">
          {(data) => (
            <StoresView
              data={data}
              csv={csvHref("stores", query)}
              link={link}
            />
          )}
        </PageData>
      )}
    </div>
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
            <Link href={link("/customers")} className={buttonClass}>
              All customers
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

/** /customers/customer: the customer record (client's sheet) and its performance. */
export function StorePage() {
  const { query, params, link, set } = usePageQuery(["storeId"]);
  const view = params.get("view") === "performance" ? "performance" : "info";
  const storeId = query.storeId;
  return (
    <div className="ck-page grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[26px] font-semibold tracking-tight text-foreground">
          Customer
        </h1>
        <Link href={link("/customers")} className={buttonClass}>
          All customers
        </Link>
      </div>
      {storeId ? (
        <>
          <div
            role="tablist"
            aria-label="Customer sections"
            className="flex gap-1 border-b border-separator"
          >
            {(
              [
                ["info", "Customer information"],
                ["performance", "Performance"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                onClick={() =>
                  set({ view: id === "info" ? null : "performance" })
                }
                className={`-mb-px inline-flex h-11 items-center border-b-2 px-3 text-[14px] font-medium ${view === id ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {view === "info" ? (
            <CustomerEditor key={storeId} customerId={storeId} />
          ) : (
            <StorePerformance storeId={storeId} />
          )}
        </>
      ) : (
        <EmptyState
          variant="zero"
          title="Pick a customer"
          action={{ label: "Open Customers", href: link("/customers") }}
        />
      )}
    </div>
  );
}

function StorePerformance({ storeId }: { storeId: string }) {
  const { query, link } = usePageQuery(["storeId"]);
  const result = useAnalytics("store", { ...query, storeId });
  return (
    <CockpitPage
      title={result.data?.store.name ?? "Customer"}
      question="Sales, visits and orders for this customer."
      header={result.data}
      bar={
        <PeriodScopeBar
          showChannel={false}
          scopeLabel={result.data?.scope.label}
        />
      }
    >
      <PageData result={result} label="this customer">
        {(data) => <StoreView data={data} link={link} />}
      </PageData>
    </CockpitPage>
  );
}
