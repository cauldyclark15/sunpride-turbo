"use client";

import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  FormField,
  Pager,
  UnderlineTabs,
  WorkspaceIcon,
} from "@sunpride/ui";
import { useQuery } from "convex/react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { salesForcePanels } from "../lib/module-access";
import { CoveragePlanner } from "./coverage-planner";
import { CoverageReview } from "./coverage-review";
import { OutletAdmin } from "./outlet-admin";
import { OutletAssignments } from "./outlet-assignments";
import { PanelErrorBoundary } from "./panel-error-boundary";
import { RouteAdmin } from "./route-admin";

const CoverageCalendarView = dynamic(() =>
  import("./coverage-calendar-view").then((m) => m.CoverageCalendarView),
);
const CoverageRouteView = dynamic(() =>
  import("./coverage-route-view").then((m) => m.CoverageRouteView),
);
const CoverageMapView = dynamic(
  () => import("./coverage-map-view").then((m) => m.CoverageMapView),
  { ssr: false },
);
const CoverageWorkloadView = dynamic(() =>
  import("./coverage-workload-view").then((m) => m.CoverageWorkloadView),
);
const CoverageExceptions = dynamic(() =>
  import("./coverage-exceptions").then((m) => m.CoverageExceptions),
);
const CoverageExport = dynamic(() =>
  import("./coverage-export").then((m) => m.CoverageExport),
);
type CoverageTab =
  | "plan"
  | "review"
  | "visits"
  | "history"
  | "calendar"
  | "route"
  | "map"
  | "workload"
  | "exceptions"
  | "export";
type SelectedPlan = {
  id: Id<"coveragePlans">;
  assigneeId: Id<"profiles">;
  assigneeName: string;
};

