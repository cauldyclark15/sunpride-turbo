import type {
  WorkspaceModuleTab,
  WorkspaceNavGroup,
  WorkspaceNavItem,
} from "@sunpride/ui";
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

/**
 * Operations (IP-NAV): the verbs of the stock and till day, in the order people do them. One tab per verb; each verb has its
 * own screens (`subs`). `access` is the page key the role map and the capability mirror test use. Old routes that still hold
 * functions the new screens do not (`/inventory`, `/van-trips`, `/workflows`) stay as their own pages and are listed under the
 * verb they belong to, so nothing is unreachable.
 */
export const OPERATIONS_SECTIONS = [
  {
    id: "stock",
    label: "Stock",
    href: "/operations/stock",
    access: "ops-stock",
    subs: [
      { id: "on-hand", label: "Stock on hand", href: "/operations/stock" },
      { id: "card", label: "Stock card", href: "/operations/stock/card" },
      {
        id: "bad-orders",
        label: "Bad orders",
        href: "/operations/stock/bad-orders",
      },
      { id: "expiry", label: "Expiry", href: "/operations/stock/expiry" },
      { id: "tools", label: "All inventory tools", href: "/inventory" },
      // IP-INT3FIX: roles without the Van day verb (sales, analyst, viewer) read trips from here; see `visibleOperationsSubs`.
      { id: "van-trips", label: "Van trips", href: "/van-trips" },
    ],
  },
  {
    id: "receive",
    label: "Receive",
    href: "/operations/receive",
    access: "ops-receive",
    subs: [
      { id: "queue", label: "To receive", href: "/operations/receive" },
      {
        id: "delivery",
        label: "Add delivery",
        href: "/operations/receive/delivery",
      },
    ],
  },
  {
    id: "transfers",
    label: "Transfers",
    href: "/operations/transfers",
    access: "ops-transfers",
    subs: [{ id: "list", label: "All transfers", href: "/operations/transfers" }],
  },
  {
    id: "counts",
    label: "Counts",
    href: "/operations/counts",
    access: "ops-counts",
    subs: [
      { id: "mine", label: "My counts", href: "/operations/counts" },
      { id: "plan", label: "Add count", href: "/operations/counts/plan" },
      { id: "review", label: "Review", href: "/operations/counts/review" },
    ],
  },
  {
    id: "van-day",
    label: "Van day",
    href: "/operations/van-day",
    access: "ops-van-day",
    subs: [
      { id: "board", label: "Board", href: "/operations/van-day" },
      { id: "roster", label: "Roster", href: "/operations/van-day/roster" },
      {
        id: "loads",
        label: "Suggested loads",
        href: "/operations/van-day/loads",
      },
      { id: "trips", label: "Trips", href: "/van-trips" },
    ],
  },
  {
    id: "stores-pos",
    label: "Stores POS",
    href: "/operations/stores-pos",
    access: "ops-stores-pos",
    subs: [
      {
        id: "days",
        label: "Registers & till days",
        href: "/operations/stores-pos",
      },
      { id: "z", label: "X / Z readings", href: "/operations/stores-pos/z" },
      {
        id: "overrides",
        label: "Overrides",
        href: "/operations/stores-pos/overrides",
      },
      {
        id: "receipts",
        label: "Receipts",
        href: "/operations/stores-pos/receipts",
      },
      { id: "tax", label: "Tax summary", href: "/operations/stores-pos/tax" },
      {
        id: "rules",
        label: "Discount & Z rules",
        href: "/operations/stores-pos/rules",
      },
    ],
  },
  {
    id: "decide",
    label: "Decide",
    href: "/operations/decide",
    access: "ops-decide",
    subs: [
      { id: "inbox", label: "Inbox", href: "/operations/decide" },
      {
        id: "orders",
        label: "Orders & truck approvals",
        href: "/workflows",
      },
    ],
  },
] as const;

export type OperationsSlug = (typeof OPERATIONS_SECTIONS)[number]["access"];
export type OperationsSection = (typeof OPERATIONS_SECTIONS)[number];

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

export type PageSlug = OwnerSlug | WebModuleSlug | OperationsSlug;

/** Pages that belong to Operations: the new routes and the older pages that moved under a verb. */
const OPERATIONS_SEGMENTS = new Set(["operations", "inventory", "van-trips", "workflows"]);
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
    slug === "messages" ||
    slug === "operations" ||
    isWorkspaceSlug(slug) ||
    isOwnerSlug(slug) ||
    Object.hasOwn(LEGACY_REDIRECTS, slug)
  );
}

