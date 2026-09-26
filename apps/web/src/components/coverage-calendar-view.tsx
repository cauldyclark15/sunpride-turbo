"use client";
import { Button } from "@heroui/react";
import {
  Card,
  ListRow,
  StatusPill,
  UnderlineTabs,
  WorkspaceIcon,
} from "@sunpride/ui";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useQuery } from "convex/react";
import { useState } from "react";
import {
  groupCalendar,
  slotKindLabel,
  coverageStatusLabel,
  type CalendarMode,
} from "../lib/coverage-view-model";
import {
  CoverageScopeSelect,
  useCoverageScopeOptions,
} from "./coverage-scope-filters";

/** The selected plan/assignee picker is supplied by scoped discovery (slice A). */
export function CoverageCalendarView({
  planId,
  assigneeName,
}: {
  planId: Id<"coveragePlans">;
  assigneeName: string;
}) {
  const [mode, setMode] = useState<CalendarMode>("week");
  const [territoryId, setTerritory] = useState("");
  const [routeId, setRoute] = useState("");
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const result = useQuery(api.coverage.views.calendar, {
    planId,
    territoryId: territoryId ? (territoryId as Id<"territories">) : undefined,
    routeId: routeId ? (routeId as Id<"routes">) : undefined,
    visitStatus: status
      ? (status as "planned" | "cancelled" | "replaced")
      : undefined,
    paginationOpts: { numItems: 20, cursor },
  });
  const rows = result?.page ?? [];
  const options = useCoverageScopeOptions(planId);
  return (
    <Card
      label="Calendar"
      count={rows.length}
      icon={<WorkspaceIcon name="field" />}
    >
      <div className="grid gap-4">
        <p className="text-[13px] text-muted">{assigneeName}</p>
        <div className="flex flex-wrap items-end gap-3">
          <UnderlineTabs
            items={[
              ["day", "Day"],
              ["week", "Week"],
              ["month", "Month"],
            ]}
            activeId={mode}
            onChange={setMode}
            label="Calendar range"
          />
          <CoverageScopeSelect
            label="Territory"
            options={options?.territories ?? []}
            selected={territoryId}
            onSelect={(id) => {
              setTerritory(id);
              setCursor(null);
            }}
          />
          <CoverageScopeSelect
            label="Route"
            options={options?.routes ?? []}
            selected={routeId}
            onSelect={(id) => {
              setRoute(id);
              setCursor(null);
            }}
          />
          <label className="grid gap-1.5 text-[13px] font-medium">
            Status
            <select
              className="h-10 rounded-[10px] border border-border bg-surface px-3 text-sm"
              aria-label="Visit status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setCursor(null);
              }}
            >
              <option value="">All</option>
              <option value="planned">Planned</option>
              <option value="cancelled">Cancelled</option>
              <option value="replaced">Replaced</option>
            </select>
          </label>
        </div>
        {result === undefined ? (
          <p>Loading calendar…</p>
        ) : rows.length === 0 ? (
          <p>No entries here</p>
        ) : (
          groupCalendar(rows, mode).map(([key, entries]) => (
            <div key={key}>
              <h4 className="font-medium">
                {mode === "week" ? `Week of ${key}` : key}
              </h4>
              <ul className="overflow-hidden rounded-xl border border-border">
                {entries.map((row) => (
                  <li key={row.slotKey}>
                    <ListRow
                      icon={<WorkspaceIcon name="field" />}
                      title={row.name ?? "Non-visit"}
                      meta={`${row.serviceDate} · ${row.sequence} · ${row.outletCode ?? ""} · ${row.routeCode ?? "No route"} · ${slotKindLabel(row.kind)}`}
                      value={
                        <span className="flex items-center gap-2">
                          <StatusPill
                            tone={
                              row.visitStatus === "cancelled"
                                ? "neutral"
                                : "success"
                            }
                          >
                            {coverageStatusLabel(
                              row.visitStatus ?? row.planStatus,
                            )}
                          </StatusPill>
                          <span className="tabular-nums">
                            {row.durationMinutes} min
                          </span>
                        </span>
                      }
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="h-10"
            isDisabled={cursor === null}
            onPress={() => setCursor(null)}
          >
            First page
          </Button>
          <Button
            variant="outline"
            className="h-10"
            isDisabled={!result || result.isDone}
            onPress={() => setCursor(result!.continueCursor)}
          >
            Next page
          </Button>
        </div>
      </div>
    </Card>
  );
}
