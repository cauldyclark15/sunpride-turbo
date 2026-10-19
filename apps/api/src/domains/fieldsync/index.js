import { readFileSync } from "node:fs";
import { roleHas } from "../../core/capabilities.js";
import { installProjections } from "./projections.js";
import {
  consent,
  consentState,
  endDay,
  live,
  recordLocation,
  storePins,
  trail,
} from "./location.js";
import { installJobs } from "./jobs.js";

/** @param {import('../../core/router.js').Router} router @param {any} ctx */
export function install(router, ctx) {
  installProjections(ctx);
  ctx.registerOp("location.record", recordLocation);
  ctx.registerTopic(
    "location",
    (/** @type {any} */ actor, /** @type {string} */ topic) =>
      topic === "location" && roleHas(actor.role, "location.read"),
  );
  router.get("/api/v1/location/live", live);
  router.get("/api/v1/location/trail", trail);
  router.get("/api/v1/location/store-pins", storePins);
  router.get("/api/v1/location/consent", consentState);
  router.post("/api/v1/location/consent", consent);
  router.post("/api/v1/location/end-day", endDay);
  const vanAbsent =
    readFileSync(new URL("../van/index.js", import.meta.url), "utf8").match(
      /placeholder:\s*replaced by lane van/,
    ) !== null;
  installJobs(ctx, vanAbsent);
}
