import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CoveragePrint } from "./coverage-print";
import type { ScheduleHeader, ScheduleRow } from "../lib/coverage-export";
const header: ScheduleHeader = {
  planId: "p",
  localMonth: "2026-09",
  version: 3,
  status: "active",
  assigneeName: "Seller",
  preparedByName: "Preparer",
  preparedAt: 1,
  submittedByName: "Submitter",
  submittedAt: 2,
  approvedByName: "Approver",
  approvedAt: 3,
  signedHashPrefix: "abcdef012345",
};
const rows: ScheduleRow[] = [
  {
    slotKey: "a",
    serviceDate: "2026-09-28",
    kind: "outlet_visit",
    outletCode: "PROSPECT",
    name: "Unlinked prospect",
    sequence: 1,
    visitStatus: "planned",
    durationMinutes: 30,
  },
];
describe("print schedule", () => {
  it("shows signed version, names/times, filters, rows and print control", () => {
    const html = renderToStaticMarkup(
      <CoveragePrint
        header={header}
        rows={rows}
        filters={{ visitStatus: "planned" }}
      />,
    );
    for (const text of [
      "2026-09",
      "Version 3",
      "Preparer",
      "Submitter",
      "Approver",
      "abcdef012345",
      "PROSPECT",
      "Unlinked prospect",
      "Print / Save as PDF",
    ])
      expect(html).toContain(text);
  });
  it("labels unsigned zero-row schedules", () => {
    const html = renderToStaticMarkup(
      <CoveragePrint
        header={{
          ...header,
          status: "UNAPPROVED",
          approvedByName: undefined,
          approvedAt: undefined,
          signedHashPrefix: undefined,
        }}
        rows={[]}
        filters={{}}
      />,
    );
    expect(html).toContain("UNAPPROVED — provisional schedule");
    expect(html).toContain("No entries match these filters");
  });
});
