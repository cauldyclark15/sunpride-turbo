"use client";

import { api } from "./coverage-model";
import type { Id } from "./coverage-model";
import { FormField, Pager, UnderlineTabs } from "@sunpride/ui";
import { useCoverageQuery } from "./coverage-data";
import dynamic from "next/dynamic";
import { useState } from "react";
import { salesForcePanels } from "../lib/module-access";
import { CoveragePlanner } from "./coverage-planner";
import { CoverageReview } from "./coverage-review";
import { CoveragePlansList, CoverageSummary } from "./coverage-summary";
import { useUrlState } from "./cockpit/use-url-state";
import { readPage } from "./list-page/list-page";
import { OutletAdmin } from "./outlet-admin";
import { OutletAssignments } from "./outlet-assignments";
import { PanelErrorBoundary } from "./panel-error-boundary";
import { RouteAdmin } from "./route-admin";
import {
  coverageSelectionFromParams,
  coverageSelectionPatch,
} from "../lib/coverage-url";

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
const CoverageDeadlines = dynamic(() =>
  import("./coverage-deadlines").then((m) => m.CoverageDeadlines),
);
const CoverageExport = dynamic(() =>
  import("./coverage-export").then((m) => m.CoverageExport),
);
const PositionStandardsPanel = dynamic(() =>
  import("./standards/position-standards-panel").then(
    (m) => m.PositionStandardsPanel,
  ),
);
const PjpPlanner = dynamic(() =>
  import("./pjp-planner").then((m) => m.PjpPlanner),
);
const ProductivePolicies = dynamic(() =>
  import("./productive-policies").then((m) => m.ProductivePolicies),
);
const TerritoryScenarios = dynamic(() =>
  import("./territory-scenarios").then((m) => m.TerritoryScenarios),
);
const WorkforceWorkspace = dynamic(() =>
  import("./workforce-workspace").then((m) => m.WorkforceWorkspace),
);
type CoverageTab =
  | "territories"
  | "workforce"
  | "productive"
  | "pjp"
  | "plans"
  | "summary"
  | "plan"
  | "deadlines"
  | "review"
  | "visits"
  | "history"
  | "calendar"
  | "route"
  | "map"
  | "workload"
  | "exceptions"
  | "export"
  | "standards"
  | "setup";
