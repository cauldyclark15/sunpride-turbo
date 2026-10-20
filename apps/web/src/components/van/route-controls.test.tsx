import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { VanTripPlanning } from "./trip-planning";
import { VanPolicyEditor } from "./route-policy-editor";
import type { TripSettlement } from "./model";

const choices = vi.hoisted(() => ({
  vehicles: [
    {
      vehicleId: "truck-id",
      name: "Sample truck",
      plateNumber: "SAMPLE",
      unitId: "unit-id",
      homeLocationId: "depot-id",
      busy: false,
    },
  ],
  sellers: [
    { profileId: "seller-id", name: "Sample seller", unitId: "unit-id" },
  ],
  depots: [{ locationId: "depot-id", name: "Sample depot", code: "DEPOT" }],
  routes: [{ routeId: "route-id", name: "Sample beat", code: "BEAT" }],
}));
vi.mock("../../lib/api", () => ({
  apiFetch: vi.fn(),
  useApi: () => ({ data: choices }),
}));
vi.mock("./use-command", () => ({ useVanCommand: () => vi.fn() }));
vi.mock("@heroui/react", () => ({
  Button: ({ children }: { children: React.ReactNode }) =>
    createElement("button", null, children),
}));

it("F-102 F-105 planner controls have exact accessible names independent of option text", () => {
  const html = renderToStaticMarkup(
    <VanTripPlanning date="2026-10-20" onPlanned={() => {}} />,
  );
  for (const label of ["Truck", "Seller", "Planned beat", "Load from"])
    expect(html).toContain(`aria-label="${label}"`);
  expect(html).toContain("Sample truck");
  expect(html).toContain("Sample seller");
  expect(html).toContain("Plan cold-chain route");
});
it("F-115 policy and product-band pickers have distinct accessible names", () => {
  // This isolated rendering fixture supplies only the projection fields the policy editor reads.
  const trip = {
    tripId: "trip-id",
    unitId: "unit-id",
    stock: [{ productId: "product-id", name: "Sample frozen goods" }],
    vanOps: {
      policies: {
        cold_chain: {
          intervalMinutes: 60,
          bands: [
            {
              productId: null,
              label: "SAMPLE frozen",
              minDeciC: -250,
              maxDeciC: -180,
            },
          ],
        },
        variance: { toleranceBasisPoints: 50, escalateAfterHours: 24 },
        returnables: { items: [{ code: "crate", label: "Sample crate" }] },
        return_reasons: { items: [{ code: "damaged", label: "Damaged" }] },
      },
    },
  } as unknown as TripSettlement;
  const html = renderToStaticMarkup(<VanPolicyEditor trip={trip} />);
  expect(html).toContain('aria-label="Policy"');
  expect(html).toContain('aria-label="Product for storage band 1"');
  expect(html).toContain("Sample frozen goods");
  expect(html).toContain("Save future version");
});
