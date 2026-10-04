"use client";

import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  DataTable,
  StatusPill,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";

type Suggestion = FunctionReturnType<
  typeof api.analytics.suggested_orders.forOutlet
>;
type LineRow = Suggestion["lines"][number] & { id: string };
type Tone = "success" | "warning" | "danger" | "neutral";

export const LINE_STATUS: Record<
  Suggestion["lines"][number]["status"],
  { label: string; tone: Tone }
> = {
  suggest: { label: "Suggest", tone: "success" },
  unavailable: { label: "Not available", tone: "danger" },
  enough_stock: { label: "Enough stock", tone: "neutral" },
  no_history: { label: "No history", tone: "warning" },
};

export const STOCK_SOURCE: Record<
  Suggestion["lines"][number]["stockSource"],
  string
> = {
  counted: "counted",
  reported_out: "found none",
  estimated: "estimated",
  none: "unknown",
};

export const NEXT_VISIT_SOURCE: Record<
  Suggestion["nextVisit"]["source"],
  string
> = {
  planned_stop: "next planned call",
  cycle: "visit cycle",
  default: "default cycle",
};

const quantity = (n: number) =>
  Number.isInteger(n) ? String(n) : n.toFixed(2);

const muted = (text: string) => (
  <span className="font-mono text-xs text-muted">{text}</span>
);

const columns: DataColumn<LineRow>[] = [
  {
    key: "sku",
    label: "SKU",
    render: (row) => (
      <span className="flex flex-col">
        <span className="text-sm font-medium text-foreground">{row.name}</span>
        {muted(row.required ? `${row.code} · required` : row.code)}
      </span>
    ),
  },
  {
    key: "suggested",
    label: "Suggested",
    align: "right",
    render: (row) => (
      <span className="flex flex-col items-end gap-1">
        <span className="tabular-nums font-semibold">
          {`${row.suggestedQuantity} ${row.unit}`}
        </span>
        <StatusPill tone={LINE_STATUS[row.status].tone}>
          {LINE_STATUS[row.status].label}
        </StatusPill>
      </span>
    ),
  },
  {
    key: "demand",
    label: "Per day",
    align: "right",
    render: (row) => (
      <span className="flex flex-col items-end tabular-nums">
        <span>{quantity(row.dailyDemand)}</span>
        {row.promotion && muted(`+${row.promotion.upliftPct}% promo`)}
      </span>
    ),
  },
  {
    key: "stock",
    label: "Store stock",
    align: "right",
    render: (row) => (
      <span className="flex flex-col items-end tabular-nums">
        <span>{quantity(row.storeStock)}</span>
        {muted(STOCK_SOURCE[row.stockSource])}
      </span>
    ),
  },
  {
    key: "why",
    label: "Why",
    render: (row) => (
      <ul className="grid gap-0.5 text-[12px] text-muted">
        {row.reasons.map((reason, index) => (
          <li key={index}>{reason}</li>
        ))}
      </ul>
    ),
  },
];

/** The store's suggested order (ICO). The server computes every number. */
export function SuggestedOrderView({ data }: { data: Suggestion }) {
  return (
    <Card
      label="Suggested order"
      count={data.totals.suggestedSkus}
      icon={<WorkspaceIcon name="catalog" />}
      flush
    >
      <p className="px-4 pt-3 text-[13px] text-muted">
        {`${data.totals.suggestedSkus} SKU(s), ${data.totals.suggestedQuantity} unit(s) in total. `}
        {`Covers ${data.coverDays} day(s): ${data.nextVisit.days} to the ${NEXT_VISIT_SOURCE[data.nextVisit.source]}`}
        {data.nextVisit.date ? ` (${data.nextVisit.date})` : ""}
        {` + ${data.leadTimeDays} day(s) delivery lead time`}
        {data.leadTimeProvisional ? " (provisional)" : ""}
        {`. Sales history ${data.historyFrom} to ${data.asOfDate}.`}
      </p>
      {data.lines.length ? (
        <DataTable
          rows={data.lines.map((row) => ({ ...row, id: row.code }))}
          columns={columns}
          bare
          empty={null}
        />
      ) : (
        <p className="px-4 py-3 text-[13px] text-muted">
          No orders in the last {data.historyDays} days and no required
          assortment, so there is nothing to suggest.
        </p>
      )}
      <p className="px-4 pb-3 text-[12px] text-muted">
        Suggested = daily demand × (days to next visit + lead time) − store
        stock. Store stock is the latest count since the last purchase, else the
        last purchase less what has sold since.
        {data.location
          ? ` Limited to stock available at ${data.location.name}.`
          : " Depot stock is not checked here."}
        {data.truncated ? " Some history was too long to read in full." : ""}
      </p>
    </Card>
  );
}

export function SuggestedOrderPanel({
  outletId,
  asOfDate,
}: {
  outletId: Id<"outlets">;
  asOfDate: string;
}) {
  const data = useQuery(api.analytics.suggested_orders.forOutlet, {
    outletId,
    asOfDate,
  });
  if (data === undefined)
    return (
      <span className="text-[13px] text-muted">Loading suggested order…</span>
    );
  return <SuggestedOrderView data={data} />;
}
