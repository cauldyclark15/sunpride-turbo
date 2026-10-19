import { roleHas } from "../../core/capabilities.js";
import { enqueue } from "../../core/jobs.js";
import { enqueueRefresh } from "../analytics/refresh.js";
import { drainFieldOrders, installFieldReview } from "./field-queue.js";
import { installOrderRoutes } from "./routes.js";
import { installOutsideRoutes } from "./outside.js";
import { installPricingRoutes } from "./pricing-routes.js";

/** @param {any} router @param {any} ctx */
export function install(router, ctx) {
  installOrderRoutes(router);
  installOutsideRoutes(router);
  installPricingRoutes(router);
  installFieldReview(router);
  ctx.scheduler.every(5000, "orders.field-capture", () =>
    drainFieldOrders(ctx),
  );
  ctx.registerTopic("orders", (/** @type {any} */ actor) =>
    roleHas(actor.role, "report.read"),
  );
  ctx.registerJob("orders.refresh", async (/** @type {any} */ job) => {
    await enqueueRefresh(
      {
        db: job.db,
        now: Date.now(),
        publish: ctx.publish,
        enqueue: (/** @type {any} */ spec) => enqueue(job.db, spec),
      },
      { kind: "order", date: job.payload.date, unitId: job.payload.unitId },
    );
  });
}

export { captureFieldOrder } from "./field.js";
