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
import { useQuery } from "convex/react";
import { useState, type ReactNode } from "react";
import {
  allocationsCsv,
  allocationUsePct,
  claimsByPartner,
  claimsCsv,
  DOC_TYPE_LABEL,
  openingMinor,
  pastDueMinor,
  prioritiesCsv,
  PRIORITY_STATUS_LABEL,
  priorityOverdue,
  receivablesCsv,
  remainingMinor,
  sourceText,
  type AllocationRow,
  type ClaimRow,
  type PackSource,
  type PartnerClaims,
  type PriorityRow,
  type ReceivableRow,
} from "../../lib/admin-pack-month";
import { pctText, pesoText } from "../../lib/admin-reports";
import { downloadCsv } from "../../lib/import-csv-export";
import { PanelErrorBoundary } from "../panel-error-boundary";
import { manilaToday } from "../supervision/supervision-model";

type MonthPack = {
  month: string;
  sources: {
    allocations: PackSource;
    priorities: PackSource;
    claims: PackSource;
    receivables: PackSource;
  };
  allocations: readonly AllocationRow[];
  priorities: readonly PriorityRow[];
  claims: readonly ClaimRow[];
  receivables: readonly ReceivableRow[];
  truncated: {
    allocations: boolean;
    priorities: boolean;
    claims: boolean;
    receivables: boolean;
  };
};

const money = (minor: number) => (
  <span className="tabular-nums">{pesoText(minor)}</span>
);

function Section({
  label,
  count,
  icon,
  source,
  truncated,
  empty,
  exportName,
  exportCsv,
  children,
  summary,
}: {
  label: string;
  count: number;
  icon: "field" | "queue" | "user";
  source: PackSource;
  truncated: boolean;
  empty: string;
  exportName: string;
  exportCsv: () => string;
  children: ReactNode;
  summary?: ReactNode;
}) {
  return (
    <Card label={label} count={count} icon={<WorkspaceIcon name={icon} />}>
      <div className="grid gap-4">
        <p className="text-[13px] text-muted">{sourceText(source)}</p>
        {summary}
        {truncated ? (
          <p className="text-[13px] text-muted">
            Too many records to read at once, so this report is incomplete and
            cannot be exported. Pick a unit.
          </p>
        ) : null}
        <div>
          <Button
            variant="outline"
            className="h-10"
            isDisabled={truncated || count === 0}
            onPress={() => downloadCsv(exportName, exportCsv())}
          >
            Export CSV
          </Button>
        </div>
        {count ? children : <p className="text-[13px] text-muted">{empty}</p>}
      </div>
    </Card>
  );
}

