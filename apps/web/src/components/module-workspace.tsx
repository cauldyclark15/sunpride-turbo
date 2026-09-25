"use client";

import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import {
  DataTable,
  EmptyPanel,
  MetricCard,
  PageHeader,
  StatusPill,
  WorkspaceModuleTabs,
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
  dashboard: {
    eyebrow: "Executive control center",
    title: "Operations dashboard",
    description:
      "A live view of orders, stock exposure, approvals, customers, and today’s sales.",
  },
  "master-data": {
    eyebrow: "SAP-governed records",
    title: "Master data",
    description:
      "Product, customer, warehouse, territory, and price references synchronized with SAP.",
  },
  imports: {
    eyebrow: "Governed data entry",
    title: "Data imports",
    description:
      "Load the approved product master and opening stock through validated CSV operations with preview, row-level errors, and an auditable run history.",
  },
  inventory: {
    eyebrow: "Operational inventory authority",
    title: "Inventory control",
    description:
      "Lot-aware stock, receiving, transfers, counts, manufacturing, rolling trucks, and an immutable movement ledger.",
  },
  "sales-force": {
    eyebrow: "Field execution",
    title: "Sales force automation",
    description:
      "Assignments, customer coverage, planned visits, field notes, and sales representative activity.",
  },
  orders: {
    eyebrow: "Order-to-SAP lifecycle",
    title: "Sales orders",
    description:
      "Create, review, approve, and track orders from field capture through SAP handoff.",
  },
  "sap-integration": {
    eyebrow: "Outbound-only bridge",
    title: "SAP integration",
    description:
      "Signed event exchange, connector health, retry queues, acknowledgements, and dead-letter operations.",
  },
  workflows: {
    eyebrow: "Controlled decisions",
    title: "Workflow & approval",
    description:
      "Pending business decisions with role-based authority and a complete audit trail.",
  },
  admin: {
    eyebrow: "Identity and governance",
    title: "Security & administration",
    description:
      "Account roles, access posture, auditability, and operational configuration.",
  },
  analytics: {
    eyebrow: "Management intelligence",
    title: "Dashboards & analytics",
    description:
      "Operational indicators that expose sales velocity, stock risk, and process bottlenecks.",
  },
} satisfies Record<
  WebModuleSlug,
  { eyebrow: string; title: string; description: string }
>;

type ModuleKey = WebModuleSlug;
const money = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 0,
});

function SectionCard({
  title,
  description,
  bullets,
}: {
  title: string;
  description: string;
  bullets: string[];
}) {
  return (
    <article className="rounded-lg border border-border bg-surface p-5 shadow-none">
      <h2 className="font-semibold text-foreground">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted">{description}</p>
      <ul className="mt-4 grid gap-2 text-sm text-foreground">
        {bullets.map((item) => (
          <li key={item} className="flex gap-2">
            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
            {item}
          </li>
        ))}
      </ul>
    </article>
  );
}

