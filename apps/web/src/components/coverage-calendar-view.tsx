"use client";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useQuery } from "convex/react";
import { useState } from "react";
import { groupCalendar, type CalendarMode } from "../lib/coverage-view-model";

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
  const territories = [
    ...new Set(rows.filter((x) => x.territoryId).map((x) => x.territoryId!)),
  ];
  const routes = [
    ...new Map(
      rows
        .filter((x) => x.routeId)
        .map((x) => [x.routeId!, x.routeCode ?? "No route"]),
    ).entries(),
  ];
  return (
    <section
      aria-label="Coverage calendar"
      className="space-y-3 rounded border border-border p-4"
    >
      <h3 className="font-semibold">Calendar · {assigneeName}</h3>
      <p className="text-sm">
        Draft/submitted = provisional proposal; approved = signed slots; active
        = generated visits. Cancelled/replaced visits are historical, not active
        calls.
      </p>
      <div className="flex flex-wrap gap-2">
        {(["day", "week", "month"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            {value}
          </button>
        ))}
        <label>
          Territory{" "}
          <select
            aria-label="Territory"
            value={territoryId}
            onChange={(e) => {
              setTerritory(e.target.value);
              setCursor(null);
            }}
          >
            <option value="">All</option>
            {territories.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Route{" "}
          <select
            aria-label="Route"
            value={routeId}
            onChange={(e) => {
              setRoute(e.target.value);
              setCursor(null);
            }}
          >
            <option value="">All</option>
            {routes.map(([id, code]) => (
              <option key={id} value={id}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status{" "}
          <select
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
        <p>No entries on this page.</p>
      ) : (
        groupCalendar(rows, mode).map(([key, entries]) => (
          <div key={key}>
            <h4 className="font-medium">
              {mode === "week" ? `Week of ${key}` : key}
            </h4>
            <ul>
              {entries.map((row) => (
                <li key={row.slotKey}>
                  {row.serviceDate} · {row.sequence} · {row.name ?? "Non-visit"}{" "}
                  {row.outletCode ? `(${row.outletCode})` : ""} ·{" "}
                  {row.routeCode ?? "No route"} · {row.kind} ·{" "}
                  {row.visitStatus ?? row.planStatus} · {row.durationMinutes}{" "}
                  min
                </li>
              ))}
            </ul>
          </div>
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
