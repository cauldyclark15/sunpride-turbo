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
  belowTarget,
  combineTerritoryFigures,
  manilaToday,
  PERIOD_PRESETS,
  pctText,
  periodFor,
  pesoText,
  rankTerritories,
  territoryRates,
  TERRITORY_SORTS,
  type PeriodPreset,
  type TerritorySortKey,
} from "../../lib/territory-performance";

type TerritoryList = FunctionReturnType<typeof api.analytics.territory.list>;
type TerritoryResult = FunctionReturnType<
  typeof api.analytics.territory.figures
>;
type Row = {
  id: string;
  code: string;
  territory: TerritoryList["territories"][number];
  data: TerritoryResult;
  figures: TerritoryResult["figures"];
};

/** People with these capabilities see the dashboard; the server re-checks every read. */
export const TERRITORY_DASHBOARD_CAPABILITIES = [
  "people.read",
  "visit.read",
  "report.read",
] as const;

const muted = (text: string) => (
  <span className="font-mono text-xs text-muted">{text}</span>
);

const columns: DataColumn<Row>[] = [
  {
    key: "rank",
    label: "#",
    render: (row) => muted(row.id.split(":")[0] ?? ""),
  },
  {
    key: "territory",
    label: "Territory",
    render: (row) => (
      <span className="flex flex-col">
        <span className="text-sm font-medium text-foreground">
          {row.territory.name}
        </span>
        {muted(
          [
            row.territory.code,
            row.territory.channel,
            row.territory.ownerUnitName,
          ]
            .filter(Boolean)
            .join(" · "),
        )}
      </span>
    ),
  },
  {
    key: "sales",
    label: "Sales",
    align: "right",
    render: (row) => (
      <span className="flex flex-col items-end tabular-nums">
        <span>{pesoText(row.figures.sales)}</span>
        {muted(`${row.figures.orders} orders`)}
      </span>
    ),
  },
  {
    key: "attainment",
    label: "Target attainment",
    align: "right",
    render: (row) => (
      <span className="flex flex-col items-end tabular-nums">
        <span>{pctText(territoryRates(row.figures).attainmentPct)}</span>
        {muted(
          row.figures.salesTarget === null
            ? "No target set"
            : `of ${pesoText(row.figures.salesTarget)}`,
        )}
      </span>
    ),
  },
  {
    key: "coverage",
    label: "Coverage",
    align: "right",
    render: (row) => (
      <span className="flex flex-col items-end tabular-nums">
        <span>{pctText(territoryRates(row.figures).coveragePct)}</span>
        {muted(
          `${row.figures.coveredOutlets} of ${row.figures.plannedOutlets} stores`,
        )}
      </span>
    ),
  },
  {
    key: "strikeRate",
    label: "Strike rate",
    align: "right",
    render: (row) => (
      <span className="flex flex-col items-end tabular-nums">
        <span>{pctText(territoryRates(row.figures).strikeRatePct)}</span>
        {muted(`${row.figures.productiveCalls} of ${row.figures.calls} calls`)}
      </span>
    ),
  },
  {
    key: "distribution",
    label: "Distribution gaps",
    align: "right",
    render: (row) => (
      <span className="flex flex-col items-end tabular-nums">
        <span>{territoryRates(row.figures).distributionGaps}</span>
        {muted(
          `${row.figures.buyingOutlets} of ${row.figures.activeOutlets} buying`,
        )}
      </span>
    ),
  },
  {
    key: "flags",
    label: "Flags",
    render: (row) => {
      const flags = [];
      if (belowTarget(row.figures))
        flags.push(
          <StatusPill key="target" tone="warning">
            Below target
          </StatusPill>,
        );
      if (row.figures.missed)
        flags.push(
          <StatusPill key="missed" tone="danger">
            {`${row.figures.missed} missed`}
          </StatusPill>,
        );
      return flags.length ? (
        <span className="flex flex-wrap gap-1">{flags}</span>
      ) : (
        <span className="text-muted">—</span>
      );
    },
  },
];

