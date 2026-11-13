"use client";

import type { Id } from "./report-dto";
import { FormField, UnderlineTabs } from "@sunpride/ui";
import { useReport, useReportSearch, replaceReportSearch } from "./report-api";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { PanelErrorBoundary } from "../panel-error-boundary";
import { ExceptionQueue } from "./exception-queue";
import { PerDiem } from "./per-diem";
import { Productivity } from "./productivity";
import { manilaToday, type SupervisionFilters } from "./supervision-model";
import { TalkSheet } from "./talk-sheet";
import { TeamExecution } from "./team-execution";
import { MyTeam } from "./report-depth";
import { WorkWith } from "./work-with";

const ActivityMap = dynamic(
  () => import("./activity-map").then((m) => m.ActivityMap),
  { ssr: false },
);

type SupervisionTab =
  | "team"
  | "exceptions"
  | "map"
  | "workwith"
  | "talk"
  | "productivity"
  | "perdiem";
const TABS: [SupervisionTab, string][] = [
  ["team", "Team"],
  ["exceptions", "Exceptions"],
  ["map", "Map"],
  ["workwith", "Work-With"],
  ["talk", "Talk Sheet"],
  ["productivity", "Productivity"],
  ["perdiem", "Per diem"],
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
  const [pickedTab, setTab] = useState<SupervisionTab>("team");
  const [pickedDate, setServiceDate] = useState(() => manilaToday());
  const params = new URLSearchParams(useReportSearch());
  // r6web5 sweep: unit, channel and "my team only" live in the URL too, so a shared/linked view applies them on load.
  const orgUnitId = (params.get("unit") ?? "") as Id<"orgUnits"> | "";
  const channel = params.get("channel") ?? "";
  const directOnly = params.get("direct") === "1";
  const setOrgUnitId = (v: Id<"orgUnits"> | "") =>
    replaceReportSearch({ unit: v || null });
  const setChannel = (v: string) => replaceReportSearch({ channel: v || null });
  const setDirectOnly = (v: boolean) =>
    replaceReportSearch({ direct: v ? "1" : null });
  const requested = params.get("tab");
  const tab = TABS.some(([id]) => id === requested)
    ? (requested as SupervisionTab)
    : pickedTab;
  const linkedDate = params.get("date");
  const serviceDate =
    linkedDate && /^\d{4}-\d{2}-\d{2}$/.test(linkedDate)
      ? linkedDate
      : pickedDate;
  const options = useReport("supervision.team.options", { serviceDate });
  const filters: SupervisionFilters = {
    serviceDate,
    ...(orgUnitId
      ? { orgUnitId: orgUnitId as NonNullable<SupervisionFilters["orgUnitId"]> }
      : {}),
    ...(channel ? { channel } : {}),
    ...(directOnly ? { directOnly } : {}),
  };
  const key = `${tab}-${serviceDate}-${orgUnitId}-${channel}-${directOnly}`;
  return (
    <div className="grid gap-4">
      <UnderlineTabs
        items={TABS}
        activeId={tab}
        onChange={(id) => {
          setTab(id);
          replaceReportSearch({ tab: id, date: serviceDate });
        }}
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
                if (event.target.value) {
                  setServiceDate(event.target.value);
                  replaceReportSearch({ date: event.target.value });
                }
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
            <>
              <MyTeam filters={filters} />
              <TeamExecution filters={filters} now={now} />
            </>
          ) : tab === "exceptions" ? (
            <ExceptionQueue filters={filters} now={now} />
          ) : tab === "workwith" ? (
            <WorkWith filters={filters} />
          ) : tab === "talk" ? (
            <TalkSheet filters={filters} />
          ) : tab === "productivity" ? (
            <Productivity filters={filters} />
          ) : tab === "perdiem" ? (
            <PerDiem filters={filters} />
          ) : (
            <ActivityMap filters={filters} />
          )}
        </PanelErrorBoundary>
      </div>
    </div>
  );
}
