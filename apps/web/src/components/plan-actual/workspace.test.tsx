/* eslint-disable turbo/no-undeclared-env-vars -- Optional local HTTP-response artifact path, never used by production code. */
import { readFileSync } from "node:fs";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { splitCsv } from "../../lib/csv";
import {
  actualLabel,
  downloadPlanActual,
  planActualCsv,
  type PlanActual,
} from "./model";

const state = vi.hoisted(() => ({
  selected: null as string | null,
  setSelected: vi.fn(),
  fetch: vi.fn(),
  live: vi.fn(),
  data: undefined as PlanActual | undefined,
  error: undefined as { message: string } | undefined,
  fetching: false,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [
    typeof value === "function"
      ? (value as () => unknown)()
      : value === null
        ? state.selected
        : value,
    state.setSelected,
  ],
}));
vi.mock("../../lib/api", () => ({
  useApi: (key: unknown, fetcher: unknown) => {
    state.fetch(key, fetcher);
    return {
      data: state.data,
      error: state.error,
      isFetching: state.fetching,
      refetch: vi.fn(),
    };
  },
  useLive: state.live,
  apiFetch: vi.fn(),
}));
import { DayDetail, PlanActualView, PlanActualWorkspace } from "./workspace";
import { apiFetch } from "../../lib/api";