export function TerritoryPerformanceView({
  list,
  results,
  period,
  preset,
  onPreset,
  sort,
  onSort,
  belowTargetOnly,
  onBelowTargetOnly,
  orgUnitId,
  onOrgUnit,
  channel,
  onChannel,
}: {
  list: TerritoryList;
  results: ReadonlyMap<string, TerritoryResult>;
  period: { from: string; to: string };
  preset: PeriodPreset;
  onPreset: (preset: PeriodPreset) => void;
  sort: TerritorySortKey;
  onSort: (sort: TerritorySortKey) => void;
  belowTargetOnly: boolean;
  onBelowTargetOnly: (value: boolean) => void;
  orgUnitId: string;
  onOrgUnit: (id: string) => void;
  channel: string;
  onChannel: (channel: string) => void;
}) {
  const loaded = list.territories.flatMap((territory) => {
    const data = results.get(territory.territoryId);
    return data
      ? [{ territory, data, code: territory.code, figures: data.figures }]
      : [];
  });
  const pending = list.territories.length - loaded.length;
  const shown = loaded.filter(
    (row) => !belowTargetOnly || belowTarget(row.figures),
  );
  const rows: Row[] = rankTerritories(shown, sort).map((row, index) => ({
    ...row,
    id: `${index + 1}:${row.territory.territoryId}`,
  }));
  const total = combineTerritoryFigures(shown.map((row) => row.figures));
  const rates = territoryRates(total);
  const gapList = rows.filter((row) => row.data.gapOutlets.length).slice(0, 5);
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
        <div className="w-[200px] max-w-full">
          <FormField label="Rank by">
            <select
              aria-label="Rank by"
              className="h-10 w-full"
              value={sort}
              onChange={(event) =>
                onSort(event.target.value as TerritorySortKey)
              }
            >
              {TERRITORY_SORTS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <label className="flex h-10 items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={belowTargetOnly}
            onChange={(event) => onBelowTargetOnly(event.target.checked)}
          />
          Below target only
        </label>
        <span className="flex h-10 items-center font-mono text-[13px] text-muted">
          {period.from} – {period.to}
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          label="Sales"
          value={pesoText(total.sales)}
          detail={`${total.orders} orders`}
        />
        <MetricCard
          label="Target attainment"
          value={pctText(rates.attainmentPct)}
          detail={
            total.salesTarget === null
              ? "No target set"
              : `of ${pesoText(total.salesTarget)}`
          }
        />
        <MetricCard
          label="Coverage"
          value={pctText(rates.coveragePct)}
          detail={`${total.coveredOutlets} of ${total.plannedOutlets} planned stores`}
        />
        <MetricCard
          label="Strike rate"
          value={pctText(rates.strikeRatePct)}
          detail={`${total.productiveCalls} of ${total.calls} calls productive`}
        />
        <MetricCard
          label="Distribution gaps"
          value={String(rates.distributionGaps)}
          detail={`${total.buyingOutlets} of ${total.activeOutlets} stores buying`}
        />
      </div>
      {list.truncated && (
        <p className="text-[13px] text-muted">
          Only the first territories are shown. Pick a unit.
        </p>
      )}
      {list.territories.length === 0 ? (
        <Card label="Territories" icon={<WorkspaceIcon name="reports" />}>
          <p className="text-[13px] text-muted">No territories here</p>
        </Card>
      ) : (
        <Card
          label="Territory performance"
          count={rows.length}
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
                {pending ? "Loading…" : "No territory below target"}
              </div>
            }
          />
        </Card>
      )}
      {gapList.length > 0 && (
        <Card
          label="Stores with no sale this period"
          icon={<WorkspaceIcon name="list" />}
        >
          <div className="grid gap-2 text-[13px]">
            {gapList.map((row) => (
              <div key={row.id}>
                <span className="font-medium text-foreground">
                  {row.territory.name}:{" "}
                </span>
                <span className="text-muted">
                  {row.data.gapOutlets
                    .map((outlet) => `${outlet.code} ${outlet.name}`)
                    .join(", ")}
                  {territoryRates(row.figures).distributionGaps >
                  row.data.gapOutlets.length
                    ? ` and ${
                        territoryRates(row.figures).distributionGaps -
                        row.data.gapOutlets.length
                      } more`
                    : ""}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
      <p className="text-[12px] text-muted">
        Sales count orders of each territory&apos;s stores on the day they were
        written (returns subtract). Target attainment compares sales with the
        territory&apos;s sales target for the same days. Coverage is planned
        stores visited at least once; strike rate is productive calls out of
        calls (a call is a route-plan store visited). Distribution gaps are
        active stores with no sale in the period. These definitions are
        provisional until Sunpride signs them off; do not use them for pay or
        discipline.
      </p>
    </div>
  );
}

function TerritoryLoader({
  territoryId,
  from,
  to,
  onResult,
}: {
  territoryId: Id<"territories">;
  from: string;
  to: string;
  onResult: (key: string, data: TerritoryResult) => void;
}) {
  const data = useQuery(api.analytics.territory.figures, {
    territoryId,
    from,
    to,
  });
  useEffect(() => {
    if (data) onResult(`${territoryId}:${from}:${to}`, data);
  }, [data, territoryId, from, to, onResult]);
  return null;
}

function TerritoryPerformancePanel() {
  const [endDate] = useState(() => manilaToday());
  const [preset, setPreset] = useState<PeriodPreset>("7");
  const [sort, setSort] = useState<TerritorySortKey>("sales");
  const [belowTargetOnly, setBelowTargetOnly] = useState(false);
  const [orgUnitId, setOrgUnitId] = useState("");
  const [channel, setChannel] = useState("");
  const [results, setResults] = useState<Map<string, TerritoryResult>>(
    () => new Map(),
  );
  const period = periodFor(preset, endDate);
  const list = useQuery(api.analytics.territory.list, {
    endDate,
    ...(orgUnitId ? { orgUnitId: orgUnitId as Id<"orgUnits"> } : {}),
    ...(channel ? { channel } : {}),
  });
  const onResult = useCallback((key: string, data: TerritoryResult) => {
    setResults((prev) =>
      prev.get(key) === data ? prev : new Map(prev).set(key, data),
    );
  }, []);
  if (list === undefined)
    return <span className="text-[13px] text-muted">Loading territories…</span>;
  const current = new Map<string, TerritoryResult>();
  for (const territory of list.territories) {
    const hit = results.get(
      `${territory.territoryId}:${period.from}:${period.to}`,
    );
    if (hit) current.set(territory.territoryId, hit);
  }
  return (
    <>
      {list.territories.map((territory) => (
        <TerritoryLoader
          key={`${territory.territoryId}:${period.from}:${period.to}`}
          territoryId={territory.territoryId}
          from={period.from}
          to={period.to}
          onResult={onResult}
        />
      ))}
      <TerritoryPerformanceView
        list={list}
        results={current}
        period={period}
        preset={preset}
        onPreset={setPreset}
        sort={sort}
        onSort={setSort}
        belowTargetOnly={belowTargetOnly}
        onBelowTargetOnly={setBelowTargetOnly}
        orgUnitId={orgUnitId}
        onOrgUnit={setOrgUnitId}
        channel={channel}
        onChannel={setChannel}
      />
    </>
  );
}

/** Reports → Territory performance; shown only to people who may read it. */
export function TerritoryPerformance() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  if (
    !permissions ||
    !TERRITORY_DASHBOARD_CAPABILITIES.every((name) =>
      permissions.capabilities.includes(name),
    )
  )
    return null;
  return <TerritoryPerformancePanel />;
}
