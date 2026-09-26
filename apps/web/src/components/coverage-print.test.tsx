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
    expect(html).toContain("Store visit");
    expect(html).toContain("Planned");
    expect(html).not.toContain("outlet_visit");
    expect(html).not.toContain('planId="p"');
    expect(html).toContain("1970-01-01 08:00");
    for (const text of [
      "2026-09",
      "Version 3",
      "Preparer",
      "Submitter",
      "Approver",
      "abcdef012345",
      "PROSPECT",
      "Unlinked prospect",
      "Print / Save PDF",
    ])
      expect(html).toContain(text);
  });
  it("shows readable filter labels without rendering database IDs", () => {
    const html = renderToStaticMarkup(
      <CoveragePrint
        header={header}
        rows={rows}
        filters={{
          territoryId: "raw-territory-id",
          territoryLabel: "T1 · North",
          routeId: "raw-route-id",
          routeLabel: "R1 · City",
          visitStatus: "planned",
        }}
      />,
    );
    expect(html).toContain("Territory: T1 · North");
    expect(html).toContain("Route: R1 · City");
    expect(html).toContain("Visit status: Planned");
    expect(html).not.toContain("raw-territory-id");
    expect(html).not.toContain("raw-route-id");
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
    expect(html).toContain("Not approved");
    expect(html).toContain("No entries match these filters");
  });
});
