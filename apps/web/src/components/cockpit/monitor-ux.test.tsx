import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/today",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { analyticsFixture, fixtureNow } from "./fixtures";
import { behindHref, behindLabel, FreshnessNote } from "./kit/freshness";
import { readCommon, presetRange, manilaToday } from "./period";
import {
  AgentDayView,
  needsDefaultPeriod,
  StoresAddedList,
} from "./pages/coverage";
import { FIELD_FIRST_ROLES, TodayView } from "./pages/today";
import { getWebNavigation, primaryIdFor } from "@/config/navigation";
import { humanize } from "./format";
import { positionMeta, type LivePosition } from "../live-map/live-map-model";

const NOW = fixtureNow(Date.parse("2026-10-19T12:00:00+08:00"));
const html = (node: React.ReactElement) =>
  renderToStaticMarkup(node)
    .replaceAll("&amp;", "&")
    .replaceAll("&#x27;", "'");

describe("SP-0175 office monitoring", () => {
  it("Today puts 'Field right now' above the sales cards for office roles", () => {
    const data = analyticsFixture("today", { date: "2026-10-19" }, NOW);
    const office = html(<TodayView data={data} fieldFirst />);
    expect(office.indexOf("Field right now")).toBeGreaterThan(-1);
    expect(office.indexOf("Field right now")).toBeLessThan(
      office.indexOf("Sales this day and month"),
    );
    const rep = html(<TodayView data={data} />);
    expect(rep.indexOf("Field right now")).toBeGreaterThan(
      rep.indexOf("Sales this day and month"),
    );
    for (const role of ["admin", "manager", "operations", "super_admin"])
      expect(FIELD_FIRST_ROLES.has(role)).toBe(true);
    expect(FIELD_FIRST_ROLES.has("sales")).toBe(false);
    expect(office).toContain("Working");
    expect(humanize("working")).toBe("Working");
  });

  it("the 'not synced' banner names the person's phone and links to it", () => {
    const freshness = {
      asOf: NOW,
      devicesBehind: 2,
      oldestDeviceSyncAt: NOW - 3_600_000,
      devicesBehindList: [
        {
          deviceId: "d1",
          profileId: "p-joel",
          name: "Joel Dela Cruz",
          app: "field-android",
          phone: "FLD-07",
          lastSeenAt: NOW - 3_600_000,
        },
      ],
    };
    const admin = html(<FreshnessNote freshness={freshness} canOpenPhones />);
    expect(admin).toContain("Joel Dela Cruz's phone (FLD-07)");
    expect(admin).toContain('href="/admin?section=devices"');
    expect(admin).toContain("and 1 more");
    const manager = html(
      <FreshnessNote freshness={freshness} canOpenPhones={false} />,
    );
    expect(manager).toContain("/coverage-people/agent?profileId=p-joel&date=");
    expect(
      behindLabel({ ...freshness.devicesBehindList[0]!, name: null }),
    ).toBe("phone FLD-07");
    expect(behindHref(freshness.devicesBehindList[0]!, true)).toBe(
      "/admin?section=devices",
    );
  });

  it("the agent day shows the shared status and the stores added that day", () => {
    const data = analyticsFixture(
      "agent-day",
      { profileId: "p01", date: "2026-10-19" },
      NOW,
    );
    data.summary.status = "working";
    data.summary.lastSeenAt = NOW - 24 * 60_000;
    data.storesAdded = [
      {
        id: "o1",
        code: "SMP-NEW-1",
        name: "Aling Nena Store",
        at: NOW - 3_600_000,
        via: "added",
        state: "approved",
      },
      {
        id: "c2",
        code: null,
        name: "Mang Kanor",
        at: NOW - 1_800_000,
        via: "gathered",
        state: "waiting",
      },
    ];
    const out = html(<AgentDayView data={data} />);
    expect(out).toContain('data-testid="agent-status"');
    expect(out).toContain("Working");
    expect(out).toContain("New stores added");
    expect(out).toContain("Aling Nena Store");
    expect(out).toContain("Waiting for review");
    expect(out).toContain("/customers?addedBy=");
    expect(html(<StoresAddedList stores={[]} />)).toContain(
      "No new stores this day",
    );
  });

  it("the trail legend names positions, not stops", () => {
    const data = analyticsFixture(
      "agent-day",
      { profileId: "p01", date: "2026-10-19" },
      NOW,
    );
    if (data.trail.length >= 2) {
      const out = html(<AgentDayView data={data} />);
      expect(out).toContain("first position");
      expect(out).not.toContain("first stop");
    }
  });

  it("Live map rows use Today's words and stops-done numbers", () => {
    const meta = positionMeta(
      {
        kind: "field",
        vehicleLabel: null,
        tripNumber: null,
        teamName: null,
        unitName: "Cebu",
        speedMetersPerSecond: null,
        batteryPercent: null,
        accuracyMeters: 10,
        mockLocation: false,
        visitOutletName: null,
        planned: 25,
        visited: 2,
        productive: 1,
        lastMovedAt: null,
        idleFlag: false,
        sample: false,
        fieldStatus: "working",
      } as unknown as LivePosition,
      NOW,
    );
    expect(meta).toContain("Day: Working");
    expect(meta).toContain("2 of 25 stops done · 1 productive");
  });

  it("Coverage opens on This week; ?period= alone is honoured", () => {
    expect(needsDefaultPeriod(new URLSearchParams())).toBe(true);
    expect(needsDefaultPeriod(new URLSearchParams("period=today"))).toBe(false);
    const today = manilaToday();
    expect(readCommon(new URLSearchParams("period=week"))).toMatchObject(
      presetRange("week", today),
    );
    expect(readCommon(new URLSearchParams("period=today"))).toMatchObject({
      from: today,
      to: today,
    });
    expect(readCommon(new URLSearchParams("period=bogus")).from).toBe(
      undefined,
    );
  });

  it("Supervision is the top-level 'Field team' item, not a Work tab", () => {
    expect(primaryIdFor("/supervision")).toBe("field-team");
    const nav = getWebNavigation("/supervision");
    const items = nav.navGroups.flatMap((g) => g.items);
    expect(items.find((i) => i.id === "field-team")?.href).toBe(
      "/supervision",
    );
    expect(nav.moduleTabs).toEqual([]);
    const work = getWebNavigation("/orders").moduleTabs.map((t) => t.id);
    expect(work).not.toContain("supervision");
  });
});
