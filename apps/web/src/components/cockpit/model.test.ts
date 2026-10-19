import { describe, expect, it } from "vitest";
import { analyticsFixture, fixtureNow, targetsFixture } from "./fixtures";
import {
  formatAge,
  formatCases,
  formatCasesPieces,
  formatCount,
  formatDelta,
  formatMinutes,
  formatPct,
  formatPhp,
  formatPhpCompact,
  formatSince,
  humanize,
  toneFor,
} from "./format";
import { gridColumns } from "./kit/kpi-card";
import { sortExceptions } from "./kit/exception-list";
import { cumulative } from "./kit/trend-chart";
import {
  addDays,
  channelLabel,
  daysBetween,
  effectiveRange,
  isIsoDate,
  manilaToday,
  presetOf,
  presetRange,
  readCommon,
} from "./period";
import {
  monthLabel,
  parsePesos,
  parseTargetsCsv,
  shiftMonth,
} from "./pages/targets-editor";
import { carryFixture, safeHref, withParams } from "./url";

const NOW = fixtureNow(Date.parse("2026-10-19T12:00:00+08:00"));
const MTD = { from: "2026-10-01", to: "2026-10-19" };

describe("money, percent and unit formatting", () => {
  it.each([
    [124_835_025, {}, "₱1,248,350"],
    [124_835_025, { cents: true }, "₱1,248,350.25"],
    [-184_050, { cents: true }, "−₱1,840.50"],
    [184_050, { cents: true, signed: true }, "+₱1,840.50"],
    [0, {}, "₱0"],
    [-20, {}, "₱0"],
    [null, {}, "—"],
  ] as const)("formatPhp(%s, %j) = %s", (centavos, options, text) => {
    expect(formatPhp(centavos, options)).toBe(text);
  });

  it.each([
    [1_200_000_000, "₱12M"],
    [1_250_000_000, "₱13M"],
    [120_000_000, "₱1.2M"],
    [85_000_00, "₱85K"],
    [90_000, "₱900"],
    [-150_000_00, "−₱150K"],
  ])("formatPhpCompact(%s) = %s", (centavos, text) => {
    expect(formatPhpCompact(centavos)).toBe(text);
  });

  it("percentages keep one decimal; unknown is a dash, not zero", () => {
    expect(formatPct(88)).toBe("88.0%");
    expect(formatPct(71.24)).toBe("71.2%");
    expect(formatPct(0)).toBe("0.0%");
    expect(formatPct(null)).toBe("—");
  });

  it("counts group thousands and keep one decimal for averages", () => {
    expect(formatCount(1312)).toBe("1,312");
    expect(formatCount(3.46)).toBe("3.5");
    expect(formatCount(undefined)).toBe("—");
  });

  it("cases and pieces read like a warehouse person writes them", () => {
    expect(formatCasesPieces(12, 4)).toBe("12 cs 4 pc");
    expect(formatCasesPieces(1200, 0)).toBe("1,200 cs");
    expect(formatCases(2)).toBe("2 cs");
    expect(formatCases(-2.5)).toBe("−2.5 cs");
    expect(formatCases(null)).toBe("—");
  });

  it("minutes become hours and minutes", () => {
    expect(formatMinutes(45)).toMatch(/45/);
    expect(formatMinutes(null)).toBe("—");
    expect(formatMinutes(125)).toBe("2h 5m");
  });

  it.each([
    [12.44, "▲ 12.4%", "up"],
    [-3, "▼ 3.0%", "down"],
    [0.04, "0.0%", "flat"],
    [null, "No prior figure", "none"],
  ] as const)("formatDelta(%s)", (delta, text, direction) => {
    expect(formatDelta(delta)).toEqual({ text, direction });
  });

  it("ages and recency in plain words", () => {
    const now = Date.parse("2026-10-19T15:05:00+08:00");
    expect(formatAge(now - 42 * 60_000, now)).toBe("42 min");
    expect(formatAge(now - 38 * 3_600_000, now)).toBe("38 h");
    expect(formatAge(now - 72 * 3_600_000, now)).toBe("3 days");
    expect(formatSince(now - 3_600_000, now)).toBe("Today");
    expect(formatSince(now - 86_400_000, now)).toBe("Yesterday");
    expect(formatSince(now - 9 * 86_400_000, now)).toBe("9 days ago");
    expect(formatSince(null, now)).toBe("Never");
  });

  it("server codes become words, never snake_case", () => {
    expect(humanize("pending_approval")).toBe("Pending approval");
    expect(humanize("in_call")).toBe("In a call");
    expect(humanize("over_limit")).toBe("Over limit");
    expect(humanize(null)).toBe("—");
  });

  it("one tone per status", () => {
    expect(toneFor("ok")).toBe("ok");
    expect(toneFor("watch")).toBe("watch");
    expect(toneFor("behind")).toBe("behind");
    expect(toneFor("unknown")).toBe("neutral");
  });
});

