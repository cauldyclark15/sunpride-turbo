import type { ConvexReactClient } from "convex/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
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
        if (
          item.operation === "pos.sale" &&
          item.payload.truckLocationId &&
          item.payload.routeSessionId &&
          item.payload.deviceId &&
          item.payload.deviceSequence !== undefined
        ) {
          const result = await client.mutation(api.inventory.pos.postSale, {
            clientRequestId: item.aggregateId,
            customerCode: item.payload.customerCode,
            truckLocationId: item.payload
              .truckLocationId as Id<"inventoryLocations">,
            routeSessionId: item.payload
              .routeSessionId as Id<"truckRouteSessions">,
            deviceId: item.payload.deviceId,
            deviceSequence: item.payload.deviceSequence,
            offlineCreatedAt: item.payload.createdAt,
            lines: [
              {
                productCode: item.payload.productCode,
                description: item.payload.description,
                quantityBase: BigInt(
                  item.payload.quantityBase ??
                    String(Math.round(item.payload.quantity * 1_000)),
                ),
                quantity: item.payload.quantity,
                unitPrice: item.payload.unitPrice,
              },
            ],
          });
          await markSynced(
            item.aggregateId,
            item.id,
            result.orderId,
            result.movementId,
          );
        } else {
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
        }
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
