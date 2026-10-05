"use client";

import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  DataTable,
  FormField,
  MetricCard,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useQueries, useQuery, type RequestForQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import {
  collectionsCsv,
  dailyPackCsv,
  mergePrograms,
  packTotals,
  pctText,
  pesoText,
  programsCsv,
  programUtilizationPct,
  ratioPct,
  type AdminPackRow,
  type CollectionLine,
  type ProgramTally,
} from "../../lib/admin-reports";
import { downloadCsv } from "../../lib/import-csv-export";
import { PanelErrorBoundary } from "../panel-error-boundary";
import {
  formatTime,
  manilaToday,
  type SupervisionFilters,
} from "../supervision/supervision-model";

type PackPage = FunctionReturnType<typeof api.analytics.admin_reports.day>;
type PersonRow = AdminPackRow & { id: string };
type ProgramRow = ProgramTally & { id: string };
type CollectionRow = CollectionLine & { id: string };

/** Reports in the memo's pack that have no source in the system yet. */
export const AWAITING_REPORTS = [
  {
    report: "Programs allocation (Promo Advice)",
    needed: "Sunpride's Promo Advice per program: what is allocated, to whom",
  },
  {
    report: "Priorities (D.A. contract, Promo Advice, COA, SASR, BR template)",
    needed: "The templates and who files each one",
  },
  {
    report: "Claims Summary (ADP)",
    needed: "The claims template and where ADP claims are recorded today",
  },
  {
    report: "Account Receivables balances (KAS)",
    needed: "The receivables source and the reckoning template",
  },
] as const;

