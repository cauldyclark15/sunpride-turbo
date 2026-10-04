import type { WorkspaceModuleTab, WorkspaceNavGroup } from "@sunpride/ui";

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
      items: canSeeIssues
        ? [
            ...workspaceItems,
            { id: "issues", label: "Issues", href: "/issues", icon: "issues" },
          ]
        : workspaceItems,
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
    moduleTabs: moduleTabs[activePrimaryId] ?? [],
    navGroups,
  };
}

export function getWebModuleTabs(pathname: string) {
  return moduleTabs[primaryIdFor(pathname)] ?? [];
}
