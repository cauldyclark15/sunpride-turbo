import { tx } from "@sunpride/db/client";
import { ApiError, invalid } from "../../core/errors.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { OpRejected } from "../../core/sync.js";
import { enqueue } from "../../core/jobs.js";
import { scopeFor, periodFor } from "../analytics/measures.js";
import { date, manilaDate, uuid } from "../visits/shared.js";
import { createRelease, preview, publishRelease, manage } from "./masters.js";
import { callSnapshot, record, decideProposal } from "./calls.js";
import { createUniverse, launchStatus } from "./metrics.js";

/** @param {any} router @param {any} installCtx */
export function install(router, installCtx) {
  installCtx.registerTopic("availability", (/** @type {any} */ a) =>
    roleHas(a.role, "outlet.read"),
  );
  /** @param {any} fn @param {string} [capability] */
  const command =
    (fn, capability = "masterdata.manage") =>
    async (/** @type {any} */ ctx) => {
      await requireCapability(ctx, capability);
      const topics = new Set();
      const result = await tx(ctx.db, async (db) =>
        fn({
          ...ctx,
          db,
          app: "web",
          payload: ctx.body,
          change: (
            /** @type {string} */ entity,
            /** @type {string} */ entityId,
            /** @type {string} */ scopeKey,
          ) => installCtx.recordChange(db, { entity, entityId, scopeKey }),
          enqueue: (/** @type {any} */ job) => enqueue(db, job),
          publish: (/** @type {string} */ topic) => topics.add(topic),
        }),
      );
      for (const topic of topics) await ctx.publish(topic);
      return result;
    };
  router.get(
    "/api/v1/availability/releases",
    async (/** @type {any} */ ctx) => {
      await manage(ctx);
      const rows =
        await ctx.db`select * from availability_releases order by created_at desc,id desc limit 501`;
      if (rows.length > 500)
        throw invalid(
          "Release history exceeds 500 rows; archive through an approved retention process",
        );
      const products =
        await ctx.db`select id,code,name from products where active and deleted_at is null order by code limit 1001`;
      if (products.length > 1000)
        throw invalid("Narrow the product catalog before editing MSL");
      const outlets =
        await ctx.db`select o.id,o.code,o.name,o.channel,o.subchannel,o.classification,o.enrolment_status,o.sales_potential,(select a.territory_id from outlet_assignments a where a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())) as "territoryId" from outlets o where o.organization_id='sunpride' and o.status='active' and o.deleted_at is null order by o.code limit 1001`;
      if (outlets.length > 1000)
        throw invalid("Narrow the store list before bulk preview");
      const territories =
        await ctx.db`select id,code,name from territories where organization_id='sunpride' and deleted_at is null order by code limit 1001`;
      if (territories.length > 1000)
        throw invalid("Narrow the territory list before editing");
      return { rows, products, outlets, territories };
    },
  );
  router.post("/api/v1/availability/releases/create", command(createRelease));
  router.post("/api/v1/availability/releases/preview", command(preview));
  router.post("/api/v1/availability/releases/publish", command(publishRelease));
  router.post("/api/v1/availability/universe/publish", command(createUniverse));
  router.get("/api/v1/availability/call", async (/** @type {any} */ ctx) =>
    tx(ctx.db, (db) =>
      callSnapshot(
        { ...ctx, db, app: "web" },
        uuid(ctx.url.searchParams.get("outletId")),
        date(ctx.url.searchParams.get("serviceDate") ?? manilaDate(ctx.now)),
      ),
    ),
  );
  router.post("/api/v1/availability/check", command(record, "visit.record"));
  router.post(
    "/api/v1/availability/proposal",
    command(decideProposal, "order.create"),
  );
  router.get("/api/v1/availability/launch", async (/** @type {any} */ ctx) =>
    tx(ctx.db, async (db) => {
      const c = { ...ctx, db },
        scope = await scopeFor(c),
        period = periodFor(c);
      return launchStatus(
        c,
        scope,
        uuid(ctx.url.searchParams.get("id")),
        period.to,
      );
    }),
  );
  for (const [kind, fn] of Object.entries({
    "availability.record": record,
    "availability.proposal": decideProposal,
  })) {
    installCtx.registerOp(kind, async (/** @type {any} */ ctx) => {
      try {
        return await fn(ctx);
      } catch (e) {
        if (e instanceof ApiError)
          throw new OpRejected(
            e.status === 403
              ? "out_of_scope"
              : e.code === "idempotency_conflict"
                ? "idempotency_conflict"
                : "invalid_request",
          );
        throw e;
      }
    });
  }
  installCtx.registerProjection("availability.call", {
    params: (/** @type {any} */ p) => ({
      outletId: uuid(p.outletId),
      serviceDate: date(p.serviceDate),
    }),
    snapshot: async (/** @type {any} */ ctx) => ({
      data: await callSnapshot(
        ctx,
        ctx.params.outletId,
        ctx.params.serviceDate,
      ),
      next: null,
    }),
    scopeKeys: () => {
      throw new ApiError(
        "rebootstrap_required",
        409,
        "Download a new call checklist",
      );
    },
  });
}
