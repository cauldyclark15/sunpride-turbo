// v2 spec PROGRAMME (F-025 traceability): read-only programme page for administrators and the owner.
// Rows are loaded by packages/db/seed/programme.js; the API never writes them.
import { requireCapability } from "../../core/capabilities.js";
import { overview } from "./queries.js";

/** @param {import('../../core/router.js').Router} router */
export function install(router) {
  router.get("/api/v1/programme/overview", async (/** @type {any} */ ctx) => {
    await requireCapability(ctx, "admin.manage");
    return overview(ctx.db);
  });
}
