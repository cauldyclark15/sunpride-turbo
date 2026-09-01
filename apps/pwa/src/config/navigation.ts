import type {
  WorkspaceModuleTab,
  WorkspaceNavGroup,
  WorkspaceNavItem,
} from "@sunpride/ui";

const primaryItems: WorkspaceNavGroup["items"] = [
  { id: "home", label: "Home", href: "/", icon: "home" },
  { id: "orders", label: "Orders", href: "/orders/new", icon: "order" },
  {
    id: "inventory",
    label: "Truck stock",
    href: "/inventory",
    icon: "inventory",
  },
  { id: "catalog", label: "Catalog", href: "/catalog", icon: "catalog" },
  { id: "sync", label: "Sync", href: "/sync", icon: "sync" },
];

export const fieldOrderTabs: WorkspaceModuleTab[] = [
  { id: "new-order", label: "New order", href: "/orders/new" },
  { id: "order-queue", label: "Device queue", href: "/orders/queue" },
];

export const fieldMobileItems: WorkspaceNavItem[] = [
  { id: "mobile-home", label: "Home", href: "/", icon: "home" },
  {
    id: "mobile-new-order",
    label: "New order",
    href: "/orders/new",
    icon: "order",
  },
  { id: "mobile-queue", label: "Queue", href: "/orders/queue", icon: "queue" },
];

export function getFieldNavigation(pathname: string) {
  const activePrimaryId = pathname.startsWith("/orders")
    ? "orders"
    : pathname.startsWith("/inventory")
      ? "inventory"
      : pathname.startsWith("/catalog")
        ? "catalog"
        : pathname.startsWith("/sync")
          ? "sync"
          : "home";

  return {
    activePrimaryId,
    moduleTabs: activePrimaryId === "orders" ? fieldOrderTabs : [],
    navGroups: [
      {
        id: "field-workspace",
        label: "Field workspace",
        items: primaryItems,
      },
    ] satisfies WorkspaceNavGroup[],
  };
}
