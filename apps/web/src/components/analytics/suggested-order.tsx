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
import { useState } from "react";

type Suggestion = FunctionReturnType<
  typeof api.analytics.suggested_orders.forOutlet
>;
type LineRow = Suggestion["lines"][number] & { id: string };
type SellingLocation = FunctionReturnType<
  typeof api.analytics.suggested_orders.sellingLocations
>[number];
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

/** Why the sales history may not be the store's whole history; null when it is. */
export const HISTORY_NOTE: Record<Suggestion["historyStatus"], string | null> =
  {
    complete: null,
    partial_scope:
      "Only orders within your access are used; orders written by sellers or depots outside it are left out.",
    shared_account:
      "The customer account of this store is shared with other stores, so its orders cannot be attributed to this store and no history is used.",
    no_customer:
      "This store is not linked to a customer account, so there is no order history.",
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
        {HISTORY_NOTE[data.historyStatus]
          ? ` ${HISTORY_NOTE[data.historyStatus]}`
          : ""}
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

const NOT_CHECKED = "";

/** The depot or truck whose stock limits the suggestion. */
export function SellingLocationPicker({
  locations,
  value,
  onChange,
}: {
  locations: SellingLocation[];
  value: Id<"inventoryLocations"> | typeof NOT_CHECKED;
  onChange: (value: Id<"inventoryLocations"> | typeof NOT_CHECKED) => void;
}) {
  return (
    <label className="grid max-w-sm gap-1 text-[13px] text-muted">
      Sell from
      <select
        aria-label="Sell from"
        className="h-10 w-full"
        value={value}
        onChange={(event) =>
          onChange(
            event.target.value as Id<"inventoryLocations"> | typeof NOT_CHECKED,
          )
        }
      >
        <option value={NOT_CHECKED}>Depot stock not checked</option>
        {locations.map((row) => (
          <option key={row.locationId} value={row.locationId}>
            {`${row.name} (${row.code})${row.recent ? " · last used" : ""}`}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Keyed by store: the selection starts at the store's last-used selling location. */
export function SuggestedOrderPanel({
  outletId,
  asOfDate,
}: {
  outletId: Id<"outlets">;
  asOfDate: string;
}) {
  const locations = useQuery(api.analytics.suggested_orders.sellingLocations, {
    outletId,
  });
  const [choice, setChoice] = useState<
    Id<"inventoryLocations"> | typeof NOT_CHECKED | null
  >(null);
  const selected =
    choice ?? locations?.find((row) => row.recent)?.locationId ?? NOT_CHECKED;
  const data = useQuery(
    api.analytics.suggested_orders.forOutlet,
    locations === undefined
      ? "skip"
      : {
          outletId,
          asOfDate,
          ...(selected ? { locationId: selected } : {}),
        },
  );
  if (locations === undefined || data === undefined)
    return (
      <span className="text-[13px] text-muted">Loading suggested order…</span>
    );
  return (
    <div className="grid gap-3">
      {locations.length ? (
        <SellingLocationPicker
          locations={locations}
          value={selected}
          onChange={setChoice}
        />
      ) : (
        <p className="text-[13px] text-muted">
          No selling location is within your access, so depot stock is not
          checked.
        </p>
      )}
      <SuggestedOrderView data={data} />
    </div>
  );
}
