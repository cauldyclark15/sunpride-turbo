import Dexie, { type EntityTable } from "dexie";

export type LocalOrder = {
  id: string;
  customerCode: string;
  productCode: string;
  description: string;
  quantity: number;
  unitPrice: number;
  createdAt: number;
  syncState: "queued" | "syncing" | "synced" | "conflict";
  remoteId?: string;
  lastError?: string;
};
export type OutboxItem = {
  id: string;
  aggregateId: string;
  operation: "order.create";
  payload: LocalOrder;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
};

class FieldDatabase extends Dexie {
  orders!: EntityTable<LocalOrder, "id">;
  outbox!: EntityTable<OutboxItem, "id">;
  constructor() {
    super("sunpride-field-v1");
    this.version(1).stores({
      orders: "id, syncState, createdAt",
      outbox: "id, aggregateId, nextAttemptAt, createdAt",
    });
  }
}

export const db = new FieldDatabase();

export async function queueOrder(
  input: Omit<LocalOrder, "id" | "createdAt" | "syncState">,
) {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const order: LocalOrder = { ...input, id, createdAt, syncState: "queued" };
  await db.transaction("rw", db.orders, db.outbox, async () => {
    await db.orders.add(order);
    await db.outbox.add({
      id: crypto.randomUUID(),
      aggregateId: id,
      operation: "order.create",
      payload: order,
      attempts: 0,
      nextAttemptAt: createdAt,
      createdAt,
    });
  });
  return order;
}

export async function markSyncing(id: string) {
  await db.orders.update(id, { syncState: "syncing", lastError: undefined });
}
export async function markSynced(
  orderId: string,
  outboxId: string,
  remoteId: string,
) {
  await db.transaction("rw", db.orders, db.outbox, async () => {
    await db.orders.update(orderId, {
      syncState: "synced",
      remoteId,
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
