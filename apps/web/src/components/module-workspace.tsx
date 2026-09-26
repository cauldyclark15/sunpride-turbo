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
import { useEffect, useRef, useState } from "react";
import { getWebModuleTabs, type WebModuleSlug } from "../config/navigation";
import { canAccessWebModule } from "../lib/module-access";
import { AdminWorkspace } from "./admin-workspace";
import { SalesForcePanels } from "./coverage-workspace";
import { ImportsWorkspace } from "./imports-workspace";
import { InventoryWorkspace } from "./inventory-workspace";


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
