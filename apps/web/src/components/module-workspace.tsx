"use client";

import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import {
  Card,
  DataTable,
  MetricCard,
  PageHeader,
  StatusPill,
  UnderlineTabs,
  WorkspaceModuleTabs,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import { usePathname, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { Id } from "@sunpride/backend/data-model";
import { useEffect, useRef, useState } from "react";
import { getWebModuleTabs, type WebModuleSlug } from "../config/navigation";
import { canAccessWebModule, salesForcePanels } from "../lib/module-access";
import { AdminWorkspace } from "./admin-workspace";
import { RouteAdmin } from "./route-admin";
import { OutletAdmin } from "./outlet-admin";
import { OutletAssignments } from "./outlet-assignments";
import { ImportsWorkspace } from "./imports-workspace";
import { InventoryWorkspace } from "./inventory-workspace";
import { CoveragePlanner } from "./coverage-planner";
import { CoverageReview } from "./coverage-review";
import { PanelErrorBoundary } from "./panel-error-boundary";

const CoverageCalendarView = dynamic(() =>
  import("./coverage-calendar-view").then((m) => m.CoverageCalendarView),
);
const CoverageRouteView = dynamic(() =>
  import("./coverage-route-view").then((m) => m.CoverageRouteView),
);
const CoverageMapView = dynamic(
  () => import("./coverage-map-view").then((m) => m.CoverageMapView),
  { ssr: false },
);
const CoverageWorkloadView = dynamic(() =>
  import("./coverage-workload-view").then((m) => m.CoverageWorkloadView),
);
const CoverageExceptions = dynamic(() =>
  import("./coverage-exceptions").then((m) => m.CoverageExceptions),
);
const CoverageExport = dynamic(() =>
  import("./coverage-export").then((m) => m.CoverageExport),
);

const modules = {
  dashboard: { title: "Dashboard" },
  "master-data": { title: "Master data" },
  imports: { title: "Imports" },
  inventory: { title: "Inventory" },
  "sales-force": { title: "Coverage" },
  orders: { title: "Orders" },
  "sap-integration": { title: "Integration" },
  workflows: { title: "Workflows" },
  admin: { title: "Administration" },
  analytics: { title: "Analytics" },
} satisfies Record<WebModuleSlug, { title: string }>;

type ModuleKey = WebModuleSlug;
const money = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 0,
});

export function ModuleWorkspace({ module }: { module: WebModuleSlug }) {
  const profile = useQuery(api.domains.profiles.current, {});

  // Do not mount ModuleContent (or its module-specific queries/mutations) until
  // the active profile is known and allowed for this route.
  if (!profile) {
    return <p className="text-sm text-muted">Checking access…</p>;
  }
  if (
    profile.status !== "active" ||
    !canAccessWebModule(module, profile.role)
  ) {
    return (
      <section className="rounded-lg border border-border bg-surface p-8">
        <h1 className="text-xl font-semibold text-foreground">Access denied</h1>
        <p className="mt-2 text-sm text-muted">
          Ask an administrator for access.
        </p>
      </section>
    );
  }
  return <AllowedModuleWorkspace module={module} />;
}

function AllowedModuleWorkspace({ module }: { module: WebModuleSlug }) {
  const config = modules[module];
  const ensureProfile = useMutation(api.domains.profiles.ensure);
  const initialized = useRef(false);
  const [setupMessage, setSetupMessage] = useState("Connecting…");
  const pathname = usePathname();
  const router = useRouter();
  const tabs = getWebModuleTabs(pathname);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void ensureProfile()
      .then(() => setSetupMessage(""))
      .catch(() => setSetupMessage(""));
  }, [ensureProfile]);

  return (
    <div className="grid gap-4">
      {!["inventory", "orders", "workflows"].includes(module) ? (
        <PageHeader title={config.title} />
      ) : null}
      <WorkspaceModuleTabs
        activeHref={pathname}
        items={tabs}
        onNavigate={(href) => router.push(href)}
      />
      <ModuleContent module={module} setupMessage={setupMessage} />
    </div>
  );
}

type CoverageTab =
  | "plan"
  | "review"
  | "visits"
  | "history"
  | "calendar"
  | "route"
  | "map"
  | "workload"
  | "exceptions"
  | "export";
type SelectedPlan = {
  id: Id<"coveragePlans">;
  assigneeId: Id<"profiles">;
  assigneeName: string;
};

