import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { REASON_LABELS as SERVER_LABELS } from "../../../../../packages/backend/convex/supervision/per_diem_model";
import { PerDiemView } from "./per-diem";
import {
  claimRange,
  decisionError,
  REASON_LABELS,
  reasonText,
  statusTone,
} from "./per-diem-model";

const item = {
  kind: "visit",
  serviceDate: "2026-09-25",
  outletCode: "O1",
  outletName: "Outlet 1",
  sequence: 1,
  checkedInAt: null,
  productivity: "verified",
  notes: [],
  missingForms: [] as string[],
};
const data = {
  localMonth: "2026-09",
  from: "2026-09-01",
  to: "2026-09-30",
  ruleVersion: "sop-004/2026-10-04",
  truncated: false,
  people: [
    {
      profileId: "p1",
      name: "Ana",
      employeeCode: "E-1",
      positionLabel: "Route Salesman",
      channel: "PMOT",
      latest: { decision: "validated", decidedAt: 1 },
    },
    {
      profileId: "p2",
      name: "Ben",
      employeeCode: null,
      positionLabel: null,
      channel: "PMOT",
      latest: null,
    },
  ],
  selected: null,
};
const selected = {
  profileId: "p1",
  name: "Ana",
  positionLabel: "Route Salesman",
  canDecide: true,
  truncated: false,
  contentHash: "h",
  totals: {
    plannedStops: 6,
    validCalls: 2,
    heldCalls: 1,
    invalidCalls: 3,
    notVisited: 1,
    validDays: 1,
    heldDays: 1,
  },
  days: [
    {
      serviceDate: "2026-09-25",
      plannedStops: 3,
      validCalls: 1,
      heldCalls: 1,
      invalidCalls: 1,
      notVisited: 1,
      dayStatus: "held",
    },
  ],
  items: [
    { ...item, id: "v1", visitId: "v1", status: "valid", reasons: [] },
    {
      ...item,
      id: "v2",
      visitId: "v2",
      status: "held",
      reasons: ["late_pending"],
    },
    {
      ...item,
      id: "v4",
      visitId: "v4",
      outletName: "Outlet 4",
      status: "held",
      reasons: ["forms_missing"],
      missingForms: ["merchandising", "inventory_check"],
    },
    {
      ...item,
      id: "v3",
      visitId: "v3",
      outletName: "Outlet 3",
      sequence: null,
      status: "invalid",
      reasons: ["outside_mcp"],
    },
  ],
  decisions: [
    {
      id: "d1",
      decision: "returned",
      note: "Stop 3 missing",
      deciderName: "Mara",
      decidedAt: 1,
      validCalls: 2,
      validDays: 1,
      ruleVersion: "sop-004/2026-10-04",
      stale: true,
    },
  ],
};

describe("per-diem view rules", () => {
  it("mirrors the server's reason labels exactly", () => {
    expect(REASON_LABELS).toEqual(SERVER_LABELS);
  });

  it("splits a month into claim halves", () => {
    expect(claimRange("2026-02", "month")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(claimRange("2026-09", "first")).toEqual({
      from: "2026-09-01",
      to: "2026-09-15",
    });
    expect(claimRange("2026-09", "second")).toEqual({
      from: "2026-09-16",
      to: "2026-09-30",
    });
  });

  it("labels reasons, tones and errors", () => {
    expect(reasonText(["outside_mcp", "no_report"])).toBe(
      "Not in the approved MCP · No call report recorded",
    );
    expect(
      reasonText(["forms_missing"], ["merchandising", "inventory_check"]),
    ).toBe(
      "Required forms for the call's purpose are missing: merchandising, inventory check",
    );
    expect(statusTone("held")).toBe("warning");
    expect(statusTone("validated")).toBe("success");
    expect(decisionError({ data: "stale_validation" })).toContain(
      "changed since you opened",
    );
    expect(decisionError(new Error("x"))).toBe("Not saved. Try again.");
  });
});

describe("per-diem screen", () => {
  it("lists people with their latest decision", () => {
    const html = renderToStaticMarkup(
      <PerDiemView data={data as never} onPick={vi.fn()} />,
    );
    expect(html).toContain("Per diem claims");
    expect(html).toContain("Validated");
    expect(html).toContain("Not decided");
    expect(html).toContain("Check per diem for Ben");
    expect(html).toContain("outside this system");
  });

  it("shows counts, exceptions and blocks validation while calls are held", () => {
    const html = renderToStaticMarkup(
      <PerDiemView
        data={{ ...data, selected } as never}
        onPick={vi.fn()}
        decide={vi.fn()}
      />,
    );
    expect(html).toContain("Calls that count");
    expect(html).toContain("of 6 planned stops");
    expect(html).toContain("Sent after the 10 PM close, waiting for review");
    expect(html).toContain("Not in the approved MCP");
    expect(html).toContain(
      "purpose are missing: merchandising, inventory check",
    );
    // The valid call is not an exception.
    expect(html.match(/Outlet 1/g)).toHaveLength(1);
    expect(html).toContain("Decide the 1 held call first");
    expect(html).toContain("Validate 2 calls · 1 day");
    expect(html).toContain("Calls changed since");
    expect(html).toContain("Stop 3 missing");
  });

  it("is read-only for people who cannot decide", () => {
    const html = renderToStaticMarkup(
      <PerDiemView
        data={{ ...data, selected: { ...selected, canDecide: false } } as never}
        onPick={vi.fn()}
        decide={vi.fn()}
      />,
    );
    expect(html).not.toContain("Validate 2 calls");
    expect(html).toContain("supervisor or manager decides");
  });
});
