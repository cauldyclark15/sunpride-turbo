import type { ConvexReactClient } from "convex/react";
import { api } from "@sunpride/backend/api";
import { db, markFailed, markSynced, markSyncing } from "./database";

let running = false;
export async function syncOutbox(client: ConvexReactClient) {
  if (running || !navigator.onLine) return;
  running = true;
  try {
    const items = await db.outbox
      .where("nextAttemptAt")
      .belowOrEqual(Date.now())
      .sortBy("createdAt");
    for (const item of items) {
      await markSyncing(item.aggregateId);
      try {
        const remoteId = await client.mutation(api.domains.orders.create, {
          clientRequestId: item.aggregateId,
          customerCode: item.payload.customerCode,
          offlineCreatedAt: item.payload.createdAt,
          lines: [
            {
              productCode: item.payload.productCode,
              description: item.payload.description,
              quantity: item.payload.quantity,
              unitPrice: item.payload.unitPrice,
            },
          ],
        });
        await markSynced(item.aggregateId, item.id, remoteId);
      } catch (error) {
        await markFailed(
          item,
          error instanceof Error ? error.message : "Sync failed",
        );
      }
    }
  } finally {
    running = false;
  }
}
