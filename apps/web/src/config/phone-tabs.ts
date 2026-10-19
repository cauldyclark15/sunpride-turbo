import type { WorkspaceNavGroup, WorkspaceNavItem } from "@sunpride/ui";
import { getWebModuleTabs, OWNER_PAGES } from "./navigation";

/**
 * Phone bottom tabs: the 4 pages a role opens most, then "More" with the rest
 * of their sidebar. Each role's wish list is filtered by what the role can
 * actually open (the navigation is already role-filtered); missing wishes
 * are filled from the sidebar order.
 */
const PREFERRED: Record<string, readonly string[]> = {
  super_admin: ["today", "sales", "coverage-people", "decide"],
  admin: ["today", "sales", "coverage-people", "decide"],
  manager: ["today", "sales", "coverage-people", "decide"],
  approver: ["today", "decide", "work", "sales"],
  operations: ["today", "stock", "vans", "work"],
  analyst: ["today", "sales", "coverage-people", "stores"],
  viewer: ["today", "sales", "coverage-people", "stores"],
  sales: ["today", "work", "live-map", "issues"],
};

const DEFAULT_PREFERRED = ["today", "sales", "coverage-people", "decide"];

/** Short labels so five cells fit a 360 px phone. */
const SHORT_LABELS: Record<string, string> = {
  sales: "Sales",
  "coverage-people": "Coverage",
  stock: "Stock",
  vans: "Vans",
  stores: "Stores",
  "live-map": "Map",
};

export const PHONE_TAB_COUNT = 4;

export function phoneTabsFor(
  role: string | null | undefined,
  navGroups: WorkspaceNavGroup[],
): { tabs: WorkspaceNavItem[]; more: WorkspaceNavItem[] } {
  const items = navGroups.flatMap((group) => group.items);
  const byId = new Map(items.map((item) => [item.id, item]));
  const wish = (role && PREFERRED[role]) || DEFAULT_PREFERRED;
  const chosen: string[] = [];
  for (const id of wish)
    if (byId.has(id) && chosen.length < PHONE_TAB_COUNT) chosen.push(id);
  for (const item of items)
    if (chosen.length < PHONE_TAB_COUNT && !chosen.includes(item.id))
      chosen.push(item.id);
  const tabs = chosen.map((id) => {
    const item = byId.get(id)!;
    return { ...item, label: SHORT_LABELS[id] ?? item.label };
  });
  const more = items.filter((item) => !chosen.includes(item.id));
  return { tabs, more };
}

/** Top-bar titles leave room for the Filters button; the page heading keeps the full name. */
const TITLE_LABELS: Record<string, string> = {
  "coverage-people": "Coverage",
  stock: "Stock",
  sales: "Sales",
};

const OTHER_TITLES: Record<string, string> = {
  account: "Account",
  issues: "Issues",
  "live-map": "Live map",
  help: "Help",
};

/** The phone top-bar title for a pathname: the page's own name. */
export function phoneTitleFor(pathname: string): string {
  const segment = pathname.split("/")[1] ?? "";
  const owner = OWNER_PAGES.find((page) => page.id === segment);
  if (owner) return TITLE_LABELS[owner.id] ?? owner.label;
  if (segment === "dashboard") return "Today";
  if (segment === "analytics") return "Sales & targets";
  const tab = getWebModuleTabs(pathname).find(
    (item) => item.href === `/${segment}`,
  );
  if (tab) return tab.label;
  return OTHER_TITLES[segment] ?? "Sunpride";
}
