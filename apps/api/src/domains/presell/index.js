import { tx } from "@sunpride/db/client";
import { join } from "node:path";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { ApiError, invalid } from "../../core/errors.js";
import { OpRejected } from "../../core/sync.js";
import { filesDir } from "../../core/media.js";
import { uuid } from "../orders/validation.js";
import {
  actions,
  command,
  board,
  manifest,
  dropFor,
  processHandoff,
  processNotification,
} from "./service.js";
import { recordProof, recordTiming, processVariance } from "./driver.js";

/** @param {any} router @param {any} platform */
export function install(router, platform) {
  platform.registerTopic("delivery", (/** @type {any} */ actor) =>
    roleHas(actor.role, "van.read"),
  );
  for (const name of Object.keys(actions))
    router.post(`/api/v1/presell/${name}`, (/** @type {any} */ ctx) =>
      command(ctx, /** @type {keyof typeof actions} */ (name)),
    );
  router.get("/api/v1/presell/board", board);
  router.get("/api/v1/presell/manifest", (/** @type {any} */ ctx) =>
    tx(ctx.db, (db) => manifest({ ...ctx, db })),
  );
  router.get("/api/v1/presell/settings", async (/** @type {any} */ ctx) => {
    await requireCapability(ctx, "admin.manage");
    const policies =
      await ctx.db`select * from presell_policies order by effective_from desc limit 101`;
    if (policies.length > 100)
      throw invalid("Policy history exceeds 100 versions");
    return { policies };
  });
  router.get("/api/v1/presell/drop", async (/** @type {any} */ ctx) =>
    tx(ctx.db, async (db) => {
      const c = { ...ctx, db },
        drop = await dropFor(c, ctx.url.searchParams.get("dropId"));
      const lines =
        await db`select * from delivery_drop_lines where drop_id=${drop.id} order by ordinal`;
      const [proof] =
        await db`select pr.*,p.name as driver_name from delivery_proofs pr join profiles p on p.id=pr.profile_id where drop_id=${drop.id}`;
      const variances = proof
        ? await db`select * from delivery_variances where proof_id=${proof.id}`
        : [];
      const slots =
        await db`select * from delivery_receiving_slots where outlet_id=${drop.outlet_id} and ends_at>now() order by starts_at limit 101`;
      if (slots.length > 100) throw invalid("Too many receiving slots");
      const messages =
        await db`select id,channel,status,attempts,eta from delivery_notification_outbox where drop_id=${drop.id} order by created_at desc limit 100`;
      return {
        drop,
        lines,
        proof: proof
          ? {
              ...proof,
              device_id: undefined,
              profile_id: undefined,
              operation_key: undefined,
              payload_hash: undefined,
            }
          : null,
        variances,
        slots,
        messages,
      };
    }),
  );
  router.get("/api/v1/presell/photo", async (/** @type {any} */ ctx) => {
    const file = await tx(ctx.db, async (db) => {
      const c = { ...ctx, db },
        drop = await dropFor(c, ctx.url.searchParams.get("dropId"));
      const [f] =
        await db`select f.path from delivery_proofs p join van_damage_photos v on v.id=p.photo_id join files f on f.id=v.storage_id where p.drop_id=${drop.id} and f.status='stored'`;
      return f;
    });
    if (!file) throw invalid("Delivery photo not found");
    return new Response(Bun.file(join(filesDir(ctx.env), file.path)), {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "private, no-store",
      },
    });
  });
  router.get("/api/v1/presell/sink", async (/** @type {any} */ ctx) => {
    await requireCapability(ctx, "integration.read");
    const rows =
      await ctx.db`select s.*,n.drop_id from delivery_notification_sink s join delivery_notification_outbox n on n.id=s.notification_id order by s.created_at desc limit 101`;
    if (rows.length > 100) throw invalid("Dev sink exceeds 100 messages");
    const allowed = [];
    for (const r of rows) {
      try {
        await dropFor(ctx, r.drop_id);
        allowed.push(r);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 403) throw e;
      }
    }
    return { adapter: "mock", externalMessagesSent: 0, rows: allowed };
  });
  for (const [kind, handler] of Object.entries({
    "delivery.confirm": recordProof,
    "delivery.timing": recordTiming,
  }))
    platform.registerOp(kind, async (/** @type {any} */ ctx) => {
      try {
        return await handler(ctx);
      } catch (e) {
        if (e instanceof ApiError)
          throw new OpRejected(
            e.status === 403
              ? "out_of_scope"
              : e.status === 409
                ? "idempotency_conflict"
                : "invalid_request",
          );
        throw e;
      }
    });
  platform.registerJob("presell.handoff", async (/** @type {any} */ c) => {
    await processHandoff(c.db, c.payload.id);
    await platform.publish("delivery");
  });
  platform.registerJob("presell.notify", async (/** @type {any} */ c) => {
    await processNotification(c.db, c.payload.id);
    await platform.publish("delivery");
  });
  platform.registerJob("presell.variance", async (/** @type {any} */ c) => {
    await processVariance(c.db, c.payload.id);
    await platform.publish("delivery");
  });
}
