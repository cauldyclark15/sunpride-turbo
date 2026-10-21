import { tx } from "@sunpride/db/client";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { actorFor } from "../../core/context.js";
import { outletContext } from "../orders/access.js";
import { configureSap } from "./transport.js";
import { runOutbox } from "./outbox.js";
import { activateMasters, syncMasters } from "./replicas.js";
import { installMasterProjection } from "./projection.js";
import { sapCreditCheck, requestCreditOverride } from "./credit.js";
import { creditTerms, creditView } from "./credit-view.js";
import { installConsole, consoleAccess } from "./console.js";

/** @param {any} c */
async function customerAccess(c) {
  await requireCapability(c, "order.create");
  const code = c.body.customerCode;
  if (typeof code !== "string" || !code.length || code.length > 100)
    throw new ApiError("invalid_request", 400, "Choose an accounting customer");
  if (c.actor.role === "super_admin") return;
  if (!c.body.outletId)
    throw new ApiError("out_of_scope", 403, "Choose an assigned outlet");
  await outletContext(c, c.body.outletId, "order.create");
  const [linked] =
    await c.db`select 1 from customers c join outlet_customer_links l on l.customer_id=c.id where c.code=${code} and c.deleted_at is null and l.outlet_id=${c.body.outletId} and l.deleted_at is null and l.effective_from<=now() and (l.effective_to is null or l.effective_to>now())`;
  if (!linked)
    throw new ApiError(
      "out_of_scope",
      403,
      "Customer does not belong to this outlet",
    );
}
/** F-002 single gateway for field, office and van; no second connector ledger.
 * @param {any} router @param {any} ctx
 */
export function install(router, ctx) {
  ctx.env.SAP_MODE ??= "mock";
  configureSap(ctx.db, ctx.env);
  ctx.registerTopic(
    "integration",
    (/** @type {any} */ a, /** @type {string} */ topic) =>
      topic === "integration" && roleHas(a.role, "integration.read"),
  );
  installConsole(router, ctx);
  installMasterProjection(ctx);

  router.post(
    "/api/v1/integration/masters/sync",
    async (/** @type {any} */ c) => {
      await consoleAccess(c, true);
      const received = await syncMasters(c.db, ctx.env);
      await c.publish("integration");
      return { received };
    },
  );
  router.get("/api/v1/credit/exposure", async (/** @type {any} */ c) => {
    const body = {
      customerCode: c.url.searchParams.get("customerCode"),
      outletId: c.url.searchParams.get("outletId"),
    };
    await customerAccess({ ...c, body });
    const [snapshot] =
      await c.db`select * from sap_credit_decisions where customer_code=${body.customerCode} order by checked_at desc limit 1`;
    const items =
      await c.db`select * from (select distinct on(sap_key) * from sap_replicas where kind='ar' and effective_from<=now() order by sap_key,sap_version desc) r where deleted_at is null and (effective_to is null or effective_to>now()) and payload->'data'->>'customerCode'=${body.customerCode} order by sap_key`;
    return {
      source: "sap",
      freshness: !snapshot
        ? "unknown"
        : new Date(snapshot.expires_at).getTime() <= Date.now()
          ? "stale"
          : "cached",
      asOf: snapshot ? new Date(snapshot.checked_at).getTime() : null,
      limitCentavos:
        snapshot?.limit_centavos === null || !snapshot
          ? null
          : Number(snapshot.limit_centavos),
      exposureCentavos:
        snapshot?.exposure_centavos === null || !snapshot
          ? null
          : Number(snapshot.exposure_centavos),
      policy: "capture_pending_only_without_live_decision",
      openItems: items.map((/** @type {any} */ r) => ({
        ...r.payload.data,
        source: r.source,
        version: Number(r.sap_version),
        receivedAt: new Date(r.received_at).getTime(),
      })),
    };
  });
  router.post("/api/v1/credit/check", async (/** @type {any} */ c) => {
    await customerAccess(c);
    const decision = await sapCreditCheck(
      c.db,
      c.body.customerCode,
      c.body.amountCentavos,
      {
        env: ctx.env,
      },
    );
    const at = Date.now();
    return {
      ...decision,
      creditSnapshot: creditView(
        decision,
        await creditTerms(c.db, c.body.outletId ?? null, at),
        c.body.customerCode,
        at,
      ),
    };
  });
  router.post(
    "/api/v1/credit/request-override",
    async (/** @type {any} */ c) => {
      await customerAccess(c);
      return tx(c.db, async (db) => {
        const actor = await actorFor(db, c.actor.userId);
        const current = { ...c, db, actor };
        await customerAccess(current);
        return requestCreditOverride(current, c.body);
      });
    },
  );
  ctx.scheduler.every(1000, "sap.outbox", async () => {
    if (await runOutbox(ctx.db, { env: ctx.env }))
      await ctx.publish("integration");
  });
  ctx.scheduler.every(60000, "sap.masters", async () => {
    await syncMasters(ctx.db, ctx.env);
    await activateMasters(ctx.db);
    await ctx.publish("integration");
  });
}
