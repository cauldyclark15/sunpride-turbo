import type { WorkspaceModuleTab, WorkspaceNavGroup } from "@sunpride/ui";
import { isModuleHiddenForBeta } from "./beta";

const routeToPrimary = {
  "/dashboard": "home",
  "/master-data": "commercial",
  "/imports": "commercial",
  "/orders": "commercial",
  "/outside-calls": "commercial",
  "/inventory": "inventory",
  "/sales-force": "field",
  "/supervision": "field",
  "/call-sheets": "field",
  "/daily-sales": "field",
  "/training": "field",
  "/activity-reports": "field",
  "/sap-integration": "operations",
  "/workflows": "approvals",
  "/analytics": "reports",
  "/admin": "admin",
};

export type WebModuleSlug = keyof typeof routeToPrimary extends infer Path
  ? Path extends `/${infer Slug}`
    ? Slug
    : never
  : never;

export function isWebModuleSlug(slug: string): slug is WebModuleSlug {
  return Object.hasOwn(routeToPrimary, `/${slug}`);
}

const workspaceItems: WorkspaceNavGroup["items"] = [
  { id: "home", label: "Home", href: "/dashboard", icon: "home" },
  {
    id: "commercial",
    label: "Commercial",
    href: "/orders",
    icon: "commercial",
  },
  {
    id: "inventory",
    label: "Inventory",
    href: "/inventory",
    icon: "inventory",
  },
  {
    id: "field",
    label: "Field",
    href: "/sales-force",
    icon: "field",
  },
  {
    id: "operations",
    label: "Integration",
    href: "/sap-integration",
    icon: "operations",
  },
  {
    id: "approvals",
    label: "Approvals",
    href: "/workflows",
    icon: "approvals",
  },
  {
    id: "reports",
    label: "Reports",
    href: "/analytics",
    icon: "reports",
  },
];

const moduleTabs: Partial<Record<string, WorkspaceModuleTab[]>> = {
  commercial: [
    { id: "sales-orders", label: "Orders", href: "/orders" },
    { id: "outside-calls", label: "Outside-call POs", href: "/outside-calls" },
    { id: "master-data", label: "Master data", href: "/master-data" },
    { id: "imports", label: "Imports", href: "/imports" },
  ],
  field: [
    { id: "sales-force", label: "Coverage", href: "/sales-force" },
    { id: "supervision", label: "Supervision", href: "/supervision" },
    { id: "call-sheets", label: "Call sheets", href: "/call-sheets" },
    { id: "daily-sales", label: "Daily sales report", href: "/daily-sales" },
    { id: "training", label: "Training", href: "/training" },
    {
      id: "activity-reports",
      label: "DAR / ROAR",
      href: "/activity-reports",
    },
  ],
};

/**
 * The issue tracker has its own routes (`/issues`, `/issues/new`, `/issues/12`), not a
 * `[module]` workspace slug; every page under it keeps the Issues item highlighted.
 */
function primaryIdFor(pathname: string) {
  const exact = (routeToPrimary as Record<string, string>)[pathname];
  if (exact) return exact;
  if (pathname === "/issues" || pathname.startsWith("/issues/"))
    return "issues";
  return "home";
}

/** Beta release: drop links to modules hidden by the beta feature list. */
function visible<T extends { href: string }>(items: T[]) {
  return items.filter((item) => !isModuleHiddenForBeta(item.href.slice(1)));
}

export function getWebNavigation(
  pathname: string,
  canAdminister: boolean,
  canSeeIssues = false,
) {
  const activePrimaryId = primaryIdFor(pathname);
  const navGroups: WorkspaceNavGroup[] = [
    {
      id: "workspace",
      label: "Workspace",
      items: [
        ...visible(workspaceItems),
        ...(canSeeIssues
          ? [
              {
                id: "issues",
                label: "Issues",
                href: "/issues",
                icon: "issues" as const,
              },
            ]
          : []),
      ],
    },
  ];

  if (canAdminister) {
    navGroups.push({
      id: "manage",
      label: "Manage",
      items: [
        {
          id: "admin",
          label: "Admin",
          href: "/admin",
          icon: "admin",
        },
      ],
    });
  }

  return {
    activePrimaryId,
    moduleTabs: visible(moduleTabs[activePrimaryId] ?? []),
    navGroups,
  };
}

/**
 * Beta release: drop sidebar items a role cannot open (they only led to "Access denied")
 * and point each item at the first of its pages the role can open.
 */
export function navigationForRole(
  groups: WorkspaceNavGroup[],
  canOpen: (slug: string) => boolean,
): WorkspaceNavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.flatMap((item) => {
        const slug = item.href.slice(1);
        if (!isWebModuleSlug(slug)) return [item];
        const pages = [
          item.href,
          ...visible(moduleTabs[item.id] ?? []).map((tab) => tab.href),
        ];
        const first = pages.find((href) => canOpen(href.slice(1)));
        return first ? [{ ...item, href: first }] : [];
      }),
    }))
    .filter((group) => group.items.length > 0);
}

export function getWebModuleTabs(pathname: string) {
  return visible(moduleTabs[primaryIdFor(pathname)] ?? []);
}
