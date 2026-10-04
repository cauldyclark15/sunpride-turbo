import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

const at = (hhmm: string) => Date.parse(`2026-09-28T${hhmm}:00+08:00`);
const dayCloseAt = at("22:00");

const person = {
  profileId: "p1",
  name: "Ana",
  employeeCode: "E-1",
  positionLabel: "Route Salesman",
  channel: "PMOT",
  orgUnitId: "u1",
  direct: true,
  planned: 3,
  plannedDone: 2,
  done: 2,
  productive: 1,
  nonproductive: 1,
  unplanned: 1,
  inProgress: true,
  outOfSequence: 1,
  openExceptions: 2,
  lateSync: 1,
  firstCheckInAt: at("08:00"),
  lastCheckOutAt: at("09:20"),
  lastActivityAt: at("10:00"),
};
const teamDay = {
  serviceDate: "2026-09-28",
  dayCloseAt,
  truncated: false,
  canDecide: true,
  units: [{ id: "u1", code: "A", name: "Region A" }],
  channels: ["PMOT", "Route Salesman"],
  people: [
    person,
    {
      ...person,
      profileId: "p2",
      name: "Ben",
      employeeCode: null,
      channel: "Route Salesman",
      direct: false,
      planned: 2,
      plannedDone: 0,
      done: 0,
      productive: 0,
      nonproductive: 0,
      unplanned: 0,
      inProgress: false,
      outOfSequence: 0,
      openExceptions: 0,
      lateSync: 0,
      firstCheckInAt: null,
      lastCheckOutAt: null,
      lastActivityAt: null,
    },
  ],
};
const empty = {
  visitId: null,
  evidenceId: null,
  event: null,
  result: null,
  distanceMeters: null,
  accuracyMeters: null,
  radiusMeters: null,
  sequence: null,
  after: null,
  reason: null,
  decision: null,
  history: [],
  open: false,
  canDecide: false,
  profileId: "p1",
  personName: "Ana",
  channel: "PMOT",
};
const queue = {
  serviceDate: "2026-09-28",
  dayCloseAt,
  truncated: false,
  canDecide: true,
  items: [
    {
      ...empty,
      id: "location:e1",
      kind: "location",
      open: true,
      canDecide: true,
      outletCode: "O1",
      outletName: "Outlet 1",
      at: at("09:00"),
      visitId: "v1",
      evidenceId: "e1",
      event: "check_in",
      result: "outside_radius",
      distanceMeters: 320.4,
      accuracyMeters: 12,
      radiusMeters: 75,
      history: [
        {
          kind: "visit.checked_in",
          at: at("09:00"),
          actorName: "Ana",
          after: "checked-in",
          reasonCode: null,
        },
      ],
    },
    {
      ...empty,
      id: "location:e2",
      kind: "location",
      outletCode: "O2",
      outletName: "Outlet 2",
      at: at("08:00"),
      evidenceId: "e2",
      event: "check_in",
      result: "unreliable",
      decision: {
        status: "approved_exception",
        reasonCode: "weak_signal",
        actorName: "Mara",
        at: at("10:30"),
      },
    },
    {
      ...empty,
      id: "sequence:v1",
      kind: "out_of_sequence",
      outletCode: "O1",
      outletName: "Outlet 1",
      at: at("09:00"),
      sequence: 1,
      after: 2,
    },
    {
      ...empty,
      id: "not_visited:pv3",
      kind: "not_visited",
      outletCode: "O3",
      outletName: "Outlet 3",
      at: null,
      sequence: 3,
    },
  ],
};
const activity = {
  serviceDate: "2026-09-28",
  truncated: false,
  showsFixes: false,
  people: [
    {
      profileId: "p1",
      name: "Ana",
      channel: "PMOT",
      stops: [
        {
          id: "v2",
          visitId: "v2",
          outletCode: "O2",
          outletName: "Outlet 2",
          territoryCode: "T-A",
          sequence: 2,
          state: "checked-out",
          productivity: "verified",
          source: "planned",
          checkedInAt: at("08:00"),
          checkedOutAt: at("08:30"),
          point: { latitude: 14.52, longitude: 121 },
          fix: null,
        },
        {
          id: "pv3",
          visitId: null,
          outletCode: "O3",
          outletName: "Outlet 3",
          territoryCode: "T-B",
          sequence: 3,
          state: "planned",
          productivity: null,
          source: "not_visited",
          checkedInAt: null,
          checkedOutAt: null,
          point: null,
          fix: null,
        },
      ],
    },
  ],
};

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    if (name === "supervision/team:options")
      return {
        canDecide: true,
        units: [
          { id: "u1", code: "A", name: "Region A" },
          { id: "u2", code: "B", name: "Region B" },
        ],
        channels: ["PMOT"],
      };
    if (name === "supervision/team:day") return teamDay;
    return undefined;
  },
}));

import {
  exceptionMeta,
  personStatus,
  plottedStops,
  reasonLabel,
  splitQueue,
  territoriesOf,
  type TeamPerson,
} from "./supervision-model";
import { ExceptionQueueView } from "./exception-queue";
import { ActivityMapView } from "./activity-map";
import { TeamExecutionView } from "./team-execution";
import { SupervisionWorkspace } from "./supervision-workspace";

