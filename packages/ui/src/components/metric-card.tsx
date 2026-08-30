"use client";

import { KPI } from "@heroui-pro/react/kpi";
import type { ReactNode } from "react";

export function MetricCard({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon?: ReactNode;
}) {
  return (
    <KPI className="min-w-0 border border-border bg-surface shadow-none">
      <KPI.Header>
        <KPI.Title>{label}</KPI.Title>
        {icon ? <KPI.Icon>{icon}</KPI.Icon> : null}
      </KPI.Header>
      <KPI.Content>
        <dd className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
          {value}
        </dd>
      </KPI.Content>
      <KPI.Footer className="text-xs text-muted">{detail}</KPI.Footer>
    </KPI>
  );
}
