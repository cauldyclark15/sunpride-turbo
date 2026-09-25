import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { activeAt, audit, interval, prospective } from "../org/validation";
import schema from "../schema";
import {
  routeTerritories,
  requireRoute,
} from "../territories/route_validation";
import {
  ownerships,
  requireTerritoryCapability,
  resolveTerritoryOwnerAt,
} from "../territories/validation";
import {
  assertActiveOutlet,
  currentRow,
  outletRows,
  required,
  requireOutletCapability,
} from "./validation";

const MAX_ROWS = 500;
const MAX_BATCH = 100;
type Ctx = MutationCtx | QueryCtx;
type Choice = {
  outletId: Id<"outlets">;
  territoryId: Id<"territories">;
  routeId?: Id<"routes">;
  sequence?: number;
};
const choice = {
  outletId: v.id("outlets"),
  territoryId: v.id("territories"),
  routeId: v.optional(v.id("routes")),
  sequence: v.optional(v.number()),
};
function overlaps(
  row: { effectiveFrom: number; effectiveTo?: number },
  from: number,
  to?: number,
) {
  return (
    row.effectiveFrom < (to ?? Infinity) && from < (row.effectiveTo ?? Infinity)
  );
}
function sequenceValid(sequence: number) {
  if (!Number.isSafeInteger(sequence) || sequence <= 0)
    throw new ConvexError("Sequence must be a positive integer");
}
async function indexedRows(
  ctx: Ctx,
  field: "routeId" | "territoryId",
  id: Id<"routes"> | Id<"territories">,
) {
  const rows =
    field === "routeId"
      ? await ctx.db
          .query("outletAssignments")
          .withIndex("by_routeId_and_effectiveFrom", (q) =>
            q.eq("routeId", id as Id<"routes">),
          )
          .take(MAX_ROWS + 1)
      : await ctx.db
          .query("outletAssignments")
          .withIndex("by_territoryId_and_effectiveFrom", (q) =>
            q.eq("territoryId", id as Id<"territories">),
          )
          .take(MAX_ROWS + 1);
  if (rows.length > MAX_ROWS)
    throw new ConvexError("Assignment list exceeds limit");
  return rows;
}
async function destination(
  ctx: MutationCtx,
  target: Choice,
  from: number,
  to?: number,
) {
  interval(from, to);
  const territory = await ctx.db.get(target.territoryId);
  if (
    !territory ||
    territory.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
    territory.status !== "active" ||
    !activeAt(territory.effectiveFrom, territory.effectiveTo, from) ||
    (territory.effectiveTo !== undefined &&
      (to === undefined || to > territory.effectiveTo))
  )
    throw new ConvexError("Territory does not cover assignment interval");
  // Gate both the persisted current owner and every future owner in the window.
  await requireTerritoryCapability(ctx, "outlet.assign", target.territoryId);
  const owners = await ownerships(ctx, target.territoryId);
  let cursor = from;
  for (const owner of owners) {
    if (!overlaps(owner, from, to)) continue;
    if (owner.effectiveFrom > cursor)
      throw new ConvexError("Territory ownership gap");
    await requireCapability(ctx, "outlet.assign", owner.orgUnitId);
    cursor = Math.max(cursor, owner.effectiveTo ?? Infinity);
  }
  if (cursor < (to ?? Infinity))
    throw new ConvexError("Territory owner does not cover assignment");
  if (target.routeId) {
    if (target.sequence === undefined)
      throw new ConvexError("Route requires sequence");
    sequenceValid(target.sequence);
    await requireRoute(ctx, "route.read", target.routeId);
    const route = await ctx.db.get(target.routeId);
    if (
      !route ||
      route.status !== "active" ||
      !activeAt(route.effectiveFrom, route.effectiveTo, from) ||
      (route.effectiveTo !== undefined &&
        (to === undefined || to > route.effectiveTo))
    )
      throw new ConvexError("Route does not cover assignment");
    let routeCursor = from;
    for (const row of await routeTerritories(ctx, target.routeId)) {
      if (!overlaps(row, from, to)) continue;
      if (
        row.territoryId !== target.territoryId ||
        row.effectiveFrom > routeCursor
      )
        throw new ConvexError(
          "Route not in destination territory throughout interval",
        );
      routeCursor = Math.max(routeCursor, row.effectiveTo ?? Infinity);
    }
    if (routeCursor < (to ?? Infinity))
      throw new ConvexError("Route territory gap");
  } else if (target.sequence !== undefined)
    throw new ConvexError("Sequence requires route");
}
async function prepare(
  ctx: MutationCtx,
  target: Choice,
  from: number,
  reason: string,
) {
  prospective(from);
  required(reason, "Reason");
  const access = await requireOutletCapability(
    ctx,
    "outlet.assign",
    target.outletId,
  );
  assertActiveOutlet(access.outlet);
  const rows = await outletRows(ctx, "outletAssignments", target.outletId);
  const previous = currentRow(rows, from);
  if (
    rows.some((row) => row.effectiveFrom >= from) ||
    (previous && previous.effectiveFrom >= from) ||
    (!previous && rows.some((row) => overlaps(row, from)))
  )
    throw new ConvexError("Overlapping or future outlet assignment");
  if (previous) {
    const sourceOwner = await resolveTerritoryOwnerAt(
      ctx,
      previous.territoryId,
      from,
    );
    if (!sourceOwner) throw new ConvexError("Source territory owner missing");
    await requireCapability(ctx, "outlet.assign", sourceOwner.orgUnitId);
  }
  if (
    previous &&
    previous.territoryId === target.territoryId &&
    previous.routeId === target.routeId &&
    previous.sequence === target.sequence
  )
    throw new ConvexError("Assignment unchanged");
  await destination(ctx, target, from);
  return { previous, actor: access.identity.tokenIdentifier };
}
async function write(
  ctx: MutationCtx,
  target: Choice,
  from: number,
  reason: string,
  previous: Doc<"outletAssignments"> | null,
  actor: string,
) {
  const now = Date.now();
  if (previous) await ctx.db.patch(previous._id, { effectiveTo: from });
  const id = await ctx.db.insert("outletAssignments", {
    ...target,
    effectiveFrom: from,
    actorSubject: actor,
    reason: reason.trim(),
    createdAt: now,
  });
  await audit(
    ctx,
    actor,
    "outlet.assignment_changed",
    "outlet",
    target.outletId,
    reason.trim(),
    now,
  );
  return id;
}
async function checkSequences(
  ctx: MutationCtx,
  changes: Choice[],
  from: number,
) {
  const routes = new Set(
    changes.flatMap((c) => (c.routeId ? [c.routeId] : [])),
  );
  for (const routeId of routes) {
    const rows = (await indexedRows(ctx, "routeId", routeId)).filter((row) =>
      overlaps(row, from),
    );
    const future = rows.filter(
      (row) => !changes.some((c) => c.outletId === row.outletId),
    );
    const incoming = changes.filter((c) => c.routeId === routeId);
    for (const c of incoming) {
      const seq = c.sequence!;
      if (future.some((row) => row.sequence === seq))
        throw new ConvexError(
          "Route sequence collision (including future interval)",
        );
      if (incoming.some((other) => other !== c && other.sequence === seq))
        throw new ConvexError("Duplicate route sequence in batch");
    }
  }
}
export const assign = mutation({
  args: { ...choice, effectiveFrom: v.number(), reason: v.string() },
  returns: v.id("outletAssignments"),
  handler: async (ctx, args) => {
    const { effectiveFrom, reason, ...target } = args;
    const prepared = await prepare(ctx, target, effectiveFrom, reason);
    await checkSequences(ctx, [target], effectiveFrom);
    return write(
      ctx,
      target,
      effectiveFrom,
      reason,
      prepared.previous,
      prepared.actor,
    );
  },
});
export const batchAssign = mutation({
  args: {
    assignments: v.array(v.object(choice)),
    effectiveFrom: v.number(),
    reason: v.string(),
  },
  returns: v.array(v.id("outletAssignments")),
  handler: async (ctx, args) => {
    if (
      !args.assignments.length ||
      args.assignments.length > MAX_BATCH ||
      new Set(args.assignments.map((c) => c.outletId)).size !==
        args.assignments.length
    )
      throw new ConvexError("Batch must contain 1–100 distinct outlets");
    const prepared = [];
    for (const target of args.assignments)
      prepared.push(
        await prepare(ctx, target, args.effectiveFrom, args.reason),
      );
    await checkSequences(ctx, args.assignments, args.effectiveFrom);
    const ids = [];
    for (let i = 0; i < prepared.length; i++)
      ids.push(
        await write(
          ctx,
          args.assignments[i]!,
          args.effectiveFrom,
          args.reason,
          prepared[i]!.previous,
          prepared[i]!.actor,
        ),
      );
    return ids;
  },
});
export const reorder = mutation({
  args: {
    routeId: v.id("routes"),
    outletIds: v.array(v.id("outlets")),
    effectiveFrom: v.number(),
    reason: v.string(),
  },
  returns: v.array(v.id("outletAssignments")),
  handler: async (ctx, args) => {
    prospective(args.effectiveFrom);
    required(args.reason, "Reason");
    if (
      !args.outletIds.length ||
      args.outletIds.length > MAX_BATCH ||
      new Set(args.outletIds).size !== args.outletIds.length
    )
      throw new ConvexError("Invalid reorder selection");
    await requireRoute(ctx, "route.read", args.routeId);
    const rows = await indexedRows(ctx, "routeId", args.routeId);
    const active = rows.filter((row) =>
      activeAt(row.effectiveFrom, row.effectiveTo, args.effectiveFrom),
    );
    if (
      active.length !== args.outletIds.length ||
      active.some((row) => !args.outletIds.includes(row.outletId)) ||
      rows.some((row) => row.effectiveFrom > args.effectiveFrom)
    )
      throw new ConvexError(
        "Reorder must include all stops; future schedule conflicts",
      );
    const next = [];
    for (let i = 0; i < args.outletIds.length; i++) {
      const previous = active.find(
        (row) => row.outletId === args.outletIds[i],
      )!;
      if (
        previous.effectiveFrom >= args.effectiveFrom ||
        previous.effectiveTo !== undefined
      )
        throw new ConvexError("Cannot reorder a bounded interval");
      const access = await requireOutletCapability(
        ctx,
        "outlet.assign",
        previous.outletId,
      );
      await destination(
        ctx,
        {
          outletId: previous.outletId,
          territoryId: previous.territoryId,
          routeId: args.routeId,
          sequence: i + 1,
        },
        args.effectiveFrom,
      );
      next.push({ previous, actor: access.identity.tokenIdentifier });
    }
    const ids = [];
    for (let i = 0; i < next.length; i++)
      ids.push(
        await write(
          ctx,
          {
            outletId: args.outletIds[i]!,
            territoryId: next[i]!.previous.territoryId,
            routeId: args.routeId,
            sequence: i + 1,
          },
          args.effectiveFrom,
          args.reason,
          next[i]!.previous,
          next[i]!.actor,
        ),
      );
    return ids;
  },
});
export const history = query({
  args: { outletId: v.id("outlets"), asOf: v.optional(v.number()) },
  returns: v.array(schema.doc("outletAssignments")),
  handler: async (ctx, args) => {
    await requireOutletCapability(ctx, "outlet.read", args.outletId);
    if (args.asOf !== undefined) interval(args.asOf);
    return (await outletRows(ctx, "outletAssignments", args.outletId)).filter(
      (row) =>
        args.asOf === undefined ||
        activeAt(row.effectiveFrom, row.effectiveTo, args.asOf),
    );
  },
});
export const routeStops = query({
  args: { routeId: v.id("routes"), asOf: v.optional(v.number()) },
  returns: v.array(schema.doc("outletAssignments")),
  handler: async (ctx, args) => {
    await requireRoute(ctx, "route.read", args.routeId);
    const at = args.asOf ?? Date.now();
    interval(at);
    const rows = await indexedRows(ctx, "routeId", args.routeId);
    const visible = [];
    for (const row of rows) {
      if (!activeAt(row.effectiveFrom, row.effectiveTo, at)) continue;
      try {
        await requireOutletCapability(ctx, "outlet.read", row.outletId);
        if (at > Date.now()) {
          const futureOwner = await resolveTerritoryOwnerAt(
            ctx,
            row.territoryId,
            at,
          );
          if (!futureOwner) throw new ConvexError("Future owner missing");
          await requireCapability(ctx, "outlet.read", futureOwner.orgUnitId);
        }
        visible.push(row);
      } catch {
        /* inaccessible stored owner */
      }
    }
    return visible.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  },
});
export const territoryRoster = query({
  args: { territoryId: v.id("territories"), asOf: v.optional(v.number()) },
  returns: v.array(schema.doc("outletAssignments")),
  handler: async (ctx, args) => {
    await requireTerritoryCapability(ctx, "outlet.read", args.territoryId);
    const at = args.asOf ?? Date.now();
    interval(at);
    const visible = [];
    for (const row of await indexedRows(ctx, "territoryId", args.territoryId)) {
      if (!activeAt(row.effectiveFrom, row.effectiveTo, at)) continue;
      try {
        await requireOutletCapability(ctx, "outlet.read", row.outletId);
        if (at > Date.now()) {
          const futureOwner = await resolveTerritoryOwnerAt(
            ctx,
            row.territoryId,
            at,
          );
          if (!futureOwner) throw new ConvexError("Future owner missing");
          await requireCapability(ctx, "outlet.read", futureOwner.orgUnitId);
        }
        visible.push(row);
      } catch {
        /* inaccessible */
      }
    }
    return visible;
  },
});
export const unassigned = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("outlets")),
  handler: async (ctx, args) => {
    await requireCapability(ctx, "outlet.read");
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > 100
    )
      throw new ConvexError("Page size must be 1–100");
    const result = await ctx.db
      .query("outlets")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .paginate(args.paginationOpts);
    const page = [];
    for (const outlet of result.page) {
      try {
        const scope = await requireOutletCapability(
          ctx,
          "outlet.read",
          outlet._id,
        );
        if (!scope.assignment) page.push(outlet);
      } catch {
        /* never expose another custodian */
      }
    }
    return { ...result, page };
  },
});
