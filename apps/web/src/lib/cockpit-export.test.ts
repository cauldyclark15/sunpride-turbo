import { afterEach, expect, it, vi } from "vitest";
import { downloadCurrentWorkbook } from "../components/cockpit/kit/page";

afterEach(() => vi.unstubAllGlobals());

it("F-601 header export preserves the exact current filters and removes only paging", () => {
  const assign = vi.fn();
  vi.stubGlobal("window", {
    location: {
      href: "https://office.test/sales?from=2026-10-01&to=2026-10-20&unitId=literal%2Bscope&channel=kas&cursor=old&limit=50",
      assign,
    },
  });
  downloadCurrentWorkbook();
  const value = assign.mock.calls[0]?.[0];
  if (typeof value !== "string") throw new Error("Missing export navigation");
  const url = new URL(value);
  expect(url.pathname).toBe("/api/v1/analytics/sales");
  expect(url.searchParams.get("format")).toBe("xlsx");
  expect(url.searchParams.get("from")).toBe("2026-10-01");
  expect(url.searchParams.get("to")).toBe("2026-10-20");
  expect(url.searchParams.get("unitId")).toBe("literal+scope");
  expect(url.searchParams.get("channel")).toBe("kas");
  expect(url.searchParams.has("cursor")).toBe(false);
  expect(url.searchParams.has("limit")).toBe(false);
});

it.each([
  ["/stores/store", "store"],
  ["/coverage-people/agent", "agent-day"],
])(
  "F-601 detail export maps %s without losing the selected source identity",
  (path, page) => {
    const assign = vi.fn();
    vi.stubGlobal("window", {
      location: {
        href: `https://office.test${path}?storeId=source-outlet&profileId=source-person&date=2026-10-20`,
        assign,
      },
    });
    downloadCurrentWorkbook();
    const value = assign.mock.calls[0]?.[0];
    if (typeof value !== "string") throw new Error("Missing detail export");
    const url = new URL(value);
    expect(url.pathname).toBe(`/api/v1/analytics/${page}`);
    expect(url.searchParams.get("storeId")).toBe("source-outlet");
    expect(url.searchParams.get("profileId")).toBe("source-person");
    expect(url.searchParams.get("date")).toBe("2026-10-20");
  },
);

it("F-601 does not navigate an unsupported page to an invented export endpoint", () => {
  const assign = vi.fn();
  vi.stubGlobal("window", {
    location: { href: "https://office.test/setup", assign },
  });
  downloadCurrentWorkbook();
  expect(assign).not.toHaveBeenCalled();
});
