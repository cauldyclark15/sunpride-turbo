import {
  Button,
  Input,
  Label,
  ListBox,
  Select,
  TextField,
} from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  EmptyPanel,
  ListRow,
  PageHeader,
  StatusPill,
  UnderlineTabs,
  WorkspaceShell,
} from "@sunpride/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useConvex, useConvexAuth, useMutation, useQuery } from "convex/react";
import { useEffect, useState, type FormEvent } from "react";
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

function OrderModuleTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <UnderlineTabs
      label="Orders"
      activeId={location.pathname}
      items={fieldOrderTabs.map((item) => [item.href, item.label] as const)}
      onChange={(href) => navigate(href)}
    />
  );
}

function Overview({
  catalogCount,
  localOrders,
  queued,
}: {
  catalogCount: number;
  localOrders: LocalOrder[];
  queued: number;
}) {
  const navigate = useNavigate();

  return (
    <div className="grid gap-4 pb-20">
      <PageHeader
        title="Today"
        meta={`${localOrders.length} orders · ${queued} waiting · ${catalogCount} catalog items`}
      />
      <Card label="Orders" count={localOrders.length} flush>
        {localOrders.length ? (
          localOrders
            .slice(0, 5)
            .map((order) => (
              <ListRow
                key={order.id}
                icon="▤"
                title={order.customerCode}
                meta={`${order.description} · ${order.quantity} × PHP ${order.unitPrice.toLocaleString()}`}
                value={
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
                }
              />
            ))
        ) : (
          <EmptyPanel title="No orders yet" />
        )}
      </Card>
      <div className="fixed inset-x-4 bottom-20 z-10 mx-auto max-w-md rounded-xl bg-background p-2 lg:bottom-6">
        <Button
          className="h-12 w-full rounded-[10px]"
          variant="primary"
          onPress={() => navigate("/orders/new")}
        >
          New order
        </Button>
      </div>
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
  const [customerCode, setCustomerCode] = useState("");
  const [productCode, setProductCode] = useState("");
  const availableProducts = products.filter((product) =>
    inventory.some(
      (stock) =>
        stock.productCode === product.code &&
        BigInt(stock.projectedAvailableBase) > 0n,
    ),
  );
  const chosenCustomer = customers.some(
    (customer) => customer.code === customerCode,
  )
    ? customerCode
    : (customers[0]?.code ?? "");
  const chosenProduct = availableProducts.some(
    (product) => product.code === productCode,
  )
    ? productCode
    : (availableProducts[0]?.code ?? "");
  return (
    <div className="grid max-w-4xl gap-4 pb-20">
      <PageHeader
        title="New order"
        meta={`${customers.length} customers · ${products.length} products`}
      />
      <OrderModuleTabs />
      <Card label="Order details">
        <form
          id="new-order-form"
          onSubmit={onSubmit}
          className="grid gap-4 sm:grid-cols-2"
        >
          <div className="grid gap-1.5 text-[13px] font-medium">
            <span>Customer</span>
            <input type="hidden" name="customerCode" value={chosenCustomer} />
            <Select
              aria-label="Customer"
              selectedKey={chosenCustomer || "__none"}
              onSelectionChange={(key) => setCustomerCode(String(key))}
            >
              <Select.Trigger className="h-10 min-h-10 rounded-[10px] !border !border-border bg-surface px-3 text-sm shadow-none">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {customers.map((customer) => (
                    <ListBox.Item
                      key={customer._id}
                      id={customer.code}
                      textValue={customer.name}
                    >
                      {customer.name}
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
          <div className="grid gap-1.5 text-[13px] font-medium">
            <span>Product</span>
            <input type="hidden" name="productCode" value={chosenProduct} />
            <Select
              aria-label="Product"
              selectedKey={chosenProduct || "__none"}
              onSelectionChange={(key) => setProductCode(String(key))}
            >
              <Select.Trigger className="h-10 min-h-10 rounded-[10px] !border !border-border bg-surface px-3 text-sm shadow-none">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {availableProducts.map((product) => (
                    <ListBox.Item
                      key={product._id}
                      id={product.code}
                      textValue={product.name}
                    >
                      {product.name} ·{" "}
                      {Number(
                        inventory.find(
                          (stock) => stock.productCode === product.code,
                        )?.projectedAvailableBase ?? 0,
                      ) / 1_000}{" "}
                      left
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
          <TextField className="grid gap-1.5">
            <Label className="text-[13px] font-medium">Quantity</Label>
            <Input
              name="quantity"
              type="number"
              min={1}
              defaultValue="1"
              required
              className="h-10 rounded-[10px] border border-border bg-surface"
            />
          </TextField>
          <TextField className="grid gap-1.5">
            <Label className="text-[13px] font-medium">Unit price (PHP)</Label>
            <Input
              name="unitPrice"
              type="number"
              min={0}
              defaultValue={products[0]?.unitPrice?.toString() ?? "1188"}
              required
              className="h-10 rounded-[10px] border border-border bg-surface"
            />
          </TextField>
        </form>
      </Card>
      <div className="fixed inset-x-4 bottom-20 z-10 mx-auto max-w-md rounded-xl bg-background p-2 lg:bottom-6">
        <Button
          type="submit"
          form="new-order-form"
          variant="primary"
          isPending={saving}
          isDisabled={!routeReady || !chosenCustomer || !chosenProduct}
          className="h-12 w-full rounded-[10px]"
        >
          {routeReady ? "Save order" : "Open route first"}
        </Button>
      </div>
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
    <div className="grid gap-4">
      <PageHeader title="Truck stock" meta={`${inventory.length} products`} />
      <Card label="Active route" flush>
        <ListRow icon="↗" title={routeCode ?? "No route opened"} />
      </Card>
      <Card label="Stock" count={inventory.length} flush>
        {inventory.map((row) => {
          const projected =
            Number(row.projectedAvailableBase) / Number(row.scale);
          const remote = Number(row.remoteAvailableBase) / Number(row.scale);
          return (
            <ListRow
              key={row.id}
              icon="▤"
              title={row.productName}
              meta={`${row.productCode} · ${remote === projected ? "Synced" : `${remote - projected} queued`}`}
              value={`${projected.toLocaleString("en-PH")} cases`}
              dotTone={projected > 0 ? "success" : "danger"}
            />
          );
        })}
        {inventory.length === 0 ? (
          <EmptyPanel title="Open a route to see stock" />
        ) : null}
      </Card>
    </div>
  );
}

function OrderQueue({ localOrders }: { localOrders: LocalOrder[] }) {
  return (
    <div className="grid gap-4">
      <PageHeader
        title="Queue"
        meta={`${localOrders.length} orders · ${localOrders.filter((order) => order.syncState !== "synced").length} waiting`}
      />
      <OrderModuleTabs />
      <Card label="Local orders" count={localOrders.length} flush>
        {localOrders.length === 0 ? (
          <EmptyPanel title="No orders yet" />
        ) : (
          localOrders.map((order) => (
            <ListRow
              key={order.id}
              icon="▤"
              title={`${order.customerCode} · ${order.description}`}
              meta={
                <>
                  {order.quantity} × PHP {order.unitPrice.toLocaleString()} ·{" "}
                  {new Date(order.createdAt).toLocaleString()}
                  {order.lastError ? ` · ${order.lastError}` : ""}
                </>
              }
              value={
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
              }
            />
          ))
        )}
      </Card>
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
    <div className="grid gap-4">
      <PageHeader
        title="Catalog"
        meta={`${customers.length} customers · ${products.length} products`}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card label="Customers" count={customers.length} flush>
          {customers.map((customer) => (
            <ListRow
              key={customer._id}
              icon="◯"
              title={customer.name}
              meta={customer.code}
            />
          ))}
          {!customers.length ? <EmptyPanel title="No customers" /> : null}
        </Card>
        <Card label="Products" count={products.length} flush>
          {products.map((product) => (
            <ListRow
              key={product._id}
              icon="▤"
              title={product.name}
              meta={product.code}
              value={`PHP ${(product.unitPrice ?? 0).toLocaleString()}`}
            />
          ))}
          {!products.length ? <EmptyPanel title="No products" /> : null}
        </Card>
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
    <div className="grid max-w-4xl gap-4 pb-20">
      <PageHeader title="Sync" meta={`${queued} waiting`} />
      <Card label="Device status" flush>
        <ListRow
          icon="↻"
          title={
            queued === 0
              ? online
                ? "All synced"
                : "No orders waiting"
              : `${queued} waiting`
          }
          meta={online ? "Online" : "Offline"}
          value={
            <StatusPill tone={online ? "success" : "warning"}>
              {online ? "Online" : "Offline"}
            </StatusPill>
          }
        />
      </Card>
      <div className="fixed inset-x-4 bottom-20 z-10 mx-auto max-w-md rounded-xl bg-background p-2 lg:bottom-6">
        <Button
          className="h-12 w-full rounded-[10px]"
          variant="primary"
          isDisabled={!online}
          isPending={syncing}
          onPress={() => void onSync()}
        >
          Sync now
        </Button>
      </div>
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
    <>
      <div className="fixed right-16 top-3 z-30 md:hidden">
        <StatusPill tone={online ? "success" : "warning"}>
          {!online ? "Offline" : queued ? `${queued} waiting` : "All synced"}
        </StatusPill>
      </div>
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
            {online ? (queued ? `${queued} waiting` : "All synced") : "Offline"}
          </StatusPill>
        }
        user={user}
      >
        {!deviceState?.routeSessionId ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-warning-soft p-3 text-warning-soft-foreground">
            <p className="text-sm font-medium">Open route to take orders</p>
            <Button
              variant="outline"
              className="h-10"
              isPending={routeBusy}
              isDisabled={!online || !truckLocations?.length || !deviceState}
              onPress={() => void activateRoute()}
            >
              Open route
            </Button>
          </div>
        ) : null}
        <Routes>
          <Route
            index
            element={
              <Overview
                catalogCount={
                  (products?.length ?? 0) + (customers?.length ?? 0)
                }
                localOrders={localOrders}
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
    </>
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
          setAccessError("Email not invited. Contact your administrator.");
      });
    return () => {
      active = false;
    };
  }, [ensureProfile]);

  if (accessError) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-5">
        <section className="w-full max-w-[400px] rounded-2xl border border-border bg-surface p-7 text-center">
          <img
            src="/sunpride-logo.jpg"
            alt="Sunpride"
            width="64"
            height="64"
            className="mx-auto rounded-[7px]"
          />
          <h1 className="mt-6 text-2xl font-semibold">Access unavailable</h1>
          <p className="mt-3 text-sm leading-6 text-muted">{accessError}</p>
          <Button
            className="mt-6 w-full"
            variant="outline"
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
        Loading…
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
        Loading…
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
