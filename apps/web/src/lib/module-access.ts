import type { AppRole } from "../../../../packages/backend/convex/lib/roles";
import type { WebModuleSlug } from "@/config/navigation";

// UI-only mirror of packages/backend/convex/lib/capabilities.ts. Importing that
// runtime module would pull Convex server code into the client bundle. The test
// compares every set here to the backend capability table.
const allReaders = [
  "super_admin",
  "admin",
  "operations",
  "manager",
  "approver",
  "sales",
  "analyst",
  "viewer",
] as const satisfies readonly AppRole[];
const administrators = [
  "super_admin",
  "admin",
] as const satisfies readonly AppRole[];
const masterDataManagers = [
  "super_admin",
  "admin",
  "operations",
] as const satisfies readonly AppRole[];
// Union of masterdata.manage, inventory.adjustment.request, and inventory.count.submit.
const importActors = [
  "super_admin",
  "admin",
  "operations",
  "manager",
] as const satisfies readonly AppRole[];
const orderActors = [
  "super_admin",
  "manager",
  "sales",
  "approver",
] as const satisfies readonly AppRole[];
const orderApprovers = [
  "super_admin",
  "manager",
  "approver",
] as const satisfies readonly AppRole[];
const integrationReaders = [
  "super_admin",
  "admin",
  "operations",
] as const satisfies readonly AppRole[];

export const MCP_PANEL_ROLES = {
  "mcp.read": allReaders,
  "mcp.plan": ["super_admin", "admin", "manager", "sales"],
  "mcp.approve": ["super_admin", "manager"],
} as const satisfies Record<string, readonly AppRole[]>;

export const OUTLET_PANEL_ROLES = {
  "territory.read": allReaders,
  "route.read": allReaders,
  "outlet.read": allReaders,
  "territory.manage": administrators,
  "route.manage": masterDataManagers,
  "outlet.manage": masterDataManagers,
  "outlet.assign": masterDataManagers,
  "outlet.verify": ["super_admin", "admin", "manager"],
} as const satisfies Record<string, readonly AppRole[]>;

export function salesForcePanels(capabilities: readonly string[]) {
  const has = (key: string) => capabilities.includes(key);
  const editing =
    has("route.manage") || has("outlet.manage") || has("outlet.assign");
  return {
    editing,
    routes: has("route.read"),
    outlets: has("outlet.read"),
    assignments:
      editing &&
      has("outlet.assign") &&
      has("route.read") &&
      has("outlet.read"),
    verification: has("outlet.verify"),
  };
}

export const MODULE_ROLES = {
  dashboard: allReaders, // report.read
  "master-data": masterDataManagers, // masterdata.manage
  imports: importActors, // union of masterdata.manage, inventory.adjustment.request, inventory.count.submit
  inventory: allReaders, // inventory.read
  "sales-force": MCP_PANEL_ROLES["mcp.read"], // all roles with MCP read
  orders: orderActors, // union of order.create and order.approve
  "sap-integration": integrationReaders, // integration.read
  workflows: orderApprovers, // order.approve
  admin: administrators, // admin.manage
  analytics: allReaders, // report.read
} as const satisfies Record<WebModuleSlug, readonly AppRole[]>;

export function canAccessWebModule(
  slug: string,
  role: string | null | undefined,
): boolean {
  if (!role || !Object.hasOwn(MODULE_ROLES, slug)) return false;
  return (MODULE_ROLES[slug as WebModuleSlug] as readonly string[]).includes(
    role,
  );
}