function ScopedPlanPicker({
  month,
  selected,
  onSelect,
}: {
  month: string;
  selected: SelectedPlan | null;
  onSelect: (plan: SelectedPlan | null) => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const result = useQuery(api.coverage.discovery.list, {
    localMonth: month,
    paginationOpts: { numItems: 20, cursor },
  });
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="grid min-w-56 flex-1 gap-1.5 text-[13px] font-medium">
        Plan
        <select
          aria-label="Scoped coverage plan"
          className="h-10 w-full rounded-[10px] border border-border bg-surface px-3 text-sm text-foreground"
          value={selected?.id ?? ""}
          onChange={(event) => {
            const plan = result?.page.find(
              (row) => row.planId === event.target.value,
            );
            onSelect(
              plan
                ? {
                    id: plan.planId,
                    assigneeId: plan.assigneeProfileId,
                    assigneeName: plan.assigneeName,
                  }
                : null,
            );
          }}
        >
          <option value="">Select a plan</option>
          {selected &&
            !result?.page.some((row) => row.planId === selected.id) && (
              <option value={selected.id}>
                {selected.assigneeName} · selected version
              </option>
            )}
          {result?.page.map((row) => (
            <option key={row.planId} value={row.planId}>
              {row.assigneeName} · v{row.version} · {row.status}
            </option>
          ))}
        </select>
      </label>
      <Button
        variant="outline"
        className="h-10"
        isDisabled={cursor === null}
        onPress={() => setCursor(null)}
      >
        First page
      </Button>
      <Button
        variant="outline"
        className="h-10"
        isDisabled={!result || result.isDone}
        onPress={() => setCursor(result!.continueCursor)}
      >
        Next page
      </Button>
      {result === undefined && (
        <span className="text-[13px] text-muted">Loading plans…</span>
      )}
      {result && !result.page.length && (
        <span className="text-[13px] text-muted">No plans here</span>
      )}
    </div>
  );
}

export function SalesForcePanels() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const profile = useQuery(api.domains.profiles.current, {});
  const [coverageTab, setCoverageTab] = useState<CoverageTab>("plan");
  const [month, setMonth] = useState(() => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
    }).formatToParts(new Date());
    return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
  });
  const [selected, setSelected] = useState<SelectedPlan | null>(null);
  if (!permissions || !profile) return <p>Loading sales force permissions…</p>;
  const panels = salesForcePanels(permissions.capabilities);
  const canRead = permissions.capabilities.includes("mcp.read");
  const canApprove = permissions.capabilities.includes("mcp.approve");
  const coverageTabs: [CoverageTab, string][] = [
    ["plan", "Plan"],
    ...(canApprove ? ([["review", "Review"]] as [CoverageTab, string][]) : []),
    ["exceptions", "Exceptions"],
    ["visits", "Visits"],
    ["history", "History"],
    ["calendar", "Calendar"],
    ["route", "Routes"],
    ["map", "Map"],
    ["workload", "Workload"],
    ["export", "Export"],
  ];
  return (
    <div className="grid gap-4">
      {canRead && (
        <>
          <Card label="Plans" icon={<WorkspaceIcon name="field" />}>
            <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-end">
              <label className="grid gap-1.5 text-[13px] font-medium">
                Month
                <input
                  type="month"
                  aria-label="Coverage month"
                  className="h-10 w-full rounded-[10px] border border-border bg-surface px-3 text-sm text-foreground"
                  value={month}
                  onChange={(event) => {
                    setMonth(event.target.value);
                    setSelected(null);
                  }}
                />
              </label>
              <PanelErrorBoundary key={month} label="Scoped plan picker">
                <ScopedPlanPicker
                  key={month}
                  month={month}
                  selected={selected}
                  onSelect={setSelected}
                />
              </PanelErrorBoundary>
            </div>
          </Card>
          <UnderlineTabs
            items={coverageTabs}
            activeId={coverageTab}
            onChange={setCoverageTab}
            label="Coverage views"
          />
          <div role="tabpanel">
            {coverageTab === "plan" ? (
              <PanelErrorBoundary key="plan" label="Coverage plan">
                <CoveragePlanner />
              </PanelErrorBoundary>
            ) : coverageTab === "review" ||
              coverageTab === "visits" ||
              coverageTab === "history" ? (
              <>
                {coverageTab === "review" && selected && (
                  <PanelErrorBoundary
                    key={`preflight-${selected.id}`}
                    label="Review preflight"
                  >
                    <CoverageExceptions planId={selected.id} />
                  </PanelErrorBoundary>
                )}
                {selected ? (
                  <PanelErrorBoundary
                    key={`${coverageTab}-${selected.id}`}
                    label={`Coverage ${coverageTab}`}
                  >
                    <CoverageReview
                      mode={coverageTab}
                      permissions={permissions}
                      profile={profile}
                      scopedSelection={{
                        planId: selected.id,
                        assigneeProfileId: selected.assigneeId,
                        localMonth: month,
                      }}
                    />
                  </PanelErrorBoundary>
                ) : (
                  <p>Select a scoped plan to open this view.</p>
                )}
              </>
            ) : coverageTab === "workload" ? (
              <PanelErrorBoundary
                key={`${coverageTab}-${month}`}
                label="Coverage workload"
              >
                <CoverageWorkloadView
                  localMonth={month}
                  planId={selected?.id}
                />
              </PanelErrorBoundary>
            ) : selected ? (
              <PanelErrorBoundary
                key={`${coverageTab}-${selected.id}`}
                label={`Coverage ${coverageTab}`}
              >
                {coverageTab === "calendar" ? (
                  <CoverageCalendarView
                    planId={selected.id}
                    assigneeName={selected.assigneeName}
                  />
                ) : coverageTab === "route" ? (
                  <CoverageRouteView planId={selected.id} />
                ) : coverageTab === "map" ? (
                  <CoverageMapView planId={selected.id} />
                ) : coverageTab === "exceptions" ? (
                  <CoverageExceptions planId={selected.id} />
                ) : (
                  <CoverageExport planId={selected.id} />
                )}
              </PanelErrorBoundary>
            ) : (
              <p>Select a scoped plan to open this view.</p>
            )}
          </div>
        </>
      )}
      {panels.routes && (
        <PanelErrorBoundary label="Territory and route editor">
          <RouteAdmin />
        </PanelErrorBoundary>
      )}
      {panels.outlets && (
        <PanelErrorBoundary label="Outlet editor">
          <OutletAdmin />
        </PanelErrorBoundary>
      )}
      {panels.assignments && (
        <PanelErrorBoundary label="Assignment editor">
          <OutletAssignments />
        </PanelErrorBoundary>
      )}
      {panels.verification && !panels.editing && (
        <p>Verification: select an outlet above to review pending pins.</p>
      )}
    </div>
  );
}

