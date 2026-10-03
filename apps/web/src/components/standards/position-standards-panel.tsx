"use client";
import { Card, ListRow, WorkspaceIcon } from "@sunpride/ui";
import { api } from "@sunpride/backend/api";
import { useQuery } from "convex/react";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon–Sat" for a contiguous run, otherwise a comma list. */
export function sellingWeekLabel(days: readonly number[]) {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return "No selling days";
  const contiguous = last - first === sorted.length - 1;
  return contiguous && sorted.length > 2
    ? `${WEEKDAYS[first]}–${WEEKDAYS[last]}`
    : sorted.map((day) => WEEKDAYS[day]).join(", ");
}

/**
 * The client's confirmed call standards per position and the productive-call rule they are
 * judged by. Read-only: values come from `positionStandards` (effective-dated, with source).
 */
export function PositionStandardsPanel() {
  const result = useQuery(api.sfa.standards.current, {});
  if (result === undefined)
    return <p className="text-[13px] text-muted">Loading standards…</p>;
  const ruleLabels = new Map(
    result.definition.rules.map((rule) => [rule.code, rule.label]),
  );
  const measured = result.positions.filter(
    (row) =>
      row.standard?.dailyCallsTarget !== undefined ||
      row.standard?.workWithWeeklyMin !== undefined,
  );
  return (
    <div className="grid gap-4">
      <Card
        label="Call standards"
        icon={<WorkspaceIcon name="field" />}
        count={measured.length}
      >
        {measured.length === 0 ? (
          <p className="text-[13px] text-muted">No standards recorded</p>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-border">
            {measured.map(({ positionId, label, standard }) => {
              const s = standard!;
              const target =
                s.dailyCallsTarget !== undefined
                  ? `${s.dailyCallsTarget} calls a day · ${s.productiveCallTargetPct ?? "—"}% productive`
                  : `Work With ${s.workWithWeeklyMin}/week · ${s.workWithMonthlyMin ?? "—"}/month`;
              const meta = [
                s.productiveCallRule
                  ? ruleLabels.get(s.productiveCallRule)
                  : undefined,
                `Selling days ${sellingWeekLabel(s.sellingWeekdays ?? result.definition.defaultSellingWeekdays)}`,
                `Source: ${s.sourceRef}`,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={positionId}>
                  <ListRow
                    icon={<WorkspaceIcon name="field" />}
                    title={label}
                    meta={s.notes ? `${meta} · ${s.notes}` : meta}
                    value={
                      <span className="text-[13px] tabular-nums">{target}</span>
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card label="Productive call" icon={<WorkspaceIcon name="field" />}>
        <div className="grid gap-2 text-[13px]">
          <p>
            A call is a store in the day&apos;s route plan that was visited. It
            is productive when any one of these was recorded at the visit:
          </p>
          <ul className="list-disc pl-5">
            {result.definition.activities.map((activity) => (
              <li key={activity.code}>{activity.label}</li>
            ))}
          </ul>
          <p className="text-muted">
            Truck sellers (PMOT, PMOT Extruck, RDS) must sell; when the store
            needs no stock they mark the visit “visited, no sales due to
            inventory” and merchandising then counts. Saturday is a selling day.
            Rule {result.definition.ruleVersion}.
          </p>
        </div>
      </Card>
    </div>
  );
}
