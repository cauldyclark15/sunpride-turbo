import type { WorkspaceModuleTab, WorkspaceNavGroup } from "@sunpride/ui";

const routeToPrimary: Record<string, string> = {
  "/dashboard": "home",
  "/master-data": "commercial",
  "/imports": "commercial",
  "/orders": "commercial",
  "/inventory": "inventory",
  "/sales-force": "field",
  "/mobile": "field",
  "/sap-integration": "operations",
  "/workflows": "approvals",
  "/analytics": "reports",
  "/admin": "admin",
};

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
  field: [
    { id: "sales-force", label: "Sales force", href: "/sales-force" },
    { id: "mobile-pwa", label: "Mobile / PWA", href: "/mobile" },
  ],
};

export function getWebNavigation(pathname: string, canAdminister: boolean) {
  const activePrimaryId = routeToPrimary[pathname] ?? "home";
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
  const activePrimaryId = routeToPrimary[pathname] ?? "home";
  return moduleTabs[activePrimaryId] ?? [];
}