function ModuleContent({
  module,
  setupMessage,
}: {
  module: ModuleKey;
  setupMessage: string;
}) {
  const metrics = useQuery(
    api.domains.dashboard.summary,
    module === "dashboard" || module === "analytics" ? {} : "skip",
  );
  const needsCommercialData = module === "master-data" || module === "orders";
  const products = useQuery(
    api.domains.masterData.products,
    needsCommercialData ? { limit: 50 } : "skip",
  );
  const customers = useQuery(
    api.domains.masterData.customers,
    needsCommercialData ? { limit: 50 } : "skip",
  );
  const orders = useQuery(
    api.domains.orders.list,
    module === "orders" || module === "workflows" ? {} : "skip",
  );
  const workflows = useQuery(
    api.domains.workflows.pending,
    module === "workflows" ? {} : "skip",
  );
  const createOrder = useMutation(api.domains.orders.create);
  const decide = useMutation(api.domains.orders.decide);
  const [busy, setBusy] = useState(false);

  const productRows = (products ?? []).map((row) => ({ ...row, id: row._id }));
  const customerRows = (customers ?? []).map((row) => ({
    ...row,
    id: row._id,
  }));
  const orderRows = (orders ?? []).map((row) => ({ ...row, id: row._id }));

  async function addDemoOrder() {
    setBusy(true);
    try {
      await createOrder({
        clientRequestId: crypto.randomUUID(),
        customerCode: customers?.[0]?.code ?? "CUS-001",
        lines: [
          {
            productCode: products?.[0]?.code ?? "SP-PJ-1L",
            description: products?.[0]?.name ?? "Sunpride Pineapple Juice 1L",
            quantity: 5,
            unitPrice: products?.[0]?.unitPrice ?? 1188,
          },
        ],
      });
    } finally {
      setBusy(false);
    }
  }

  if (module === "dashboard" || module === "analytics")
    return (
      <>
        {setupMessage ? (
          <p className="text-[13px] text-muted">{setupMessage}</p>
        ) : null}
        {metrics?.restricted ? (
          <p className="text-sm text-muted">
            Totals unavailable for this account.
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <MetricCard
            label="Products"
            value={String(metrics?.productCount ?? "—")}
            detail="Active"
          />
          <MetricCard
            label="Customers"
            value={String(metrics?.customerCount ?? "—")}
            detail="Trading"
          />
          <MetricCard
            label="Low stock"
            value={String(metrics?.lowStockCount ?? "—")}
            detail="Need stock"
          />
          <MetricCard
            label="Open orders"
            value={String(metrics?.openOrderCount ?? "—")}
            detail="In progress"
          />
          <MetricCard
            label="Approvals"
            value={String(metrics?.pendingApprovalCount ?? "—")}
            detail="Waiting"
          />
          <MetricCard
            label="Sales today"
            value={metrics ? money.format(metrics.salesToday) : "—"}
            detail="Order value"
          />
        </div>
      </>
    );

  if (module === "master-data") {
    const productColumns: DataColumn<(typeof productRows)[number]>[] = [
      {
        key: "code",
        label: "Code",
        render: (row) => (
          <span className="font-semibold text-foreground">{row.code}</span>
        ),
      },
      { key: "name", label: "Product", render: (row) => row.name },
      { key: "category", label: "Category", render: (row) => row.category },
      {
        key: "price",
        label: "Unit price",
        align: "right",
        render: (row) => money.format(row.unitPrice),
      },
      {
        key: "status",
        label: "Status",
        render: (row) => (
          <StatusPill tone={row.active ? "success" : "neutral"}>
            {row.active ? "Active" : "Inactive"}
          </StatusPill>
        ),
      },
    ];
    const customerColumns: DataColumn<(typeof customerRows)[number]>[] = [
      {
        key: "code",
        label: "Code",
        render: (row) => (
          <span className="font-semibold text-foreground">{row.code}</span>
        ),
      },
      { key: "name", label: "Customer", render: (row) => row.name },
      { key: "channel", label: "Channel", render: (row) => row.channel },
      { key: "territory", label: "Territory", render: (row) => row.territory },
      {
        key: "credit",
        label: "Credit limit",
        align: "right",
        render: (row) => money.format(row.creditLimit),
      },
    ];
    return (
      <>
        <Card
          label="Products"
          icon={<WorkspaceIcon name="catalog" />}
          count={productRows.length}
          flush
        >
          <DataTable
            rows={productRows}
            columns={productColumns}
            bare
            empty={<p className="p-4 text-[13px] text-muted">No products</p>}
          />
        </Card>
        <Card
          label="Customers"
          icon={<WorkspaceIcon name="commercial" />}
          count={customerRows.length}
          flush
        >
          <DataTable
            rows={customerRows}
            columns={customerColumns}
            bare
            empty={<p className="p-4 text-[13px] text-muted">No customers</p>}
          />
        </Card>
      </>
    );
  }

  if (module === "inventory") {
    return <InventoryWorkspace setupMessage={setupMessage} />;
  }

  if (module === "imports") {
    return <ImportsWorkspace setupMessage={setupMessage} />;
  }

  if (module === "orders" || module === "workflows") {
    const columns: DataColumn<(typeof orderRows)[number]>[] = [
      {
        key: "number",
        label: "Order",
        render: (row) => (
          <span className="font-semibold text-foreground">
            {row.orderNumber}
          </span>
        ),
      },
      { key: "customer", label: "Customer", render: (row) => row.customerCode },
      {
        key: "status",
        label: "Status",
        render: (row) => (
          <StatusPill
            tone={
              row.status === "approved" || row.status === "sent_to_sap"
                ? "success"
                : row.status === "rejected"
                  ? "danger"
                  : "warning"
            }
          >
            {row.status.replaceAll("_", " ")}
          </StatusPill>
        ),
      },
      {
        key: "total",
        label: "Total",
        align: "right",
        render: (row) => money.format(row.total),
      },
      {
        key: "action",
        label: "Decision",
        align: "right",
        render: (row) =>
          row.status === "pending_approval" ? (
            <span className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="secondary"
                onPress={() =>
                  void decide({
                    orderId: row._id,
                    decision: "rejected",
                    comment: "Rejected from operations workspace",
                  })
                }
              >
                Reject
              </Button>
              <Button
                size="sm"
                variant="primary"
                onPress={() =>
                  void decide({
                    orderId: row._id,
                    decision: "approved",
                    comment: "Approved from operations workspace",
                  })
                }
              >
                Approve
              </Button>
            </span>
          ) : (
            "—"
          ),
      },
    ];
    return (
      <>
        <PageHeader
          title={module === "workflows" ? "Workflows" : "Orders"}
          meta={
            module === "workflows"
              ? workflows
                ? `${workflows.length} waiting`
                : undefined
              : orders
                ? `${orders.length} orders`
                : undefined
          }
          actions={
            module === "orders" ? (
              <Button
                variant="primary"
                isPending={busy}
                onPress={() => void addDemoOrder()}
              >
                New order
              </Button>
            ) : undefined
          }
        />
        <Card
          label="Orders"
          icon={<WorkspaceIcon name="order" />}
          count={orderRows.length}
          flush
        >
          <DataTable
            bare
            rows={orderRows}
            columns={columns}
            empty={<p className="p-4 text-[13px] text-muted">No orders yet</p>}
          />
        </Card>
      </>
    );
  }

  if (module === "admin") return <AdminWorkspace />;
  if (module === "sales-force") return <SalesForcePanels />;

  return (
    <Card label="Integration" icon={<WorkspaceIcon name="operations" />}>
      <p className="text-[13px] text-muted">Not connected yet</p>
    </Card>
  );
}