const totals = {
  planned: 2,
  visited: 1,
  missed: 1,
  outstanding: 0,
  unplanned: 0,
  actualVisits: 1,
  plannedActivities: 3,
  doneActivities: 1,
  followed: 0,
  followedPct: 0,
  visitPct: 50,
  plannedDays: 2,
  visitedDays: 1,
  plannedStores: 1,
  visitedStores: 1,
};
const stop = {
  key: "stop-1",
  profileId: "seller",
  person: "Sample salesman",
  date: "2026-11-20",
  unitId: "branch",
  branch: "Sample branch",
  outletId: "store",
  outlet: 'Sample, "store"',
  outletCode: "001",
  territoryId: "territory",
  territory: "Sample territory",
  territoryType: "customer_group",
  groupId: "group",
  group: "Sample group",
  route: "001",
  planned: true,
  planVersion: 1,
  sequence: 1,
  visited: true,
  completedVisits: 1,
  activities: [
    { activityId: "collection", name: "Collection", done: true },
    { activityId: "countering", name: "Countering", done: false },
  ],
  visits: [
    {
      id: "visit",
      state: "checked-out",
      review: null,
      completed: true,
      checkedInAt: Date.parse("2026-11-20T00:00:00Z"),
      checkedOutAt: Date.parse("2026-11-20T00:20:00Z"),
      reason: "Sample reason",
      activities: ["note"],
    },
  ],
  status: "Activities unfinished",
};
const sample: PlanActual = {
  from: "2026-11-20",
  to: "2026-11-21",
  priorFrom: "2026-11-18",
  priorTo: "2026-11-19",
  options: {
    people: [{ id: "seller", name: "Sample salesman" }],
    branches: [{ id: "branch", name: "Sample branch" }],
    territories: [{ id: "territory", name: "Sample territory" }],
    groups: [{ id: "group", name: "Sample group" }],
  },
  summary: totals,
  prior: { ...totals, planned: 0, followedPct: null },
  salesmen: [{ profileId: "seller", person: "Sample salesman", totals }],
  days: [
    {
      key: "seller:2026-11-20",
      profileId: "seller",
      person: "Sample salesman",
      date: "2026-11-20",
      totals,
      stops: [stop],
    },
    {
      key: "seller:2026-11-21",
      profileId: "seller",
      person: "Sample salesman",
      date: "2026-11-21",
      totals,
      stops: [
        {
          ...stop,
          key: "stop-2",
          visited: false,
          visits: [],
          completedVisits: 0,
          status: "Missed",
        },
      ],
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  state.selected = null;
  state.data = sample;
  state.error = undefined;
  state.fetching = false;
});
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as Element;
  return [el, ...elements(el.props.children as ReactNode)];
}
it("renders totals, prior comparison and daily exceptions; the open-day button selects the real detail", () => {
  const html = renderToStaticMarkup(<PlanActualView data={sample} />);
  for (const text of [
    "0%",
    "1 missed",
    "Prior equal period",
    "By salesman",
    "Daily trend",
    "Open day",
    "Export CSV",
  ])
    expect(html).toContain(text);
  const buttons = elements(PlanActualView({ data: sample })).filter(
    (e) => e.type === "button",
  );
  const open = buttons.find(
    (b) => b.props["aria-label"] === "Open Sample salesman 2026-11-20",
  )!;
  (open.props.onClick as () => void)();
  expect(state.setSelected).toHaveBeenCalledWith(sample.days[0]!.key);
  state.selected = sample.days[0]!.key;
  const expanded = renderToStaticMarkup(<PlanActualView data={sample} />);
  expect(expanded).toContain("Done — Collection");
  expect(expanded).toContain("Not done — Countering");
  expect(expanded).toContain("Activities unfinished");
  expect(expanded).toContain("checked out");
});
it("exports all days, including missed stops, regardless of expansion, and protects spreadsheet formulas", () => {
  const data = structuredClone(sample);
  data.days[0]!.stops[0]!.person = "=HYPERLINK(1)";
  data.days[0]!.stops[0]!.visits[0]!.reason = " \t@malicious\nsecond line";
  const csv = planActualCsv(data),
    rows = splitCsv(csv);
  expect(csv.startsWith("\uFEFF")).toBe(true);
  expect(csv).toContain("\r\n");
  expect(rows).toHaveLength(3);
  expect(rows[1]![2]).toBe("'=HYPERLINK(1)");
  expect(rows[1]![10]).toBe('Sample, "store"');
  expect(rows[1]![22]).toBe("' \t@malicious\nsecond line");
  expect(rows[2]![13]).toBe("Missed");
  expect(rows[1]![15]).toContain("Countering");
  expect(rows[1]![17]).toBe("Countering");
});
it("downloads the CSV bytes under the selected date range", async () => {
  const create = vi.fn(() => "blob:sample"),
    revoke = vi.fn(),
    click = vi.fn();
  const anchor = { href: "", download: "", click };
  vi.stubGlobal("document", { createElement: () => anchor });
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  try {
    downloadPlanActual(sample);
    expect(anchor.download).toBe("plan-vs-actual-2026-11-20-2026-11-21.csv");
    expect(click).toHaveBeenCalledOnce();
    expect(
      new Uint8Array(
        await (create.mock.calls[0] as unknown as [Blob])[0].arrayBuffer(),
      ),
    ).toEqual(new TextEncoder().encode(planActualCsv(sample)));
    expect(revoke).toHaveBeenCalledWith("blob:sample");
  } finally {
    vi.unstubAllGlobals();
  }
});
it("has all requested filters, submits a keyed request and subscribes to visit/plan changes", async () => {
  const html = renderToStaticMarkup(<PlanActualWorkspace />);
  for (const label of [
    "From",
    "To",
    "Salesman",
    "Branch",
    "Territory",
    "Territory type",
    "Customer group",
  ])
    expect(html).toContain(`aria-label="${label}"`);
  expect(html).toContain("Show report");
  expect(html).toContain("self-reported");
  expect(html).toContain("Unsynced phone work");
  const [key, fetcher] = state.fetch.mock.calls[0]!;
  const signal = new AbortController().signal;
  await fetcher({ signal });
  expect(apiFetch).toHaveBeenCalledWith("/api/v1/coverage/plan-actual", {
    query: key[2],
    signal,
  });
  expect(state.live).toHaveBeenCalledWith(
    ["coverage", "visits", "analytics"],
    [["coverage", "plan-actual"]],
  );
  const form = elements(PlanActualWorkspace()).find((e) => e.type === "form")!;
  const preventDefault = vi.fn();
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(state.setSelected).toHaveBeenCalled();
});
it("does not export stale results on an error/loading state and distinguishes empty/no-plan data", () => {
  state.error = { message: "Choose a shorter date range" };
  const error = renderToStaticMarkup(<PlanActualWorkspace />);
  expect(error).toContain('role="alert"');
  expect(error).not.toContain("Export CSV");
  state.error = undefined;
  state.fetching = true;
  expect(renderToStaticMarkup(<PlanActualWorkspace />)).not.toContain(
    "Export CSV",
  );
  const empty = renderToStaticMarkup(
    <PlanActualView
      data={{
        ...sample,
        summary: { ...totals, planned: 0, followedPct: null },
        salesmen: [],
        days: [],
      }}
    />,
  );
  expect(empty).toContain("No plan");
  expect(empty).toContain("No approved stops");
  expect(empty).toContain("disabled");
});
it("shows rejected/review states without inventing completion", () => {
  expect(actualLabel({ ...stop.visits[0]!, review: "pending_review" })).toBe(
    "checked out · pending review",
  );
  expect(renderToStaticMarkup(<DayDetail day={sample.days[1]!} />)).toContain(
    "No visit recorded",
  );
});
// Optional cross-boundary proof: exact JSON saved by the HTTP integration, not a recreated UI mock.
it.runIf(!!process.env.SP_PLAN_ACTUAL_PROOF)(
  "renders and exports the exact public plan → signed simulated-device → report response",
  () => {
    const data = JSON.parse(
      readFileSync(process.env.SP_PLAN_ACTUAL_PROOF!, "utf8"),
    ) as PlanActual;
    expect(data.summary).toMatchObject({
      planned: 2,
      visited: 1,
      doneActivities: 1,
    });
    const html = renderToStaticMarkup(<PlanActualView data={data} />);
    expect(html).toContain("Seller225");
    const detail = renderToStaticMarkup(
      <DayDetail day={data.days.find((d) => d.date === "2030-11-10")!} />,
    );
    expect(detail).toContain("Done — Collection");
    expect(detail).toContain("Not done — Countering");
    expect(splitCsv(planActualCsv(data))).toHaveLength(3);
  },
);
