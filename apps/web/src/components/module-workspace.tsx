"use client";

import {
  Card,
  PageHeader,
  WorkspaceIcon,
  WorkspaceModuleTabs,
} from "@sunpride/ui";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import {
  getWebModuleTabs,
  LEGACY_REDIRECTS,
  type WebModuleSlug,
} from "../config/navigation";
import { useSession } from "../lib/auth/session";
import { canAccessWebModule } from "../lib/module-access";
import { ActivityReportsWorkspace } from "./activity-reports/activity-reports-workspace";
import { AdminWorkspace } from "./admin-workspace";
import {
  TradeMarketingWorkspace,
  FinanceClaimsWorkspace,
} from "./tpm/tpm-workspace";
import { CallSheetsWorkspace } from "./call-sheets/call-sheets-workspace";
import { lazyWorkspace } from "./cockpit/lazy-workspace";
import { SalesForcePanels } from "./coverage-workspace";
import { DailySalesWorkspace } from "./daily-sales/daily-sales-workspace";
import { ImportsWorkspace } from "./imports-workspace";
import { InventoryWorkspace } from "./inventory-workspace";
import { LiveMapWorkspace } from "./live-map/live-map-workspace";
import { OutsideCallOrders } from "./outside-call-orders";
import { PanelErrorBoundary } from "./panel-error-boundary";
import { SupervisionWorkspace } from "./supervision/supervision-workspace";
import { TrainingWorkspace } from "./training/trainer-forms";
import { VanCashApproval } from "./van-cash-approval";
import { VanDamageApprovals } from "./van-damage-approvals";
import { VanStockApproval } from "./van-stock-approval";
import { VanVoidApproval } from "./van-void-approval";

/**
 * The Work and Setup pages (`app/(dashboard)/[module]`). The owner pages have
 * their own routes and live in `components/cockpit`. Workspaces that other v2
 * lanes rebuild are mounted by export name through `lazyWorkspace`.
 */

// MOUNT: MasterDataWorkspace from "@/components/master-data" → /master-data
const MasterDataWorkspace = lazyWorkspace("MasterDataWorkspace");
// MOUNT: OrdersWorkspace from "@/components/orders" → /orders, and with view="approvals" on /workflows
const OrdersWorkspace = lazyWorkspace("OrdersWorkspace");
// MOUNT: PricingWorkspace from "@/components/pricing" → /pricing
const PricingWorkspace = lazyWorkspace("PricingWorkspace");
// MOUNT: VanTripsWorkspace from "@/components/van" → /van-trips (reads ?trip=<tripId>)
const VanTripsWorkspace = lazyWorkspace("VanTripsWorkspace");

const TITLES = {
  orders: "Orders",
  workflows: "Approvals",
  "sales-force": "Coverage plans",
  supervision: "Supervision",
  "call-sheets": "Call sheets",
  "daily-sales": "Daily sales report",
  "activity-reports": "DAR / ROAR",
  training: "Training",
  inventory: "Inventory",
  imports: "Imports",
  "outside-calls": "Outside-call POs",
  "van-trips": "Van trips",
  "live-map": "Live map",
  admin: "Administration",
  "master-data": "Master data",
  pricing: "Prices",
  "trade-promotions": "Trade Marketing",
  "finance-claims": "Claims & Finance",
  "sap-integration": "Integration",
} satisfies Record<WebModuleSlug, string>;

export function moduleTitle(module: WebModuleSlug) {
  return TITLES[module];
}

function MovedNotice({ to }: { to: string }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-8">
      <h1 className="text-xl font-semibold text-foreground">This page moved</h1>
      <p className="mt-2 text-sm text-muted">
        Open{" "}
        <Link href={to} className="font-medium text-foreground underline">
          {to === "/today" ? "Today" : "Sales & targets"}
        </Link>
        .
      </p>
    </section>
  );
}

