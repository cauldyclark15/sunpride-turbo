import { describe, expect, it } from "vitest";
import * as backend from "../../../../packages/backend/convex/analytics/model";
import {
  channelSummaries,
  emptyTotals,
  formatCentavos,
  headline,
  mergeTotals,
  pctLabel,
  personFlags,
  summarize,
  type ExecutionRow,
} from "./execution-dashboard";

const row = (over: Partial<ExecutionRow>): ExecutionRow => ({
  profileId: "p",
  name: "P",
  employeeCode: null,
  positionLabel: null,
  channel: "Route",
  sellingDay: true,
  scheduled: true,
  active: true,
  inField: false,
  planned: 0,
  plannedDone: 0,
  plannedOutlets: 0,
  coveredOutlets: 0,
  calls: 0,
  productiveCalls: 0,
  unplanned: 0,
  callsTarget: null,
  productiveTargetPct: null,
  sales: 0,
  salesTarget: null,
  firstCheckInAt: null,
  lastActivityAt: null,
  ...over,
});

const sample = [
  row({
    channel: "KAS",
    calls: 5,
    productiveCalls: 5,
    callsTarget: 5,
    productiveTargetPct: 90,
    planned: 5,
    plannedDone: 5,
    plannedOutlets: 5,
    coveredOutlets: 5,
    sales: 12_345_67,
    salesTarget: 10_000_00,
  }),
  row({
    channel: "Route",
    calls: 21,
    productiveCalls: 17,
    callsTarget: 30,
    productiveTargetPct: 85,
    planned: 30,
    plannedDone: 21,
    plannedOutlets: 28,
    coveredOutlets: 20,
    unplanned: 2,
    inField: true,
    sales: 4_000_00,
  }),
  row({ channel: "Route", scheduled: false, active: false }),
];

describe("execution dashboard view rules", () => {
  it("adds totals exactly like the backend", () => {
    const web = summarize(sample);
    const server = backend.summarize(sample as never);
    expect(web).toEqual(server);
    expect(headline(web)).toEqual(backend.headline(server));
    expect(
      mergeTotals(summarize(sample.slice(0, 1)), summarize(sample.slice(1))),
    ).toEqual(
      backend.mergeTotals(
        backend.summarize(sample.slice(0, 1) as never),
        backend.summarize(sample.slice(1) as never),
      ),
    );
    expect(Object.keys(emptyTotals()).sort()).toEqual(
      Object.keys(backend.emptyTotals()).sort(),
    );
  });

  it("formats centavos and missing percentages", () => {
    expect(formatCentavos(1_000_50)).toBe("₱1,001");
    expect(pctLabel(null)).toBe("—");
    expect(pctLabel(41)).toBe("41%");
  });

  it("groups by channel with summed, not averaged, figures", () => {
    const channels = channelSummaries(sample);
    expect(channels.map((c) => c.channel)).toEqual(["KAS", "Route"]);
    expect(channels[1]!.totals).toMatchObject({ people: 2, calls: 21 });
    expect(channels[1]!.figures.productivePct).toBe(80);
  });

  it("flags not started after 9 AM and target misses only after the day closes", () => {
    const date = "2026-09-30";
    const at = (hhmm: string) => Date.parse(`${date}T${hhmm}:00+08:00`);
    const idle = row({ active: false, scheduled: true });
    expect(personFlags(idle, date, at("08:30"))).toEqual([]);
    expect(personFlags(idle, date, at("09:00")).map((f) => f.label)).toEqual([
      "Not started",
    ]);
    const behind = sample[1]!;
    expect(personFlags(behind, date, at("15:00")).map((f) => f.key)).toEqual([
      "in-field",
      "unplanned",
    ]);
    expect(personFlags(behind, date, at("22:00")).map((f) => f.label)).toEqual([
      "In the field",
      "21/30 calls",
      "80% productive",
      "2 unplanned",
    ]);
    // KAS met both targets.
    expect(personFlags(sample[0]!, date, at("23:00"))).toEqual([]);
  });
});
