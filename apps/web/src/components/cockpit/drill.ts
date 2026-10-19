import type { SalesGroupBy } from "./types";
import { withParams } from "./url";

/**
 * Drill-down state in the URL. `groupBy` and `parent` go to the API; the
 * web-only `crumb` params remember the path (region → territory → agent → store)
 * so breadcrumbs can step back. One crumb = `<groupBy>~<parent>~<label>`:
 * the view that the drill opened, the parent it filtered on, and its label.
 */

export type Crumb = { groupBy: string; parent: string; label: string };

export const GROUP_LABEL: Record<SalesGroupBy, string> = {
  channel: "Channel",
  territory: "Territory",
  agent: "Agent",
  category: "Category",
  sku: "Product",
  store: "Store",
};

export function encodeCrumb(crumb: Crumb): string {
  return `${crumb.groupBy}~${crumb.parent}~${crumb.label}`;
}

export function decodeCrumbs(search: URLSearchParams): Crumb[] {
  return search.getAll("crumb").flatMap((raw) => {
    const [groupBy, parent, ...label] = raw.split("~");
    if (!groupBy || !parent || !label.length) return [];
    return [{ groupBy, parent, label: label.join("~") }];
  });
}

/** Href after clicking a row that drills to `drill` (`parent` = `<groupBy>:<key>`). */
export function drillHref(
  pathname: string,
  search: URLSearchParams,
  row: { label: string; drill: { groupBy: string; parent: string } },
): string {
  const crumbs = [...decodeCrumbs(search), { ...row.drill, label: row.label }];
  return withParams(pathname, search, {
    groupBy: row.drill.groupBy,
    parent: row.drill.parent,
    crumb: crumbs.map(encodeCrumb),
  });
}

/** Breadcrumb links: the root view first, then every drill step; the last one is current. */
export function breadcrumbs(
  pathname: string,
  search: URLSearchParams,
  root: { label: string; groupBy: string },
): Array<{ label: string; href: string; current: boolean }> {
  const crumbs = decodeCrumbs(search);
  const rootHref = withParams(pathname, search, {
    groupBy: root.groupBy,
    parent: null,
    crumb: null,
  });
  return [
    { label: root.label, href: rootHref, current: crumbs.length === 0 },
    ...crumbs.map((crumb, index) => ({
      label: crumb.label,
      href: withParams(pathname, search, {
        groupBy: crumb.groupBy,
        parent: crumb.parent,
        crumb: crumbs.slice(0, index + 1).map(encodeCrumb),
      }),
      current: index === crumbs.length - 1,
    })),
  ];
}