export function ModuleWorkspace({ module }: { module: WebModuleSlug }) {
  const profile = useQuery(api.domains.profiles.current, {});

  // Do not mount ModuleContent (or its module-specific queries/mutations) until
  // the active profile is known and allowed for this route.
  if (!profile) {
    return <p className="text-sm text-muted">Verifying module access…</p>;
  }
  if (
    profile.status !== "active" ||
    !canAccessWebModule(module, profile.role)
  ) {
    return (
      <section className="rounded-lg border border-border bg-surface p-8">
        <h1 className="text-xl font-semibold text-foreground">Access denied</h1>
        <p className="mt-2 text-sm text-muted">
          Your role does not have access to this module.
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
  const [setupMessage, setSetupMessage] = useState("Preparing your workspace…");
  const pathname = usePathname();
  const router = useRouter();
  const tabs = getWebModuleTabs(pathname);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void ensureProfile()
      .then(() => setSetupMessage("Operational data connected."))
      .catch(() => setSetupMessage("Workspace connected."));
  }, [ensureProfile]);

  return (
    <div className="grid gap-7">
      <PageHeader
        eyebrow={config.eyebrow}
        title={config.title}
        description={config.description}
      />
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
    <div className="space-y-2">
      <label>
        Scoped plan{" "}
        <select
          aria-label="Scoped coverage plan"
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
      {result === undefined && <p>Loading scoped plans…</p>}
      {result && !result.page.length && (
        <p>No plans on this page. Continue to check more.</p>
      )}
      <button
        type="button"
        disabled={cursor === null}
        onClick={() => setCursor(null)}
      >
        First plans
      </button>{" "}
      <button
        type="button"
        disabled={!result || result.isDone}
        onClick={() => setCursor(result!.continueCursor)}
      >
        Next plans
      </button>
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
    ["visits", "Planned visits"],
    ["history", "History"],
    ["calendar", "Calendar"],
    ["route", "Territory / route"],
    ["map", "Map"],
    ["workload", "Workload"],
    ["export", "Export / print"],
  ];
  return (
    <div className="grid gap-6">
      {canRead && (
        <section
          aria-label="Coverage plans"
          className="grid gap-4 rounded border border-border p-4"
        >
          <h2 className="text-lg font-semibold">Coverage plans</h2>
          <label>
            Manila month{" "}
            <input
              type="month"
              aria-label="Coverage month"
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
          <div
            role="tablist"
            aria-label="Master Coverage Plans"
            className="flex flex-wrap gap-2"
          >
            {coverageTabs.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={coverageTab === key}
                className="rounded border border-border px-3 py-1"
                onClick={() => setCoverageTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
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
                <CoverageWorkloadView localMonth={month} />
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
        </section>
      )}
      {panels.editing ? (
        <h2 className="text-lg font-semibold">Territory coverage editors</h2>
      ) : (
        <h2 className="text-lg font-semibold">Scoped route and outlet lists</h2>
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
        <p className="text-xs font-medium text-muted">{setupMessage}</p>
        {metrics?.restricted ? (
          <p className="text-sm text-muted">
            Company-wide totals are visible to national users only.
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <MetricCard
            label="Products"
            value={String(metrics?.productCount ?? "—")}
            detail="Active catalog references"
          />
          <MetricCard
            label="Customers"
            value={String(metrics?.customerCount ?? "—")}
            detail="Trading accounts"
          />
          <MetricCard
            label="Low stock"
            value={String(metrics?.lowStockCount ?? "—")}
            detail="Requires replenishment"
          />
          <MetricCard
            label="Open orders"
            value={String(metrics?.openOrderCount ?? "—")}
            detail="In active processing"
          />
          <MetricCard
            label="Approvals"
            value={String(metrics?.pendingApprovalCount ?? "—")}
            detail="Awaiting a decision"
          />
          <MetricCard
            label="Sales today"
            value={metrics ? money.format(metrics.salesToday) : "—"}
            detail="Submitted order value"
          />
        </div>
        <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
          <SectionCard
            title="Commercial pulse"
            description="Sunpride’s control plane is organized around exception management: stock risk, stalled approvals, and SAP delivery status."
            bullets={[
              "Realtime Convex subscriptions update every connected workspace",
              "Approval decisions generate outbound SAP events",
              "All privileged actions append immutable audit records",
            ]}
          />
          <SectionCard
            title="Management focus"
            description="Today’s operating rhythm, ready for client-specific KPI definitions."
            bullets={[
              "Review low-stock products",
              "Resolve approval backlog",
              "Confirm connector heartbeat before cut-off",
            ]}
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
        <h2 className="text-lg font-semibold">Products</h2>
        <DataTable
          rows={productRows}
          columns={productColumns}
          empty={
            <EmptyPanel
              title="No products"
              description="Products will appear after SAP synchronization."
            />
          }
        />
        <h2 className="mt-4 text-lg font-semibold">Customers</h2>
        <DataTable
          rows={customerRows}
          columns={customerColumns}
          empty={
            <EmptyPanel
              title="No customers"
              description="Customers will appear after SAP synchronization."
            />
          }
        />
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
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted">
            {module === "workflows"
              ? `${workflows?.length ?? 0} pending workflow(s)`
              : "Orders are idempotent across online and offline clients."}
          </p>
          {module === "orders" ? (
            <Button
              variant="primary"
              isPending={busy}
              onPress={() => void addDemoOrder()}
            >
              Create sample order
            </Button>
          ) : null}
        </div>
        <DataTable
          rows={orderRows}
          columns={columns}
          empty={
            <EmptyPanel
              title="No orders yet"
              description="Create a sample order or sync an offline field order."
            />
          }
        />
      </>
    );
  }

  if (module === "admin") return <AdminWorkspace />;
  if (module === "sales-force") return <SalesForcePanels />;

  const content =
    {
      "sap-integration": [
        "Outbound-only local connector",
        "HMAC signed requests with replay window",
        "Durable Bun SQLite retries and dead-letter handling",
      ],
      admin: [
        "Invitation-only Better Auth email and password identity",
        "Role-based authorization in Convex",
        "Server-derived identity and immutable audit events",
      ],
    }[module as "sap-integration" | "admin"] ?? [];
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <SectionCard
        title="Ready foundation"
        description="This module is connected to the shared architecture and prepared for client-specific business rules."
        bullets={content}
      />
      <SectionCard
        title="Control posture"
        description="Operational safety is built into every state-changing flow."
        bullets={[
          "Validated inputs and bounded queries",
          "Idempotent write boundaries",
          "Visible error and recovery states",
        ]}
      />
      <SectionCard
        title="Next configuration"
        description="Finalize these values during discovery with Sunpride and the SAP team."
        bullets={[
          "Field mapping and ownership",
          "Role matrix and thresholds",
          "Cut-off, retry, and SLA rules",
        ]}
      />
    </div>
  );
}