type SetupSection = "routes" | "outlets" | "assignments";
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
  const result = useCoverageQuery(api.coverage.discovery.list, {
    localMonth: month,
    paginationOpts: { numItems: 20, cursor },
  });
  return (
    <div className="grid gap-3">
      <FormField label="Plan">
        <select
          aria-label="Scoped coverage plan"
          className="h-10 w-full"
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
              {row.assigneeName} · v{row.version} ·{" "}
              {row.status
                .replaceAll("_", " ")
                .replace(/^./, (initial) => initial.toUpperCase())}
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
  const permissions = useCoverageQuery(
    api.lib.capabilities.currentPermissions,
    {},
  );
  const profile = useCoverageQuery(api.domains.profiles.current, {});
  const url = useUrlState();
  const coverageTab = (url.params.get("tab") ?? "plans") as CoverageTab;
  const setCoverageTab = (tab: CoverageTab) =>
    url.set({
      tab: tab === "plans" ? null : tab,
      q: null,
      page: null,
      status: null,
    });
  const [setupSection, setSetupSection] = useState<SetupSection>("routes");
  // Month, opened plan and its assignee live in the URL so reload and shared
  // links reopen the same plan (WEB-113/114).
  const fromUrl = coverageSelectionFromParams(url.params);
  const month = fromUrl.month;
  const selected = fromUrl.selected as SelectedPlan | null;
  const [plannerNonce, setPlannerNonce] = useState(0);
  const setMonth = (next: string) => {
    setPlannerNonce((n) => n + 1);
    url.set({ month: next || null, plan: null, person: null });
  };
  const setSelected = (plan: SelectedPlan | null) =>
    url.set({ plan: plan?.id || null, person: plan?.assigneeId || null });
  if (!permissions || !profile)
    return (
      <span className="text-[13px] text-muted">
        Loading sales force permissions…
      </span>
    );
  const panels = salesForcePanels(permissions.capabilities);
  const canRead = permissions.capabilities.includes("mcp.read");
  const canApprove = permissions.capabilities.includes("mcp.approve");
  const setupSections: [SetupSection, string][] = [
    ...(panels.routes
      ? ([["routes", "Territories & routes"]] as [SetupSection, string][])
      : []),
    ...(panels.outlets
      ? ([["outlets", "Outlets"]] as [SetupSection, string][])
      : []),
    ...(panels.assignments
      ? ([["assignments", "Assignments"]] as [SetupSection, string][])
      : []),
  ];
  const activeSetupSection: SetupSection = setupSections.some(
    ([id]) => id === setupSection,
  )
    ? setupSection
    : (setupSections[0]?.[0] ?? "routes");
  const setupContent = (
    <div className="grid gap-4">
      {setupSections.length > 0 && (
        <UnderlineTabs
          items={setupSections}
          activeId={activeSetupSection}
          onChange={setSetupSection}
          label="Setup sections"
        />
      )}
      {panels.routes && activeSetupSection === "routes" && (
        <PanelErrorBoundary label="Territory and route editor">
          <RouteAdmin />
        </PanelErrorBoundary>
      )}
      {panels.outlets && activeSetupSection === "outlets" && (
        <PanelErrorBoundary label="Outlet editor">
          <OutletAdmin />
        </PanelErrorBoundary>
      )}
      {panels.assignments && activeSetupSection === "assignments" && (
        <PanelErrorBoundary label="Assignment editor">
          <OutletAssignments />
        </PanelErrorBoundary>
      )}
      {panels.verification && !panels.editing && (
        <span className="text-[13px] text-muted">
          Verification: select an outlet above to review pending pins.
        </span>
      )}
    </div>
  );
  const needsPlan =
    coverageTab !== "workforce" &&
    coverageTab !== "territories" &&
    coverageTab !== "productive" &&
    coverageTab !== "pjp" &&
    coverageTab !== "plans" &&
    coverageTab !== "summary" &&
    coverageTab !== "plan" &&
    coverageTab !== "deadlines" &&
    coverageTab !== "setup" &&
    coverageTab !== "standards" &&
    coverageTab !== "workload";
  const needsMonth =
    coverageTab !== "workforce" &&
    coverageTab !== "territories" &&
    coverageTab !== "productive" &&
    coverageTab !== "pjp" &&
    coverageTab !== "plan" &&
    coverageTab !== "setup" &&
    coverageTab !== "standards";
  const coverageTabs: [CoverageTab, string][] = [
    ["plans", "Plans"],
    ["plan", "Plan"],
    ["pjp", "Journey plans"],
    ["territories", "Territory rebalancing"],
    ["productive", "Productive call rules"],
    ["workforce", "Workforce"],
    ["deadlines", "Deadlines"],
    ...(canApprove ? ([["review", "Review"]] as [CoverageTab, string][]) : []),
    ["exceptions", "Exceptions"],
    ["visits", "Visits"],
    ["history", "History"],
    ["calendar", "Calendar"],
    ["route", "Route"],
    ["map", "Map"],
    ["workload", "Workload"],
    ["standards", "Standards"],
    ["summary", "Overview"],
    ["export", "Export"],
    ...(setupSections.length
      ? ([["setup", "Setup"]] as [CoverageTab, string][])
      : []),
  ];
  return (
    <div className="grid gap-4">
      {canRead && (
        <>
          <UnderlineTabs
            items={coverageTabs}
            activeId={coverageTab}
            onChange={setCoverageTab}
            label="Coverage views"
          />
          {needsMonth && (
            <div className="flex flex-wrap items-start gap-3">
              <div className="w-[180px] max-w-full">
                <FormField label="Month">
                  <input
                    type="month"
                    aria-label="Coverage month"
                    className="h-10 w-full"
                    value={month}
                    onChange={(event) => setMonth(event.target.value)}
                  />
                </FormField>
              </div>
              {needsPlan && (
                <div className="w-[320px] max-w-full">
                  <PanelErrorBoundary key={month} label="Scoped plan picker">
                    <ScopedPlanPicker
                      key={month}
                      month={month}
                      selected={selected}
                      onSelect={setSelected}
                    />
                  </PanelErrorBoundary>
                </div>
              )}
            </div>
          )}
          <div role="tabpanel">
            {coverageTab === "workforce" && (
              <PanelErrorBoundary label="Workforce">
                <WorkforceWorkspace />
              </PanelErrorBoundary>
            )}
            {coverageTab === "productive" && (
              <PanelErrorBoundary label="Productive call rules">
                <ProductivePolicies />
              </PanelErrorBoundary>
            )}
            {coverageTab === "pjp" && (
              <PanelErrorBoundary label="Journey plans">
                <PjpPlanner capabilities={permissions.capabilities} />
              </PanelErrorBoundary>
            )}
            {coverageTab === "territories" && (
              <PanelErrorBoundary label="Territory rebalancing">
                <TerritoryScenarios />
              </PanelErrorBoundary>
            )}
            {coverageTab === "territories" ||
            coverageTab === "workforce" ||
            coverageTab === "productive" ||
            coverageTab === "pjp" ? null : coverageTab === "plans" ? (
              <PanelErrorBoundary key={`plans-${month}`} label="Coverage plans">
                <CoveragePlansList
                  month={month}
                  q={url.params.get("q") ?? ""}
                  status={url.params.get("status")}
                  page={readPage(url.params)}
                  onSearch={(q) =>
                    url.set({ q: q || null, page: null }, { replace: true })
                  }
                  onFilter={(status) => url.set({ status, page: null })}
                  onPage={(n) => url.set({ page: n > 1 ? String(n) : null })}
                  onAdd={() => setCoverageTab("plan")}
                  onOpen={(row) => {
                    setPlannerNonce((n) => n + 1);
                    url.set({
                      tab: row.awaitsMyApproval ? "review" : "plan",
                      q: null,
                      page: null,
                      status: null,
                      plan:
                        row.approvalPlanId ??
                        row.action.planId ??
                        row.planId ??
                        null,
                      person: row.profileId,
                    });
                  }}
                />
              </PanelErrorBoundary>
            ) : coverageTab === "summary" ? (
              <PanelErrorBoundary
                key={`summary-${month}`}
                label="Coverage summary"
              >
                <CoverageSummary month={month} />
              </PanelErrorBoundary>
            ) : coverageTab === "plan" ? (
              <PanelErrorBoundary key="plan" label="Coverage plan">
                <CoveragePlanner
                  key={plannerNonce}
                  initialMonth={month}
                  initialPersonId={fromUrl.personId ?? undefined}
                  initialPlanId={selected?.id || undefined}
                  onSelectionChange={(next) => {
                    const patch = coverageSelectionPatch(url.params, next);
                    if (patch) url.set(patch, { replace: true });
                  }}
                />
              </PanelErrorBoundary>
            ) : coverageTab === "setup" ? (
              setupContent
            ) : coverageTab === "standards" ? (
              <PanelErrorBoundary key="standards" label="Call standards">
                <PositionStandardsPanel />
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
                  <span className="text-[13px] text-muted">Select a plan</span>
                )}
              </>
            ) : coverageTab === "deadlines" ? (
              <PanelErrorBoundary
                key={`${coverageTab}-${month}`}
                label="MCP deadlines"
              >
                <CoverageDeadlines
                  localMonth={month}
                  profileId={profile._id}
                  canApprove={canApprove}
                />
              </PanelErrorBoundary>
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
              <span className="text-[13px] text-muted">Select a plan</span>
            )}
          </div>
        </>
      )}
      {!canRead && setupContent}
    </div>
  );
}