describe("period and URL state", () => {
  it.each([
    ["today", "2026-10-19", "2026-10-19"],
    ["mtd", "2026-10-01", "2026-10-19"],
    ["last_month", "2026-09-01", "2026-09-30"],
  ] as const)("%s on Mon Oct 19 is %s to %s", (preset, from, to) => {
    expect(presetRange(preset, "2026-10-19")).toEqual({ from, to });
    expect(presetOf(from, to, "2026-10-19")).toBe(preset);
  });

  it("this week starts on Monday (on a Monday it equals today)", () => {
    expect(presetRange("week", "2026-10-19")).toEqual({
      from: "2026-10-19",
      to: "2026-10-19",
    });
    expect(presetOf("2026-10-19", "2026-10-21", "2026-10-21")).toBe("week");
    expect(presetRange("week", "2026-10-22")).toEqual({
      from: "2026-10-19",
      to: "2026-10-22",
    });
    expect(presetOf("2026-10-05", "2026-10-09", "2026-10-19")).toBe("custom");
  });

  it("last month in January is December of the year before", () => {
    expect(presetRange("last_month", "2027-01-10")).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
  });

  it("Manila dates roll over at midnight Manila, not UTC", () => {
    expect(manilaToday(Date.parse("2026-10-19T16:30:00Z"))).toBe("2026-10-20");
    expect(manilaToday(Date.parse("2026-10-19T15:30:00Z"))).toBe("2026-10-19");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(daysBetween("2026-10-01", "2026-10-19")).toBe(19);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-10-19")).toBe(true);
  });

  it("readCommon drops invalid values so the server uses its defaults", () => {
    expect(
      readCommon(
        new URLSearchParams(
          "from=2026-10-19&to=2026-10-01&unitId=u-south&channel=kas&compare=yoy",
        ),
      ),
    ).toEqual({ unitId: "u-south", channel: "kas" });
    expect(
      readCommon(
        new URLSearchParams("from=2026-10-01&to=2026-10-19&compare=ly"),
      ),
    ).toEqual({
      ...MTD,
      compare: "ly",
    });
    expect(effectiveRange({}, "2026-10-19")).toEqual(MTD);
  });

  it("channel labels are plain words", () => {
    expect(channelLabel(null)).toBe("All channels");
    expect(channelLabel("kas")).toBe("Key accounts (KAS)");
  });

  it("withParams replaces, repeats and removes params", () => {
    expect(
      withParams("/sales", "from=2026-10-01&cursor=abc", {
        cursor: null,
        groupBy: "agent",
      }),
    ).toBe("/sales?from=2026-10-01&groupBy=agent");
    expect(withParams("/sales", "", { crumb: ["a", "b"] })).toBe(
      "/sales?crumb=a&crumb=b",
    );
    expect(withParams("/sales", "channel=gt", { channel: "" })).toBe("/sales");
  });

  it("safeHref keeps same-site paths only", () => {
    expect(safeHref("/decide?kind=credit_breach")).toBe(
      "/decide?kind=credit_breach",
    );
    expect(safeHref("https://evil.example")).toBeNull();
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("/x\n")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });

  it("fixture mode survives navigation", () => {
    const on = new URLSearchParams("fixture=1");
    expect(carryFixture("/sales", on)).toBe("/sales?fixture=1");
    expect(carryFixture("/sales?groupBy=agent", on)).toBe(
      "/sales?groupBy=agent&fixture=1",
    );
    expect(carryFixture("/sales", new URLSearchParams())).toBe("/sales");
  });
});

