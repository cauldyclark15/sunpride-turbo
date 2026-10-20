import { tx } from "@sunpride/db/client";
import { roleHas } from "../../core/capabilities.js";
import { scopeFor, periodFor, header, csv } from "./measures.js";
import {
  todayPage,
  salesPage,
  coveragePage,
  agentDayPage,
} from "./sales-coverage.js";
import { storesPage, storePage } from "./stores.js";
import { stockPage, vansPage, moneyPage } from "./stock-money.js";
import { exceptionsPage } from "./exceptions.js";
import { listTargets, setTargets } from "./targets.js";
import { installRefresh } from "./refresh.js";
import { installAlerts } from "./alerts.js";
import { orderedDb } from "./ordered-db.js";
import { xlsx } from "./xlsx.js";
import { coverageAvailabilityPage } from "./availability-adapter.js";
import {
  primarySecondaryPage,
  demandSignalPage,
  installPlanning,
} from "./trade-planning.js";
import { fraudPage, installPolicies } from "./context-adapter.js";

/** @param {any} router @param {any} installCtx */
export function install(router, installCtx) {
  installRefresh(installCtx);
  installPlanning(router, installCtx);
  installPolicies(router, installCtx);
  installAlerts(router, installCtx);
  installCtx.registerTopic("analytics", (/** @type {any} */ actor) =>
    roleHas(actor.role, "report.read"),
  );
  const handlers =
    /** @type {Record<string,(ctx:any,p:any,s:any)=>Promise<any>>} */ ({
      today: todayPage,
      sales: (ctx, p, s) =>
        salesPage(
          ctx.db,
          p,
          s,
          ctx.url.searchParams.get("groupBy") ?? "channel",
          ctx.url.searchParams.get("parent"),
        ),
      coverage: (ctx, p, s) =>
        coveragePage(
          ctx.db,
          p,
          s,
          ctx.url.searchParams.get("groupBy") ?? "agent",
        ),
      "agent-day": agentDayPage,
      stores: storesPage,
      store: storePage,
      stock: (ctx, p, s) => stockPage(ctx.db, p, s),
      vans: (ctx, p, s) => vansPage(ctx.db, p, s),
      money: (ctx, p, s) => moneyPage(ctx.db, p, s),
      exceptions: exceptionsPage,
      "coverage-availability": coverageAvailabilityPage,
      "primary-secondary": primarySecondaryPage,
      "demand-signals": demandSignalPage,
      fraud: fraudPage,
    });
  for (const [page, handler] of Object.entries(handlers)) {
    router.get(`/api/v1/analytics/${page}`, async (/** @type {any} */ ctx) =>
      tx(ctx.db, async (db) => {
        await db`set transaction isolation level repeatable read read only`;
        await db`set local jit=off`;
        await db`set local work_mem='64MB'`;
        await db`set local plan_cache_mode='force_custom_plan'`;
        const local = { ...ctx, db: orderedDb(db) },
          s = await scopeFor(local),
          p = periodFor(
            local,
            ["today", "agent-day"].includes(page) ||
              (page === "vans" && ctx.url.searchParams.has("date")),
          );
        const [head, body] = await Promise.all([
          header(local, p, s),
          handler(local, p, s),
        ]);
        const response = {
          ...head,
          ...body,
          demo: head.demo || body.demo === true,
          definitionVersion: "commercial/v1",
        };
        if (ctx.url.searchParams.get("format") === "xlsx")
          return xlsx(response, page);
        return ctx.url.searchParams.get("format") === "csv" &&
          Array.isArray(body.rows)
          ? csv(body.rows)
          : response;
      }),
    );
  }
  router.get("/api/v1/targets", async (/** @type {any} */ ctx) => {
    const result = await listTargets(ctx);
    if (ctx.url.searchParams.get("format") === "xlsx")
      return xlsx(result, "targets");
    return ctx.url.searchParams.get("format") === "csv"
      ? csv(result.rows)
      : result;
  });
  router.post("/api/v1/targets/set", (/** @type {any} */ ctx) =>
    setTargets(ctx, false, installCtx),
  );
  router.post("/api/v1/targets/import", (/** @type {any} */ ctx) =>
    setTargets(ctx, true, installCtx),
  );
}