export function AdminMonthlyPackView({
  pack,
  today,
}: {
  pack: MonthPack;
  today: string;
}) {
  const { month } = pack;
  const allocations = pack.allocations.map((row) => ({ ...row, id: row.code }));
  const priorities = pack.priorities.map((row) => ({ ...row, id: row.code }));
  const partners = claimsByPartner(pack.claims).map((row) => ({
    ...row,
    id: row.partnerCode,
  }));
  const receivables = pack.receivables.map((row) => ({
    ...row,
    id: row.code,
  }));
  const overdue = pack.priorities.filter((row) =>
    priorityOverdue(row, today),
  ).length;
  const claimed = partners.reduce((sum, row) => sum + row.claimedMinor, 0);
  const openClaims = partners.reduce((sum, row) => sum + row.openMinor, 0);
  const opening = pack.receivables.reduce(
    (sum, row) => sum + openingMinor(row),
    0,
  );
  const remaining = pack.receivables.reduce(
    (sum, row) => sum + remainingMinor(row),
    0,
  );

  const allocationColumns: DataColumn<AllocationRow & { id: string }>[] = [
    {
      key: "program",
      label: "Program",
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-sm font-medium text-foreground">
            {row.programName}
          </span>
          <span className="font-mono text-xs text-muted">{row.programRef}</span>
        </span>
      ),
    },
    {
      key: "allocated",
      label: "Allocated stores",
      align: "right",
      render: (row) => String(row.allocatedStores),
    },
    {
      key: "executed",
      label: "Stores executed",
      align: "right",
      render: (row) => String(row.executedStores),
    },
    {
      key: "used",
      label: "Used",
      align: "right",
      render: (row) => pctText(allocationUsePct(row)),
    },
    {
      key: "checks",
      label: "Checks done / not done",
      align: "right",
      render: (row) => `${row.executedChecks} / ${row.notExecutedChecks}`,
    },
    {
      key: "budget",
      label: "Budget",
      align: "right",
      render: (row) => money(row.budgetMinor),
    },
  ];

  const priorityColumns: DataColumn<PriorityRow & { id: string }>[] = [
    {
      key: "doc",
      label: "Document",
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-sm font-medium text-foreground">
            {DOC_TYPE_LABEL[row.docType]}
          </span>
          <span className="text-xs text-muted">{row.title}</span>
        </span>
      ),
    },
    { key: "account", label: "Account", render: (row) => row.accountName },
    { key: "owner", label: "Owner", render: (row) => row.ownerName },
    {
      key: "due",
      label: "Due",
      align: "right",
      render: (row) => (
        <span className="font-mono text-[13px]">{row.dueDate}</span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (row) =>
        priorityOverdue(row, today)
          ? `${PRIORITY_STATUS_LABEL[row.status]} · overdue`
          : PRIORITY_STATUS_LABEL[row.status],
    },
  ];

  const partnerColumns: DataColumn<PartnerClaims & { id: string }>[] = [
    {
      key: "partner",
      label: "Distribution partner",
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-sm font-medium text-foreground">
            {row.partnerName}
          </span>
          <span className="font-mono text-xs text-muted">
            {row.partnerCode}
          </span>
        </span>
      ),
    },
    {
      key: "claims",
      label: "Claims",
      align: "right",
      render: (row) => String(row.claims),
    },
    {
      key: "claimed",
      label: "Claimed",
      align: "right",
      render: (row) => money(row.claimedMinor),
    },
    {
      key: "approved",
      label: "Approved",
      align: "right",
      render: (row) => money(row.approvedMinor),
    },
    {
      key: "paid",
      label: "Paid",
      align: "right",
      render: (row) => money(row.paidMinor),
    },
    {
      key: "open",
      label: "Open",
      align: "right",
      render: (row) => money(row.openMinor),
    },
  ];

  const receivableColumns: DataColumn<ReceivableRow & { id: string }>[] = [
    {
      key: "account",
      label: "Account",
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-sm font-medium text-foreground">
            {row.customerName}
          </span>
          <span className="font-mono text-xs text-muted">
            {row.customerCode}
            {row.customerFound ? "" : " · not in customer list"}
          </span>
        </span>
      ),
    },
    {
      key: "opening",
      label: "Opening balance",
      align: "right",
      render: (row) => money(openingMinor(row)),
    },
    {
      key: "pastDue",
      label: "Past due",
      align: "right",
      render: (row) => money(pastDueMinor(row)),
    },
    {
      key: "collected",
      label: "Collected",
      align: "right",
      render: (row) => money(row.collectedMinor),
    },
    {
      key: "pending",
      label: "Pending review",
      align: "right",
      render: (row) => money(row.pendingReviewMinor),
    },
    {
      key: "remaining",
      label: "Remaining",
      align: "right",
      render: (row) => money(remainingMinor(row)),
    },
  ];

  return (
    <div className="grid gap-4">
      <Section
        label="Programs utilization vs allocation"
        count={allocations.length}
        icon="field"
        source={pack.sources.allocations}
        truncated={pack.truncated.allocations}
        empty="No programme allocations this month"
        exportName={`programs-allocation-${month}.csv`}
        exportCsv={() =>
          allocationsCsv(month, pack.allocations, pack.sources.allocations)
        }
      >
        <DataTable
          rows={allocations}
          columns={allocationColumns}
          bare
          empty={null}
        />
      </Section>
      <Section
        label="Priorities"
        count={priorities.length}
        icon="queue"
        source={pack.sources.priorities}
        truncated={pack.truncated.priorities}
        empty="No priority documents this month"
        exportName={`priorities-${month}.csv`}
        exportCsv={() =>
          prioritiesCsv(month, pack.priorities, today, pack.sources.priorities)
        }
        summary={
          <p className="text-[13px] text-muted">
            {overdue ? `${overdue} overdue` : "Nothing overdue"}
          </p>
        }
      >
        <DataTable
          rows={priorities}
          columns={priorityColumns}
          bare
          empty={null}
        />
      </Section>
      <Section
        label="Claims Summary (ADP)"
        count={pack.claims.length}
        icon="queue"
        source={pack.sources.claims}
        truncated={pack.truncated.claims}
        empty="No distribution partner claims this month"
        exportName={`adp-claims-${month}.csv`}
        exportCsv={() => claimsCsv(month, pack.claims, pack.sources.claims)}
        summary={
          <div className="grid gap-4 sm:grid-cols-2">
            <MetricCard
              label="Claimed"
              value={pesoText(claimed)}
              detail={`${pack.claims.length} claims`}
            />
            <MetricCard
              label="Open"
              value={pesoText(openClaims)}
              detail="Filed or validated, not yet decided"
            />
          </div>
        }
      >
        <DataTable rows={partners} columns={partnerColumns} bare empty={null} />
      </Section>
      <Section
        label="Account Receivables reckoning (KAS)"
        count={receivables.length}
        icon="user"
        source={pack.sources.receivables}
        truncated={pack.truncated.receivables}
        empty="No receivable balances this month"
        exportName={`ar-reckoning-${month}.csv`}
        exportCsv={() =>
          receivablesCsv(month, pack.receivables, pack.sources.receivables)
        }
        summary={
          <div className="grid gap-4 sm:grid-cols-2">
            <MetricCard
              label="Opening balance"
              value={pesoText(opening)}
              detail={`${receivables.length} key accounts`}
            />
            <MetricCard
              label="Remaining"
              value={pesoText(remaining)}
              detail="After recorded field collections"
            />
          </div>
        }
      >
        <DataTable
          rows={receivables}
          columns={receivableColumns}
          bare
          empty={null}
        />
      </Section>
    </div>
  );
}

