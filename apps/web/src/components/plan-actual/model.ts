export type Totals = {
  planned: number;
  visited: number;
  missed: number;
  outstanding: number;
  unplanned: number;
  actualVisits: number;
  plannedActivities: number;
  doneActivities: number;
  followed: number;
  followedPct: number | null;
  visitPct: number | null;
  plannedDays: number;
  visitedDays: number;
  plannedStores: number;
  visitedStores: number;
};
export type ActualVisit = {
  id: string;
  state: string;
  review: string | null;
  completed: boolean;
  checkedInAt: number | null;
  checkedOutAt: number | null;
  reason: string | null;
  activities: string[];
};
export type Stop = {
  key: string;
  profileId: string;
  person: string;
  date: string;
  unitId: string;
  branch: string;
  outletId: string;
  outlet: string;
  outletCode: string;
  territoryId: string | null;
  territory: string;
  territoryType: string | null;
  groupId: string | null;
  group: string;
  route: string;
  planned: boolean;
  planVersion: number | null;
  sequence: number | null;
  visited: boolean;
  completedVisits: number;
  activities: { activityId: string; name: string; done: boolean }[];
  visits: ActualVisit[];
  status: string;
};
export type Day = {
  key: string;
  profileId: string;
  person: string;
  date: string;
  stops: Stop[];
  /** Stops on the day; `stops` is filled only for the requested day or detail=all. */
  stopCount?: number;
  totals: Totals;
};
export type Option = { id: string; name: string };
export type PlanActual = {
  from: string;
  to: string;
  priorFrom: string;
  priorTo: string;
  options: {
    people: Option[];
    branches: Option[];
    territories: Option[];
    groups: Option[];
  };
  summary: Totals;
  prior: Totals;
  salesmen: { profileId: string; person: string; totals: Totals }[];
  /** "all" when every day carries its stops, else the one day key returned in full. */
  detail?: string | null;
  days: Day[];
};
export const percent = (n: number | null) => (n === null ? "No plan" : `${n}%`);
export const actualLabel = (v: ActualVisit) =>
  `${v.state.replaceAll("-", " ")}${v.review ? ` · ${v.review.replaceAll("_", " ")}` : ""}`;
const time = (at: number | null) =>
  at === null ? "" : new Date(at).toISOString();
/** Full filtered detail, never only the expanded day. RFC 4180 + Excel formula protection. */
export function planActualCsv(data: PlanActual) {
  const rows: unknown[][] = [
    [
      "From",
      "To",
      "Salesman",
      "Date",
      "Branch",
      "Territory",
      "Territory type (current)",
      "Customer group (current)",
      "Route",
      "Store code",
      "Store",
      "Planned",
      "Plan version",
      "Status",
      "Completed visits",
      "Planned activities",
      "Activities done",
      "Activities unfinished",
      "Actual visit states",
      "Other recorded activities",
      "Check in (UTC)",
      "Check out (UTC)",
      "Reasons",
      "Day planned stops",
      "Day completed stops",
      "Day planned activities",
      "Day activities done",
      "Day % followed",
      "Range % followed",
    ],
  ];
  for (const d of data.days)
    for (const s of d.stops)
      rows.push([
        data.from,
        data.to,
        s.person,
        s.date,
        s.branch,
        s.territory,
        s.territoryType,
        s.group,
        s.route,
        s.outletCode,
        s.outlet,
        s.planned ? "Yes" : "No",
        s.planVersion,
        s.status,
        s.completedVisits,
        s.activities.map((a) => a.name).join("; "),
        s.activities
          .filter((a) => a.done)
          .map((a) => a.name)
          .join("; "),
        s.activities
          .filter((a) => !a.done)
          .map((a) => a.name)
          .join("; "),
        s.visits.map(actualLabel).join("; "),
        s.visits.flatMap((v) => v.activities).join("; "),
        s.visits.map((v) => time(v.checkedInAt)).join("; "),
        s.visits.map((v) => time(v.checkedOutAt)).join("; "),
        s.visits
          .map((v) => v.reason ?? "")
          .filter(Boolean)
          .join("; "),
        d.totals.planned,
        d.totals.visited,
        d.totals.plannedActivities,
        d.totals.doneActivities,
        d.totals.followedPct,
        data.summary.followedPct,
      ]);
  return (
    "\uFEFF" +
    rows
      .map((row) =>
        row
          .map((v) => {
            const text = String(v ?? "");
            return `"${(/^[\s]*[=+\-@\t\r\n]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
          })
          .join(","),
      )
      .join("\r\n")
  );
}
export function downloadPlanActual(data: PlanActual) {
  const url = URL.createObjectURL(
    new Blob([planActualCsv(data)], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `plan-vs-actual-${data.from}-${data.to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