export function AdminReportsView({
  serviceDate,
  rows,
  programs,
  collectionLines,
  peopleInScope,
  loading,
  truncated,
  collectionLinesTruncated,
  buyingAccountsTruncated = false,
}: {
  serviceDate: string;
  rows: readonly AdminPackRow[];
  programs: readonly ProgramTally[];
  collectionLines: readonly CollectionLine[];
  peopleInScope: number;
  loading: boolean;
  truncated: boolean;
  collectionLinesTruncated: boolean;
  buyingAccountsTruncated?: boolean;
}) {
  // Fail closed: a report whose source rows were capped is never exported as if complete.
  const dailyIncomplete = truncated || buyingAccountsTruncated;
  const programsIncomplete = truncated;
  const collectionsIncomplete = truncated || collectionLinesTruncated;
  const totals = packTotals(rows);
  const people: PersonRow[] = rows.map((row) => ({
    ...row,
    id: row.profileId,
  }));
  const programRows: ProgramRow[] = programs.map((row) => ({
    ...row,
    id: row.programRef,
  }));
  const lines: CollectionRow[] = [...collectionLines];
  const collected = collectionLines.reduce(
    (sum, line) => sum + line.amountMinor,
    0,
  );

  const personColumns: DataColumn<PersonRow>[] = [
    {
      key: "person",
      label: "Person",
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-sm font-medium text-foreground">
            {row.name}
          </span>
          <span className="font-mono text-xs text-muted">
            {[row.employeeCode, row.channel].filter(Boolean).join(" · ")}
          </span>
        </span>
      ),
    },
    {
      key: "manday",
      label: "Manday",
      align: "right",
      render: (row) => (row.manday ? "1" : "0"),
    },
    {
      key: "calls",
      label: "Calls",
      align: "right",
      render: (row) =>
        row.callsTarget === null
          ? String(row.calls)
          : `${row.calls}/${row.callsTarget}`,
    },
    {
      key: "productive",
      label: "Productive",
      align: "right",
      render: (row) =>
        `${row.productiveCalls} · ${pctText(ratioPct(row.productiveCalls, row.calls))}`,
    },
    {
      key: "uba",
      label: "UBA",
      align: "right",
      render: (row) => String(row.buyingAccounts.length),
    },
    {
      key: "osa",
      label: "OSA",
      align: "right",
      render: (row) =>
        row.osaRequired
          ? `${pctText(ratioPct(row.osaAvailable, row.osaRequired))} · ${row.osaAvailable}/${row.osaRequired}`
          : "—",
    },
  ];

  const programColumns: DataColumn<ProgramRow>[] = [
    {
      key: "program",
      label: "Program",
      render: (row) => (
        <span className="font-mono text-[13px]">{row.programRef}</span>
      ),
    },
    {
      key: "executed",
      label: "Executed",
      align: "right",
      render: (row) => String(row.executed),
    },
    {
      key: "not",
      label: "Not executed",
      align: "right",
      render: (row) => String(row.notExecuted),
    },
    {
      key: "na",
      label: "Not applicable",
      align: "right",
      render: (row) => String(row.notApplicable),
    },
    {
      key: "utilization",
      label: "Utilization",
      align: "right",
      render: (row) => pctText(programUtilizationPct(row)),
    },
    {
      key: "allocation",
      label: "Allocation",
      align: "right",
      render: () => <span className="text-muted">Awaiting</span>,
    },
  ];

  const collectionColumns: DataColumn<CollectionRow>[] = [
    {
      key: "customer",
      label: "Customer",
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-sm font-medium text-foreground">
            {row.customerName}
          </span>
          <span className="font-mono text-xs text-muted">
            {[row.customerCode, row.outletCode].filter(Boolean).join(" · ")}
          </span>
        </span>
      ),
    },
    { key: "person", label: "Salesperson", render: (row) => row.personName },
    {
      key: "amount",
      label: "Amount",
      align: "right",
      render: (row) => (
        <span className="tabular-nums">{pesoText(row.amountMinor)}</span>
      ),
    },
    {
      key: "reference",
      label: "Reference",
      render: (row) => `${row.method} · ${row.reference}`,
    },
    {
      key: "status",
      label: "Status",
      render: (row) =>
        row.status === "recorded" ? "Recorded" : "Pending review",
    },
    {
      key: "at",
      label: "Time",
      align: "right",
      render: (row) => (
        <span className="font-mono text-[13px]">{formatTime(row.at)}</span>
      ),
    },
  ];

  return (
    <div className="grid gap-4">
      {loading ? (
        <p className="text-[13px] text-muted">
          Loading {rows.length} of {peopleInScope} people…
        </p>
      ) : null}
      {truncated ? (
        <p className="text-[13px] text-muted">
          Only the first {peopleInScope} people are counted, so the reports
          cannot be exported. Pick a unit or channel.
        </p>
      ) : null}
      <Card
        label="Daily productive calls, UBA, OSA, mandays"
        count={people.length}
        icon={<WorkspaceIcon name="user" />}
      >
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Productive calls"
              value={pctText(ratioPct(totals.productiveCalls, totals.calls))}
              detail={`${totals.productiveCalls} of ${totals.calls} calls · target ${totals.callsTarget}`}
            />
            <MetricCard
              label="UBA"
              value={String(totals.uniqueBuyingAccounts)}
              detail="Unique buying accounts"
            />
            <MetricCard
              label="OSA"
              value={pctText(ratioPct(totals.osaAvailable, totals.osaRequired))}
              detail={`${totals.osaAvailable} of ${totals.osaRequired} required SKUs on shelf`}
            />
            <MetricCard
              label="Mandays"
              value={String(totals.mandays)}
              detail={`of ${totals.people} people`}
            />
          </div>
          {buyingAccountsTruncated ? (
            <p className="text-[13px] text-muted">
              Someone wrote too many orders today to count every buying account.
              UBA is incomplete and cannot be exported. Pick a unit or channel.
            </p>
          ) : null}
          <div>
            <Button
              variant="outline"
              className="h-10"
              isDisabled={loading || dailyIncomplete}
              onPress={() =>
                downloadCsv(
                  `pc-uba-osa-mandays-${serviceDate}.csv`,
                  dailyPackCsv(serviceDate, rows),
                )
              }
            >
              Export CSV
            </Button>
          </div>
          {people.length ? (
            <DataTable
              rows={people}
              columns={personColumns}
              bare
              empty={null}
            />
          ) : (
            <p className="text-[13px] text-muted">No field people here</p>
          )}
        </div>
      </Card>
      <Card
        label="Programs utilization vs allocation"
        count={programRows.length}
        icon={<WorkspaceIcon name="field" />}
      >
        <div className="grid gap-4">
          <p className="text-[13px] text-muted">
            Utilization comes from the program checks recorded at each visit.
            Allocation is not in the system yet: it needs Sunpride&apos;s Promo
            Advice.
          </p>
          <div>
            <Button
              variant="outline"
              className="h-10"
              isDisabled={loading || programsIncomplete}
              onPress={() =>
                downloadCsv(
                  `programs-${serviceDate}.csv`,
                  programsCsv(serviceDate, programs),
                )
              }
            >
              Export CSV
            </Button>
          </div>
          {programRows.length ? (
            <DataTable
              rows={programRows}
              columns={programColumns}
              bare
              empty={null}
            />
          ) : (
            <p className="text-[13px] text-muted">No program checks today</p>
          )}
        </div>
      </Card>
      <Card
        label="Collections for AR reckoning"
        count={lines.length}
        icon={<WorkspaceIcon name="queue" />}
      >
        <div className="grid gap-4">
          <p className="text-[13px] text-muted">
            {`${pesoText(collected)} collected in the field. Receivable balances are not in the system yet.`}
          </p>
          {collectionLinesTruncated ? (
            <p className="text-[13px] text-muted">
              Only the first collections are listed and the list cannot be
              exported. Pick a unit or channel.
            </p>
          ) : null}
          <div>
            <Button
              variant="outline"
              className="h-10"
              isDisabled={loading || collectionsIncomplete}
              onPress={() =>
                downloadCsv(
                  `collections-${serviceDate}.csv`,
                  collectionsCsv(serviceDate, collectionLines),
                )
              }
            >
              Export CSV
            </Button>
          </div>
          {lines.length ? (
            <DataTable
              rows={lines}
              columns={collectionColumns}
              bare
              empty={null}
            />
          ) : (
            <p className="text-[13px] text-muted">No collections today</p>
          )}
        </div>
      </Card>
      <Card label="Waiting on Sunpride" icon={<WorkspaceIcon name="queue" />}>
        <ul className="grid gap-2 text-[13px]">
          {AWAITING_REPORTS.map((item) => (
            <li key={item.report} className="flex flex-col">
              <span className="font-medium text-foreground">{item.report}</span>
              <span className="text-muted">{item.needed}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/** Subscribes to every page of the scope and adds them up. */
function AdminReportsData({ filters }: { filters: SupervisionFilters }) {
  const first = useQuery(api.analytics.admin_reports.day, {
    ...filters,
    page: 0,
  });
  const pageCount = first?.pageCount ?? 1;
  const requests: RequestForQueries = {};
  for (let page = 1; page < pageCount; page++)
    requests[String(page)] = {
      query: api.analytics.admin_reports.day,
      args: { ...filters, page },
    };
  const more = useQueries(requests) as Record<
    string,
    PackPage | Error | undefined
  >;
  if (first === undefined)
    return <span className="text-[13px] text-muted">Loading reports…</span>;
  const pages: PackPage[] = [first];
  let loading = false;
  for (let page = 1; page < pageCount; page++) {
    const result = more[String(page)];
    if (result instanceof Error) throw result;
    if (result === undefined) loading = true;
    else pages.push(result);
  }
  return (
    <AdminReportsView
      serviceDate={filters.serviceDate}
      rows={pages.flatMap((page) => page.rows)}
      programs={mergePrograms(pages.map((page) => page.programs))}
      collectionLines={pages.flatMap((page) => page.collectionLines)}
      peopleInScope={first.peopleInScope}
      loading={loading}
      truncated={first.truncated}
      buyingAccountsTruncated={pages.some(
        (page) => page.buyingAccountsTruncated,
      )}
      collectionLinesTruncated={pages.some(
        (page) => page.collectionLinesTruncated,
      )}
    />
  );
}

/**
 * SOP-012 admin report pack (memo §V): daily productive calls, UBA, OSA and mandays;
 * programs utilization; collections for AR reckoning; each with a CSV export.
 */
export function AdminReports() {
  const [serviceDate, setServiceDate] = useState(() => manilaToday());
  const [orgUnitId, setOrgUnitId] = useState<Id<"orgUnits"> | "">("");
  const [channel, setChannel] = useState("");
  const options = useQuery(api.supervision.team.options, { serviceDate });
  const filters: SupervisionFilters = {
    serviceDate,
    ...(orgUnitId ? { orgUnitId } : {}),
    ...(channel ? { channel } : {}),
  };
  const key = `${serviceDate}-${orgUnitId}-${channel}`;
  return (
    <section className="grid gap-4" aria-label="Admin reports">
      <h2 className="text-base font-semibold text-foreground">Admin reports</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[180px] max-w-full">
          <FormField label="Date">
            <input
              type="date"
              aria-label="Report date"
              className="h-10 w-full"
              value={serviceDate}
              max={manilaToday()}
              onChange={(event) => {
                if (event.target.value) setServiceDate(event.target.value);
              }}
            />
          </FormField>
        </div>
        {options && options.units.length > 1 && (
          <div className="w-[220px] max-w-full">
            <FormField label="Unit">
              <select
                aria-label="Report unit"
                className="h-10 w-full"
                value={orgUnitId}
                onChange={(event) =>
                  setOrgUnitId(event.target.value as Id<"orgUnits"> | "")
                }
              >
                <option value="">All units</option>
                {options.units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        )}
        {options && options.channels.length > 0 && (
          <div className="w-[200px] max-w-full">
            <FormField label="Channel">
              <select
                aria-label="Report channel"
                className="h-10 w-full"
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
              >
                <option value="">All channels</option>
                {options.channels.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        )}
      </div>
      <PanelErrorBoundary key={key} label="Admin reports">
        <AdminReportsData filters={filters} />
      </PanelErrorBoundary>
    </section>
  );
}
