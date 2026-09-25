"use client";
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
    <section
      aria-label="Coverage by route"
      className="space-y-3 rounded border border-border p-4"
    >
      <h3 className="font-semibold">Territory / route coverage</h3>
      <p className="text-sm">
        Uncovered = eligible, currently scoped assigned outlets absent from this
        version. Counts exclude other units.
      </p>
      {result === undefined ? (
        <p>Loading routes…</p>
      ) : result.page.length === 0 ? (
        <p>No scoped routes on this page.</p>
      ) : (
        result.page.map((group) => (
          <article
            key={`${group.territoryId ?? "none"}:${group.routeId ?? "none"}`}
          >
            <h4 className="font-medium">
              {group.territoryCode} / {group.routeCode}
            </h4>
            <p>
              {group.coveredCount} covered · {group.uncoveredCount} uncovered ·{" "}
              {group.slotCount} slots · {group.visitCount} planned visits
            </p>
            <ul>
              {group.outlets.map((outlet) => (
                <li key={outlet.outletCode}>
                  {outlet.outletCode} · {outlet.name} ·{" "}
                  {outlet.frequency ?? "No planned frequency"} ·{" "}
                  {outlet.covered ? "Covered" : "Uncovered"}
                </li>
              ))}
            </ul>
          </article>
        ))
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={cursor === null}
          onClick={() => setCursor(null)}
        >
          First page
        </button>
        <button
          type="button"
          disabled={!result || result.isDone}
          onClick={() => setCursor(result!.continueCursor)}
        >
          Next page
        </button>
      </div>
    </section>
  );
}
