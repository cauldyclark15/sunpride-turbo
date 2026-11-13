import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OverrideRow } from "./store-day-model";

// WEB-088 (SP-0169 r6web5): Decide's "Open the overrides" passes ?kind=&id=; the screen applies them on load.
const search = { value: "" };
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.value),
  usePathname: () => "/operations/stores-pos/overrides",
}));
const row = (id: string, kind: string, reason: string): OverrideRow => ({
  id,
  registerId: "r1",
  registerName: "Till one",
  businessDate: "2026-11-13",
  kind,
  label: kind,
  method: "pin_online",
  supervisorName: "Sup",
  cashierName: "Ana",
  reason,
  amountCentavos: "5000",
  refType: null,
  refId: null,
  capturedAt: Date.parse("2026-11-13T02:00:00Z"),
});
vi.mock("../../lib/api", () => ({
  useApi: () => ({
    data: {
      overrides: [
        row("o-disc", "discount", "Loyal buyer"),
        row("o-void", "void_sale", "Customer left"),
      ],
    },
  }),
  useLive: () => {},
}));

import { OverridesScreen } from "./overrides-review";
import { useUrlParam } from "../../lib/use-url-tab";

const html = () => renderToStaticMarkup(createElement(OverridesScreen));

describe("overrides list filters from the URL (WEB-088)", () => {
  it("shows everything without a kind", () => {
    search.value = "";
    const out = html();
    expect(out).toContain("Loyal buyer");
    expect(out).toContain("Customer left");
  });
  it("a Decide link with ?kind= opens filtered and marks ?id=", () => {
    search.value = "kind=discount&id=o-disc";
    const out = html();
    expect(out).toContain("Loyal buyer");
    expect(out).not.toContain("Customer left");
    expect(out).toContain('aria-current="true"');
  });
  it("useUrlParam is exported for other list pages", () => {
    expect(typeof useUrlParam).toBe("function");
  });
});
