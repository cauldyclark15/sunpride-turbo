"use client";
import { Button } from "@heroui/react";
import { Card, ListRow, WorkspaceIcon } from "@sunpride/ui";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useQuery } from "convex/react";
import { useState } from "react";
import {
  CoverageScopeSelect,
  useCoverageScopeOptions,
} from "./coverage-scope-filters";

export function CoverageWorkloadView({
  localMonth,
  planId,
}: {
  localMonth: string;
  planId?: Id<"coveragePlans">;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [territoryId, setTerritory] = useState("");
  const [routeId, setRoute] = useState("");
  const result = useQuery(api.coverage.views.workload, {
    localMonth,
    territoryId: territoryId ? (territoryId as Id<"territories">) : undefined,
    routeId: routeId ? (routeId as Id<"routes">) : undefined,
    paginationOpts: { numItems: 20, cursor },
  });
  const options = useCoverageScopeOptions(planId);
  return (
    <Card
      label="Workload"
      icon={<WorkspaceIcon name="field" />}
      count={result?.page.length}
    >
      <div className="grid gap-4">
        {planId ? (
          <div className="flex flex-wrap gap-3">
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
          </div>
        ) : null}
        {result === undefined ? (
          <p className="text-[13px] text-muted">Loading workload…</p>
        ) : result.page.length === 0 ? (
          <p className="text-[13px] text-muted">No employees here</p>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-border">
            {result.page.map((person) => (
              <li key={person.assigneeProfileId}>
                <ListRow
                  icon={<WorkspaceIcon name="field" />}
                  title={person.assigneeName}
                  meta={`${person.selection} · ${person.routeCodes.join(", ") || "No route"} · ${person.workingDays.join(", ") || "No working days"}`}
                  value={
                    <span className="text-[13px] tabular-nums">
                      {person.visitCount} calls · {person.durationMinutes} min ·{" "}
                      {person.dailyCallsTarget === undefined
                        ? "No target"
                        : `${person.dailyCallsTarget}/day · ${person.variance! > 0 ? "Over" : person.variance! < 0 ? "Under" : "On"} (${person.variance})`}
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
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
