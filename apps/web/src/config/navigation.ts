import type { WorkspaceModuleTab, WorkspaceNavGroup } from "@sunpride/ui";
import { isModuleHiddenForBeta } from "./beta";

/**
 * v2 navigation (ANALYTICS_V2 §2): the owner's questions in order, then the
 * live map, the workflow pages grouped under Work, Issues, and Setup.
 */

/** Owner cockpit pages, each with its own route under `app/(dashboard)`. */
export const OWNER_PAGES = [
  { id: "today", label: "Today", href: "/today", icon: "home" },
  { id: "sales", label: "Sales & targets", href: "/sales", icon: "reports" },
  {
    id: "coverage-people",
    label: "Coverage & people",
    href: "/coverage-people",
    icon: "field",
  },
  { id: "stores", label: "Stores", href: "/stores", icon: "commercial" },
  { id: "stock", label: "Products & stock", href: "/stock", icon: "inventory" },
  { id: "vans", label: "Vans & cash", href: "/vans", icon: "order" },
  { id: "money", label: "Money", href: "/money", icon: "document" },
  { id: "decide", label: "Decide", href: "/decide", icon: "approvals" },
] as const satisfies WorkspaceNavGroup["items"];

export type OwnerSlug = (typeof OWNER_PAGES)[number]["id"];

/** Workflow pages rendered by `app/(dashboard)/[module]` through ModuleWorkspace. */
export const WORKSPACE_SLUGS = [
  "orders",
  "workflows",
  "sales-force",
  "supervision",
  "call-sheets",
  "daily-sales",
  "activity-reports",
  "training",
  "inventory",
  "imports",
  "outside-calls",
  "modern-trade",
  "van-trips",
  "retail-execution",
  "live-map",
  "admin",
  "master-data",
  "pricing",
  "trade-promotions",
  "finance-claims",
  "sap-integration",
  "programme",
  "distributors",
  "agencies",
] as const;

export type WebModuleSlug = (typeof WORKSPACE_SLUGS)[number];

/** Old routes kept as redirects: `/dashboard` → Today, `/analytics` → Sales. */
export const LEGACY_REDIRECTS = {
  dashboard: "/today",
  analytics: "/sales",
} as const;

export type PageSlug = OwnerSlug | WebModuleSlug;

const OWNER_SLUGS = new Set<string>(OWNER_PAGES.map((page) => page.id));
const WORKSPACES = new Set<string>(WORKSPACE_SLUGS);

/** A `[module]` workspace slug (the dynamic route renders only these). */
export function isWorkspaceSlug(slug: string): slug is WebModuleSlug {
  return WORKSPACES.has(slug);
}

export function isOwnerSlug(slug: string): slug is OwnerSlug {
  return OWNER_SLUGS.has(slug);
}

/** Any real page of the web app, including the two redirecting legacy routes. */
export function isWebModuleSlug(slug: string): boolean {
  return (
    slug === "account" ||
    slug === "distributor" ||
    isWorkspaceSlug(slug) ||
    isOwnerSlug(slug) ||
    Object.hasOwn(LEGACY_REDIRECTS, slug)
  );
}