describe("supervision rules", () => {
  const base: TeamPerson = {
    planned: 3,
    plannedDone: 0,
    done: 0,
    inProgress: false,
    firstCheckInAt: null,
    lastActivityAt: null,
  };
  it("derives the field-day status from the viewer's clock", () => {
    const status = (p: Partial<TeamPerson>, now: number) =>
      personStatus({ ...base, ...p }, "2026-09-28", dayCloseAt, now).label;
    expect(status({}, at("08:00"))).toBe("Not yet");
    expect(status({}, at("09:00"))).toBe("Not started");
    expect(status({}, at("22:00"))).toBe("No calls");
    expect(status({ planned: 0 }, at("10:00"))).toBe("No plan");
    expect(status({ inProgress: true, done: 1 }, at("10:00"))).toBe("In call");
    expect(status({ plannedDone: 3, done: 3 }, at("12:00"))).toBe("Done");
    expect(
      status(
        { done: 1, firstCheckInAt: at("08:00"), lastActivityAt: at("08:30") },
        at("11:00"),
      ),
    ).toBe("Idle 2h");
    expect(
      status(
        { done: 1, firstCheckInAt: at("08:00"), lastActivityAt: at("10:30") },
        at("11:00"),
      ),
    ).toBe("On route");
    expect(
      status(
        { done: 1, firstCheckInAt: at("08:00"), lastActivityAt: at("10:30") },
        at("23:00"),
      ),
    ).toBe("Incomplete");
  });
  it("holds stops not visited back until the day closes", () => {
    const items = queue.items as Parameters<typeof splitQueue>[0];
    expect(splitQueue(items, dayCloseAt, at("12:00")).other).toHaveLength(2);
    const closed = splitQueue(items, dayCloseAt, at("22:30"));
    expect(closed.open).toHaveLength(1);
    expect(closed.other).toHaveLength(3);
  });
  it("writes short meta lines and labels reason codes", () => {
    expect(
      exceptionMeta(queue.items[0] as Parameters<typeof exceptionMeta>[0]),
    ).toBe("Check-in · Outside radius · 320 m away · ±12 m · 09:00");
    expect(
      exceptionMeta(queue.items[2] as Parameters<typeof exceptionMeta>[0]),
    ).toBe("Stop 1 after stop 2 · 09:00");
    expect(reasonLabel("weak_signal")).toBe("Weak signal");
    expect(reasonLabel("custom_code")).toBe("custom code");
  });
  it("plots only pinned stops and lists territories", () => {
    const stops = activity.people[0]!.stops as Parameters<
      typeof plottedStops
    >[0];
    expect(plottedStops(stops)).toHaveLength(1);
    expect(territoriesOf(activity.people as never)).toEqual(["T-A", "T-B"]);
  });
});

describe("supervision screens", () => {
  it("groups the team by channel with calls, productivity and flags", () => {
    const html = renderToStaticMarkup(
      <TeamExecutionView data={teamDay as never} now={at("11:00")} />,
    );
    expect(html).toContain("PMOT");
    expect(html).toContain("Route Salesman");
    expect(html.indexOf("PMOT")).toBeLessThan(html.indexOf("Ben"));
    expect(html).toContain("2/3");
    expect(html).toContain("1 · 50%");
    expect(html).toContain("2 to review");
    expect(html).toContain("1 out of order");
    expect(html).toContain("1 late sync");
    expect(html).toContain("In call");
    expect(html).toContain("Not started");
  });
  it("puts open geofence evidence with decision controls first", () => {
    const html = renderToStaticMarkup(
      <ExceptionQueueView
        data={queue as never}
        now={at("11:00")}
        decide={vi.fn()}
      />,
    );
    expect(html.indexOf("Needs decision")).toBeLessThan(
      html.indexOf("Other exceptions"),
    );
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    expect(html).toContain("Approved · Weak signal · Mara");
    expect(html).toContain("History · 1");
    expect(html).toContain("Out of order");
    expect(html).not.toContain("Outlet 3");
    expect(html.match(/aria-label="Reason for/g)).toHaveLength(1);
  });
  it("lists each person's stops in order and filters by territory", () => {
    const html = renderToStaticMarkup(
      <ActivityMapView
        data={activity as never}
        profileId=""
        territory=""
        onProfile={vi.fn()}
        onTerritory={vi.fn()}
      />,
    );
    expect(html).toContain("Field activity map");
    expect(html).toContain("Productive");
    expect(html).toContain("Not visited");
    expect(html).toContain("No pin");
    const filtered = renderToStaticMarkup(
      <ActivityMapView
        data={activity as never}
        profileId=""
        territory="T-A"
        onProfile={vi.fn()}
        onTerritory={vi.fn()}
      />,
    );
    expect(filtered).not.toContain("Outlet 3");
  });
  it("mounts the team view with date, unit and channel filters", () => {
    const html = renderToStaticMarkup(<SupervisionWorkspace />);
    expect(html).toContain("Supervision views");
    expect(html).toContain('aria-label="Service date"');
    expect(html).toContain("Region B");
    expect(html).toContain("All channels");
    expect(html).toContain("My team only");
    expect(html).toContain("Work-With");
    expect(html).toContain("Talk Sheet");
    expect(html).toContain("Productivity");
    expect(html).toContain("Ana");
  });
});
