import Dexie, { type EntityTable } from "dexie";

export type LocalOrder = {
  id: string;
  customerCode: string;
  productCode: string;
  description: string;
  quantity: number;
  quantityBase?: string;
  unitPrice: number;
  truckLocationId?: string;
  routeSessionId?: string;
  deviceId?: string;
  deviceSequence?: number;
  createdAt: number;
  syncState: "queued" | "syncing" | "synced" | "conflict";
  remoteId?: string;
  remoteMovementId?: string;
  lastError?: string;
};
export type OutboxItem = {
  id: string;
  aggregateId: string;
  operation: "order.create" | "pos.sale";
  payload: LocalOrder;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
};

export type DeviceState = {
  id: "primary";
  deviceId: string;
  lastIssuedSequence: number;
  truckLocationId?: string;
  routeSessionId?: string;
  routeCode?: string;
  updatedAt: number;
};

export type LocalInventory = {
  id: string;
  productCode: string;
  productName: string;
  locationId: string;
  locationCode: string;
  scale: string;
  remoteAvailableBase: string;
  projectedAvailableBase: string;
  updatedAt: number;
};

class FieldDatabase extends Dexie {
  orders!: EntityTable<LocalOrder, "id">;
  outbox!: EntityTable<OutboxItem, "id">;
  deviceState!: EntityTable<DeviceState, "id">;
  inventory!: EntityTable<LocalInventory, "id">;
  constructor() {
    super("sunpride-field-v1");
    this.version(1).stores({
      orders: "id, syncState, createdAt",
      outbox: "id, aggregateId, nextAttemptAt, createdAt",
    });
    this.version(2).stores({
      orders: "id, syncState, createdAt, truckLocationId, deviceSequence",
      outbox: "id, aggregateId, operation, nextAttemptAt, createdAt",
      deviceState: "id, deviceId, truckLocationId, routeSessionId",
      inventory: "id, productCode, locationId, updatedAt",
    });
  }
}

export const db = new FieldDatabase();

export async function queueOrder(
  input: Omit<
    LocalOrder,
    "id" | "createdAt" | "syncState" | "deviceId" | "deviceSequence"
  > & {
    quantityBase: string;
    truckLocationId: string;
    routeSessionId: string;
  },
) {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  let order: LocalOrder | null = null;
  await db.transaction(
    "rw",
    db.orders,
    db.outbox,
    db.deviceState,
    db.inventory,
    async () => {
      const device = await getOrCreateDeviceState();
      if (
        device.routeSessionId !== input.routeSessionId ||
        device.truckLocationId !== input.truckLocationId
      )
        throw new Error(
          "Open and cache this truck route before selling offline",
        );
      const inventoryId = `${input.truckLocationId}:${input.productCode}`;
      const stock = await db.inventory.get(inventoryId);
      if (!stock)
        throw new Error("Truck inventory is not cached on this device");
      const requested = BigInt(input.quantityBase);
      const projected = BigInt(stock.projectedAvailableBase);
      if (requested > projected)
        throw new Error(
          `Only ${Number(projected) / Number(BigInt(stock.scale))} case(s) remain on this truck`,
        );
      const deviceSequence = device.lastIssuedSequence + 1;
      order = {
        ...input,
        id,
        createdAt,
        syncState: "queued",
        deviceId: device.deviceId,
        deviceSequence,
      };
      await db.orders.add(order);
      await db.outbox.add({
        id: crypto.randomUUID(),
        aggregateId: id,
        operation: "pos.sale",
        payload: order,
        attempts: 0,
        nextAttemptAt: createdAt,
        createdAt,
      });
      await db.deviceState.update("primary", {
        lastIssuedSequence: deviceSequence,
        updatedAt: createdAt,
      });
      await db.inventory.update(inventoryId, {
        projectedAvailableBase: (projected - requested).toString(),
        updatedAt: createdAt,
      });
    },
  );
  if (!order) throw new Error("Could not save sale locally");
  return order;
}

export async function getOrCreateDeviceState() {
  const existing = await db.deviceState.get("primary");
  if (existing) return existing;
  const state: DeviceState = {
    id: "primary",
    deviceId: crypto.randomUUID(),
    lastIssuedSequence: 0,
    updatedAt: Date.now(),
  };
  await db.deviceState.add(state);
  return state;
}

export async function saveRoute(input: {
  truckLocationId: string;
  routeSessionId: string;
  routeCode: string;
  lastAcknowledgedSequence: number;
}) {
  const state = await getOrCreateDeviceState();
  await db.deviceState.put({
    ...state,
    ...input,
    lastIssuedSequence: Math.max(
      state.lastIssuedSequence,
      input.lastAcknowledgedSequence,
    ),
    updatedAt: Date.now(),
  });
}

export async function replaceInventoryProjection(
  locationId: string,
  rows: {
    productCode: string;
    productName: string;
    locationCode: string;
    available: string;
  }[],
) {
  const queued = await db.orders
    .where("truckLocationId")
    .equals(locationId)
    .filter((order) => order.syncState !== "synced")
    .toArray();
  const pendingByProduct = new Map<string, bigint>();
  for (const order of queued)
    pendingByProduct.set(
      order.productCode,
      (pendingByProduct.get(order.productCode) ?? 0n) +
        BigInt(
          order.quantityBase ?? String(Math.round(order.quantity * 1_000)),
        ),
    );
  await db.transaction("rw", db.inventory, async () => {
    await db.inventory.where("locationId").equals(locationId).delete();
    await db.inventory.bulkPut(
      rows.map((row) => {
        const remote = BigInt(Math.round(Number(row.available) * 1_000));
        const projected =
          remote - (pendingByProduct.get(row.productCode) ?? 0n);
        return {
          id: `${locationId}:${row.productCode}`,
          productCode: row.productCode,
          productName: row.productName,
          locationId,
          locationCode: row.locationCode,
          scale: "1000",
          remoteAvailableBase: remote.toString(),
          projectedAvailableBase: (projected < 0n ? 0n : projected).toString(),
          updatedAt: Date.now(),
        };
      }),
    );
  });
}

export async function markSyncing(id: string) {
  await db.orders.update(id, { syncState: "syncing", lastError: undefined });
}
export async function markSynced(
  orderId: string,
  outboxId: string,
  remoteId: string,
  remoteMovementId?: string,
) {
  await db.transaction("rw", db.orders, db.outbox, async () => {
    await db.orders.update(orderId, {
      syncState: "synced",
      remoteId,
      remoteMovementId,
      lastError: undefined,
    });
    await db.outbox.delete(outboxId);
  });
}
export async function markFailed(item: OutboxItem, message: string) {
  const attempts = item.attempts + 1;
  const conflict = attempts >= 5;
  await db.transaction("rw", db.orders, db.outbox, async () => {
    await db.orders.update(item.aggregateId, {
      syncState: conflict ? "conflict" : "queued",
      lastError: message,
    });
    await db.outbox.update(item.id, {
      attempts,
      nextAttemptAt: Date.now() + Math.min(60_000, 1000 * 2 ** attempts),
    });
  });
}