const moduleTabs: Record<string, WorkspaceModuleTab[]> = {
  work: [
    { id: "orders", label: "Orders", href: "/orders" },
    { id: "distributors", label: "Distributors", href: "/distributors" },
    {
      id: "finance-claims",
      label: "Claims & Finance",
      href: "/finance-claims",
    },
    { id: "modern-trade", label: "Modern trade", href: "/modern-trade" },
    { id: "workflows", label: "Approvals", href: "/workflows" },
    { id: "sales-force", label: "Coverage plans", href: "/sales-force" },
    { id: "supervision", label: "Supervision", href: "/supervision" },
    { id: "call-sheets", label: "Call sheets", href: "/call-sheets" },
    { id: "daily-sales", label: "DSR", href: "/daily-sales" },
    { id: "activity-reports", label: "DAR / ROAR", href: "/activity-reports" },
    { id: "training", label: "Training", href: "/training" },
    { id: "inventory", label: "Inventory", href: "/inventory" },
    { id: "imports", label: "Imports", href: "/imports" },
    { id: "outside-calls", label: "Outside-call POs", href: "/outside-calls" },
    { id: "van-trips", label: "Van trips", href: "/van-trips" },
    {
      id: "retail-execution",
      label: "Retail execution",
      href: "/retail-execution",
    },
    { id: "agencies", label: "Agency work & billing", href: "/agencies" },
  ],
  setup: [
    { id: "admin", label: "Admin", href: "/admin" },
    { id: "master-data", label: "Master data", href: "/master-data" },
    { id: "pricing", label: "Prices", href: "/pricing" },
    {
      id: "trade-promotions",
      label: "Trade Marketing",
      href: "/trade-promotions",
    },
    { id: "sap-integration", label: "Integration", href: "/sap-integration" },
    // v2 spec F-025: Sunpride Phase 1 traceability (admin and owner only).
    { id: "programme", label: "Programme", href: "/programme" },
  ],
};

const tailItems: WorkspaceNavGroup["items"] = [
  { id: "live-map", label: "Live map", href: "/live-map", icon: "mobile" },
  { id: "work", label: "Work", href: "/orders", icon: "board" },
  { id: "issues", label: "Issues", href: "/issues", icon: "issues" },
  { id: "setup", label: "Setup", href: "/admin", icon: "admin" },
];

/** Sidebar item for a pathname; sub-pages keep their parent highlighted. */
export function primaryIdFor(pathname: string): string {
  const segment = pathname.split("/")[1] ?? "";
  if (Object.hasOwn(LEGACY_REDIRECTS, segment))
    return segment === "analytics" ? "sales" : "today";
  if (isOwnerSlug(segment)) return segment;
  if (segment === "live-map") return "live-map";
  if (segment === "issues") return "issues";
  for (const [group, tabs] of Object.entries(moduleTabs))
    if (tabs.some((tab) => tab.href === `/${segment}`)) return group;
  return "today";
}

/** Beta release: drop links to modules hidden by the beta feature list. */
function visible<T extends { href: string }>(items: T[]) {
  return items.filter((item) => !isModuleHiddenForBeta(item.href.slice(1)));
}

/** Slug a nav href opens (`/coverage-people` → `coverage-people`). */
function slugOf(href: string) {
  return href.split("?")[0]!.split("/")[1] ?? "";
}

/**
 * Full navigation for a pathname. `canOpen(slug)` is the role's UX access map;
 * items the role cannot open are dropped and grouped items point at their
 * first openable page.
 */
export function getWebNavigation(
  pathname: string,
  canOpen: (slug: string) => boolean = () => true,
) {
  return {
    activePrimaryId: primaryIdFor(pathname),
    moduleTabs: getWebModuleTabs(pathname).filter((tab) =>
      canOpen(slugOf(tab.href)),
    ),
    navGroups: navigationForRole(
      [
        { id: "owner", items: [...OWNER_PAGES] },
        { id: "more", items: tailItems },
      ],
      canOpen,
    ),
  };
}

/** Drops items a role cannot open and points grouped items at their first open page. */
export function navigationForRole(
  groups: WorkspaceNavGroup[],
  canOpen: (slug: string) => boolean,
): WorkspaceNavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.flatMap((item) => {
        const tabs = moduleTabs[item.id];
        if (tabs) {
          const first = visible(tabs).find((tab) => canOpen(slugOf(tab.href)));
          return first ? [{ ...item, href: first.href }] : [];
        }
        if (isModuleHiddenForBeta(slugOf(item.href))) return [];
        return canOpen(slugOf(item.href)) ? [item] : [];
      }),
    }))
    .filter((group) => group.items.length > 0);
}

/** In-content tabs for grouped pages (Work, Setup); none elsewhere. */
export function getWebModuleTabs(pathname: string) {
  return visible(moduleTabs[primaryIdFor(pathname)] ?? []);
}