/** Access-denied card shared by workspace and cockpit routes. */
export function AccessDenied() {
  return (
    <section className="rounded-lg border border-border bg-surface p-8">
      <h1 className="text-xl font-semibold text-foreground">Access denied</h1>
      <p className="mt-2 text-sm text-muted">
        Your role cannot open this page. Ask an administrator for access.
      </p>
    </section>
  );
}

/**
 * Mounts nothing module-specific until the signed-in profile is known and its
 * role may open the page (UX only; the API authorizes every call).
 */
export function ModuleWorkspace({
  module,
}: {
  module: WebModuleSlug | keyof typeof LEGACY_REDIRECTS;
}) {
  const { profile } = useSession();
  if (module === "dashboard" || module === "analytics")
    return <MovedNotice to={LEGACY_REDIRECTS[module]} />;
  if (!profile)
    return <div className="text-[13px] text-muted">Checking access…</div>;
  if (!profile.active || !canAccessWebModule(module, profile.role))
    return <AccessDenied />;
  return <AllowedModuleWorkspace module={module} role={profile.role} />;
}

function AllowedModuleWorkspace({
  module,
  role,
}: {
  module: WebModuleSlug;
  role: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // A tab the role cannot open would only lead to "Access denied".
  const tabs = getWebModuleTabs(pathname).filter((tab) =>
    canAccessWebModule(tab.href.slice(1), role),
  );
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      {/* Inventory and the rebuilt Orders workspace draw their own header. */}
      {module === "inventory" || module === "orders" ? null : (
        <PageHeader title={TITLES[module]} />
      )}
      {tabs.length > 1 ? (
        <WorkspaceModuleTabs
          activeHref={pathname}
          items={tabs}
          onNavigate={(href) => router.push(href)}
        />
      ) : null}
      <ModuleContent module={module} />
    </div>
  );
}

function VanTripRoute() {
  const query = useSearchParams();
  return (
    <VanTripsWorkspace
      initialDate={query.get("date") ?? undefined}
      initialTripId={query.get("tripId")}
    />
  );
}

function ModuleContent({ module }: { module: WebModuleSlug }): ReactNode {
  switch (module) {
    case "orders":
      return <OrdersWorkspace />;
    case "workflows":
      return (
        <>
          <PanelErrorBoundary label="Orders waiting for approval">
            <OrdersWorkspace view="approvals" />
          </PanelErrorBoundary>
          <PanelErrorBoundary label="Truck damage">
            <VanDamageApprovals />
          </PanelErrorBoundary>
          <VanVoidApproval />
          <VanCashApproval />
          <VanStockApproval />
        </>
      );
    case "master-data":
      return <MasterDataWorkspace />;
    case "trade-promotions":
      return <TradeMarketingWorkspace />;
    case "finance-claims":
      return <FinanceClaimsWorkspace />;
    case "pricing":
      return <PricingWorkspace />;
    case "van-trips":
      return <VanTripRoute />;
    case "inventory":
      return <InventoryWorkspace setupMessage="" />;
    case "imports":
      return <ImportsWorkspace setupMessage="" />;
    case "admin":
      return <AdminWorkspace />;
    case "sales-force":
      return <SalesForcePanels />;
    case "supervision":
      return <SupervisionWorkspace />;
    case "call-sheets":
      return <CallSheetsWorkspace />;
    case "daily-sales":
      return <DailySalesWorkspace />;
    case "training":
      return <TrainingWorkspace />;
    case "activity-reports":
      return <ActivityReportsWorkspace />;
    case "live-map":
      return (
        <PanelErrorBoundary label="Live map">
          <LiveMapWorkspace />
        </PanelErrorBoundary>
      );
    case "outside-calls":
      return <OutsideCallOrders />;
    case "sap-integration":
      return (
        <Card label="Integration" icon={<WorkspaceIcon name="operations" />}>
          <p className="text-[13px] text-muted">Not connected yet</p>
        </Card>
      );
  }
}