function ScopedPlanPicker({
  month,
  selected,
  onSelect,
}: {
  month: string;
  selected: SelectedPlan | null;
  onSelect: (plan: SelectedPlan | null) => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const result = useQuery(api.coverage.discovery.list, {
    localMonth: month,
    paginationOpts: { numItems: 20, cursor },
  });
  return (
    <div className="grid gap-3">
      <FormField label="Plan">
        <select
          aria-label="Scoped coverage plan"
          className="w-full"
          value={selected?.id ?? ""}
          onChange={(event) => {
            const plan = result?.page.find(
              (row) => row.planId === event.target.value,
            );
            onSelect(
              plan
                ? {
                    id: plan.planId,
                    assigneeId: plan.assigneeProfileId,
                    assigneeName: plan.assigneeName,
                  }
                : null,
            );
          }}
        >
          <option value="">Select a plan</option>
          {selected &&
            !result?.page.some((row) => row.planId === selected.id) && (
              <option value={selected.id}>
                {selected.assigneeName} · selected version
              </option>
            )}
          {result?.page.map((row) => (
            <option key={row.planId} value={row.planId}>
              {row.assigneeName} · v{row.version} · {row.status}
            </option>
          ))}
        </select>
      </FormField>
      {result === undefined && (
        <span className="text-[13px] text-muted">Loading plans…</span>
      )}
      {result && !result.page.length && (
        <span className="text-[13px] text-muted">No plans here</span>
      )}
      {/* The picker is a dropdown, so paging only appears once the month has
          more plans than one page holds. */}
      {(cursor !== null || (result && !result.isDone)) && (
        <Pager
          label="Plans pages"
          page={page}
          canPrevious={cursor !== null}
          canNext={!!result && !result.isDone}
          onPrevious={() => {
            setCursor(null);
            setPage(1);
          }}
          onNext={() => {
            if (result) {
              setCursor(result.continueCursor);
              setPage((old) => old + 1);
            }
          }}
        />
      )}
    </div>
  );
}

export function SalesForcePanels() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const profile = useQuery(api.domains.profiles.current, {});
  const [coverageTab, setCoverageTab] = useState<CoverageTab>("plan");
  const [month, setMonth] = useState(() => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
    }).formatToParts(new Date());
    return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
  });
  const [selected, setSelected] = useState<SelectedPlan | null>(null);
  if (!permissions || !profile) return <p>Loading sales force permissions…</p>;
  const panels = salesForcePanels(permissions.capabilities);
  const canRead = permissions.capabilities.includes("mcp.read");
  const canApprove = permissions.capabilities.includes("mcp.approve");
  const coverageTabs: [CoverageTab, string][] = [
    ["plan", "Plan"],
    ...(canApprove ? ([["review", "Review"]] as [CoverageTab, string][]) : []),
    ["exceptions", "Exceptions"],
    ["visits", "Visits"],
    ["history", "History"],
    ["calendar", "Calendar"],
    ["route", "Routes"],
    ["map", "Map"],
    ["workload", "Workload"],
    ["export", "Export"],
  ];
  return (
    <div className="grid gap-4">
      {canRead && (
        <>
          <Card label="Plans" icon={<WorkspaceIcon name="field" />}>
            <div className="grid items-start gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
              <FormField label="Month">
                <input
                  type="month"
                  aria-label="Coverage month"
                  className="w-full"
                  value={month}
                  onChange={(event) => {
                    setMonth(event.target.value);
                    setSelected(null);
                  }}
                />
              </FormField>
              <PanelErrorBoundary key={month} label="Scoped plan picker">
                <ScopedPlanPicker
                  key={month}
                  month={month}
                  selected={selected}
                  onSelect={setSelected}
                />
              </PanelErrorBoundary>
            </div>
          </Card>
          <UnderlineTabs
            items={coverageTabs}
            activeId={coverageTab}
            onChange={setCoverageTab}
            label="Coverage views"
          />
          <div role="tabpanel">
            {coverageTab === "plan" ? (
              <PanelErrorBoundary key="plan" label="Coverage plan">
                <CoveragePlanner />
              </PanelErrorBoundary>
            ) : coverageTab === "review" ||
              coverageTab === "visits" ||
              coverageTab === "history" ? (
              <>
                {coverageTab === "review" && selected && (
                  <PanelErrorBoundary
                    key={`preflight-${selected.id}`}
                    label="Review preflight"
                  >
                    <CoverageExceptions planId={selected.id} />
                  </PanelErrorBoundary>
                )}
                {selected ? (
                  <PanelErrorBoundary
                    key={`${coverageTab}-${selected.id}`}
                    label={`Coverage ${coverageTab}`}
                  >
                    <CoverageReview
                      mode={coverageTab}
                      permissions={permissions}
                      profile={profile}
                      scopedSelection={{
                        planId: selected.id,
                        assigneeProfileId: selected.assigneeId,
                        localMonth: month,
                      }}
                    />
                  </PanelErrorBoundary>
                ) : (
                  <p>Select a scoped plan to open this view.</p>
                )}
              </>
            ) : coverageTab === "workload" ? (
              <PanelErrorBoundary
                key={`${coverageTab}-${month}`}
                label="Coverage workload"
              >
                <CoverageWorkloadView
                  localMonth={month}
                  planId={selected?.id}
                />
              </PanelErrorBoundary>
            ) : selected ? (
              <PanelErrorBoundary
                key={`${coverageTab}-${selected.id}`}
                label={`Coverage ${coverageTab}`}
              >
                {coverageTab === "calendar" ? (
                  <CoverageCalendarView
                    planId={selected.id}
                    assigneeName={selected.assigneeName}
                  />
                ) : coverageTab === "route" ? (
                  <CoverageRouteView planId={selected.id} />
                ) : coverageTab === "map" ? (
                  <CoverageMapView planId={selected.id} />
                ) : coverageTab === "exceptions" ? (
                  <CoverageExceptions planId={selected.id} />
                ) : (
                  <CoverageExport planId={selected.id} />
                )}
              </PanelErrorBoundary>
            ) : (
              <p>Select a scoped plan to open this view.</p>
            )}
          </div>
        </>
      )}
      {panels.routes && (
        <PanelErrorBoundary label="Territory and route editor">
          <RouteAdmin />
        </PanelErrorBoundary>
      )}
      {panels.outlets && (
        <PanelErrorBoundary label="Outlet editor">
          <OutletAdmin />
        </PanelErrorBoundary>
      )}
      {panels.assignments && (
        <PanelErrorBoundary label="Assignment editor">
          <OutletAssignments />
        </PanelErrorBoundary>
      )}
      {panels.verification && !panels.editing && (
        <p>Verification: select an outlet above to review pending pins.</p>
      )}
    </div>
  );
}
