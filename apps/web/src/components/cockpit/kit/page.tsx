"use client";

import type { ReactNode } from "react";
import type { ApiResult } from "@/lib/api";
import { formatDateRange } from "../format";
import type { ResponseHeader } from "../types";
import { DemoBadge, FreshnessNote } from "./freshness";
import { PanelError } from "./panel";

/** F-601: main-report tables with the shared URL filters; add-on panels export their own source views. */
export function downloadCurrentWorkbook(
  period?: { from: string; to: string },
  query?: Record<string, string | undefined>,
) {
  const current = new URL(window.location.href);
  const page = (
    {
      "/today": "today",
      "/sales": "sales",
      "/coverage-people": "coverage",
      "/coverage-people/agent": "agent-day",
      "/stores": "stores",
      "/stores/store": "store",
      "/stock": "stock",
      "/vans": "vans",
      "/money": "money",
      "/decide": "exceptions",
    } as Record<string, string>
  )[current.pathname];
  if (!page) return;
  current.pathname = `/api/v1/analytics/${page}`;
  for (const [key, value] of Object.entries(query ?? {}))
    if (value !== undefined && value !== "")
      current.searchParams.set(key, value);
  if (period) {
    current.searchParams.set("from", period.from);
    current.searchParams.set("to", period.to);
    if (page === "today" || page === "agent-day")
      current.searchParams.set("date", period.to);
  }
  current.searchParams.set("format", "xlsx");
  current.searchParams.delete("cursor");
  current.searchParams.delete("limit");
  window.location.assign(current.toString());
}

/** The page head: the owner question, the period in words, freshness and the demo badge. */
export function CockpitPage({
  title,
  question,
  header,
  bar,
  actions,
  exportQuery,
  children,
}: {
  title: string;
  question: string;
  header?: ResponseHeader;
  bar?: ReactNode;
  actions?: ReactNode;
  exportQuery?: Record<string, string | undefined>;
  children: ReactNode;
}) {
  return (
    <div className="ck-page grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[22px] font-semibold tracking-tight text-foreground sm:text-[26px]">
              {title}
            </h1>
            {header ? <DemoBadge demo={header.demo} /> : null}
          </div>
          <p className="mt-0.5 text-[14px] text-muted">{question}</p>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          {header ? (
            <p className="text-[12px] text-muted">
              <span className="font-medium text-foreground">
                {header.scope.label}
              </span>{" "}
              · {formatDateRange(header.period.from, header.period.to)}
              {header.period.days > 1
                ? ` · vs ${formatDateRange(header.compare.from, header.compare.to)}`
                : ""}
            </p>
          ) : null}
          {header ? <FreshnessNote freshness={header.freshness} /> : null}
          <div className="flex flex-wrap items-center gap-2 empty:hidden">
            {actions}
            {header ? (
              <button
                type="button"
                className="ck-noprint rounded-lg border border-border px-3 py-1 text-[13px] hover:bg-default-soft"
                onClick={() =>
                  downloadCurrentWorkbook(header.period, exportQuery)
                }
                title="Exports the main report. Other panels have their own Excel links."
              >
                Download Excel
              </button>
            ) : null}
          </div>
        </div>
      </header>
      {bar}
      {children}
    </div>
  );
}

/** Loading, failure (what failed + retry) or the data, for one page read. */
export function PageData<T>({
  result,
  label,
  children,
}: {
  result: Pick<ApiResult<T>, "data" | "error" | "refetch">;
  label: string;
  children: (data: T) => ReactNode;
}) {
  if (result.data !== undefined) return <>{children(result.data)}</>;
  if (result.error)
    return (
      <PanelError
        label={label}
        message={
          result.error.status === 403
            ? "Your account cannot see these figures. Ask an administrator for access."
            : `${result.error.message} Your filters are kept; try again.`
        }
        onRetry={() => void result.refetch()}
      />
    );
  return <PageSkeleton />;
}

export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading figures" className="grid gap-3">
      <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div
            key={i}
            className="h-[118px] animate-pulse rounded-2xl border border-border bg-default-soft/40"
          />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-2xl border border-border bg-default-soft/40" />
    </div>
  );
}