function MonthlyPackData({
  month,
  orgUnitId,
}: {
  month: string;
  orgUnitId: Id<"orgUnits"> | "";
}) {
  const pack = useQuery(api.analytics.admin_pack.month, {
    month,
    ...(orgUnitId ? { orgUnitId } : {}),
  });
  if (pack === undefined)
    return (
      <span className="text-[13px] text-muted">Loading monthly reports…</span>
    );
  return <AdminMonthlyPackView pack={pack} today={manilaToday()} />;
}

/**
 * SOP-012 monthly pack: programme allocation, priorities, ADP claims and KAS receivables,
 * each with a CSV export. Inputs are sample data until Sunpride's real records replace them.
 */
export function AdminMonthlyPack() {
  const [month, setMonth] = useState(() => manilaToday().slice(0, 7));
  const [orgUnitId, setOrgUnitId] = useState<Id<"orgUnits"> | "">("");
  const options = useQuery(api.supervision.team.options, {
    serviceDate: `${month}-01`,
  });
  return (
    <section className="grid gap-4" aria-label="Monthly admin reports">
      <h3 className="text-sm font-semibold text-foreground">
        Monthly admin reports
      </h3>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[180px] max-w-full">
          <FormField label="Month">
            <input
              type="month"
              aria-label="Report month"
              className="h-10 w-full"
              value={month}
              onChange={(event) => {
                if (/^\d{4}-\d{2}$/.test(event.target.value))
                  setMonth(event.target.value);
              }}
            />
          </FormField>
        </div>
        {options && options.units.length > 1 && (
          <div className="w-[220px] max-w-full">
            <FormField label="Unit">
              <select
                aria-label="Monthly report unit"
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
      </div>
      <PanelErrorBoundary
        key={`${month}-${orgUnitId}`}
        label="Monthly admin reports"
      >
        <MonthlyPackData month={month} orgUnitId={orgUnitId} />
      </PanelErrorBoundary>
    </section>
  );
}
