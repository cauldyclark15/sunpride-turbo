"use client";

import { KPI } from "@heroui-pro/react/kpi";
import type { ReactNode } from "react";

export function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
  /** Accepted for compatibility; KPIs never have decorative icons. */
  icon?: ReactNode;
}) {
  return (
    <KPI className="min-w-0 rounded-2xl border border-border bg-surface p-4 shadow-none">
      <KPI.Header>
        <KPI.Title className="text-[11px] font-medium uppercase tracking-wide text-muted">
          {label}
        </KPI.Title>
      </KPI.Header>
      <KPI.Content>
        <dd className="text-[28px] font-medium leading-9 tabular-nums tracking-tight text-foreground">
          {value}
        </dd>
      </KPI.Content>
      {detail ? (
        <KPI.Footer className="text-[13px] text-muted">{detail}</KPI.Footer>
      ) : null}
    </KPI>
  );
}
