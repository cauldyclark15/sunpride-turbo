"use client";

import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  DataTable,
  FormField,
  MetricCard,
  Notice,
  Pager,
  StatusPill,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useEffect, useState } from "react";
import {
  AVAILABILITY_LABELS,
  changeText,
  daysText,
  lastOrderTone,
  pctText,
  pesoText,
  REGULARITY_LABELS,
  TREND_LABELS,
  WEEK_PRESETS,
  weekLabel,
} from "../../lib/customer-execution";
import { PanelErrorBoundary } from "../panel-error-boundary";
import { manilaToday } from "../supervision/supervision-model";
import { SuggestedOrderPanel } from "./suggested-order";

type StoreFigures = FunctionReturnType<typeof api.analytics.customer.store>;
type StorePage = FunctionReturnType<typeof api.analytics.customer.stores>;
type WeekRow = StoreFigures["weeks"][number] & { id: string };
type SkuRow = StoreFigures["assortment"]["skus"][number] & { id: string };

const muted = (text: string) => (
  <span className="font-mono text-xs text-muted">{text}</span>
);

const weekColumns: DataColumn<WeekRow>[] = [
  {
    key: "week",
    label: "Week of",
    render: (row) => weekLabel(row.weekStart),
  },
  {
    key: "visits",
    label: "Visit days",
    align: "right",
    render: (row) => (
      <span className="flex flex-col items-end tabular-nums">
        <span>{row.visitDays}</span>
        {row.unplannedVisits > 0 &&
          muted(`${row.unplannedVisits} unplanned visit(s)`)}
      </span>
    ),
  },
  {
    key: "planned",
    label: "Planned calls done",
    align: "right",
    render: (row) =>
      row.planned ? `${row.plannedDone}/${row.planned}` : muted("none"),
  },
  {
    key: "missed",
    label: "Missed",
    align: "right",
    render: (row) =>
      row.missed ? (
        <StatusPill tone="danger">{row.missed}</StatusPill>
      ) : (
        <span className="tabular-nums">0</span>
      ),
  },
  {
    key: "orders",
    label: "Orders",
    align: "right",
    render: (row) => <span className="tabular-nums">{row.orders}</span>,
  },
  {
    key: "sales",
    label: "Sales",
    align: "right",
    render: (row) => (
      <span className="tabular-nums">{pesoText(row.sales)}</span>
    ),
  },
];

const skuColumns: DataColumn<SkuRow>[] = [
  {
    key: "sku",
    label: "Required SKU",
    render: (row) => (
      <span className="flex flex-col">
        <span className="text-sm font-medium text-foreground">{row.name}</span>
        {muted(row.code)}
      </span>
    ),
  },
  {
    key: "ordered",
    label: "Last ordered",
    render: (row) =>
      row.lastOrderedDate ? (
        <span className="font-mono text-[13px]">{row.lastOrderedDate}</span>
      ) : (
        <StatusPill tone="warning">Not ordered</StatusPill>
      ),
  },
  {
    key: "shelf",
    label: "Last audit",
    render: (row) =>
      row.availability ? (
        <span className="flex items-center gap-2">
          <StatusPill tone={AVAILABILITY_LABELS[row.availability].tone}>
            {AVAILABILITY_LABELS[row.availability].label}
          </StatusPill>
          {row.facings !== null && muted(`${row.facings} facings`)}
        </span>
      ) : (
        <span className="text-muted">Not checked</span>
      ),
  },
];

