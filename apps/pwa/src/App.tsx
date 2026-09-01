import { Button, Input } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  MetricCard,
  PageHeader,
  StatusPill,
  WorkspaceModuleTabs,
  WorkspaceShell,
} from "@sunpride/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useConvex, useConvexAuth, useMutation, useQuery } from "convex/react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { AuthScreen } from "./components/auth-screen";
import {
  fieldMobileItems,
  fieldOrderTabs,
  getFieldNavigation,
} from "./config/navigation";
import { authClient } from "./lib/auth-client";
import {
  db,
  getOrCreateDeviceState,
  queueOrder,
  replaceInventoryProjection,
  saveRoute,
  type LocalInventory,
  type LocalOrder,
} from "./lib/database";
import { syncOutbox } from "./lib/sync";

function Surface({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-5 shadow-none sm:p-6">
      {children}
    </section>
  );
}

function OrderModuleTabs() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <WorkspaceModuleTabs
      activeHref={location.pathname}
      items={fieldOrderTabs}
      onNavigate={(href) => navigate(href)}
    />
  );
}

function Overview({
  catalogCount,
  localOrders,
  online,
  queued,
}: {
  catalogCount: number;
  localOrders: LocalOrder[];
  online: boolean;
  queued: number;
}) {
  const navigate = useNavigate();

  return (
    <div className="grid gap-7">
      <PageHeader
        eyebrow="Field Sales"
        title="Today’s workspace"
        description="Capture orders on the road, monitor the device queue, and continue working through unreliable connections."
        actions={
          <Button variant="primary" onPress={() => navigate("/orders/new")}>
            Create order
          </Button>
        }
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard
          label="Local orders"
          value={String(localOrders.length)}
          detail="Retained on this device"
        />
        <MetricCard
          label="Waiting to sync"
          value={String(queued)}
          detail={online ? "Automatic sync active" : "Will resume online"}
        />
        <MetricCard
          label="Catalog items"
          value={String(catalogCount)}
          detail="Ready for order entry"
        />
      </div>
      <Surface>
        <div className="grid gap-5 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <p className="text-sm font-medium text-accent-soft-foreground">
              Offline-first
            </p>
            <h2 className="mt-1 text-xl font-semibold text-foreground">
              Your work stays on this device first
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
              Every new order is saved locally before a network request. The
              queue synchronizes automatically whenever a trusted connection
              returns.
            </p>
          </div>
          <Button variant="secondary" onPress={() => navigate("/orders/queue")}>
            View queue
          </Button>
        </div>
      </Surface>
    </div>
  );
}

type Customer = { _id: string; code: string; name: string };
type Product = { _id: string; code: string; name: string; unitPrice?: number };