describe("targets editor", () => {
  it("months shift across years", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(monthLabel("2026-10")).toMatch(/Oct/);
  });

  it.each([
    ["1250000", 125_000_000],
    ["₱1,250,000.50", 125_000_050],
    [" 900 ", 90_000],
    ["12.345", null],
    ["-5", null],
    ["abc", null],
  ] as const)("parsePesos(%j) = %s centavos", (text, centavos) => {
    expect(parsePesos(text)).toBe(centavos);
  });

  it("CSV import checks the header and every row", () => {
    const parsed = parseTargetsCsv(
      'level,key,amount_php\ncompany,company,17600000\nterritory,t-tmg,"3,900,000"\nregion,x,1\nagent,,5\n',
    );
    expect(parsed.rows).toEqual([
      { level: "company", key: "company", amountCentavos: 1_760_000_000 },
      { level: "territory", key: "t-tmg", amountCentavos: 390_000_000 },
    ]);
    expect(parsed.errors.map((e) => e.row)).toEqual([4, 5]);
    expect(parseTargetsCsv("key,level\n").errors[0]!.message).toContain(
      "level,key,amount_php",
    );
    expect(
      parseTargetsCsv("level,key,amount_php\n").errors[0]!.message,
    ).toContain("No target rows");
  });
});

describe("kit helpers", () => {
  it("cumulative sums leave a gap on unknown days without resetting the run", () => {
    expect(cumulative([1, 2, null, 4])).toEqual([1, 3, null, 7]);
  });

  it("exceptions sort urgent first, then oldest", () => {
    const base = {
      kind: "behind_target",
      title: "",
      detail: "",
      owner: null,
      dueAt: null,
      action: null,
      evidence: {},
    };
    const sorted = sortExceptions([
      { ...base, id: "a", severity: "low", openedAt: 1 },
      { ...base, id: "b", severity: "high", openedAt: 5 },
      { ...base, id: "c", severity: "high", openedAt: 2 },
      { ...base, id: "d", severity: "medium", openedAt: 1 },
    ] as never);
    expect(sorted.map((item: { id: string }) => item.id)).toEqual([
      "c",
      "b",
      "d",
      "a",
    ]);
  });

  it("KPI grids leave no lonely card on desktop", () => {
    expect(gridColumns(8)).toContain("xl:grid-cols-4");
    expect(gridColumns(6)).toContain("md:grid-cols-3");
    expect(gridColumns(5)).toContain("xl:grid-cols-5");
  });
});

describe("demo company numbers reconcile across pages", () => {
  const sales = (groupBy: string, extra: Record<string, string> = {}) =>
    analyticsFixture("sales", { ...MTD, groupBy, ...extra }, NOW);
  const total = sales("territory").kpis.find((k) => k.key === "sales")!.value!;

  it.each(["channel", "territory", "agent"])(
    "sales by %s add up to the total",
    (groupBy) => {
      expect(sales(groupBy).rows.reduce((s, r) => s + r.sales, 0)).toBe(total);
    },
  );

  it.each(["channel", "territory", "agent"])(
    "orders by %s add up to the total",
    (groupBy) => {
      const view = sales(groupBy);
      const kpi = view.kpis.find((k) => k.key === "orders")!;
      expect(view.rows.reduce((s, r) => s + r.orders, 0)).toBe(kpi.value);
    },
  );

  it("Today's month to date equals Sales & targets month to date", () => {
    const today = analyticsFixture("today", { date: MTD.to }, NOW);
    expect(today.kpis.find((k) => k.key === "mtdSales")!.value).toBe(total);
  });

  it("a territory's agents add up to that territory", () => {
    const territory = sales("territory").rows.find((r) => r.key === "t-tmg")!;
    const agents = sales("agent", { parent: "territory:t-tmg" }).rows;
    expect(agents.reduce((s, r) => s + r.sales, 0)).toBe(territory.sales);
  });

  it("aging buckets add up to open receivables and overdue over 30 days", () => {
    const money = analyticsFixture("money", MTD, NOW);
    const aging = money.aging;
    const open = Object.values(aging).reduce((s, v) => s + v, 0);
    expect(money.kpis.find((k) => k.key === "arTotal")!.value).toBe(open);
    const over30 = aging.d31_60 + aging.d61_90 + aging.d90p;
    expect(money.kpis.find((k) => k.key === "overdue")!.value).toBe(over30);
  });

  it("van cash variance is remitted minus expected", () => {
    const vans = analyticsFixture("vans", { date: MTD.to }, NOW);
    for (const row of vans.rows)
      if (row.cashRemitted !== null)
        expect(row.variance).toBe(row.cashRemitted - row.cashExpected);
  });

  it("company target is the sum of agent targets", () => {
    const company = targetsFixture("2026-10", "company");
    const agents = targetsFixture("2026-10", "agent");
    expect(Math.abs(company.total - agents.total)).toBeLessThan(100_000 * 2);
  });
});
