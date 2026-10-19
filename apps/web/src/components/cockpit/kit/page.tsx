"use client";

import type { ReactNode } from "react";
import type { ApiResult } from "@/lib/api";
import { formatDateRange } from "../format";
import type { ResponseHeader } from "../types";
import { DemoBadge, FreshnessNote } from "./freshness";
import { PanelError } from "./panel";

/** The page head: the owner question, the period in words, freshness and the demo badge. */
export function CockpitPage({
  title,
  question,
  header,
  bar,
  actions,
  children,
}: {
  title: string;
  question: string;
  header?: ResponseHeader;
  bar?: ReactNode;
  actions?: ReactNode;
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
          {actions}
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
