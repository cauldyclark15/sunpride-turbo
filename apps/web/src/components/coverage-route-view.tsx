"use client";
import { Button } from "@heroui/react";
import { Card, ListRow, StatusPill, WorkspaceIcon } from "@sunpride/ui";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useQuery } from "convex/react";
import { useState } from "react";

export function CoverageRouteView({ planId }: { planId: Id<"coveragePlans"> }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const result = useQuery(api.coverage.views.byRoute, {
    planId,
    paginationOpts: { numItems: 20, cursor },
  });
  return (
    <Card
      label="Routes"
      icon={<WorkspaceIcon name="field" />}
      count={result?.page.length}
    >
      <div className="grid gap-4">
        {result === undefined ? (
          <p className="text-[13px] text-muted">Loading routes…</p>
        ) : result.page.length === 0 ? (
          <p className="text-[13px] text-muted">No routes here</p>
        ) : (
          result.page.map((group) => (
            <section
              key={`${group.territoryId ?? "none"}:${group.routeId ?? "none"}`}
            >
              <h3 className="mb-1 text-[13px] font-medium">
                {group.territoryCode} · {group.routeCode}
              </h3>
              <p className="mb-2 text-[13px] text-muted">
                {group.coveredCount} covered · {group.uncoveredCount} uncovered
                · {group.slotCount} slots · {group.visitCount} visits
              </p>
              <ul className="overflow-hidden rounded-xl border border-border">
                {group.outlets.map((outlet) => (
                  <li key={outlet.outletCode}>
                    <ListRow
                      icon={<WorkspaceIcon name="field" />}
                      title={outlet.name}
                      meta={`${outlet.outletCode} · ${outlet.frequency ?? "No frequency"}`}
                      value={
                        <StatusPill
                          tone={outlet.covered ? "success" : "neutral"}
                        >
                          {outlet.covered ? "Covered" : "Uncovered"}
                        </StatusPill>
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
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
