"use client";

import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import {
  Card,
  DataTable,
  MetricCard,
  PageHeader,
  StatusPill,
  WorkspaceModuleTabs,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getWebModuleTabs, type WebModuleSlug } from "../config/navigation";
import { canAccessWebModule } from "../lib/module-access";
import { AdminWorkspace } from "./admin-workspace";
import { SalesForcePanels } from "./coverage-workspace";
import { ImportsWorkspace } from "./imports-workspace";
import { InventoryWorkspace } from "./inventory-workspace";

const modules = {
  dashboard: { title: "Home" },
  "master-data": { title: "Commercial" },
  imports: { title: "Commercial" },
  inventory: { title: "Inventory" },
  "sales-force": { title: "Coverage" },
  orders: { title: "Orders" },
  "sap-integration": { title: "Integration" },
  workflows: { title: "Approvals" },
  admin: { title: "Administration" },
  analytics: { title: "Reports" },
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
    return <div className="text-[13px] text-muted">Checking access…</div>;
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

  const commercialTabs = (
    <WorkspaceModuleTabs
      activeHref={pathname}
      items={tabs}
      onNavigate={(href) => router.push(href)}
    />
  );

  return (
    <div className="grid gap-4">
      {!["inventory", "orders", "workflows"].includes(module) ? (
        <PageHeader title={config.title} />
      ) : null}
      {module === "orders" ? null : commercialTabs}
      <ModuleContent
        module={module}
        setupMessage={setupMessage}
        commercialTabs={commercialTabs}
      />
    </div>
  );
}

function ModuleContent({
  module,
  setupMessage,
  commercialTabs,
}: {
  module: ModuleKey;
  setupMessage: string;
  commercialTabs: ReactNode;
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
          <div className="text-[13px] text-muted">{setupMessage}</div>
        ) : null}
        {metrics?.restricted ? (
          <div className="text-[13px] text-muted">
            Totals unavailable for this account.
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <MetricCard
            label="Products"
            value={String(metrics?.productCount ?? "—")}
          />
          <MetricCard
            label="Customers"
            value={String(metrics?.customerCount ?? "—")}
          />
          <MetricCard
            label="Low stock"
            value={String(metrics?.lowStockCount ?? "—")}
          />
          <MetricCard
            label="Open orders"
            value={String(metrics?.openOrderCount ?? "—")}
          />
          <MetricCard
            label="Approvals"
            value={String(metrics?.pendingApprovalCount ?? "—")}
          />
          <MetricCard
            label="Sales today"
            value={metrics ? money.format(metrics.salesToday) : "—"}
          />
        </div>
      </>
    );

  if (module === "master-data") {
    const productColumns: DataColumn<(typeof productRows)[number]>[] = [
      {
        key: "product",
        label: "Product",
        render: (row) => (
          <span className="flex flex-col">
            <span className="text-sm font-medium text-foreground">
              {row.name}
            </span>
            <span className="font-mono text-xs text-muted">{row.code}</span>
          </span>
        ),
      },
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
        key: "customer",
        label: "Customer",
        render: (row) => (
          <span className="flex flex-col">
            <span className="text-sm font-medium text-foreground">
              {row.name}
            </span>
            <span className="font-mono text-xs text-muted">{row.code}</span>
          </span>
        ),
      },
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
            empty={
              <div className="p-4 text-[13px] text-muted">No products</div>
            }
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
            empty={
              <div className="p-4 text-[13px] text-muted">No customers</div>
            }
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
    const waitingIds = new Set((workflows ?? []).map((row) => row.entityId));
    const visibleOrders =
      module === "workflows"
        ? orderRows.filter(
            (row) =>
              row.status === "pending_approval" && waitingIds.has(row._id),
          )
        : orderRows;
    const customerNames = new Map(
      (customers ?? []).map((customer) => [customer.code, customer.name]),
    );
    const columns: DataColumn<(typeof orderRows)[number]>[] = [
      {
        key: "number",
        label: "Order",
        render: (row) => (
          <span className="font-medium text-foreground">{row.orderNumber}</span>
        ),
      },
      {
        key: "customer",
        label: "Customer",
        render: (row) => {
          const name =
            module === "orders"
              ? customerNames.get(row.customerCode)
              : undefined;
          return name ? (
            <span className="flex flex-col">
              <span className="text-sm font-medium text-foreground">
                {name}
              </span>
              <span className="font-mono text-xs text-muted">
                {row.customerCode}
              </span>
            </span>
          ) : (
            <span className="font-mono text-xs text-muted">
              {row.customerCode}
            </span>
          );
        },
      },
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
            {row.status === "pending_approval"
              ? "Waiting"
              : row.status === "sent_to_sap"
                ? "Sent"
                : row.status}
          </StatusPill>
        ),
      },
      {
        key: "total",
        label: "Total",
        align: "right",
        render: (row) => money.format(row.total),
      },
      ...(visibleOrders.some((row) => row.status === "pending_approval")
        ? [
            {
              key: "action",
              label: "Decision",
              align: "right" as const,
              render: (row: (typeof orderRows)[number]) =>
                row.status === "pending_approval" ? (
                  <span className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="outline"
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
          ]
        : []),
    ];
    return (
      <>
        <PageHeader
          title={module === "workflows" ? "Approvals" : "Commercial"}
          meta={
            module === "workflows"
              ? orders && workflows
                ? `${visibleOrders.length} waiting`
                : undefined
              : orders
                ? `${orders.length} ${orders.length === 1 ? "order" : "orders"}`
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
        {module === "orders" ? commercialTabs : null}
        <DataTable
          rows={visibleOrders}
          columns={columns}
          empty={
            <div className="rounded-2xl border border-border bg-surface p-4 text-[13px] text-muted">
              {module === "workflows" ? "Nothing waiting" : "No orders yet"}
            </div>
          }
        />
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
