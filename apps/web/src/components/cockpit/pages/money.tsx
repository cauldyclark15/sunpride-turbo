"use client";

import { FiscalWorkspace } from "../../fiscal/fiscal-workspace";
import {
  CollectionsPlanPanel,
  readMoneyTab,
} from "../../collections-plan-panel";
import { csvHref, useAnalytics } from "../api";
import { formatPct, formatPhp, formatSince } from "../format";
import {
  CockpitPage,
  DrillTable,
  EmptyState,
  KpiGrid,
  PageData,
  Panel,
  PeriodScopeBar,
  StatusChip,
  type DrillColumn,
} from "../kit";
import type { MoneyResponse, MoneyRow } from "../types";
import { usePageQuery } from "./shared";

export const AGING_BUCKETS: Array<{
  key: keyof MoneyResponse["aging"];
  label: string;
  color: string;
}> = [
  { key: "current", label: "Not yet due", color: "#18181b" },
  { key: "d1_30", label: "1–30 days", color: "#71717a" },
  { key: "d31_60", label: "31–60 days", color: "#d97706" },
  { key: "d61_90", label: "61–90 days", color: "#dc6d1f" },
  { key: "d90p", label: "Over 90 days", color: "#c8102e" },
];

export function AgingBar({ aging }: { aging: MoneyResponse["aging"] }) {
  const total = AGING_BUCKETS.reduce((s, b) => s + aging[b.key], 0);
  if (!total)
    return (
      <EmptyState variant="zero" title="Nothing owed">
        Every account in scope is paid up.
      </EmptyState>
    );
  return (
    <div>
      <div className="flex h-4 overflow-hidden rounded-full" aria-hidden>
        {AGING_BUCKETS.map((b) =>
          aging[b.key] ? (
            <span
              key={b.key}
              style={{
                width: `${(aging[b.key] / total) * 100}%`,
                background: b.color,
              }}
            />
          ) : null,
        )}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5">
        {AGING_BUCKETS.map((b) => (
          <div key={b.key} data-bucket={b.key}>
            <dt className="flex items-center gap-1.5 text-[12px] text-muted">
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: b.color }}
              />
              {b.label}
            </dt>
            <dd className="text-[15px] font-semibold tabular-nums text-foreground">
              {formatPhp(aging[b.key])}
            </dd>
            <dd className="text-[12px] tabular-nums text-muted">
              {formatPct(Math.round((aging[b.key] / total) * 1000) / 10)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function moneyColumns(now: number): DrillColumn<MoneyRow>[] {
  const money = (
    key: keyof MoneyRow,
    label: string,
    warn = false,
  ): DrillColumn<MoneyRow> => ({
    key,
    label,
    align: "right",
    render: (r) => {
      const v = r[key] as number;
      return (
        <span className={warn && v ? "text-[#b4101f]" : v ? "" : "text-muted"}>
          {formatPhp(v)}
        </span>
      );
    },
    sort: (r) => r[key] as number,
  });
  return [
    {
      key: "name",
      label: "Account",
      render: (r) => (
        <span className="flex flex-col">
          <span>{r.name}</span>
          <span className="text-[12px] font-normal text-muted">
            {r.code} · {r.channel} · {r.agent ?? "No agent"}
          </span>
        </span>
      ),
      sort: (r) => r.name,
    },
    money("balance", "Balance"),
    money("current", "Not due"),
    money("d1_30", "1–30"),
    money("d31_60", "31–60", true),
    money("d61_90", "61–90", true),
    money("d90p", "90+", true),
    {
      key: "limit",
      label: "Limit",
      align: "right",
      render: (r) =>
        r.creditLimit === null ? (
          <span className="text-muted">No limit</span>
        ) : (
          <span
            className={
              r.balance > r.creditLimit ? "font-semibold text-[#b4101f]" : ""
            }
          >
            {formatPhp(r.creditLimit)}
          </span>
        ),
      sort: (r) => r.creditLimit,
    },
    {
      key: "paid",
      label: "Last paid",
      align: "right",
      render: (r) => formatSince(r.lastPaymentAt, now),
      sort: (r) => r.lastPaymentAt,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusChip status={r.status} />,
      sort: (r) => ({ over_limit: 0, overdue: 1 })[r.status] ?? 2,
    },
  ];
}

export function MoneyView({
  data,
  csv,
  now: nowProp,
}: {
  data: MoneyResponse;
  csv: string;
  now?: number;
}) {
  const now = nowProp ?? data.freshness.asOf;
  return (
    <div className="grid gap-4">
      <KpiGrid kpis={data.kpis} />
      <Panel
        title="How old the money owed is"
        question="Open receivables by days past the invoice due date."
      >
        <AgingBar aging={data.aging} />
      </Panel>
      <Panel
        csvHref={csv}
        title="Accounts"
        question="Oldest balances first."
        flush
      >
        <DrillTable
          label="Receivables by account"
          columns={moneyColumns(now)}
          rows={data.rows}
          rowKey={(r) => r.accountId}
          empty={
            <EmptyState
              variant="setup"
              title="No receivables loaded"
              action={{ label: "Open Imports", href: "/imports" }}
            >
              Open invoices come from SAP. Until they are imported, this list
              stays empty.
            </EmptyState>
          }
        />
      </Panel>
    </div>
  );
}

export function MoneyPage() {
  const { query, params } = usePageQuery();
  const result = useAnalytics("money", query);
  const overview = readMoneyTab(params) === "overview";
  return (
    <CockpitPage
      title="Money"
      question="Are we collecting?"
      header={result.data}
      bar={
        overview ? (
          <PeriodScopeBar
            showCompare={false}
            scopeLabel={result.data?.scope.label}
          />
        ) : undefined
      }
    >
      <CollectionsPlanPanel
        overview={
          <>
            <PageData result={result} label="money figures">
              {(data) => (
                <MoneyView data={data} csv={csvHref("money", query)} />
              )}
            </PageData>
            <FiscalWorkspace moneyOnly />
          </>
        }
      />
    </CockpitPage>
  );
}
