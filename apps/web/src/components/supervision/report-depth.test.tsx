import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MyTeamView, TeamSalesView, Sparkline } from "./report-depth";
import { teamDailySalesCsv, teamPrioritiesCsv } from "../../lib/daily-sales";
import type { TeamCockpit, TeamDsr } from "./depth-model";
vi.mock("./report-api", () => ({
  useReportSearch: () => "",
  replaceReportSearch: () => {},
  useReport: () => undefined,
}));
const team: TeamCockpit = {
  serviceDate: "2026-10-19",
  week: { start: "2026-10-19", end: "2026-10-25" },
  definition: "Recorded server evidence; unsynced work may be missing.",
  rows: [
    {
      profileId: "private-person-identifier",
      name: "Ana",
      position: "Distributor Specialist",
      channel: "GT",
      today: { planned: 5, visited: 3, productive: 2, standard: 5 },
      week: { planned: 10, visited: 7, productive: 6, priorVisited: 8 },
      trend: [1, 2, 4],
      workWith: { done: 1, required: 4 },
      talkActions: 2,
      overdue: 1,
      perDiemWaiting: 1,
      darMissing: true,
      actions: {
        day: "/analytics?view=agent-day",
        workWith: "/supervision?tab=workwith",
        talk: "/supervision?tab=talk",
        perDiem: "/supervision?tab=perdiem",
        report: "/activity-reports",
      },
    },
  ],
};
const sales: TeamDsr = {
  serviceDate: "2026-10-19",
  definition: "Sales are net order lines in centavos",
  totals: { todaySales: 12345, mtdSales: 50000, target: 100000, prior: 40000 },
  rows: [
    {
      profileId: "ana",
      name: "Ana",
      todaySales: 12345,
      mtdSales: 50000,
      target: 100000,
      dailyTarget: null,
      balanceToSell: 50000,
      calls: 3,
      productive: 2,
      trend: [{ date: "2026-10-19", sales: 12345, cumulative: 50000 }],
      prior: 40000,
    },
  ],
};
describe("owner depth", () => {
  it("read-only people see the missing report without an invitation to prepare it", () => {
    const html = renderToStaticMarkup(<MyTeamView report={team} />);
    expect(html).not.toContain("Prepare missing DAR");
    expect(html).toContain("View missing DAR");
  });
  it("shows day and prior-week comparisons, coaching cadence, overdue actions and a next action for each exception", () => {
    const html = renderToStaticMarkup(<MyTeamView report={team} canPrepare />);
    for (const label of [
      "My team today and this week",
      "5 / 3 / 2",
      "5 calls required",
      "7 / 8",
      "1 / 4",
      "2 open · 1 overdue",
      "Prepare missing DAR",
      "Export CSV",
      "Print / Save PDF",
    ])
      expect(html).toContain(label);
    expect(html).toContain("text-danger");
    expect(html).toContain('href="/supervision?tab=talk"');
    expect(html).not.toContain("private-person-identifier");
  });
  it("keeps a measured zero distinct from standards that need setup", () => {
    const row = team.rows[0]!;
    const html = renderToStaticMarkup(
      <MyTeamView
        report={{
          ...team,
          rows: [
            {
              ...row,
              today: { planned: 0, visited: 0, productive: 0, standard: null },
              workWith: { done: 0, required: null },
            },
          ],
        }}
      />,
    );
    expect(html).toContain("0 / 0 / 0");
    expect(html).toContain("Call standard needs setup");
    expect(html).toContain("Needs setup");
  });
  it("whole-team mode shows totals, prior period, sortable rows, trends and individual drill-down", () => {
    const html = renderToStaticMarkup(
      <TeamSalesView report={sales} onPerson={() => {}} />,
    );
    expect(html).toContain("Whole team · daily sales");
    expect(html).toContain("₱123.45");
    expect(html).toContain("₱500.00");
    expect(html).toContain("₱1,000.00");
    expect(html).toContain("Prior MTD");
    expect(html).toContain("Sort by");
    expect(html).toContain("Not set");
    expect(html).toContain("cumulative sales this month");
    expect(html).toContain("Review calls");
  });
  it("team exports preserve decimal pesos, BOM, quoting and formula protection", () => {
    const csv = teamDailySalesCsv({
      ...sales,
      rows: [{ ...sales.rows[0]!, name: "=SUM(1,2)" }],
    });
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"\'=SUM(1,2)"');
    expect(csv).toContain("123.45");
    expect(csv).toContain("500.00");
    expect(csv).toContain("\r\n");
    const priorities = teamPrioritiesCsv(team);
    expect(priorities).toContain("Prior week visited");
    expect(priorities).toContain("Overdue actions");
    expect(priorities).not.toContain("private-person-identifier");
  });
  it("sparkline keeps negative net-sales data visible instead of clipping it", () => {
    const html = renderToStaticMarkup(
      <Sparkline values={[-200, 0, 400, -100]} label="Net sales" />,
    );
    const points = /points="([^"]*)"/.exec(html)![1]!.split(" ");
    expect(points).toHaveLength(4);
    expect(
      points.every((p) => {
        const y = Number(p.split(",")[1]);
        return y >= 0 && y <= 32;
      }),
    ).toBe(true);
  });
});