/** One store's execution: everything is computed by the server, this only lays it out. */
export function CustomerExecutionView({ data }: { data: StoreFigures }) {
  const regularity = REGULARITY_LABELS[data.regularity.status];
  const trend = TREND_LABELS[data.orders.direction];
  const planned = data.plannedCalls;
  const assortment = data.assortment;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
        <span className="text-sm font-medium text-foreground">
          {data.outlet.name}
        </span>
        <span className="font-mono">{data.outlet.code}</span>
        {[
          data.customer
            ? `Customer ${data.customer.code} · ${data.customer.name}`
            : "No customer linked",
          data.outlet.unitName,
          data.outlet.territory,
          data.outlet.route ? `Route ${data.outlet.route}` : null,
          data.outlet.channel,
        ]
          .filter(Boolean)
          .map((part) => (
            <span key={part}>· {part}</span>
          ))}
        <span className="font-mono">
          {data.from} – {data.to}
        </span>
      </div>
      {data.customer?.sharedWithOtherOutlets && (
        <Notice
          tone="neutral"
          title="This customer account also buys for other stores"
          meta="Orders are recorded per customer, so the order figures include its other stores."
        />
      )}
      {data.truncated && (
        <Notice
          title="Some records were left out"
          meta="This store has more records than one read covers. Pick fewer weeks."
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          label="Visit regularity"
          value={regularity.label}
          detail={
            data.regularity.lastVisitDate
              ? `Last visit ${daysText(data.regularity.daysSinceLastVisit)} ago${
                  data.regularity.expectedCycleDays
                    ? ` · every ${data.regularity.expectedCycleDays} days expected`
                    : ""
                }`
              : "No visit on record"
          }
        />
        <MetricCard
          label="Days since last order"
          value={daysText(data.orders.daysSinceLastOrder)}
          detail={
            data.orders.lastOrderDate
              ? `${data.orders.lastOrderDate} · ${pesoText(data.orders.lastOrderAmount)}`
              : "No order on record"
          }
        />
        <MetricCard
          label="Order trend (last 4 weeks)"
          value={changeText(data.orders.changePct)}
          detail={`${trend.label} · ${pesoText(data.orders.recentSales)} vs ${pesoText(data.orders.priorSales)}`}
        />
        <MetricCard
          label="Missed planned calls"
          value={String(planned.missed)}
          detail={`${planned.done} of ${planned.planned} done${
            planned.pending ? ` · ${planned.pending} still due` : ""
          } · ${pctText(planned.missedPct)} missed`}
        />
        <MetricCard
          label="Distribution"
          value={pctText(assortment.distributionPct)}
          detail={
            assortment.hasAssortment
              ? `${assortment.ordered} of ${assortment.required} required SKUs ordered`
              : "No required assortment set"
          }
        />
        <MetricCard
          label="On-shelf availability"
          value={pctText(assortment.availabilityPct)}
          detail={
            assortment.lastAuditDate
              ? `${assortment.available} of ${assortment.checked} checked · audit ${assortment.lastAuditDate}`
              : "No merchandising audit yet"
          }
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <StatusPill tone={regularity.tone}>{regularity.label}</StatusPill>
        {data.regularity.onCadencePct !== null && (
          <StatusPill tone="neutral">
            {`${pctText(data.regularity.onCadencePct)} of gaps on cadence`}
          </StatusPill>
        )}
        {data.regularity.longestGapDays !== null && (
          <StatusPill tone="neutral">
            {`Longest gap ${daysText(data.regularity.longestGapDays)}`}
          </StatusPill>
        )}
        <StatusPill
          tone={lastOrderTone(
            data.orders.daysSinceLastOrder,
            data.regularity.expectedCycleDays,
          )}
        >
          {`Last order ${daysText(data.orders.daysSinceLastOrder)}`}
        </StatusPill>
        <StatusPill tone={trend.tone}>{trend.label}</StatusPill>
        {assortment.gaps > 0 && (
          <StatusPill tone="warning">
            {`${assortment.gaps} distribution gap(s)`}
          </StatusPill>
        )}
        {assortment.outOfStock > 0 && (
          <StatusPill tone="danger">
            {`${assortment.outOfStock} out of stock`}
          </StatusPill>
        )}
      </div>
      <Card
        label="Week by week"
        count={data.weeks.length}
        icon={<WorkspaceIcon name="reports" />}
        flush
      >
        <DataTable
          rows={data.weeks.map((week) => ({ ...week, id: week.weekStart }))}
          columns={weekColumns}
          bare
          empty={null}
        />
      </Card>
      {planned.recentMissed.length > 0 && (
        <Card
          label="Recent missed planned calls"
          count={planned.recentMissed.length}
          icon={<WorkspaceIcon name="field" />}
        >
          <ul className="grid gap-1 text-[13px]">
            {planned.recentMissed.map((row, index) => (
              <li
                key={`${row.serviceDate}-${index}`}
                className="flex flex-wrap gap-2"
              >
                <span className="font-mono">{row.serviceDate}</span>
                <span className="text-foreground">{row.assigneeName}</span>
                {row.route && muted(`Route ${row.route}`)}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card
        label="Assortment and distribution"
        count={assortment.required}
        icon={<WorkspaceIcon name="catalog" />}
        flush
      >
        {assortment.skus.length ? (
          <DataTable
            rows={assortment.skus.map((sku) => ({ ...sku, id: sku.productId }))}
            columns={skuColumns}
            bare
            empty={null}
          />
        ) : (
          <p className="px-4 py-3 text-[13px] text-muted">
            No required assortment is set for this store.{" "}
            {data.orders.skusBought} SKU(s) bought in the period.
          </p>
        )}
      </Card>
      <p className="text-[12px] text-muted">
        Visit days count checked-out visits to this store by anyone, planned or
        not. A planned call is missed when the store was not visited by the 10
        PM close of its day. Orders are the linked customer&apos;s orders that
        count as a sale, by the day written; the trend compares the latest 4
        weeks with the 4 before. Distribution counts required SKUs ordered in
        the period; availability is the latest merchandising audit. These
        definitions are provisional until Sunpride signs them off.
      </p>
    </div>
  );
}

/** One page of the store picker (keeps paging past empty filtered pages). */
function StorePicker({
  asOfDate,
  orgUnitId,
  search,
  selected,
  onSelect,
  onUnits,
}: {
  asOfDate: string;
  orgUnitId: Id<"orgUnits"> | "";
  search: string;
  selected: Id<"outlets"> | "";
  onSelect: (id: Id<"outlets">) => void;
  onUnits: (units: StorePage["units"]) => void;
}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const page = useQuery(api.analytics.customer.stores, {
    asOfDate,
    ...(orgUnitId ? { orgUnitId } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
    paginationOpts: { cursor: cursors[cursors.length - 1]!, numItems: 50 },
  });
  const units = page?.units;
  useEffect(() => {
    if (units && units.length > 1) onUnits(units);
  }, [units, onUnits]);
  if (page === undefined)
    return <span className="text-[13px] text-muted">Loading stores…</span>;
  return (
    <Card
      label="Stores"
      count={page.page.length}
      icon={<WorkspaceIcon name="list" />}
      flush
    >
      {page.page.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted">
          {page.isDone
            ? "No stores here."
            : "No match on this page. Use Next to keep looking."}
        </p>
      ) : (
        <ul className="grid max-h-[320px] overflow-auto">
          {page.page.map((store) => (
            <li key={store.outletId}>
              <button
                type="button"
                aria-pressed={selected === store.outletId}
                className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm ${
                  selected === store.outletId
                    ? "bg-default-soft font-medium"
                    : ""
                }`}
                onClick={() => onSelect(store.outletId)}
              >
                <span>{store.name}</span>
                <span className="font-mono text-xs text-muted">
                  {store.code}
                  {store.status !== "active" ? ` · ${store.status}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Pager
        page={cursors.length}
        canPrevious={cursors.length > 1}
        canNext={!page.isDone}
        onPrevious={() => setCursors((old) => old.slice(0, -1))}
        onNext={() => setCursors((old) => [...old, page.continueCursor])}
        label="Store pages"
      />
    </Card>
  );
}

function StoreFiguresLoader({
  outletId,
  asOfDate,
  weeks,
}: {
  outletId: Id<"outlets">;
  asOfDate: string;
  weeks: number;
}) {
  const data = useQuery(api.analytics.customer.store, {
    outletId,
    asOfDate,
    weeks,
  });
  if (data === undefined)
    return <span className="text-[13px] text-muted">Loading store…</span>;
  return <CustomerExecutionView data={data} />;
}

/**
 * ANA-005 customer execution dashboard: pick a store in your scope and see its visit
 * regularity, order trend, days since last order, missed planned calls and
 * assortment/distribution status.
 */
export function CustomerExecution() {
  const [asOfDate, setAsOfDate] = useState(() => manilaToday());
  const [weeks, setWeeks] = useState(12);
  const [orgUnitId, setOrgUnitId] = useState<Id<"orgUnits"> | "">("");
  const [search, setSearch] = useState("");
  const [units, setUnits] = useState<StorePage["units"]>([]);
  const [outletId, setOutletId] = useState<Id<"outlets"> | "">("");
  const pickerKey = `${asOfDate}-${orgUnitId}-${search.trim()}`;
  const onUnits = useCallback(
    (next: StorePage["units"]) =>
      setUnits((old) => (old.length === next.length ? old : next)),
    [],
  );
  return (
    <section className="grid gap-4" aria-label="Customer execution">
      <h2 className="text-base font-semibold text-foreground">
        Customer execution
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[180px] max-w-full">
          <FormField label="As of">
            <input
              type="date"
              aria-label="As of date"
              className="h-10 w-full"
              value={asOfDate}
              max={manilaToday()}
              onChange={(event) => {
                if (event.target.value) setAsOfDate(event.target.value);
              }}
            />
          </FormField>
        </div>
        <div className="w-[180px] max-w-full">
          <FormField label="Period">
            <select
              aria-label="Customer period"
              className="h-10 w-full"
              value={weeks}
              onChange={(event) => setWeeks(Number(event.target.value))}
            >
              {WEEK_PRESETS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        {units.length > 1 && (
          <div className="w-[220px] max-w-full">
            <FormField label="Unit">
              <select
                aria-label="Store unit"
                className="h-10 w-full"
                value={orgUnitId}
                onChange={(event) =>
                  setOrgUnitId(event.target.value as Id<"orgUnits"> | "")
                }
              >
                <option value="">All units</option>
                {units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        )}
        <div className="w-[220px] max-w-full">
          <FormField label="Find a store">
            <input
              type="search"
              aria-label="Find a store"
              className="h-10 w-full"
              placeholder="Code or name"
              maxLength={80}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </FormField>
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
        <PanelErrorBoundary key={pickerKey} label="Stores">
          <StorePicker
            asOfDate={asOfDate}
            orgUnitId={orgUnitId}
            search={search}
            selected={outletId}
            onSelect={setOutletId}
            onUnits={onUnits}
          />
        </PanelErrorBoundary>
        {outletId ? (
          <PanelErrorBoundary
            key={`${outletId}-${asOfDate}-${weeks}`}
            label="Customer execution"
          >
            <div className="grid gap-4">
              <StoreFiguresLoader
                outletId={outletId}
                asOfDate={asOfDate}
                weeks={weeks}
              />
              <PanelErrorBoundary
                key={`suggested-${outletId}-${asOfDate}`}
                label="Suggested order"
              >
                <SuggestedOrderPanel outletId={outletId} asOfDate={asOfDate} />
              </PanelErrorBoundary>
            </div>
          </PanelErrorBoundary>
        ) : (
          <p className="text-[13px] text-muted">
            Pick a store to see its execution.
          </p>
        )}
      </div>
    </section>
  );
}
