import { tx } from "@sunpride/db/client";
import { enqueue } from "../../core/jobs.js";
import { bounded } from "./common.js";
import { publishScore } from "./scoring.js";
/** F-316: daily catch-up publishes the last completed week; unchanged facts reuse the same revision.
 * The durable worker processes one account per transaction, never a nationwide score transaction.
 * @param {number} at */
export function previousWeek(at) {
  const today = new Date(at + 8 * 3600000).toISOString().slice(0, 10),
    dow = new Date(today).getUTCDay();
  return new Date(Date.parse(today) - (((dow + 6) % 7) + 7) * 86400000)
    .toISOString()
    .slice(0, 10);
}
/** @param {any} installCtx */
export function installWeekly(installCtx) {
  installCtx.scheduler.daily(
    "00:15",
    "Asia/Manila",
    "retail.weekly.queue",
    async (/** @type {any} */ c) => {
      const now = Date.now(),
        week = previousWeek(now),
        day = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
      const accounts = bounded(
        await c.db`select distinct customer_id from outlet_customer_links where deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now()) order by customer_id limit 5001`,
        5000,
      );
      for (const row of accounts)
        await enqueue(c.db, {
          kind: "retail.weekly.publish",
          key: `${week}:${row.customer_id}:${day}`,
          payload: { customerId: row.customer_id, weekStart: week },
        });
    },
  );
  installCtx.registerJob(
    "retail.weekly.publish",
    async (/** @type {any} */ c) => {
      const topics = new Set();
      await tx(c.db, async (db) => {
        await publishScore({
          ...c,
          db,
          body: c.payload,
          now: Date.now(),
          actor: {
            subject: "system:retail-weekly",
            role: "super_admin",
            profileId: null,
            orgUnitId: null,
          },
          change: (
            /** @type {string} */ entity,
            /** @type {string} */ entityId,
            /** @type {string} */ scopeKey,
          ) => installCtx.recordChange(db, { entity, entityId, scopeKey }),
          publish: (/** @type {string} */ topic) => topics.add(topic),
        });
      });
      for (const topic of topics) await installCtx.publish(topic);
    },
  );
}
