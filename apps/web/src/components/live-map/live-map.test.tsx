import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";

const NOW = Date.parse("2026-10-08T05:00:00Z"); // 13:00 Manila

const base = {
  kind: "field" as const,
  vehicleId: null,
  vehicleLabel: null,
  tripNumber: null,
  orgUnitId: "u1",
  unitName: "Cebu North",
  teamId: null,
  teamName: null,
  accuracyMeters: 12,
  speedMetersPerSecond: 5,
  headingDegrees: 90,
  batteryPercent: 80,
  mockLocation: false,
  receivedAt: NOW,
  serviceDate: "2026-10-08",
  visitOutletName: null,
  sample: false,
};
const positions = [
  {
    ...base,
    id: "l1",
    profileId: "p1",
    name: "Rhea Santos",
    latitude: 10.33,
    longitude: 123.9,
    recordedAt: NOW - 30_000,
    status: "moving" as const,
    visitOutletName: "Colon Grocery",
  },
  {
    ...base,
    id: "l2",
    kind: "van" as const,
    profileId: "p2",
    name: "Jomar Abella",
    vehicleId: "v1",
    vehicleLabel: "SMP-TRK-01 · GAC 4521",
    tripNumber: "TRIP-1",
    latitude: 10.29,
    longitude: 123.88,
    recordedAt: NOW - 20 * 60_000,
    speedMetersPerSecond: 0,
    status: "stale" as const,
    sample: true,
  },
];
const live = {
  now: NOW,
  truncated: false,
  selfOnly: false,
  positions,
  units: [
    { id: "u1", name: "Cebu North" },
    { id: "u2", name: "Cebu South" },
  ],
  teams: [{ id: "t1", name: "North team" }],
};
const trail = {
  profileId: "p1",
  name: "Rhea Santos",
  serviceDate: "2026-10-08",
  truncated: false,
  pings: [
    {
      kind: "field" as const,
      latitude: 10.31,
      longitude: 123.89,
      accuracyMeters: 10,
      speedMetersPerSecond: 0,
      batteryPercent: 90,
      mockLocation: false,
      trigger: "start",
      recordedAt: Date.parse("2026-10-08T00:00:00Z"),
    },
    {
      kind: "field" as const,
      latitude: 10.32,
      longitude: 123.9,
      accuracyMeters: 10,
      speedMetersPerSecond: 6,
      batteryPercent: 88,
      mockLocation: false,
      trigger: "moving",
      recordedAt: Date.parse("2026-10-08T00:30:00Z"),
    },
  ],
  stops: [
    {
      visitId: "v1",
      outletCode: "SMP-O-0002",
      outletName: "Colon Grocery Center",
      state: "checked-out",
      checkedInAt: Date.parse("2026-10-08T00:10:00Z"),
      checkedOutAt: Date.parse("2026-10-08T00:25:00Z"),
      latitude: 10.31,
      longitude: 123.89,
      pinned: true,
    },
  ],
};

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(ref as never);
    if (name === "location/queries:live") return live;
    if (name === "location/queries:trail") return trail;
    return undefined;
  },
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: () => undefined,
  }),
}));

import {
  clusterPoints,
  countByStatus,
  escapeHtml,
  filterPositions,
  lastSeen,
  mapProvider,
  markerHtml,
  positionMeta,
  type LivePosition,
} from "./live-map-model";
import {
  LiveMapView,
  LiveMapWorkspace,
  trailKm,
  type LiveMapViewProps,
} from "./live-map-workspace";

const typed = positions as unknown as LivePosition[];

