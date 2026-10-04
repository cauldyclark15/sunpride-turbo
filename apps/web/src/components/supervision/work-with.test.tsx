import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkWithCadenceView, WorkWithEditorView } from "./work-with";
import { cadenceCell, shortDate, statusTone } from "./work-with-model";

const trainer = {
  profileId: "p1",
  name: "Dina",
  employeeCode: "E-9",
  positionLabel: "Distributor Specialist",
  orgUnitId: "u1",
  direct: true,
  weeklyMin: 4,
  monthlyMin: 16,
  weekCount: 2,
  monthCount: 3,
  openCount: 1,
  weekState: "on_track",
  monthState: "on_track",
  sourceRef: "memo 2026-01-20 §III",
};
const session = {
  sessionId: "s1",
  serviceDate: "2026-09-30",
  trainerProfileId: "p1",
  trainerName: "Dina",
  traineeProfileId: "p2",
  traineeName: "Ana",
  objective: "sales_validation",
  mode: "truck",
  truckReference: "TRK-7",
  status: "open",
};
const cadence = {
  week: { start: "2026-09-28", end: "2026-10-04" },
  month: { start: "2026-09-01", end: "2026-09-30" },
  truncated: false,
  trainers: [
    trainer,
    {
      ...trainer,
      profileId: "p3",
      name: "Eli",
      positionLabel: "Channel Development Specialist",
      weeklyMin: 3,
      monthlyMin: 12,
      weekCount: 0,
      monthCount: 12,
      openCount: 0,
      weekState: "behind",
      monthState: "met",
    },
  ],
  sessions: [
    session,
    { ...session, sessionId: "s2", status: "completed", mode: "booking" },
  ],
};
const detail = {
  session: {
    _id: "s1",
    _creationTime: 1,
    organizationId: "sunpride",
    trainerProfileId: "p1",
    traineeProfileId: "p2",
    orgUnitId: "u1",
    serviceDate: "2026-09-30",
    objective: "sales_validation",
    mode: "truck",
    truckReference: "TRK-7",
    status: "open",
    observations: [{ area: "bcp", item: "Greet", rating: "met" }],
    createdBy: "x",
    createdAt: 1,
    updatedBy: "x",
    updatedAt: 1,
  },
  trainerName: "Dina",
  traineeName: "Ana",
  mcp: { planned: 3, done: 1 },
  gaps: [
    {
      code: "mcp_unfinished",
      label: "The trainee has not finished the day's MCP",
    },
  ],
  canEdit: true,
};

describe("work-with view rules", () => {
  it("tones cadence by state and formats dates", () => {
    expect(cadenceCell(4, 4, "met")).toEqual({ label: "4/4", tone: "success" });
    expect(cadenceCell(1, 4, "behind")).toEqual({
      label: "1/4 · behind",
      tone: "danger",
    });
    expect(cadenceCell(1, 4, "on_track").tone).toBe("warning");
    expect(cadenceCell(2, null, "no_standard").label).toBe("2");
    expect(shortDate("2026-09-28")).toBe("28 Sep");
    expect(statusTone("completed")).toBe("success");
  });
});

describe("work-with screens", () => {
  it("shows each trainer's week and month against the minimum", () => {
    const html = renderToStaticMarkup(
      <WorkWithCadenceView data={cadence as never} onOpen={vi.fn()} />,
    );
    expect(html).toContain("Work-With cadence");
    expect(html).toContain("Week of 28 Sep");
    expect(html).toContain("2/4");
    expect(html).toContain("3/16");
    expect(html).toContain("0/3 · behind");
    expect(html).toContain("12/12");
    expect(html).toContain("Sales and validation · Truck TRK-7");
    expect(html).toContain("Open Work-With with Ana on 2026-09-30");
    expect(html).toContain("Done");
  });

  it("asks the trainer for the sales objective's review, SWOT and truck ride", () => {
    const html = renderToStaticMarkup(
      <WorkWithEditorView
        detail={detail as never}
        save={vi.fn()}
        complete={vi.fn()}
        cancel={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain("Still needed to complete");
    expect(html).toContain("not finished the day&#x27;s MCP");
    expect(html).toContain("MCP 1/3");
    expect(html).toContain("Daily Productive Sales Report");
    expect(html).toContain('aria-label="Threats"');
    expect(html).toContain("Rode with truck TRK-7");
    expect(html).toContain("Save and complete");
    expect(html).not.toContain('aria-label="Training log"');
  });

  it("shows a training session read-only to anyone but its trainer", () => {
    const html = renderToStaticMarkup(
      <WorkWithEditorView
        detail={
          {
            ...detail,
            canEdit: false,
            gaps: [],
            session: {
              ...detail.session,
              objective: "training",
              mode: "booking",
              status: "completed",
              trainingLog: {
                topics: "BCP",
                tradeDevelopment: "Displays",
                discussedWithTrainee: true,
              },
            },
          } as never
        }
        save={vi.fn()}
        complete={vi.fn()}
        cancel={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain('aria-label="Training log"');
    expect(html).toContain("Reviewed and discussed with the trainee");
    expect(html).not.toContain("Save and complete");
    expect(html).not.toContain("Add BCP");
  });
});
