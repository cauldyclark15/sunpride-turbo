import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

const at = (hhmm: string) => Date.parse(`2026-09-30T${hhmm}:00+08:00`);
const summary = {
  planned: 3,
  plannedDone: 2,
  notVisited: 1,
  unplanned: 1,
  calls: 2,
  productiveCalls: 1,
  productivePct: 50,
  workWithSessions: 0,
  workWithCompleted: 0,
  firstCheckInAt: at("08:00"),
  lastCheckOutAt: at("10:30"),
  fieldMinutes: 150,
};
const stop = {
  routeCode: "R-01",
  reasonCode: null,
  notes: [],
  collections: 0,
  matchedCodes: [],
  activityKinds: [],
  checkedInAt: null,
  checkedOutAt: null,
  callMinutes: null,
};
const roar = {
  kind: "roar",
  serviceDate: "2026-09-30",
  sellingDay: true,
  dueAt: at("22:00"),
  canSubmit: true,
  submitBlockedReason: null,
  status: "due",
  sourceRef: "memo",
  person: {
    profileId: "p1",
    name: "Ana",
    employeeCode: "E-1",
    positionCode: "RDS",
    positionLabel: "Route Distribution Salesman (RDS)",
    unitName: "Region A",
  },
  standard: {
    dailyCallsTarget: 30,
    productiveCallTargetPct: 85,
    sourceRef: "call",
  },
  summary,
  callsTargetMet: false,
  productiveTargetMet: false,
  routes: [],
  stops: [
    {
      ...stop,
      key: "v1",
      outletCode: "O1",
      outletName: "Outlet One",
      sequence: 1,
      source: "planned",
      state: "checked-out",
      callStatus: "productive",
      matchedCodes: ["purchase_order"],
      activityKinds: ["order_intent", "note"],
      collections: 1,
      notes: ["Owner asked for the new promo"],
      checkedInAt: at("08:00"),
      checkedOutAt: at("08:30"),
      callMinutes: 30,
    },
    {
      ...stop,
      key: "p3",
      outletCode: "O3",
      outletName: "Outlet Three",
      sequence: 3,
      source: "not_visited",
      state: "planned",
      callStatus: "not_visited",
      routeCode: null,
    },
  ],
  workWith: [],
  submission: null,
  revisions: 0,
};
const dar = {
  ...roar,
  kind: "dar",
  status: "submitted",
  standard: null,
  person: {
    ...roar.person,
    name: "Dina",
    positionLabel: "Distributor Specialist",
  },
  summary: { ...summary, workWithSessions: 1, workWithCompleted: 1 },
  stops: [],
  workWith: [
    {
      sessionId: "w1",
      traineeName: "Ana",
      objective: "training",
      mode: "booking",
      status: "completed",
      mcpPlanned: 3,
      mcpDone: 3,
    },
  ],
  submission: {
    revision: 2,
    remarks: "Coached Ana on the close",
    summary: { ...summary, calls: 0, workWithCompleted: 1 },
    submittedAt: at("21:00"),
    firstSubmittedAt: at("20:00"),
    submittedByName: "Dina",
  },
  revisions: 2,
};
const day = (serviceDate: string, status: string) => ({
  serviceDate,
  status,
  revisions: status === "submitted" || status === "late" ? 1 : 0,
  submittedAt: null,
});
const grid = {
  dates: ["2026-09-28", "2026-09-29", "2026-09-30"],
  truncated: false,
  units: [
    { id: "u1", code: "A", name: "Region A" },
    { id: "u2", code: "B", name: "Region B" },
  ],
  people: [
    {
      profileId: "p1",
      name: "Ana",
      employeeCode: "E-1",
      positionLabel: "Route Distribution Salesman (RDS)",
      kind: "roar",
      days: [
        day("2026-09-28", "late"),
        day("2026-09-29", "missing"),
        day("2026-09-30", "submitted"),
      ],
    },
    {
      profileId: "p2",
      name: "Dina",
      employeeCode: null,
      positionLabel: "Distributor Specialist",
      kind: "dar",
      days: [
        day("2026-09-28", "submitted"),
        day("2026-09-29", "missing"),
        day("2026-09-30", "due"),
      ],
    },
  ],
  totals: [
    {
      serviceDate: "2026-09-28",
      required: 2,
      submitted: 1,
      late: 1,
      missing: 0,
    },
    {
      serviceDate: "2026-09-29",
      required: 2,
      submitted: 0,
      late: 0,
      missing: 2,
    },
    {
      serviceDate: "2026-09-30",
      required: 2,
      submitted: 1,
      late: 0,
      missing: 0,
    },
  ],
};

const state = vi.hoisted(() => ({
  kind: "roar" as string | null,
  capabilities: ["visit.read", "visit.record", "people.read"],
}));

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    if (name === "field_reports/reports:myKind") return state.kind;
    if (name === "lib/capabilities:currentPermissions")
      return { capabilities: state.capabilities };
    if (name === "field_reports/reports:day") return state.kind ? roar : null;
    if (name === "field_reports/reports:completeness") return grid;
    return undefined;
  },
}));

