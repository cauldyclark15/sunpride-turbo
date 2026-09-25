import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "../../../../packages/backend/convex/lib/capabilities";
import { canAccessWebModule, MODULE_ROLES } from "./module-access";

const roles = [
  "super_admin",
  "admin",
  "operations",
  "manager",
  "approver",
  "sales",
  "analyst",
  "viewer",
] as const;

const expectedCapabilities = {
  dashboard: ["report.read"],
  "master-data": ["masterdata.manage"],
  imports: [
    "masterdata.manage",
    "inventory.adjustment.request",
    "inventory.count.submit",
  ],
  inventory: ["inventory.read"],
  "sales-force": ["visit.read"],
  orders: ["order.create", "order.approve"],
  "sap-integration": ["integration.read"],
  workflows: ["order.approve"],
  admin: ["admin.manage"],
  analytics: ["report.read"],
} as const;

const expectedModulesByRole: Record<(typeof roles)[number], string[]> = {
  super_admin: Object.keys(expectedCapabilities),
  admin: [
    "dashboard",
    "master-data",
    "imports",
    "inventory",
    "sales-force",
    "sap-integration",
    "admin",
    "analytics",
  ],
  operations: [
    "dashboard",
    "master-data",
    "imports",
    "inventory",
    "sales-force",
    "sap-integration",
    "analytics",
  ],
  manager: [
    "dashboard",
    "imports",
    "inventory",
    "sales-force",
    "orders",
    "workflows",
    "analytics",
  ],
  approver: [
    "dashboard",
    "inventory",
    "sales-force",
    "orders",
    "workflows",
    "analytics",
  ],
  sales: ["dashboard", "inventory", "sales-force", "orders", "analytics"],
  analyst: ["dashboard", "inventory", "sales-force", "analytics"],
  viewer: ["dashboard", "inventory", "sales-force", "analytics"],
};

describe("web module access", () => {
  it("matches the backend capability role sets for each module", () => {
    for (const [module, capabilities] of Object.entries(expectedCapabilities)) {
      const expected = new Set(
        capabilities.flatMap((key) => CAPABILITIES[key]),
      );
      expect(
        new Set(MODULE_ROLES[module as keyof typeof MODULE_ROLES]),
      ).toEqual(expected);
    }
  });

  it.each(roles)("allows and denies every module for the %s role", (role) => {
    for (const slug of Object.keys(MODULE_ROLES)) {
      expect(canAccessWebModule(slug, role)).toBe(
        expectedModulesByRole[role].includes(slug),
      );
    }
  });

  it("refuses unknown, retired, and unassigned modules and roles", () => {
    expect(canAccessWebModule("mobile", "super_admin")).toBe(false);
    expect(canAccessWebModule("unknown", "super_admin")).toBe(false);
    expect(canAccessWebModule("toString", "super_admin")).toBe(false);
    expect(canAccessWebModule("admin", "viewer")).toBe(false);
    expect(canAccessWebModule("admin", null)).toBe(false);
    expect(canAccessWebModule("dashboard", "unknown")).toBe(false);
  });

  it("never invokes demo seeding from the module workspace", () => {
    const source = readFileSync(
      new URL("../components/module-workspace.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/api\.seed\.demo|seedDemo/);
    expect(source).toContain("api.domains.profiles.ensure");
  });
});