describe("live map model", () => {
  it("filters by kind, status and name/plate search", () => {
    const f = { kind: "" as const, status: "" as const, search: "" };
    expect(
      filterPositions(typed, { ...f, kind: "van" }).map((p) => p.id),
    ).toEqual(["l2"]);
    expect(
      filterPositions(typed, { ...f, status: "moving" }).map((p) => p.id),
    ).toEqual(["l1"]);
    expect(
      filterPositions(typed, { ...f, search: "gac" }).map((p) => p.id),
    ).toEqual(["l2"]);
    expect(countByStatus(typed)).toEqual({
      moving: 1,
      idle: 0,
      stale: 1,
      offline: 0,
    });
  });

  it("writes last-seen text from the viewer's clock", () => {
    expect(lastSeen(NOW, NOW - 10_000)).toBe("just now");
    expect(lastSeen(NOW, NOW - 4 * 60_000)).toBe("4 min ago");
    expect(lastSeen(NOW, NOW - 2 * 3_600_000)).toBe("2 h ago");
    expect(lastSeen(NOW, Date.parse("2026-10-07T09:05:00Z"))).toBe(
      "yesterday 17:05",
    );
  });

  it("clusters nearby markers when zoomed out and splits them when zoomed in", () => {
    const near = [
      { latitude: 10.3, longitude: 123.9 },
      { latitude: 10.3005, longitude: 123.9005 },
      { latitude: 10.6, longitude: 124.2 },
    ];
    expect(
      clusterPoints(near, 10)
        .map((c) => c.items.length)
        .sort(),
    ).toEqual([1, 2]);
    expect(clusterPoints(near, 19)).toHaveLength(3);
  });

  it("escapes names in marker HTML and uses different shapes for trucks", () => {
    const hostile = { ...typed[0]!, name: '<img src=x onerror="x">' };
    const html = markerHtml(hostile, false);
    expect(html).not.toContain("<img");
    expect(escapeHtml("<a&'\">")).toBe("&lt;a&amp;&#39;&quot;&gt;");
    expect(markerHtml(typed[1]!, true)).toContain("border-radius:6px");
    expect(markerHtml(typed[1]!, true)).toContain("box-shadow");
    expect(markerHtml(typed[0]!, false)).toContain("border-radius:999px");
  });

  it("uses Google Maps only when a key is configured", () => {
    expect(mapProvider(undefined)).toBe("osm");
    expect(mapProvider("  ")).toBe("osm");
    expect(mapProvider("key")).toBe("google");
  });

  it("summarises a position and a trail", () => {
    expect(positionMeta(typed[0]!)).toBe(
      "Field · Cebu North · 18 km/h · 80% battery · ±12 m · In call: Colon Grocery",
    );
    expect(positionMeta(typed[1]!)).toContain("Sample");
    expect(trailKm(trail as never)).toBeGreaterThan(1);
  });
});

const props = (over: Partial<LiveMapViewProps> = {}): LiveMapViewProps => ({
  data: live as never,
  now: NOW,
  filters: { kind: "", status: "", search: "" },
  onFilters: () => undefined,
  orgUnitId: "",
  onUnit: () => undefined,
  teamId: "",
  onTeam: () => undefined,
  selectedProfileId: null,
  onSelect: () => undefined,
  trail: null,
  trailDate: "2026-10-08",
  onTrailDate: () => undefined,
  map: <div data-testid="map" />,
  ...over,
});

describe("live map view", () => {
  it("lists people and trucks with status, last seen and the sample note", () => {
    const html = renderToStaticMarkup(<LiveMapView {...props()} />);
    expect(html).toContain("Rhea Santos");
    expect(html).toContain("Jomar Abella · truck");
    expect(html).toContain("SMP-TRK-01 · GAC 4521");
    expect(html).toContain("Moving");
    expect(html).toContain("Stale");
    expect(html).toContain("20 min ago");
    expect(html).toContain("Includes sample positions");
    expect(html).toContain("Cebu South");
    expect(html).toContain("North team");
    expect(html).toContain('data-testid="map"');
    expect(html).toContain("Pick a person or truck");
  });

  it("explains when nobody is sharing and when filters hide everyone", () => {
    const empty = renderToStaticMarkup(
      <LiveMapView {...props({ data: { ...live, positions: [] } as never })} />,
    );
    expect(empty).toContain("No one is sharing their location");
    const filtered = renderToStaticMarkup(
      <LiveMapView
        {...props({ filters: { kind: "", status: "offline", search: "" } })}
      />,
    );
    expect(filtered).toContain("Nobody matches these filters.");
  });

  it("shows the selected person's trail with stops and timestamps", () => {
    const html = renderToStaticMarkup(
      <LiveMapView
        {...props({ selectedProfileId: "p1", trail: trail as never })}
      />,
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("2 positions");
    expect(html).toContain("08:00–08:30");
    expect(html).toContain("Colon Grocery Center");
    expect(html).toContain("08:10–08:25");
  });

  it("mounts the workspace from the live subscription", () => {
    const html = renderToStaticMarkup(<LiveMapWorkspace />);
    expect(html).toContain("Live map");
    expect(html).toContain("Rhea Santos");
  });
});