const moduleTabs: Record<string, WorkspaceModuleTab[]> = {
  operations: OPERATIONS_SECTIONS.map(({ id, label, href }) => ({
    id,
    label,
    href,
  })),
  work: [
    { id: "orders", label: "Orders", href: "/orders" },
    { id: "distributors", label: "Distributors", href: "/distributors" },
    {
      id: "finance-claims",
      label: "Claims & Finance",
      href: "/finance-claims",
    },
    { id: "modern-trade", label: "Modern trade", href: "/modern-trade" },
    { id: "sales-force", label: "Coverage plans", href: "/sales-force" },
    { id: "supervision", label: "Supervision", href: "/supervision" },
    { id: "call-sheets", label: "Call sheets", href: "/call-sheets" },
    { id: "daily-sales", label: "DSR", href: "/daily-sales" },
    { id: "activity-reports", label: "DAR / ROAR", href: "/activity-reports" },
    { id: "training", label: "Training", href: "/training" },
    { id: "imports", label: "Imports", href: "/imports" },
    { id: "outside-calls", label: "Outside-call POs", href: "/outside-calls" },
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
  {
    id: "operations",
    label: "Operations",
    href: "/operations/stock",
    icon: "inventory",
  },
  { id: "live-map", label: "Live map", href: "/live-map", icon: "mobile" },
  { id: "work", label: "Work", href: "/orders", icon: "board" },
  { id: "messages", label: "Messages", href: "/messages", icon: "comment" },
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
  if (OPERATIONS_SEGMENTS.has(segment)) return "operations";
  if (segment === "issues") return "issues";
  if (segment === "messages") return "messages";
  for (const [group, tabs] of Object.entries(moduleTabs))
    if (tabs.some((tab) => tab.href === `/${segment}`)) return group;
  return "today";
}

/** Beta release: drop links to modules hidden by the beta feature list. */
function visible<T extends { href: string }>(items: T[]) {
  return items.filter((item) => !isModuleHiddenForBeta(item.href.slice(1)));
}

/**
 * Page key a nav href opens (`/coverage-people` → `coverage-people`). Operations screens are gated per verb:
 * `/operations/counts/plan` → `ops-counts`.
 */
export function slugOf(href: string) {
  const [, first = "", second = ""] = href.split("?")[0]!.split("/");
  return first === "operations" ? `ops-${second || "stock"}` : first;
}

/**
 * Full navigation for a pathname. `canOpen(slug)` is the role's UX access map;
 * items the role cannot open are dropped and grouped items point at their
 * first openable page.
 */
export function getWebNavigation(
  pathname: string,
  canOpen: (slug: string) => boolean = () => true,
  badges: Partial<Record<string, WorkspaceNavItem["badge"]>> = {},
) {
  const navGroups = navigationForRole(
    [
      { id: "owner", items: [...OWNER_PAGES] },
      { id: "more", items: tailItems },
    ],
    canOpen,
  ).map((group) => ({
    ...group,
    items: group.items.map((item) =>
      badges[item.id] ? { ...item, badge: badges[item.id] } : item,
    ),
  }));
  return {
    activePrimaryId: primaryIdFor(pathname),
    moduleTabs: getWebModuleTabs(pathname).filter((tab) =>
      canOpen(slugOf(tab.href)),
    ),
    navGroups,
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

/** The old pages that moved under a verb of Operations (they keep working at their own address). */
const MOVED_UNDER: Record<string, OperationsSection["id"]> = {
  inventory: "stock",
  "van-trips": "van-day",
  workflows: "decide",
};

/**
 * The screens of a verb this role sees: each must be openable for the role. The stock verb's own `van-trips` link exists only
 * for roles that do not have the Van day verb (everyone else already has Trips under it), so nobody sees it twice.
 */
export function visibleOperationsSubs(
  section: OperationsSection,
  canOpen: (slug: string) => boolean,
) {
  return section.subs.filter(
    (sub) =>
      canOpen(slugOf(sub.href)) &&
      !(
        section.id === "stock" &&
        sub.id === "van-trips" &&
        canOpen("ops-van-day")
      ),
  );
}

/** The Operations verb a pathname belongs to, or null outside Operations. */
export function operationsSectionFor(pathname: string): OperationsSection | null {
  const [, first = "", second = ""] = pathname.split("?")[0]!.split("/");
  const id = first === "operations" ? second || "stock" : MOVED_UNDER[first];
  return OPERATIONS_SECTIONS.find((section) => section.id === id) ?? null;
}

/** The sub-tab (second row) a pathname lights up inside its verb. */
export function operationsSubFor(pathname: string) {
  const section = operationsSectionFor(pathname);
  if (!section) return null;
  const path = pathname.split("?")[0]!.replace(/\/+$/, "");
  const exact = section.subs.find((sub) => sub.href === path);
  if (exact) return exact;
  // Detail pages (/operations/transfers/<id>) keep their list lit.
  const parents = section.subs
    .filter((sub) => path.startsWith(`${sub.href}/`))
    .sort((a, b) => b.href.length - a.href.length);
  return parents[0] ?? section.subs[0] ?? null;
}

/** The href of the top tab to light for a pathname (top tabs match by verb, not by exact address). */
export function activeTabHref(pathname: string) {
  return operationsSectionFor(pathname)?.href ?? pathname;
}
