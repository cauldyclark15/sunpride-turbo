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

export const MODULE_ROLES = {
  dashboard: allReaders, // report.read
  "master-data": masterDataManagers, // masterdata.manage
  imports: masterDataManagers, // masterdata.manage; server enforces national scope
  inventory: allReaders, // inventory.read
  "sales-force": allReaders, // visit.read
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
