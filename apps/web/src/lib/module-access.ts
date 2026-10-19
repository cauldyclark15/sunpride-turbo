import type { PageSlug } from "@/config/navigation";

/**
 * UX access map: which pages a role sees in the navigation and may open. It
 * mirrors the v2 capability table in `apps/api/src/core/capabilities.js` (the
 * test compares them). The API authorizes every request itself; hiding a page
 * here is never the security boundary.
 */
export const APP_ROLES = [
  "super_admin",
  "admin",
  "operations",
  "manager",
  "approver",
  "sales",
  "analyst",
  "viewer",
] as const;
export type AppRole = (typeof APP_ROLES)[number];

const allReaders = APP_ROLES;
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
// Union of order.create, order.approve and order.encode.
const orderActors = [
  "super_admin",
  "admin",
  "operations",
  "manager",
  "sales",
  "approver",
] as const satisfies readonly AppRole[];
// CALL-09: order.encode (sales admin) plus visit.record (the credited salesperson).
const outsideCallActors = [
  "super_admin",
  "admin",
  "operations",
  "manager",
  "sales",
] as const satisfies readonly AppRole[];
// Union of order.approve and the van.*.approve capabilities.
const approvers = [
  "super_admin",
  "manager",
  "approver",
] as const satisfies readonly AppRole[];
// issues.triage — the staff who work issues (status, board moves, assignee, edits).
const issueTriagers = [
  "super_admin",
  "admin",
  "operations",
  "manager",
  "approver",
] as const satisfies readonly AppRole[];
// people.read (every holder also has visit.read): supervisors read their team's field day.
const supervisors = [
  "super_admin",
  "admin",
  "manager",
  "analyst",
  "viewer",
] as const satisfies readonly AppRole[];
// SOP-009: visit.record files a DAR/ROAR; people.read reads the team's submissions.
const activityReportReaders = [
  "super_admin",
  "admin",
  "manager",
  "sales",
  "analyst",
  "viewer",
] as const satisfies readonly AppRole[];
// SP-0135 location.read: supervisors see their scope, sales only themselves.
const locationReaders = [
  "super_admin",
  "admin",
  "operations",
  "manager",
  "sales",
  "analyst",
] as const satisfies readonly AppRole[];
const integrationReaders = [
  "super_admin",
  "admin",
  "operations",
] as const satisfies readonly AppRole[];
/**
 * report.read minus field sales: the owner pages. Sales open only Today, which
 * the server scopes to themselves. analyst and viewer read without acting.
 */
const ownerReaders = [
  "super_admin",
  "admin",
  "operations",
  "manager",
  "approver",
  "analyst",
  "viewer",
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

export const ISSUE_PANEL_ROLES = {
  "issues.read": allReaders,
  "issues.write": allReaders,
  "issues.triage": issueTriagers,
  "issues.manage": administrators,
} as const satisfies Record<string, readonly AppRole[]>;

/** Who sets sales targets (target.manage); everyone else reads them. */
export const TARGET_MANAGERS = [
  "super_admin",
  "admin",
  "manager",
] as const satisfies readonly AppRole[];

export const MODULE_ROLES = {
  // Owner cockpit (report.read).
  today: allReaders,
  sales: ownerReaders,
  "coverage-people": ownerReaders,
  stores: ownerReaders,
  stock: ownerReaders,
  vans: ownerReaders,
  money: ownerReaders,
  decide: ownerReaders,
  // Work.
  orders: orderActors, // order.create, order.approve, order.encode
  workflows: approvers, // order.approve + van.*.approve
  "sales-force": MCP_PANEL_ROLES["mcp.read"], // all roles with MCP read
  supervision: supervisors, // people.read + visit.read
  "call-sheets": allReaders, // outlet.read + visit.read; editing needs outlet.manage
  "daily-sales": activityReportReaders, // people.read for the roster, or sales self-only
  "activity-reports": activityReportReaders, // visit.record (file) or people.read (team)
  training: allReaders, // visit.read; each person sees only their own trainer forms
  inventory: allReaders, // inventory.read
  imports: importActors, // masterdata.manage, inventory.adjustment.request, inventory.count.submit
  "outside-calls": outsideCallActors, // order.encode + visit.record
  "van-trips": allReaders, // van.read
  "live-map": locationReaders, // location.read; the server limits sales to themselves
  // Setup.
  admin: administrators, // admin.manage
  "master-data": masterDataManagers, // masterdata.manage
  pricing: masterDataManagers, // masterdata.manage (price lists are master data)
  "sap-integration": integrationReaders, // integration.read
} as const satisfies Record<PageSlug, readonly AppRole[]>;

/** Old slugs that redirect; access follows their destination. */
const ALIASES: Record<string, PageSlug> = {
  dashboard: "today",
  analytics: "sales",
};

export function canAccessWebModule(
  slug: string,
  role: string | null | undefined,
): boolean {
  if (!role) return false;
  // Personal settings are outside the sidebar and require no business capability.
  if (slug === "account")
    return (APP_ROLES as readonly string[]).includes(role);
  // The tracker has its own `/issues` routes rather than a `[module]` slug.
  if (slug === "issues")
    return (ISSUE_PANEL_ROLES["issues.read"] as readonly string[]).includes(
      role,
    );
  const page = Object.hasOwn(ALIASES, slug) ? ALIASES[slug]! : slug;
  if (!Object.hasOwn(MODULE_ROLES, page)) return false;
  return (MODULE_ROLES[page as PageSlug] as readonly string[]).includes(role);
}

/** analyst and viewer read every owner page but never act. */
export function isReadOnlyRole(role: string | null | undefined) {
  return role === "analyst" || role === "viewer";
}
