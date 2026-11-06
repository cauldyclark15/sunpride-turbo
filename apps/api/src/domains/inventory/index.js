import { roleHas } from "../../core/capabilities.js";
import { commands, execute } from "./commands.js";
import { visibleLocations } from "./common.js";
import { installIntegrityRoutes, installJobs } from "./jobs.js";
import { installDispositionRoutes } from "./dispositions.js";
import { installValuationRoutes } from "./valuation.js";
import { installCommandExtensions } from "./extensions.js";
import { installCountRoutes } from "./counts.js";
import { installReasonRoutes } from "./reasons.js";
import { installToleranceRoutes } from "./tolerances.js";
import { installTransferRoutes } from "./transfers.js";
import { installReceivingRoutes } from "./receiving.js";
import { lots, policies } from "./reference.js";
import {
  catalog,
  countDetail,
  documents,
  movements,
  negative,
  overview,
  productDetail,
  suggestions,
  trace,
} from "./queries.js";

/** @param {import('../../core/router.js').Router} router @param {any} core */
export function install(router, core) {
  installCommandExtensions();
  const prefix = "/api/v1/inventory";
  router.get(`${prefix}/overview`, overview);
  router.get(`${prefix}/products`, catalog);
  router.get(`${prefix}/product`, productDetail);
  router.get(`${prefix}/locations`, async (c) =>
    (await visibleLocations(c)).map((l) => ({
      id: l.id,
      _id: l.id,
      code: l.code,
      name: l.name,
      type: l.type,
      orgUnitId: l.org_unit_id,
      active: l.active,
    })),
  );
  router.get(`${prefix}/movements`, (c) => movements(c));
  router.get(`${prefix}/trace`, trace);
  router.get(`${prefix}/lots`, lots);
  router.get(`${prefix}/policies`, policies);
  router.get(`${prefix}/counts/detail`, countDetail);
  router.get(`${prefix}/negative`, negative);
  router.get(`${prefix}/replenishment`, suggestions);
  installReasonRoutes(router);
  installToleranceRoutes(router);
  // IP-VALUE: stock card, valuation, dispositions + expiry board, integrity (adds commands before they are routed below)
  installValuationRoutes(router);
  installDispositionRoutes(router);
  installIntegrityRoutes(router, core);
  installTransferRoutes(router);
  installReceivingRoutes(router);
  installCountRoutes(router, core);
  for (const kind of [
    "receipts",
    "transfers",
    "counts",
    "adjustments",
    "reservations",
  ])
    router.get(`${prefix}/${kind}`, (c) => documents(c, kind));
  for (const action of Object.keys(commands))
    router.post(`${prefix}/${action}`, (c) => execute(c, action));
  core.registerTopic(
    "inventory",
    (/** @type {any} */ actor, /** @type {string} */ topic) =>
      topic === "inventory" && roleHas(actor.role, "inventory.read"),
  );
  installJobs(core);
}