function NewOrder({
  customers,
  products,
  saving,
  onSubmit,
  inventory,
  routeReady,
}: {
  customers: Customer[];
  products: Product[];
  saving: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  inventory: LocalInventory[];
  routeReady: boolean;
}) {
  return (
    <div className="grid max-w-4xl gap-7">
      <PageHeader
        eyebrow="Orders"
        title="New sales order"
        description="Save the order to this device immediately. Network synchronization happens separately in the background."
      />
      <OrderModuleTabs />
      <Surface>
        <form onSubmit={onSubmit} className="grid gap-5 sm:grid-cols-2">
          <label className="grid gap-2 text-sm font-medium text-foreground">
            Customer
            <select
              name="customerCode"
              required
              className="h-10 rounded-md border border-border bg-surface px-3 outline-none focus:border-accent"
            >
              {customers.map((customer) => (
                <option key={customer._id} value={customer.code}>
                  {customer.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-medium text-foreground">
            Product
            <select
              name="productCode"
              required
              className="h-10 rounded-md border border-border bg-surface px-3 outline-none focus:border-accent"
            >
              {products
                .filter((product) =>
                  inventory.some(
                    (stock) =>
                      stock.productCode === product.code &&
                      BigInt(stock.projectedAvailableBase) > 0n,
                  ),
                )
                .map((product) => (
                  <option key={product._id} value={product.code}>
                    {product.name} ·{" "}
                    {Number(
                      inventory.find(
                        (stock) => stock.productCode === product.code,
                      )?.projectedAvailableBase ?? 0,
                    ) / 1_000}{" "}
                    left
                  </option>
                ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-medium text-foreground">
            Quantity
            <Input
              name="quantity"
              type="number"
              min={1}
              defaultValue="1"
              required
            />
          </label>
          <label className="grid gap-2 text-sm font-medium text-foreground">
            Unit price (PHP)
            <Input
              name="unitPrice"
              type="number"
              min={0}
              defaultValue={products[0]?.unitPrice?.toString() ?? "1188"}
              required
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            isPending={saving}
            isDisabled={!routeReady || inventory.length === 0}
            className="sm:col-span-2"
          >
            {routeReady
              ? "Save sale and issue truck stock"
              : "Open a truck route first"}
          </Button>
        </form>
      </Surface>
    </div>
  );
}

function TruckInventory({
  inventory,
  routeCode,
}: {
  inventory: LocalInventory[];
  routeCode?: string;
}) {
  return (
    <div className="grid gap-7">
      <PageHeader
        eyebrow="Rolling truck custody"
        title="Truck inventory"
        description="This device projection includes queued offline sales, so available stock is conservative until synchronization completes."
      />
      <div className="rounded-lg border border-border bg-foreground p-5 text-background">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] opacity-60">
          Active route
        </p>
        <p className="mt-1 text-xl font-semibold">
          {routeCode ?? "No route opened"}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {inventory.map((row) => {
          const projected =
            Number(row.projectedAvailableBase) / Number(row.scale);
          const remote = Number(row.remoteAvailableBase) / Number(row.scale);
          return (
            <article key={row.id} className="truck-stock-card">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                {row.productCode}
              </p>
              <h2 className="mt-1 font-semibold text-foreground">
                {row.productName}
              </h2>
              <div className="mt-5 flex items-end justify-between gap-4">
                <div>
                  <strong className="text-3xl text-foreground">
                    {projected.toLocaleString("en-PH")}
                  </strong>
                  <span className="ml-1 text-sm text-muted">cases</span>
                </div>
                <StatusPill tone={projected > 0 ? "success" : "danger"}>
                  {remote === projected
                    ? "synced"
                    : `${remote - projected} queued`}
                </StatusPill>
              </div>
            </article>
          );
        })}
        {inventory.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-surface p-8 text-center text-sm text-muted sm:col-span-2">
            Open a route while online to cache its truck inventory.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function OrderQueue({ localOrders }: { localOrders: LocalOrder[] }) {
  return (
    <div className="grid gap-7">
      <PageHeader
        eyebrow="Orders"
        title="Device order queue"
        description="Review orders stored on this device and see their synchronization state."
      />
      <OrderModuleTabs />
      <div className="grid gap-3">
        {localOrders.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface p-10 text-center text-sm text-muted">
            No local orders yet.
          </div>
        ) : (
          localOrders.map((order) => (
            <article
              key={order.id}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-none sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="font-medium text-foreground">
                  {order.customerCode} · {order.description}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {order.quantity} × PHP {order.unitPrice.toLocaleString()} ·{" "}
                  {new Date(order.createdAt).toLocaleString()}
                </p>
                {order.lastError ? (
                  <p className="mt-1 text-xs text-danger">{order.lastError}</p>
                ) : null}
              </div>
              <StatusPill
                tone={
                  order.syncState === "synced"
                    ? "success"
                    : order.syncState === "conflict"
                      ? "danger"
                      : "warning"
                }
              >
                {order.syncState}
              </StatusPill>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

function Catalog({
  customers,
  products,
}: {
  customers: Customer[];
  products: Product[];
}) {
  return (
    <div className="grid gap-7">
      <PageHeader
        eyebrow="Reference data"
        title="Customer & product catalog"
        description="The currently available master data used during mobile order capture."
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Surface>
          <h2 className="text-lg font-semibold text-foreground">Customers</h2>
          <div className="mt-4 divide-y divide-separator">
            {customers.map((customer) => (
              <div
                key={customer._id}
                className="flex justify-between gap-4 py-3 text-sm"
              >
                <span className="font-medium text-foreground">
                  {customer.name}
                </span>
                <span className="text-muted">{customer.code}</span>
              </div>
            ))}
          </div>
        </Surface>
        <Surface>
          <h2 className="text-lg font-semibold text-foreground">Products</h2>
          <div className="mt-4 divide-y divide-separator">
            {products.map((product) => (
              <div
                key={product._id}
                className="flex justify-between gap-4 py-3 text-sm"
              >
                <div>
                  <p className="font-medium text-foreground">{product.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{product.code}</p>
                </div>
                <span className="shrink-0 text-muted">
                  PHP {(product.unitPrice ?? 0).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </Surface>
      </div>
    </div>
  );
}

function SyncStatus({
  online,
  queued,
  syncing,
  onSync,
}: {
  online: boolean;
  queued: number;
  syncing: boolean;
  onSync: () => Promise<void>;
}) {
  return (
    <div className="grid max-w-4xl gap-7">
      <PageHeader
        eyebrow="Connectivity"
        title="Sync status"
        description="Check this device’s connectivity and manually retry any orders that are still waiting."
      />
      <Surface>
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <StatusPill tone={online ? "success" : "warning"}>
              {online ? "Online" : "Offline"}
            </StatusPill>
            <h2 className="mt-4 text-xl font-semibold text-foreground">
              {queued === 0
                ? "This device is up to date"
                : `${queued} ${queued === 1 ? "order" : "orders"} waiting`}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              {online
                ? "Background synchronization is active while the app remains open."
                : "Orders remain safely stored on this device until connectivity returns."}
            </p>
          </div>
          <Button
            variant="primary"
            isDisabled={!online}
            isPending={syncing}
            onPress={() => void onSync()}
          >
            Sync now
          </Button>
        </div>
      </Surface>
    </div>
  );
}

function FieldWorkspace({ user }: { user: { name: string; role: string } }) {
  const convex = useConvex();
  const navigate = useNavigate();
  const location = useLocation();
  const products = useQuery(api.domains.masterData.products, { limit: 20 });
  const customers = useQuery(api.domains.masterData.customers, { limit: 20 });
  const truckLocations = useQuery(api.inventory.queries.locations, {
    type: "truck",
  });
  const localOrders =
    useLiveQuery(
      () => db.orders.orderBy("createdAt").reverse().toArray(),
      [],
    ) ?? [];
  const deviceState = useLiveQuery(() => db.deviceState.get("primary"), []);
  const localInventory =
    useLiveQuery(() => db.inventory.orderBy("productCode").toArray(), []) ?? [];
  const currentRoute = useQuery(
    api.inventory.pos.currentRoute,
    deviceState?.deviceId ? { deviceId: deviceState.deviceId } : "skip",
  );
  const remoteInventory = useQuery(
    api.inventory.queries.overview,
    deviceState?.truckLocationId
      ? {
          locationId: deviceState.truckLocationId as Id<"inventoryLocations">,
          limit: 100,
        }
      : "skip",
  );
  const openRoute = useMutation(api.inventory.pos.openRoute);
  const queued = localOrders.filter(
    (item) => item.syncState !== "synced",
  ).length;
  const [online, setOnline] = useState(() => window.navigator.onLine);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [routeBusy, setRouteBusy] = useState(false);
  const navigation = getFieldNavigation(location.pathname);

  async function syncNow() {
    setSyncing(true);
    try {
      await syncOutbox(convex);
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    void getOrCreateDeviceState();
  }, []);

  useEffect(() => {
    if (!currentRoute) return;
    void saveRoute({
      truckLocationId: currentRoute.truckLocationId,
      routeSessionId: currentRoute._id,
      routeCode: currentRoute.routeCode,
      lastAcknowledgedSequence: currentRoute.lastAcknowledgedSequence,
    });
  }, [currentRoute]);

  useEffect(() => {
    if (!deviceState?.truckLocationId || !remoteInventory) return;
    void replaceInventoryProjection(
      deviceState.truckLocationId,
      remoteInventory,
    );
  }, [deviceState?.truckLocationId, remoteInventory]);

  useEffect(() => {
    const update = () => {
      setOnline(window.navigator.onLine);
      if (window.navigator.onLine) void syncOutbox(convex);
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    const timer = window.setInterval(update, 15_000);
    void syncOutbox(convex);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      window.clearInterval(timer);
    };
  }, [convex]);

  async function activateRoute() {
    const truck = truckLocations?.[0];
    if (!truck || !deviceState) return;
    setRouteBusy(true);
    try {
      const routeSessionId = await openRoute({
        truckLocationId: truck._id,
        deviceId: deviceState.deviceId,
      });
      await saveRoute({
        truckLocationId: truck._id,
        routeSessionId,
        routeCode: `ROUTE-${new Date().toISOString().slice(0, 10)}`,
        lastAcknowledgedSequence: 0,
      });
    } finally {
      setRouteBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const data = new FormData(event.currentTarget);
      const productCode = String(data.get("productCode"));
      if (!deviceState?.truckLocationId || !deviceState.routeSessionId)
        throw new Error("Open a truck route before recording a sale");
      await queueOrder({
        customerCode: String(data.get("customerCode")),
        productCode,
        description:
          products?.find((product) => product.code === productCode)?.name ??
          "Sunpride product",
        quantity: Number(data.get("quantity")),
        quantityBase: String(Math.round(Number(data.get("quantity")) * 1_000)),
        unitPrice: Number(data.get("unitPrice")),
        truckLocationId: deviceState.truckLocationId,
        routeSessionId: deviceState.routeSessionId,
      });
      event.currentTarget.reset();
      if (window.navigator.onLine) await syncOutbox(convex);
      navigate("/orders/queue");
    } finally {
      setSaving(false);
    }
  }

  async function signOut() {
    await authClient.signOut();
    navigate("/login", { replace: true });
  }

  return (
    <WorkspaceShell
      activeHref={location.pathname}
      activePrimaryId={navigation.activePrimaryId}
      brand={{
        logo: <img src="/sunpride-logo.jpg" alt="" width="40" height="40" />,
        name: "sunpride",
        descriptor: "Field Sales",
      }}
      mobilePrimaryItems={fieldMobileItems}
      navGroups={navigation.navGroups}
      onNavigate={(href) => navigate(href)}
      onSignOut={signOut}
      status={
        <StatusPill tone={online ? "success" : "warning"}>
          {online ? (queued ? `${queued} queued` : "Online") : "Offline"}
        </StatusPill>
      }
      user={user}
    >
      {!deviceState?.routeSessionId ? (
        <div className="mb-5 flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold text-foreground">
              Truck custody is not active
            </p>
            <p className="mt-1 text-sm text-muted">
              Open the assigned truck route online before accepting offline
              sales.
            </p>
          </div>
          <Button
            variant="primary"
            isPending={routeBusy}
            isDisabled={!online || !truckLocations?.length || !deviceState}
            onPress={() => void activateRoute()}
          >
            Open assigned route
          </Button>
        </div>
      ) : null}
      <Routes>
        <Route
          index
          element={
            <Overview
              catalogCount={(products?.length ?? 0) + (customers?.length ?? 0)}
              localOrders={localOrders}
              online={online}
              queued={queued}
            />
          }
        />
        <Route
          path="orders/new"
          element={
            <NewOrder
              customers={customers ?? []}
              products={products ?? []}
              saving={saving}
              onSubmit={submit}
              inventory={localInventory}
              routeReady={Boolean(deviceState?.routeSessionId)}
            />
          }
        />
        <Route
          path="inventory"
          element={
            <TruckInventory
              inventory={localInventory}
              routeCode={deviceState?.routeCode}
            />
          }
        />
        <Route
          path="orders/queue"
          element={<OrderQueue localOrders={localOrders} />}
        />
        <Route
          path="catalog"
          element={
            <Catalog customers={customers ?? []} products={products ?? []} />
          }
        />
        <Route
          path="sync"
          element={
            <SyncStatus
              online={online}
              queued={queued}
              syncing={syncing}
              onSync={syncNow}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </WorkspaceShell>
  );
}

function ProvisionedWorkspace() {
  const ensureProfile = useMutation(api.domains.profiles.ensure);
  const profile = useQuery(api.domains.profiles.current, {});
  const [accessError, setAccessError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void ensureProfile()
      .then(() => {
        if (active) setAccessError(null);
      })
      .catch(() => {
        if (active)
          setAccessError(
            "This email address has not been invited to Sunpride Operations.",
          );
      });
    return () => {
      active = false;
    };
  }, [ensureProfile]);

  if (accessError) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-5">
        <section className="w-full max-w-md rounded-lg border border-border bg-surface p-7 text-center shadow-none">
          <img
            src="/sunpride-logo.jpg"
            alt="Sunpride"
            width="64"
            height="64"
            className="mx-auto rounded-[7px]"
          />
          <h1 className="mt-6 text-2xl font-semibold">
            Access not provisioned
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted">{accessError}</p>
          <Button
            className="mt-6 w-full"
            variant="secondary"
            onPress={() => void authClient.signOut()}
          >
            Sign out
          </Button>
        </section>
      </main>
    );
  }

  if (!profile || profile.status !== "active") {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-muted">
        Verifying your Sunpride access…
      </div>
    );
  }

  return <FieldWorkspace user={{ name: profile.name, role: profile.role }} />;
}

export default function App() {
  const { isAuthenticated, isLoading } = useConvexAuth();

  if (isLoading) {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-muted">
        Opening field workspace…
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="/login" element={<AuthScreen mode="login" />} />
        <Route path="/register" element={<AuthScreen mode="register" />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return <ProvisionedWorkspace />;
}
