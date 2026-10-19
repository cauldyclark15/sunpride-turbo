import { expect, test } from "bun:test";
import { generateDemo } from "./index.js";
import { rowId } from "./store.js";

test("demo depot is in Mandaue under Visayas and each stocked truck belongs to its seller's area", () => {
  const { data } = generateDemo({ anchorDate: "2026-10-20", days: 3 });
  const locations = data.rows("inventory_locations");
  const depot = locations.find(
    (l) => l.id === rowId("inventory_locations", "depot"),
  );
  expect(depot?.org_unit_id).toBe(rowId("org_units", "territory-0"));
  const area = data.rows("org_units").find((u) => u.id === depot?.org_unit_id);
  expect(area?.parent_id).toBe(rowId("org_units", "visayas"));
  for (const location of locations.filter((l) => l.type === "truck")) {
    const trip = data
      .rows("van_trips")
      .find((t) => t.truck_location_id === location.id);
    const seller = data
      .rows("profiles")
      .find((p) => p.id === trip?.salesperson_profile_id);
    expect(location.org_unit_id).toBe(seller?.org_unit_id);
  }
});
