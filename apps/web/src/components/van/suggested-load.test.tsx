import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { SuggestedLoad } from "./suggested-load";
import type { TripSettlement } from "./model";

// Explicit SSR hook fixture; the real browser proof separately runs both commands against PostgreSQL.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async () => ({
  ...(await vi.importActual<typeof import("react")>("react")),
  useState: () => [hooks.values[hooks.index++], () => {}],
}));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ can: () => true }),
}));
vi.mock("./use-command", () => ({ useVanCommand: () => vi.fn() }));
vi.mock("@heroui/react", () => ({
  Button: ({
    children,
    isDisabled,
  }: {
    children: import("react").ReactNode;
    isDisabled?: boolean;
  }) => createElement("button", { disabled: isDisabled }, children),
}));
const suggestion = {
  suggestionId: "suggestion-id",
  contentHash: "hash",
  routeOutletCount: 25,
  classMix: { A: 25 },
  sourceOrderCount: 0,
  algorithm: "SAMPLE source facts",
  capacity: "Check physical capacity",
  cycles: [],
  manualInitialLoad: true,
  recommendations: [
    {
      productId: "sku",
      name: "Sample frozen pack",
      uomCode: "PC",
      quantityScale: "1",
      caseBase: "12",
      forecastBase: "0",
      presellBase: "0",
      depotAvailableBase: "20",
      recommendedBase: "0",
    },
  ],
};
const trip = { tripId: "trip-id", status: "planned" } as TripSettlement;
beforeEach(() => {
  hooks.index = 0;
  hooks.values = [
    suggestion,
    { sku: "12" },
    "SAMPLE reviewed initial load",
    true,
    false,
    "",
  ];
});
it("F-102 first-load review names its input unit visibly, not only in an accessibility attribute", () => {
  const html = renderToStaticMarkup(<SuggestedLoad trip={trip} />);
  expect(html).toContain("Load quantity (PC)");
  expect(html).toContain('aria-label="Load Sample frozen pack in PC"');
  expect(html).toContain('value="12"');
  expect(html).toContain("Stocked depot items start at zero");
  expect(html).toContain("<button>Apply reviewed load</button>");
});
it("F-102 a capacity check never enables an all-zero initial load", () => {
  hooks.values[1] = { sku: "0" };
  const html = renderToStaticMarkup(<SuggestedLoad trip={trip} />);
  expect(html).toContain('<button disabled="">Apply reviewed load</button>');
  expect(html).toContain(
    "No sales history or open pre-sell demand is available.",
  );
});
