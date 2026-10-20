import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgencyEvidenceView,
  comparisonPeriod,
  effectiveManilaTime,
  type AgencyEvidence,
} from "./workspace";
import { toMe } from "../../lib/auth/types";

const evidence: AgencyEvidence = {
  partner: {
    id: "hidden-agency-uuid",
    name: "Sample Cebu agency",
    sample: true,
  },
  from: "2026-10-14",
  to: "2026-10-20",
  source: "System evidence, not agency-reported attendance.",
  evidenceHash: "hidden-hash",
  summary: {
    staff: 1,
    planned: 3,
    attended: 2,
    completed: 2,
    compliant: 1,
    issues: 1,
    eligibleDays: 1,
    amountCentavos: 65000,
  },
  rows: [
    {
      profileId: "hidden-staff-uuid",
      name: "Ana Reyes",
      date: "2026-10-20",
      planned: 3,
      attended: 2,
      completed: 2,
      compliant: 1,
      issues: 1,
      target: 2,
      eligible: true,
      amountCentavos: 65000,
    },
  ],
  visits: [
    {
      id: "hidden-visit-uuid",
      profileId: "hidden-staff-uuid",
      name: "Ana Reyes",
      outlet: "Sample Mandaue market",
      date: "2026-10-20",
      attended: true,
      completed: true,
      compliant: false,
      issues: ["Required activity evidence is missing"],
      dwellMs: 600000,
    },
  ],
};
describe("F-319 F-322 agency evidence portal", () => {
  it("renders verified attendance, explicit evidence gaps and the next action without identifiers", () => {
    const html = renderToStaticMarkup(
      <AgencyEvidenceView data={evidence} onBuild={() => {}} />,
    );
    expect(html).toContain("Sample Cebu agency");
    expect(html).toContain("Sample data");
    expect(html).toContain("Build billing evidence");
    expect(html).toContain("Required activity evidence is missing");
    expect(html).toContain("Completed");
    expect(html).toContain("Review 1 check");
    expect(html).toContain("₱650.00");
    expect(html).not.toContain("hidden-agency-uuid");
    expect(html).not.toContain("hidden-visit-uuid");
    expect(html).not.toContain("hidden-hash");
  });
  it("keeps missing prior data distinct from a zero prior and shows the contractual trend", () => {
    const noPrior = renderToStaticMarkup(
      <AgencyEvidenceView data={evidence} />,
    );
    expect(noPrior).toContain("Prior period: Unavailable");
    expect(noPrior).toContain("Contract minimum");
    expect(noPrior).toContain("Agency compliant calls by day");
    const prior = {
      ...evidence,
      summary: {
        ...evidence.summary,
        amountCentavos: 0,
        attended: 0,
        completed: 0,
        compliant: 0,
      },
    };
    const html = renderToStaticMarkup(
      <AgencyEvidenceView data={evidence} prior={prior} />,
    );
    expect(html).toContain("Prior period: ₱0.00");
  });
  it("does not imply attendance or billability from an empty staff day", () => {
    const html = renderToStaticMarkup(
      <AgencyEvidenceView data={{ ...evidence, visits: [] }} />,
    );
    expect(html).toContain("Attendance and billable work are not inferred");
  });
  it("uses the immediately preceding equal-length comparison period", () => {
    expect(comparisonPeriod("2026-10-14", "2026-10-20")).toEqual({
      from: "2026-10-07",
      to: "2026-10-13",
    });
  });
  it("F-319 F-322 policy dates preserve Manila time and allow an explicit immediate default", () => {
    expect(effectiveManilaTime("2026-10-22T09:30")).toBe(
      "2026-10-22T01:30:00.000Z",
    );
    expect(effectiveManilaTime("")).toBeUndefined();
    expect(effectiveManilaTime(null)).toBeUndefined();
  });
  it("preserves the server partner identity for isolated shell routing", () => {
    const me = toMe({
      user: { id: "u" },
      profile: { id: "p", role: "agency", status: "active" },
      partner: { id: "partner", kind: "agency", name: "Cebu agency" },
      capabilities: [],
    });
    expect(me?.partner?.kind).toBe("agency");
    expect(me?.permissions).toEqual([]);
  });
  it("F-319 discloses an unavailable operational incident feed instead of asserting zero incidents", () => {
    const html = renderToStaticMarkup(
      <AgencyEvidenceView
        data={{ ...evidence, retailIssueFeedAvailable: false }}
      />,
    );
    expect(html).toContain("Operational incident feed is not connected");
    expect(html).toContain("configured contract only");
    expect(comparisonPeriod("", "")).toEqual({ from: "", to: "" });
  });
});
