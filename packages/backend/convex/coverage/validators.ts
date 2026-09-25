import { v } from "convex/values";

// Dates in coverage rows are Manila local dates; timestamps are UTC epoch milliseconds.
// Weekdays use JavaScript's 0–6 convention: Sunday = 0, Saturday = 6.
export const weekday = v.union(
  v.literal(0),
  v.literal(1),
  v.literal(2),
  v.literal(3),
  v.literal(4),
  v.literal(5),
  v.literal(6),
);
export const planStatus = v.union(
  v.literal("draft"),
  v.literal("submitted"),
  v.literal("approved"),
  v.literal("active"),
  v.literal("superseded"),
);
export const cycleType = v.literal("monthly");
export const frequency = v.union(
  v.literal("weekly"),
  v.literal("biweekly"),
  v.literal("monthly"),
  v.literal("custom"),
);
export const slotKind = v.union(
  v.literal("outlet_visit"),
  v.literal("non_visit"),
);
export const routineDayKind = v.union(
  v.literal("selling"),
  v.literal("field"),
  v.literal("admin"),
  v.literal("day_off"),
);
export const plannedVisitStatus = v.union(
  v.literal("planned"),
  v.literal("cancelled"),
  v.literal("replaced"),
);

// Kept separate from the live outlet/assignment rows: approval signs these values.
// An unlinked prospect has no customer or link ID. A route is optional for a
// territory-only assignment, but its source assignment IDs remain independently
// identifiable when present.
export const approvedOutletSnapshot = v.object({
  outletId: v.id("outlets"),
  outletCode: v.string(),
  outletName: v.string(),
  customerId: v.optional(v.id("customers")),
  outletCustomerLinkId: v.optional(v.id("outletCustomerLinks")),
  territoryId: v.id("territories"),
  territoryCode: v.string(),
  routeId: v.optional(v.id("routes")),
  routeCode: v.optional(v.string()),
  sequence: v.optional(v.number()),
  outletAssignmentId: v.id("outletAssignments"),
  territoryOwnershipId: v.id("territoryOwnerships"),
  territorySalespersonId: v.optional(v.id("territorySalespeople")),
  routeTerritoryId: v.optional(v.id("routeTerritories")),
  routeSalespersonId: v.optional(v.id("routeSalespeople")),
  employeeAssignmentId: v.id("employeeAssignments"),
  orgUnitId: v.id("orgUnits"),
  activityKind: v.string(),
  approvedAssigneeProfileId: v.id("profiles"),
});
