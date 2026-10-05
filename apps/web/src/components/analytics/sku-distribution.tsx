"use client";

import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  DataTable,
  FormField,
  MetricCard,
  StatusPill,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useEffect, useState } from "react";
import {
  channelSplit,
  combineSkuFigures,
  matchesSku,
  rankSkus,
  SHELF_LABELS,
  SKU_SORTS,
  skuRates,
  skuRows,
  territorySplit,
  type SkuRow,
  type SkuSortKey,
  type SplitRow,
} from "../../lib/sku-distribution";
import {
  manilaToday,
  PERIOD_PRESETS,
  pctText,
  periodFor,
  pesoText,
  type PeriodPreset,
} from "../../lib/territory-performance";

type TerritoryList = FunctionReturnType<typeof api.analytics.territory.list>;
type SkuResult = FunctionReturnType<typeof api.analytics.sku.territory>;
type GapResult = FunctionReturnType<typeof api.analytics.sku.gaps>;
type TableRow = SkuRow & { id: string };
type SplitTableRow = SplitRow & { id: string };

/** People with these capabilities see the dashboard; the server re-checks every read. */
export const SKU_DASHBOARD_CAPABILITIES = [
  "people.read",
  "visit.read",
  "report.read",
] as const;

const MAX_SKU_ROWS = 100;

const muted = (text: string) => (
  <span className="font-mono text-xs text-muted">{text}</span>
);

function shelfFlags(figures: SkuRow["figures"]) {
  const flags = [];
  if (figures.outOfStockOutlets)
    flags.push(
      <StatusPill key="oos" tone="danger">
        {`${figures.outOfStockOutlets} out of stock`}
      </StatusPill>,
    );
  if (figures.lowStockOutlets)
    flags.push(
      <StatusPill key="low" tone="warning">
        {`${figures.lowStockOutlets} low stock`}
      </StatusPill>,
    );
  if (figures.notCarriedOutlets)
    flags.push(
      <StatusPill key="nc" tone="neutral">
        {`${figures.notCarriedOutlets} not carried`}
      </StatusPill>,
    );
  return flags.length ? (
    <span className="flex flex-wrap gap-1">{flags}</span>
  ) : (
    <span className="text-muted">—</span>
  );
}

function figureColumns<
  R extends { activeOutlets: number; figures: SkuRow["figures"] },
>(): DataColumn<R & { id: string }>[] {
  return [
    {
      key: "buying",
      label: "Buying stores",
      align: "right",
      render: (row) => (
        <span className="flex flex-col items-end tabular-nums">
          <span>
            {pctText(skuRates(row.figures, row.activeOutlets).distributionPct)}
          </span>
          {muted(`${row.figures.buyingOutlets} of ${row.activeOutlets} stores`)}
        </span>
      ),
    },
    {
      key: "gaps",
      label: "Gaps",
      align: "right",
      render: (row) => (
        <span className="tabular-nums">
          {skuRates(row.figures, row.activeOutlets).distributionGaps}
        </span>
      ),
    },
    {
      key: "sales",
      label: "Sales",
      align: "right",
      render: (row) => (
        <span className="flex flex-col items-end tabular-nums">
          <span>
            {pesoText(skuRates(row.figures, row.activeOutlets).netSalesMinor)}
          </span>
          {muted(
            `${row.figures.quantity} units · ${row.figures.orders} orders`,
          )}
        </span>
      ),
    },
    {
      key: "shelf",
      label: "On shelf",
      align: "right",
      render: (row) => (
        <span className="flex flex-col items-end tabular-nums">
          <span>
            {pctText(skuRates(row.figures, row.activeOutlets).onShelfPct)}
          </span>
          {muted(
            `${row.figures.onShelfOutlets} of ${row.figures.auditedOutlets} audited`,
          )}
        </span>
      ),
    },
    {
      key: "flags",
      label: "Shelf signals",
      render: (row) => shelfFlags(row.figures),
    },
  ];
}

