import type { WorkspaceModuleTab, WorkspaceNavGroup } from "@sunpride/ui";

const routeToPrimary = {
  "/dashboard": "home",
  "/master-data": "commercial",
  "/imports": "commercial",
  "/orders": "commercial",
  "/inventory": "inventory",
  "/sales-force": "field",
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
    label: "Field Sales",
    href: "/sales-force",
    icon: "field",
  },
  {
    id: "operations",
    label: "SAP Operations",
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
    { id: "sales-orders", label: "Sales orders", href: "/orders" },
    { id: "master-data", label: "Master data", href: "/master-data" },
    { id: "imports", label: "Imports", href: "/imports" },
  ],
  field: [{ id: "sales-force", label: "Sales force", href: "/sales-force" }],
};

export function getWebNavigation(pathname: string, canAdminister: boolean) {
  const activePrimaryId =
    (routeToPrimary as Record<string, string>)[pathname] ?? "home";
  const navGroups: WorkspaceNavGroup[] = [
    { id: "workspace", label: "Workspace", items: workspaceItems },
  ];

  if (canAdminister) {
    navGroups.push({
      id: "manage",
      label: "Manage",
      items: [
        {
          id: "admin",
          label: "Administration",
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
  const activePrimaryId =
    (routeToPrimary as Record<string, string>)[pathname] ?? "home";
  return moduleTabs[activePrimaryId] ?? [];
}
