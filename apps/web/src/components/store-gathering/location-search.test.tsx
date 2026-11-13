import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", () => ({
  apiFetch: vi.fn(),
  useApi: () => ({ data: { rows: [], truncated: false, total: 0, missing: 0 } }),
}));

import { LocationCoverage } from "./location-coverage";

describe("WEB-160 Locations search", () => {
  it("uses the shared search-as-you-type box, not an Enter-only form", () => {
    const html = renderToStaticMarkup(createElement(LocationCoverage));
    // The shared ListPage search box filters 250 ms after typing stops (L2).
    expect(html).toContain('data-testid="list-search"');
    expect(html).toContain('placeholder="Find a store"');
  });
});

describe("WEB-165 Locations empty search", () => {
  it("names the search text instead of saying there are no stores", async () => {
    const { LocationCoverageView } = await import("./location-coverage");
    const html = renderToStaticMarkup(
      createElement(LocationCoverageView, {
        data: { rows: [], truncated: false, total: 0, located: 0, missing: 0 } as never,
        missingOnly: false,
        onMissingOnly: () => {},
        term: "zzz",
      }),
    );
    expect(html).toContain("No store named “zzz”.");
    expect(html).not.toContain("No stores yet.");
  });
});
