"use client";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useQuery } from "convex/react";
import { useState } from "react";

export function CoverageWorkloadView({ localMonth }: { localMonth: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [territoryId, setTerritory] = useState("");
  const [routeId, setRoute] = useState("");
  const result = useQuery(api.coverage.views.workload, {
    localMonth,
    territoryId: territoryId ? (territoryId as Id<"territories">) : undefined,
    routeId: routeId ? (routeId as Id<"routes">) : undefined,
    paginationOpts: { numItems: 20, cursor },
  });
  return (
    <section
      aria-label="Employee workload"
      className="space-y-3 rounded border border-border p-4"
    >
      <h3 className="font-semibold">Employee workload · {localMonth}</h3>
      <p className="text-sm">
        One selected version per employee. Variance is advisory, against the
        effective daily call standard × planned working days.
      </p>
      <div className="flex gap-2">
        <label>
          Territory ID{" "}
          <input
            aria-label="Territory ID"
            value={territoryId}
            onChange={(e) => {
              setTerritory(e.target.value);
              setCursor(null);
            }}
          />
        </label>
        <label>
          Route ID{" "}
          <input
            aria-label="Route ID"
            value={routeId}
            onChange={(e) => {
              setRoute(e.target.value);
              setCursor(null);
            }}
          />
        </label>
      </div>
      {result === undefined ? (
        <p>Loading workload…</p>
      ) : result.page.length === 0 ? (
        <p>No scoped employees on this page.</p>
      ) : (
        <ul>
          {result.page.map((person) => (
            <li key={person.assigneeProfileId}>
              <strong>{person.assigneeName}</strong> · {person.selection} ·{" "}
              {person.routeCodes.join(", ") || "No route"} ·{" "}
              {person.workingDays.join(", ") || "No working days"} ·{" "}
              {person.visitCount} calls · {person.durationMinutes} min ·{" "}
              {person.dailyCallsTarget === undefined
                ? "No effective standard"
                : `${person.dailyCallsTarget}/day target · ${person.variance! > 0 ? "Over" : person.variance! < 0 ? "Under" : "On"} target (${person.variance})`}
            </li>
          ))}
        </ul>
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
