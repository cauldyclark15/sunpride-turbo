import { join } from "node:path";
import { filesDir } from "../../core/media.js";
import { notFound } from "../../core/errors.js";
import { gate, invalid, integer, userLite } from "./model.js";
import {
  types,
  resolveRefs,
  resolveType,
  searchType,
  thumbBlob,
  SEARCH_BUDGET,
} from "./refs/common.js";
/** @param {import('../../core/router.js').Router} router */
export function installDirectory(router) {
  router.get("/api/v1/messaging/users/search", async (c) => {
    const a = await gate(c),
      q = c.url.searchParams.get("q") ?? "",
      limit = integer(c.url.searchParams.get("limit"), 20, 100);
    const refs = await searchType(c.db, a, q.slice(0, 200), limit, "user");
    return Promise.all(
      refs.map(async (r) => ({
        ...(await userLite(c.db, r.id)),
        role_label: r.subtitle,
      })),
    );
  });
  router.get("/api/v1/messaging/refs/search", async (c) => {
    const a = await gate(c),
      q = (c.url.searchParams.get("q") ?? "").slice(0, 200),
      limit = integer(c.url.searchParams.get("limit"), 20, 100);
    const wanted = (c.url.searchParams.get("types") ?? types.join(",")).split(
      ",",
    );
    if (wanted.some((t) => !types.includes(t)))
      throw invalid("Unknown reference type");
    // Each readable type gets its own candidate budget, so one call does at most
    // types × SEARCH_BUDGET row checks however large or restricted the tables are.
    const result = [];
    for (const t of new Set(wanted)) {
      if (result.length >= limit) break;
      result.push(
        ...(await searchType(c.db, a, q, limit, t, { left: SEARCH_BUDGET })),
      );
    }
    return result.slice(0, limit);
  });
  router.post("/api/v1/messaging/refs/resolve", async (c) => {
    const a = await gate(c);
    if (!Array.isArray(c.body?.refs) || c.body.refs.length > 100)
      throw invalid("Resolve at most 100 references");
    return resolveRefs(c.db, a, c.body.refs);
  });
  router.get("/api/v1/messaging/refs/:type/:id/thumb", async (c) => {
    const a = await gate(c),
      { type, id } = c.params;
    const [r] = await resolveType(c.db, a, [id], type);
    if (r?.access !== "ok") throw notFound();
    const blob = await thumbBlob(c.db, type, id);
    const [f] = blob
      ? await c.db`select * from files where id=${blob} and status='stored'`
      : [];
    if (!f?.path) throw notFound();
    return new Response(Bun.file(join(filesDir(c.env), f.path)), {
      headers: { "content-type": f.mime, "x-content-type-options": "nosniff" },
    });
  });
}
