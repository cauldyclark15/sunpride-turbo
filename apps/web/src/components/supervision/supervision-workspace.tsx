"use client";

import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { FormField, UnderlineTabs } from "@sunpride/ui";
import { useQuery } from "convex/react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { PanelErrorBoundary } from "../panel-error-boundary";
import { ExceptionQueue } from "./exception-queue";
import { manilaToday, type SupervisionFilters } from "./supervision-model";
import { TeamExecution } from "./team-execution";

const ActivityMap = dynamic(
  () => import("./activity-map").then((m) => m.ActivityMap),
  { ssr: false },
);

type SupervisionTab = "team" | "exceptions" | "map";
const TABS: [SupervisionTab, string][] = [
  ["team", "Team"],
  ["exceptions", "Exceptions"],
  ["map", "Map"],
];

/** The viewer's clock, refreshed every minute, for time-based statuses. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function SupervisionWorkspace() {
  const now = useNow();
  const [tab, setTab] = useState<SupervisionTab>("team");
  const [serviceDate, setServiceDate] = useState(() => manilaToday());
  const [orgUnitId, setOrgUnitId] = useState<Id<"orgUnits"> | "">("");
  const [channel, setChannel] = useState("");
  const [directOnly, setDirectOnly] = useState(false);
  const options = useQuery(api.supervision.team.options, { serviceDate });
  const filters: SupervisionFilters = {
    serviceDate,
    ...(orgUnitId ? { orgUnitId } : {}),
    ...(channel ? { channel } : {}),
    ...(directOnly ? { directOnly } : {}),
  };
  const key = `${tab}-${serviceDate}-${orgUnitId}-${channel}-${directOnly}`;
  return (
    <div className="grid gap-4">
      <UnderlineTabs
        items={TABS}
        activeId={tab}
        onChange={setTab}
        label="Supervision views"
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[180px] max-w-full">
          <FormField label="Date">
            <input
              type="date"
              aria-label="Service date"
              className="h-10 w-full"
              value={serviceDate}
              max={manilaToday(now)}
              onChange={(event) => {
                if (event.target.value) setServiceDate(event.target.value);
              }}
            />
          </FormField>
        </div>
        {options && options.units.length > 1 && (
          <div className="w-[220px] max-w-full">
            <FormField label="Unit">
              <select
                aria-label="Unit"
                className="h-10 w-full"
                value={orgUnitId}
                onChange={(event) =>
                  setOrgUnitId(event.target.value as Id<"orgUnits"> | "")
                }
              >
                <option value="">All units</option>
                {options.units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        )}
        {options && options.channels.length > 0 && (
          <div className="w-[200px] max-w-full">
            <FormField label="Channel">
              <select
                aria-label="Channel"
                className="h-10 w-full"
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
              >
                <option value="">All channels</option>
                {options.channels.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        )}
        <label className="flex h-10 items-center gap-2 text-[13px] text-foreground">
          <input
            type="checkbox"
            checked={directOnly}
            onChange={(event) => setDirectOnly(event.target.checked)}
          />
          My team only
        </label>
      </div>
      <div role="tabpanel">
        <PanelErrorBoundary key={key} label={`Supervision ${tab}`}>
          {tab === "team" ? (
            <TeamExecution filters={filters} now={now} />
          ) : tab === "exceptions" ? (
            <ExceptionQueue filters={filters} now={now} />
          ) : (
            <ActivityMap filters={filters} />
          )}
        </PanelErrorBoundary>
      </div>
    </div>
  );
}
