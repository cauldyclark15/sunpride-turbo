"use client";

import { useState } from "react";
import { OrgAdmin } from "./org-admin";
import { TerritoryAdmin } from "./territory-admin";
import { RouteAdmin } from "./route-admin";
import { OutletAdmin } from "./outlet-admin";
import { OutletAssignments } from "./outlet-assignments";
import { PeopleAdmin } from "./people-admin";
import { TeamsAdmin } from "./teams-admin";
import { IntegrityFleet } from "./integrity/fleet";
import { DevicesAdmin } from "./devices-admin";
import { CallFlowAdmin } from "./callflow-admin";
import { MastersWorkspace } from "./spec-masters/workspace";
import { FiscalWorkspace } from "./fiscal/fiscal-workspace";
import { SetupHealth } from "./master-data/setup-health";
import { useSetupParam } from "./master-data/location";
import { AvailabilityEditor } from "./availability/editor";

const groups = [
  [
    "People",
    [
      ["people", "People"],
      ["teams", "Teams"],
      ["devices", "Phones"],
    ],
  ],
  [
    "Places",
    [
      ["organization", "Organization"],
      ["territories", "Territories"],
      ["routes", "Routes"],
      ["outlets", "Stores"],
      ["assignments", "Assignments"],
    ],
  ],
  [
    "Field work",
    [
      ["callflow", "Call flows"],
      ["field-masters", "Field masters"],
      ["availability", "Trade Marketing"],
    ],
  ],
  [
    "Checks",
    [
      ["health", "Setup health"],
      ["fiscal", "Fiscal & authority"],
      ["fleet", "Fleet & integrity"],
    ],
  ],
] as const;
type AdminTab = (typeof groups)[number][1][number][0];
const tabs: (readonly [AdminTab, string])[] = groups.flatMap(
  ([, items]) => items as readonly (readonly [AdminTab, string])[],
);
/** Old links (?section=invitations) land on People, where adding a person now lives. */
const aliases: Record<string, AdminTab> = { invitations: "people" };

/** Picks a section and clears the old section's search, page and filter. */
function openSection(value: AdminTab) {
  const url = new URL(window.location.href);
  for (const key of ["q", "page", "filter", "unassigned", "unverified"])
    url.searchParams.delete(key);
  url.searchParams.set("section", value);
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event("popstate"));
}

/** Setup sections as a grouped list on the left (a picker on a phone), so no name is cut off. */
function SectionNav({
  active,
  onChange,
}: {
  active: AdminTab;
  onChange: (value: AdminTab) => void;
}) {
  return (
    <>
      <label className="grid gap-1 lg:hidden">
        <span className="text-[12px] font-medium text-muted">Section</span>
        <select
          aria-label="Setup section"
          value={active}
          onChange={(event) => onChange(event.target.value as AdminTab)}
          className="h-11 rounded-xl border border-border bg-surface px-3 text-[15px]"
        >
          {groups.map(([group, items]) => (
            <optgroup key={group} label={group}>
              {items.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <nav
        aria-label="Setup sections"
        className="hidden content-start gap-4 lg:grid"
      >
        {groups.map(([group, items]) => (
          <div key={group} className="grid gap-0.5">
            <p className="px-3 pb-1 text-[12px] font-medium text-muted">
              {group}
            </p>
            {items.map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-current={id === active ? "page" : undefined}
                onClick={() => onChange(id)}
                className={`h-9 rounded-lg px-3 text-left text-[14px] ${id === active ? "bg-default-soft font-semibold text-foreground" : "text-muted hover:bg-default-soft hover:text-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
        ))}
      </nav>
    </>
  );
}

export function AdminWorkspace() {
  const [tab, setTab] = useState<AdminTab>("health");
  const raw = useSetupParam("section");
  const section = aliases[raw] ?? raw;
  const activeTab = (
    tabs.some(([id]) => id === section) ? section : tab
  ) as AdminTab;
  return (
    <div className="grid gap-4 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-6">
      <SectionNav
        active={activeTab}
        onChange={(value) => {
          setTab(value);
          openSection(value);
        }}
      />
      <div className="min-w-0">
        {activeTab === "health" ? (
          <SetupHealth />
        ) : activeTab === "organization" ? (
          <OrgAdmin />
        ) : activeTab === "people" ? (
          <PeopleAdmin />
        ) : activeTab === "teams" ? (
          <TeamsAdmin />
        ) : activeTab === "territories" ? (
          <TerritoryAdmin />
        ) : activeTab === "routes" ? (
          <RouteAdmin />
        ) : activeTab === "outlets" ? (
          <OutletAdmin />
        ) : activeTab === "assignments" ? (
          <OutletAssignments />
        ) : activeTab === "callflow" ? (
          <CallFlowAdmin />
        ) : activeTab === "field-masters" ? (
          <MastersWorkspace />
        ) : activeTab === "fiscal" ? (
          <FiscalWorkspace />
        ) : activeTab === "fleet" ? (
          <IntegrityFleet />
        ) : activeTab === "availability" ? (
          <AvailabilityEditor />
        ) : (
          <DevicesAdmin />
        )}
      </div>
    </div>
  );
}