export function SkuDistributionView({
  list,
  results,
  gaps,
  period,
  preset,
  onPreset,
  orgUnitId,
  onOrgUnit,
  channel,
  onChannel,
  sort,
  onSort,
  search,
  onSearch,
  selected,
  onSelect,
}: {
  list: TerritoryList;
  results: ReadonlyMap<string, SkuResult>;
  gaps: ReadonlyMap<string, GapResult>;
  period: { from: string; to: string };
  preset: PeriodPreset;
  onPreset: (preset: PeriodPreset) => void;
  orgUnitId: string;
  onOrgUnit: (id: string) => void;
  channel: string;
  onChannel: (channel: string) => void;
  sort: SkuSortKey;
  onSort: (sort: SkuSortKey) => void;
  search: string;
  onSearch: (search: string) => void;
  selected: string;
  onSelect: (productCode: string) => void;
}) {
  const loaded = list.territories.flatMap((territory) => {
    const data = results.get(territory.territoryId);
    return data ? [data] : [];
  });
  const pending = list.territories.length - loaded.length;
  const all = skuRows(loaded);
  const shown = rankSkus(
    all.filter((row) => matchesSku(row, search)),
    sort,
  );
  const rows: TableRow[] = shown
    .slice(0, MAX_SKU_ROWS)
    .map((row) => ({ ...row, id: row.productCode }));
  const total = combineSkuFigures(all.map((row) => row.figures));
  const activeOutlets = loaded.reduce((n, t) => n + t.activeOutlets, 0);
  const auditedOutlets = loaded.reduce((n, t) => n + t.auditedOutlets, 0);
  const sold = all.filter((row) => row.figures.orders > 0).length;
  const truncated = list.truncated || loaded.some((t) => t.truncated);
  const selectedRow = all.find((row) => row.productCode === selected);

  const columns: DataColumn<TableRow>[] = [
    {
      key: "sku",
      label: "SKU",
      render: (row) => (
        <button
          type="button"
          className="flex flex-col text-left"
          aria-pressed={row.productCode === selected}
          onClick={() => onSelect(row.productCode)}
        >
          <span className="text-sm font-medium text-foreground">
            {row.name ?? row.productCode}
          </span>
          {muted([row.productCode, row.category].filter(Boolean).join(" · "))}
        </button>
      ),
    },
    ...figureColumns<SkuRow>(),
  ];
  const splitColumns = (label: string): DataColumn<SplitTableRow>[] => [
    {
      key: "label",
      label,
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-sm font-medium text-foreground">
            {row.label}
          </span>
          {row.detail ? muted(row.detail) : null}
        </span>
      ),
    },
    ...figureColumns<SplitRow>(),
  ];
  const byTerritory = selectedRow
    ? territorySplit(loaded, selectedRow.productCode).map((row) => ({
        ...row,
        id: row.key,
      }))
    : [];
  const byChannel = selectedRow
    ? channelSplit(loaded, selectedRow.productCode).map((row) => ({
        ...row,
        id: row.key,
      }))
    : [];
  const gapTerritories = selectedRow
    ? loaded.flatMap((territory) => {
        const gap = gaps.get(territory.territoryId);
        return gap &&
          gap.productCode === selectedRow.productCode &&
          gap.gapCount
          ? [{ territory, gap }]
          : [];
      })
    : [];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[180px] max-w-full">
          <FormField label="Period">
            <select
              aria-label="Period"
              className="h-10 w-full"
              value={preset}
              onChange={(event) => onPreset(event.target.value as PeriodPreset)}
            >
              {PERIOD_PRESETS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <div className="w-[200px] max-w-full">
          <FormField label="Unit">
            <select
              aria-label="Unit"
              className="h-10 w-full"
              value={orgUnitId}
              onChange={(event) => onOrgUnit(event.target.value)}
            >
              <option value="">All my units</option>
              {list.units.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.name}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <div className="w-[160px] max-w-full">
          <FormField label="Channel">
            <select
              aria-label="Channel"
              className="h-10 w-full"
              value={channel}
              onChange={(event) => onChannel(event.target.value)}
            >
              <option value="">All channels</option>
              {list.channels.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <div className="w-[180px] max-w-full">
          <FormField label="Rank by">
            <select
              aria-label="Rank SKUs by"
              className="h-10 w-full"
              value={sort}
              onChange={(event) => onSort(event.target.value as SkuSortKey)}
            >
              {SKU_SORTS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <div className="w-[200px] max-w-full">
          <FormField label="Find SKU">
            <input
              aria-label="Find SKU"
              className="h-10 w-full"
              value={search}
              placeholder="Code, name or category"
              onChange={(event) => onSearch(event.target.value)}
            />
          </FormField>
        </div>
        <span className="flex h-10 items-center font-mono text-[13px] text-muted">
          {period.from} – {period.to}
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="SKUs sold"
          value={String(sold)}
          detail={`${all.length} SKUs sold or audited`}
        />
        <MetricCard
          label="Active stores"
          value={String(activeOutlets)}
          detail={`${auditedOutlets} audited this period`}
        />
        <MetricCard
          label="Out of stock"
          value={String(total.outOfStockOutlets)}
          detail="Store × SKU, latest audit"
        />
        <MetricCard
          label="Low stock"
          value={String(total.lowStockOutlets)}
          detail="Store × SKU, latest audit"
        />
      </div>
      {truncated && (
        <p className="text-[13px] text-muted">
          Only part of the data is shown. Pick a unit or channel.
        </p>
      )}
      {list.territories.length === 0 ? (
        <Card label="SKU distribution" icon={<WorkspaceIcon name="reports" />}>
          <p className="text-[13px] text-muted">No territories here</p>
        </Card>
      ) : (
        <Card
          label="SKU distribution"
          count={shown.length}
          icon={<WorkspaceIcon name="reports" />}
          actions={
            pending ? (
              <span className="text-[13px] text-muted">Loading {pending}…</span>
            ) : undefined
          }
          flush
        >
          <DataTable
            rows={rows}
            columns={columns}
            bare
            empty={
              <div className="p-4 text-[13px] text-muted">
                {pending ? "Loading…" : "No SKU sold or audited in this period"}
              </div>
            }
          />
          {shown.length > rows.length && (
            <p className="p-4 text-[13px] text-muted">
              Showing the first {rows.length} of {shown.length} SKUs. Use Find
              SKU to narrow the list.
            </p>
          )}
        </Card>
      )}
      {selectedRow && (
        <Card
          label={`${selectedRow.name ?? selectedRow.productCode} by territory and channel`}
          icon={<WorkspaceIcon name="list" />}
          actions={
            <button
              type="button"
              className="text-[13px] text-muted"
              onClick={() => onSelect("")}
            >
              Close
            </button>
          }
          flush
        >
          <DataTable
            rows={byTerritory}
            columns={splitColumns("Territory")}
            bare
            empty={<div className="p-4 text-[13px] text-muted">—</div>}
          />
          <DataTable
            rows={byChannel}
            columns={splitColumns("Channel")}
            bare
            empty={<div className="p-4 text-[13px] text-muted">—</div>}
          />
          {gapTerritories.length > 0 && (
            <div className="grid gap-2 p-4 text-[13px]">
              <span className="font-medium text-foreground">
                Stores not buying {selectedRow.productCode}
              </span>
              {gapTerritories.map(({ territory, gap }) => (
                <div key={territory.territoryId}>
                  <span className="font-medium text-foreground">
                    {territory.name}:{" "}
                  </span>
                  <span className="text-muted">
                    {gap.outlets
                      .map(
                        (outlet) =>
                          `${outlet.code} ${outlet.name}${
                            outlet.shelfStatus
                              ? ` (${SHELF_LABELS[outlet.shelfStatus]})`
                              : ""
                          }`,
                      )
                      .join(", ")}
                    {gap.gapCount > gap.outlets.length
                      ? ` and ${gap.gapCount - gap.outlets.length} more`
                      : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
      <p className="text-[12px] text-muted">
        Buying stores are active stores of the territory that bought the SKU in
        the period; gaps are active stores that did not. Sales are the
        SKU&apos;s order lines on the day they were written, less returns. Shelf
        signals come from each store&apos;s latest merchandising audit in the
        period; stores not audited give no signal. Channel is the
        territory&apos;s channel. These definitions are provisional until
        Sunpride signs them off.
      </p>
    </div>
  );
}

function SkuLoader({
  territoryId,
  from,
  to,
  onResult,
}: {
  territoryId: Id<"territories">;
  from: string;
  to: string;
  onResult: (key: string, data: SkuResult) => void;
}) {
  const data = useQuery(api.analytics.sku.territory, { territoryId, from, to });
  useEffect(() => {
    if (data) onResult(`${territoryId}:${from}:${to}`, data);
  }, [data, territoryId, from, to, onResult]);
  return null;
}

function GapLoader({
  territoryId,
  from,
  to,
  productCode,
  onResult,
}: {
  territoryId: Id<"territories">;
  from: string;
  to: string;
  productCode: string;
  onResult: (key: string, data: GapResult) => void;
}) {
  const data = useQuery(api.analytics.sku.gaps, {
    territoryId,
    from,
    to,
    productCode,
  });
  useEffect(() => {
    if (data) onResult(`${territoryId}:${from}:${to}:${productCode}`, data);
  }, [data, territoryId, from, to, productCode, onResult]);
  return null;
}

function SkuDistributionPanel() {
  const [endDate] = useState(() => manilaToday());
  const [preset, setPreset] = useState<PeriodPreset>("7");
  const [orgUnitId, setOrgUnitId] = useState("");
  const [channel, setChannel] = useState("");
  const [sort, setSort] = useState<SkuSortKey>("sales");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [results, setResults] = useState<Map<string, SkuResult>>(
    () => new Map(),
  );
  const [gapResults, setGapResults] = useState<Map<string, GapResult>>(
    () => new Map(),
  );
  const period = periodFor(preset, endDate);
  const list = useQuery(api.analytics.territory.list, {
    endDate,
    ...(orgUnitId ? { orgUnitId: orgUnitId as Id<"orgUnits"> } : {}),
    ...(channel ? { channel } : {}),
  });
  const onResult = useCallback((key: string, data: SkuResult) => {
    setResults((prev) =>
      prev.get(key) === data ? prev : new Map(prev).set(key, data),
    );
  }, []);
  const onGap = useCallback((key: string, data: GapResult) => {
    setGapResults((prev) =>
      prev.get(key) === data ? prev : new Map(prev).set(key, data),
    );
  }, []);
  if (list === undefined)
    return <span className="text-[13px] text-muted">Loading territories…</span>;
  const current = new Map<string, SkuResult>();
  const currentGaps = new Map<string, GapResult>();
  for (const territory of list.territories) {
    const key = `${territory.territoryId}:${period.from}:${period.to}`;
    const hit = results.get(key);
    if (hit) current.set(territory.territoryId, hit);
    const gap = selected ? gapResults.get(`${key}:${selected}`) : undefined;
    if (gap) currentGaps.set(territory.territoryId, gap);
  }
  return (
    <>
      {list.territories.map((territory) => (
        <SkuLoader
          key={`${territory.territoryId}:${period.from}:${period.to}`}
          territoryId={territory.territoryId}
          from={period.from}
          to={period.to}
          onResult={onResult}
        />
      ))}
      {selected
        ? list.territories.map((territory) => (
            <GapLoader
              key={`${territory.territoryId}:${period.from}:${period.to}:${selected}`}
              territoryId={territory.territoryId}
              from={period.from}
              to={period.to}
              productCode={selected}
              onResult={onGap}
            />
          ))
        : null}
      <SkuDistributionView
        list={list}
        results={current}
        gaps={currentGaps}
        period={period}
        preset={preset}
        onPreset={setPreset}
        orgUnitId={orgUnitId}
        onOrgUnit={setOrgUnitId}
        channel={channel}
        onChannel={setChannel}
        sort={sort}
        onSort={setSort}
        search={search}
        onSearch={setSearch}
        selected={selected}
        onSelect={setSelected}
      />
    </>
  );
}

/** Reports → SKU distribution; shown only to people who may read it. */
export function SkuDistribution() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  if (
    !permissions ||
    !SKU_DASHBOARD_CAPABILITIES.every((name) =>
      permissions.capabilities.includes(name),
    )
  )
    return null;
  return <SkuDistributionPanel />;
}
