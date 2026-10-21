import { tx } from "@sunpride/db/client";
import { invalid, conflict, forbidden } from "../../core/errors.js";
import { requireCapability } from "../../core/capabilities.js";
import { actorFor } from "../../core/context.js";
import { enqueue } from "../../core/jobs.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { geographyCommand } from "../org/commands.js";
import { writeAudit } from "../org/audit.js";
import { ORG_LOCK } from "../org/identity.js";
import { uuid } from "../org/model.js";
const hash = (/** @type {any} */ v) => sha256Hex(canonicalJson(v));
/** F-224 bounded, literal GeoJSON; coordinates are longitude/latitude, including holes. @param {any} raw */
export function geometry(raw) {
  let g;
  try {
    g = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw invalid("Invalid boundary JSON");
  }
  if (g?.type === "Feature") g = g.geometry;
  if (!g || !["Polygon", "MultiPolygon"].includes(g.type))
    throw invalid("Use Polygon or MultiPolygon GeoJSON");
  const polygons = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  if (!Array.isArray(polygons) || !polygons.length || polygons.length > 10)
    throw invalid("Use 1 to 10 polygons");
  let count = 0;
  for (const p of polygons) {
    if (!Array.isArray(p) || !p.length || p.length > 10)
      throw invalid("Invalid polygon rings");
    for (const ring of p) {
      if (!Array.isArray(ring) || ring.length < 4)
        throw invalid("A polygon ring needs at least four coordinates");
      for (const pt of ring) {
        if (
          !Array.isArray(pt) ||
          pt.length !== 2 ||
          !pt.every(Number.isFinite) ||
          Math.abs(pt[0]) > 180 ||
          Math.abs(pt[1]) > 90
        )
          throw invalid("Invalid longitude/latitude");
        if (++count > 1000)
          throw invalid("Use at most 1,000 boundary coordinates");
      }
      if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])
        throw invalid("Close every polygon ring");
    }
  }
  return g;
}
/** @param {number[]} point @param {number[][]} ring */
function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
/** @param {any} g @param {number[]} point */
export function contains(g, point) {
  return (g.type === "Polygon" ? [g.coordinates] : g.coordinates).some(
    (/** @type {number[][][]} */ p) =>
      inRing(point, p[0]) && !p.slice(1).some((r) => inRing(point, r)),
  );
}
/** Frozen selection; the server expands whole routes rather than trusting a partial client list. @param {any} raw */
export function scenarioPlan(raw = {}) {
  if (raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw))
    throw invalid("Invalid scenario plan");
  const routeMoves = raw.routeMoves ?? [],
    boundaries = raw.boundaries ?? [];
  if (
    !Array.isArray(routeMoves) ||
    routeMoves.length > 10 ||
    !Array.isArray(boundaries) ||
    boundaries.length > 10
  )
    throw invalid("Use at most ten route or boundary changes");
  const routingMode = raw.routingMode ?? "estimate";
  if (!["estimate", "road"].includes(routingMode))
    throw invalid("Choose road routing or the SAMPLE estimate");
  const r = routeMoves.map((/** @type {any} */ m) => ({
    routeId: uuid(m.routeId),
    toTerritoryId: uuid(m.toTerritoryId),
  }));
  const b = boundaries.map((/** @type {any} */ m) => ({
    territoryId: uuid(m.territoryId),
    geoJson: geometry(m.geoJson),
  }));
  if (
    new Set(r.map((/** @type {any} */ m) => m.routeId)).size !== r.length ||
    new Set(b.map((/** @type {any} */ m) => m.territoryId)).size !== b.length
  )
    throw invalid("Change each route/boundary once");
  return { routeMoves: r, boundaries: b, routingMode };
}
/** @param {any} c @param {ReturnType<typeof scenarioPlan>} plan */
export async function routeSelection(c, plan) {
  await requireCapability(c, "route.manage");
  const selected = [];
  for (const m of plan.routeMoves) {
    const [r] =
      await c.db`select r.id,r.name,rt.territory_id,rt.id association_id from routes r join route_territories rt on rt.route_id=r.id where r.id=${m.routeId} and r.status='active' and r.deleted_at is null and rt.deleted_at is null and rt.effective_from<=now() and (rt.effective_to is null or rt.effective_to>now())`;
    if (!r || r.territory_id === m.toTerritoryId)
      throw invalid("Move a current whole route to another territory");
    const stops =
      await c.db`select s.id,s.territory_id,s.route_id,(select a.sequence from outlet_assignments a where a.outlet_id=s.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) order by a.effective_from desc limit 1) sequence from analytics_store_scope s where s.route_id=${r.id} and s.status='active' order by sequence,s.id limit 101`;
    if (!stops.length || stops.length > 100)
      throw invalid("A route move needs 1 to 100 active stores");
    selected.push({ ...r, toTerritoryId: m.toTerritoryId, stops });
  }
  return selected;
}
/** @param {any} f @param {any[]} explicit @param {any[]} routes @param {ReturnType<typeof scenarioPlan>} plan */
export function expandMoves(f, explicit, routes, plan) {
  const moves = new Map(explicit.map((m) => [m.outletId, m]));
  for (const r of routes)
    for (const s of r.stops) {
      const old = moves.get(s.id);
      if (old && old.toTerritoryId !== r.toTerritoryId)
        throw invalid("A whole route conflicts with an individual move");
      moves.set(s.id, {
        outletId: s.id,
        toTerritoryId: r.toTerritoryId,
        routeId: r.id,
        sequence: Number(s.sequence),
      });
    }
  for (const s of f.stores.filter((/** @type {any} */ s) =>
    plan.boundaries.some((b) => b.territoryId === s.territory_id),
  )) {
    if (moves.has(s.id)) continue;
    if (s.latitude == null || s.longitude == null)
      throw invalid(
        `${s.name} has no verified pin; give it an explicit destination before changing boundaries`,
      );
    const matches = plan.boundaries.filter((b) =>
      contains(b.geoJson, [Number(s.longitude), Number(s.latitude)]),
    );
    if (matches.length !== 1)
      throw invalid(
        `${s.name} is outside or overlaps the proposed boundaries; give it an explicit destination`,
      );
    if (matches[0].territoryId !== s.territory_id)
      moves.set(s.id, {
        outletId: s.id,
        toTerritoryId: matches[0].territoryId,
      });
  }
  const result = [...moves.values()];
  if (result.length > 100) throw invalid("A scenario moves at most 100 stores");
  return result;
}
/** Nearest-neighbour road tour, not a claim of an optimal beat or live traffic. @param {any[]} stores */
function points(stores) {
  const left = stores
    .filter((s) => s.latitude != null && s.longitude != null)
    .map((s) => [Number(s.longitude), Number(s.latitude)]);
  if (left.length < 2) return left;
  /** @type {number[][]} */ const out = [
    /** @type {number[]} */ (left.shift()),
  ];
  while (left.length) {
    const at = out[out.length - 1];
    let best = 0;
    for (let i = 1; i < left.length; i++)
      if (
        (left[i][0] - at[0]) ** 2 + (left[i][1] - at[1]) ** 2 <
        (left[best][0] - at[0]) ** 2 + (left[best][1] - at[1]) ** 2
      )
        best = i;
    out.push(left.splice(best, 1)[0]);
  }
  out.push(out[0]);
  return out;
}
/** Optional trusted operator-configured OSRM origin. Default stays free/offline/SAMPLE. @param {any} c @param {any} f @param {any[]} moves @param {any[]} sim @param {ReturnType<typeof scenarioPlan>} plan */
export async function roadWorkloads(c, f, moves, sim, plan) {
  const destination = new Map(moves.map((m) => [m.outletId, m.toTerritoryId]));
  const tasks = sim.flatMap((t) =>
    ["before", "after"].map((phase) => ({ t, phase })),
  );
  const deadline = Date.now() + 8000;
  async function one(/** @type {any} */ task) {
    const { t, phase } = task,
      w = t[phase];
    w.travelSource =
      "SAMPLE geometric estimate · no road graph or live traffic";
    w.provisionalTravel = true;
    if (plan.routingMode !== "road") return;
    const stores = f.stores.filter(
        (/** @type {any} */ s) =>
          (phase === "before"
            ? s.territory_id
            : (destination.get(s.id) ?? s.territory_id)) === t.territoryId,
      ),
      pts = points(stores);
    try {
      const origin = new URL(c.env?.ROUTING_OSRM_ORIGIN ?? "");
      if (
        !["http:", "https:"].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.search ||
        origin.hash ||
        origin.pathname !== "/"
      )
        throw Error("Invalid operator origin");
      if (pts.length > 101 || (pts.length < 2 && w.unpinned > 0))
        throw Error("Routing bound");
      let duration = 0;
      if (pts.length > 1) {
        const url = new URL(
          "/route/v1/driving/" + pts.map((p) => p.join(",")).join(";"),
          origin,
        );
        url.search =
          "overview=false&steps=false&alternatives=false&skip_waypoints=true";
        const res = await fetch(url, {
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(2000, deadline - Date.now())),
          ),
          redirect: "error",
        });
        if (!res.ok || Number(res.headers.get("content-length")) > 100000)
          throw Error("Routing unavailable");
        const reader = res.body?.getReader();
        if (!reader) throw Error("Empty routing response");
        const chunks = [];
        let size = 0;
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            size += r.value.length;
            if (size > 100000) throw Error("Routing response bound");
            chunks.push(r.value);
          }
        } finally {
          await reader.cancel();
        }
        const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        duration = raw.routes?.[0]?.duration;
        if (
          raw.code !== "Ok" ||
          !Number.isFinite(duration) ||
          duration < 0 ||
          duration > 604800
        )
          throw Error("Invalid road duration");
      }
      w.travelMinutes = Math.round(
        (duration / 60) * (stores.length ? w.visits / stores.length : 0),
      );
      w.loadPct = w.capacityMinutes
        ? Math.round(
            ((w.serviceMinutes + w.travelMinutes) / w.capacityMinutes) * 100,
          )
        : null;
      w.travelSource =
        pts.length < 2
          ? "No between-store leg · no road lookup"
          : "OSRM road graph · nearest-neighbour tour, no live traffic";
      w.provisionalTravel = w.unpinned > 0;
    } catch {
      w.travelSource =
        "SAMPLE geometric fallback · configured road routing unavailable or outside its bound";
    }
  }
  const pending = [...tasks];
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      for (;;) {
        const t = pending.shift();
        if (!t) return;
        await one(t);
      }
    }),
  );
  return sim;
}
/** One transaction detaches, transfers and reattaches the whole route using the existing ORG authorities. @param {any} c @param {any[]} routes @param {number} from @param {string} reason @param {any} assign */
export async function transferRoutes(c, routes, from, reason, assign) {
  for (const r of routes) {
    await assign(c, "batchAssign", {
      assignments: r.stops.map((/** @type {any} */ s) => ({
        outletId: s.id,
        territoryId: s.territory_id,
      })),
      effectiveFrom: from,
      reason,
    });
    await geographyCommand(c, "routes", "move", {
      routeId: r.id,
      territoryId: r.toTerritoryId,
      effectiveFrom: from,
      reason,
    });
    await writeAudit(c.db, {
      subject: c.actor.subject,
      action: "route.move",
      entityType: "routes",
      entityId: r.id,
      details: {
        scenario: true,
        toTerritoryId: r.toTerritoryId,
        effectiveFrom: from,
      },
    });
  }
}
/** @param {any} c @param {any} s @param {number} from */
export async function scheduleBoundaries(c, s, from) {
  if (!s.plan?.boundaries?.length) return;
  await enqueue(c.db, {
    kind: "coverage.scenarioBoundaries",
    key: s.id,
    runAt: from,
    payload: { scenarioId: s.id },
  });
}
/** Idempotent effective-day canonical shape update; stale shape or withdrawn publisher fails visibly in the durable job. @param {any} db @param {string} id @param {number} [now] */
export async function applyScenarioBoundaries(db, id, now = Date.now()) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(${ORG_LOCK})`;
    const [s] =
      await t`select * from territory_scenarios where id=${uuid(id)} for update`;
    if (!s || s.status !== "published")
      throw invalid("Published scenario required");
    if (s.plan.boundaryStatus === "applied") return;
    if (
      !Number.isSafeInteger(s.plan.boundaryEffectiveFrom) ||
      s.plan.boundaryEffectiveFrom > now
    )
      throw conflict("Boundary effective day has not arrived");
    const [p] =
      await t`select user_id from profiles where id=${s.published_by}`;
    const actor = p?.user_id ? await actorFor(t, p.user_id) : null;
    if (!actor) throw forbidden("The publisher needs renewed access");
    /** @type {any} */ const c = { db: t, actor, now };
    for (const b of s.plan.boundaries) {
      const [territory] =
        await t`select * from territories where id=${b.territoryId} for update`;
      if (
        !territory ||
        hash(territory.boundary_geo_json ?? null) !== b.previousHash
      )
        throw conflict(
          "Territory boundary changed; reconcile this scheduled change",
        );
      await geographyCommand(c, "territories", "edit", {
        territoryId: b.territoryId,
        name: territory.name,
        channel: territory.channel,
        boundaryGeoJson: JSON.stringify(b.geoJson),
        reason: "F-224 independently published boundary scenario",
      });
      await writeAudit(t, {
        subject: actor.subject,
        action: "territory.boundary",
        entityType: "territories",
        entityId: b.territoryId,
        details: { scenarioId: s.id, geometryHash: hash(b.geoJson) },
      });
    }
    await t`update territory_scenarios set plan=plan||'{"boundaryStatus":"applied"}'::jsonb,updated_at=now() where id=${s.id}`;
  });
}