import {
  activitySummary,
  completenessMark,
  completenessMeta,
  dayHeader,
  formatMinutes,
  submissionLine,
} from "../../lib/activity-reports";
import {
  ActivityReportsWorkspace,
  CompletenessView,
  ReportView,
  SubmitPanel,
} from "./activity-reports-workspace";

describe("activity report rules", () => {
  it("labels completeness, activities and durations", () => {
    expect(completenessMeta("missing")).toEqual({
      label: "Missing",
      tone: "danger",
    });
    expect(completenessMark("late")).toBe("L");
    expect(completenessMark("off_day")).toBe("");
    expect(activitySummary(["order_intent", "note", "merchandising"], 2)).toBe(
      "Order, Merchandising, 2 collections",
    );
    expect(activitySummary([], 0)).toBe("—");
    expect(formatMinutes(150)).toBe("2 h 30 min");
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(null)).toBe("—");
    expect(dayHeader("2026-09-30")).toBe("Wed 30");
    expect(submissionLine({ status: "late", revisions: 3 })).toBe(
      "Late · corrected 2×",
    );
    expect(submissionLine({ status: "due", revisions: 0 })).toBe(
      "Not submitted yet",
    );
  });
});

describe("activity report screens", () => {
  it("shows the ROAR in route order with targets and stops not visited", () => {
    const html = renderToStaticMarkup(<ReportView report={roar as never} />);
    expect(html).toContain("Route Activity Report (ROAR)");
    expect(html).toContain("Ana · E-1 · Route Distribution Salesman (RDS)");
    expect(html).toContain("target 30");
    expect(html).toContain("50% · target 85%");
    expect(html).toContain("2 h 30 min");
    expect(html.indexOf("Outlet One")).toBeLessThan(
      html.indexOf("Outlet Three"),
    );
    expect(html).toContain("Order, Collection");
    expect(html).toContain("Owner asked for the new promo");
    expect(html).toContain("Not visited");
    expect(html).toContain("Not submitted yet");
    expect(html).not.toContain("Work-With sessions");
  });

  it("shows the DAR with Work-With sessions and the filed revision", () => {
    const html = renderToStaticMarkup(<ReportView report={dar as never} />);
    expect(html).toContain("Daily Activity Report (DAR)");
    expect(html).toContain("Work-With sessions");
    expect(html).toContain("Training");
    expect(html).toContain("3/3");
    expect(html).toContain("Coached Ana on the close");
    expect(html).toContain("Submitted · corrected 1×");
    expect(html).toContain("by Dina");
    expect(html).toContain("first filed 20:00");
  });

  it("offers Submit, then Resubmit, only while the filer may file", () => {
    const submit = vi.fn();
    expect(
      renderToStaticMarkup(
        <SubmitPanel report={roar as never} submit={submit} />,
      ),
    ).toContain("Submit ROAR");
    expect(
      renderToStaticMarkup(
        <SubmitPanel report={dar as never} submit={submit} />,
      ),
    ).toContain("Resubmit");
    const blocked = renderToStaticMarkup(
      <SubmitPanel
        report={
          {
            ...roar,
            canSubmit: false,
            submitBlockedReason: "Only the filer submits their report",
          } as never
        }
        submit={submit}
      />,
    );
    expect(blocked).toContain("Only the filer");
    expect(blocked).not.toContain("Remarks");
  });

  it("grids each person's submissions per day", () => {
    const html = renderToStaticMarkup(
      <CompletenessView
        grid={grid as never}
        selected={null}
        onSelect={vi.fn()}
      />,
    );
    expect(html).toContain("DAR / ROAR submissions");
    expect(html).toContain("Mon 28");
    expect(html).toContain('aria-label="Ana 2026-09-29 Missing"');
    expect(html).toContain('aria-label="Ana 2026-09-28 Late"');
    expect(html).toContain('aria-label="Dina 2026-09-30 Due 10 PM"');
    expect(html).toContain("ROAR · Route Distribution Salesman (RDS)");
    // Filed today 1 of 2; two missing across the week.
    expect(html).toContain("1/2");
    expect(html).toMatch(/Missing this week[\s\S]*?>2</);
  });

  it("opens the filer's own report and the team tab for supervisors", () => {
    state.kind = "roar";
    state.capabilities = ["visit.read", "visit.record", "people.read"];
    const html = renderToStaticMarkup(<ActivityReportsWorkspace />);
    expect(html).toContain("My ROAR");
    expect(html).toContain("Team submissions");
    expect(html).toContain("Submit ROAR");
    expect(html).toContain('aria-label="Service date"');
  });

  it("explains when the signed-in position files no report", () => {
    state.kind = null;
    state.capabilities = ["visit.read", "visit.record"];
    const html = renderToStaticMarkup(<ActivityReportsWorkspace />);
    expect(html).toContain("does not file a DAR or ROAR");
    expect(html).not.toContain("Team submissions");
  });

  it("goes straight to team submissions for a supervisor who files nothing", () => {
    state.kind = null;
    state.capabilities = ["visit.read", "people.read"];
    const html = renderToStaticMarkup(<ActivityReportsWorkspace />);
    expect(html).toContain("Week ending");
    expect(html).toContain("DAR / ROAR submissions");
    expect(html).toContain("Region B");
  });
});
