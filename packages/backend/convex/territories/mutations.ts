import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, mutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import {
  assertEffectiveStart,
  authorizeWrite,
  USER_ACTOR,
  type WriteActor,
} from "../lib/write_actor";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import {
  activeAt,
  audit,
  interval,
  normalizeCode,
  prospective,
  topology,
} from "../org/validation";
import {
  assertActiveUnit,
  assertBoundary,
  MAX_TERRITORY_HISTORY,
  overlaps,
  ownerships,
  required,
  requireTerritoryCapability,
  resolveTerritoryOwnerAt,
} from "./validation";

async function activeTerritory(
  ctx: MutationCtx,
  territoryId: Id<"territories">,
  from: number,
  actor: WriteActor = USER_ACTOR,
) {
  assertEffectiveStart(actor, from);
  const access =
    actor.kind === "system"
      ? await systemTerritory(ctx, territoryId, actor.subject)
      : await requireTerritoryCapability(ctx, "territory.manage", territoryId);
  const actorSubject = access.identity.tokenIdentifier;
  if (
    access.territory.status !== "active" ||
    !activeAt(
      access.territory.effectiveFrom,
      access.territory.effectiveTo,
      from,
    )
  )
    throw new ConvexError("Territory not active at effective time");
  return { ...access, actorSubject };
}

async function systemTerritory(
  ctx: MutationCtx,
  territoryId: Id<"territories">,
  subject: string,
) {
  const territory = await ctx.db.get(territoryId);
  if (!territory || territory.organizationId !== SUNPRIDE_ORGANIZATION_ID)
    throw new ConvexError("Territory not found");
  return { territory, identity: { tokenIdentifier: subject } };
}

async function assignments(ctx: MutationCtx, territoryId: Id<"territories">) {
  const rows = await ctx.db
    .query("territorySalespeople")
    .withIndex("by_territoryId_and_effectiveFrom", (q) =>
      q.eq("territoryId", territoryId),
    )
    .take(MAX_TERRITORY_HISTORY + 1);
  if (rows.length > MAX_TERRITORY_HISTORY)
    throw new ConvexError("Territory assignments exceed limit");
  return rows;
}

async function personUnitAt(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
  at: number,
) {
  const person = await ctx.db.get(profileId);
  if (!person || person.status !== "active" || !person.orgUnitId)
    throw new ConvexError("Salesperson has no active unit");
  const history = await ctx.db
    .query("employeeAssignments")
    .withIndex("by_profileId_and_effectiveFrom", (q) =>
      q.eq("profileId", profileId).lte("effectiveFrom", at),
    )
    .order("desc")
    .take(2);
  const assignment = history.find((row) =>
    activeAt(row.effectiveFrom, row.effectiveTo, at),
  );
  if (history.length && !assignment)
    throw new ConvexError("Salesperson has no assignment at effective time");
  return { person, unitId: assignment?.orgUnitId ?? person.orgUnitId };
}

async function assertPersonWithin(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
  ownerUnitId: Id<"orgUnits">,
  from: number,
  to?: number,
  actor: WriteActor = USER_ACTOR,
) {
  const { person, unitId } = await personUnitAt(ctx, profileId, from);
  if (!unitId)
    throw new ConvexError("Salesperson has no unit at effective time");
  await authorizeWrite(ctx, actor, "territory.manage", person.orgUnitId!);
  await assertActiveUnit(ctx, unitId, from, to);
  const tree = await topology(ctx, from);
  const parent = new Map(tree.map((row) => [row._id, row.parentId]));
  let cursor: Id<"orgUnits"> | undefined = unitId;
  while (cursor && cursor !== ownerUnitId) cursor = parent.get(cursor);
  if (cursor !== ownerUnitId)
    throw new ConvexError("Salesperson outside territory owner hierarchy");
  const future = await ctx.db
    .query("employeeAssignments")
    .withIndex("by_profileId_and_effectiveFrom", (q) =>
      q.eq("profileId", profileId).gt("effectiveFrom", from),
    )
    .take(501);
  if (
    future.length > 500 ||
    future.some((row) => row.effectiveFrom < (to ?? Infinity))
  )
    throw new ConvexError("Future employee assignment needs revalidation");
}

export const create = mutation({
  args: {
    code: v.string(),
    name: v.string(),
    orgUnitId: v.id("orgUnits"),
    channel: v.optional(v.string()),
    boundaryGeoJson: v.optional(v.string()),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    reason: v.string(),
  },
  returns: v.id("territories"),
  handler: async (ctx, args) =>
    (await createTerritory(ctx, args, USER_ACTOR)).territoryId,
});

/** The territory writer: identity row, its first ownership row, projection and audit. */
export async function createTerritory(
  ctx: MutationCtx,
  args: {
    code: string;
    name: string;
    orgUnitId: Id<"orgUnits">;
    channel?: string;
    boundaryGeoJson?: string;
    effectiveFrom: number;
    effectiveTo?: number;
    reason: string;
  },
  actor: WriteActor,
) {
  assertEffectiveStart(actor, args.effectiveFrom);
  interval(args.effectiveFrom, args.effectiveTo);
  const actorSubject = await authorizeWrite(
    ctx,
    actor,
    "territory.manage",
    args.orgUnitId,
  );
  await assertActiveUnit(
    ctx,
    args.orgUnitId,
    args.effectiveFrom,
    args.effectiveTo,
  );
  const code = normalizeCode(args.code);
  if (
    await ctx.db
      .query("territories")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("code", code),
      )
      .first()
  )
    throw new ConvexError("Duplicate territory code");
  const name = required(args.name, "Name");
  const reason = required(args.reason, "Reason");
  assertBoundary(args.boundaryGeoJson);
  const now = Date.now();
  const territoryId = await ctx.db.insert("territories", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    code,
    name,
    channel: args.channel?.trim(),
    boundaryGeoJson: args.boundaryGeoJson,
    status: "active",
    effectiveFrom: args.effectiveFrom,
    effectiveTo: args.effectiveTo,
    createdBy: actorSubject,
    createdAt: now,
    updatedAt: now,
  });
  const ownershipId = await ctx.db.insert("territoryOwnerships", {
    territoryId,
    orgUnitId: args.orgUnitId,
    effectiveFrom: args.effectiveFrom,
    effectiveTo: args.effectiveTo,
    actorSubject,
    reason,
    createdAt: now,
  });
  if (args.effectiveTo !== undefined)
    await ctx.scheduler.runAt(
      args.effectiveTo,
      internal.territories.mutations.applyProjection,
      { territoryId },
    );
  await audit(
    ctx,
    actorSubject,
    "territory.created",
    "territory",
    territoryId,
    reason,
    now,
  );
  return { territoryId, ownershipId };
}

export const edit = mutation({
  args: {
    territoryId: v.id("territories"),
    name: v.string(),
    channel: v.optional(v.string()),
    boundaryGeoJson: v.optional(v.string()),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { territory, identity } = await requireTerritoryCapability(
      ctx,
      "territory.manage",
      args.territoryId,
    );
    if (
      territory.status !== "active" ||
      (territory.effectiveTo !== undefined &&
        territory.effectiveTo <= Date.now())
    )
      throw new ConvexError("Inactive territory");
    const reason = required(args.reason, "Reason");
    assertBoundary(args.boundaryGeoJson);
    const now = Date.now();
    await ctx.db.patch(territory._id, {
      name: required(args.name, "Name"),
      channel: args.channel?.trim(),
      boundaryGeoJson: args.boundaryGeoJson,
      updatedAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "territory.edited",
      "territory",
      territory._id,
      reason,
      now,
    );
    return null;
  },
});

export const transferOwner = mutation({
  args: {
    territoryId: v.id("territories"),
    orgUnitId: v.id("orgUnits"),
    effectiveFrom: v.number(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { territory, identity } = await activeTerritory(
      ctx,
      args.territoryId,
      args.effectiveFrom,
    );
    await requireCapability(ctx, "territory.manage", args.orgUnitId);
    await assertActiveUnit(
      ctx,
      args.orgUnitId,
      args.effectiveFrom,
      territory.effectiveTo,
    );
    const rows = await ownerships(ctx, territory._id);
    const previous = rows.at(-1);
    if (
      !previous ||
      previous.effectiveFrom >= args.effectiveFrom ||
      (previous.effectiveTo !== undefined &&
        previous.effectiveTo <= args.effectiveFrom) ||
      previous.orgUnitId === args.orgUnitId
    )
      throw new ConvexError("Overlapping or invalid ownership transition");
    await requireCapability(ctx, "territory.manage", previous.orgUnitId);
    const reason = required(args.reason, "Reason");
    for (const row of await assignments(ctx, territory._id)) {
      if (overlaps(row, args.effectiveFrom, territory.effectiveTo))
        await assertPersonWithin(
          ctx,
          row.profileId,
          args.orgUnitId,
          Math.max(row.effectiveFrom, args.effectiveFrom),
          row.effectiveTo ?? territory.effectiveTo,
        );
    }
    const now = Date.now();
    await ctx.db.patch(previous._id, { effectiveTo: args.effectiveFrom });
    await ctx.db.insert("territoryOwnerships", {
      territoryId: territory._id,
      orgUnitId: args.orgUnitId,
      effectiveFrom: args.effectiveFrom,
      effectiveTo: territory.effectiveTo,
      actorSubject: identity.tokenIdentifier,
      reason,
      createdAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "territory.owner_transferred",
      "territory",
      territory._id,
      reason,
      now,
    );
    return null;
  },
});

export const assignSalesperson = mutation({
  args: {
    territoryId: v.id("territories"),
    profileId: v.id("profiles"),
    kind: v.optional(v.union(v.literal("primary"), v.literal("secondary"))),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    reason: v.string(),
  },
  returns: v.id("territorySalespeople"),
  handler: async (ctx, args) =>
    assignTerritorySalesperson(ctx, args, USER_ACTOR),
});

/** The territory salesperson writer (overlap, owner window and person hierarchy checked). */
export async function assignTerritorySalesperson(
  ctx: MutationCtx,
  args: {
    territoryId: Id<"territories">;
    profileId: Id<"profiles">;
    kind?: "primary" | "secondary";
    effectiveFrom: number;
    effectiveTo?: number;
    reason: string;
  },
  actor: WriteActor,
) {
  const { territory, actorSubject } = await activeTerritory(
    ctx,
    args.territoryId,
    args.effectiveFrom,
    actor,
  );
  interval(args.effectiveFrom, args.effectiveTo);
  if (
    territory.effectiveTo !== undefined &&
    (args.effectiveTo === undefined || args.effectiveTo > territory.effectiveTo)
  )
    throw new ConvexError("Assignment exceeds territory interval");
  const owner = await resolveTerritoryOwnerAt(
    ctx,
    territory._id,
    args.effectiveFrom,
  );
  if (
    !owner ||
    (owner.effectiveTo !== undefined &&
      (args.effectiveTo === undefined || args.effectiveTo > owner.effectiveTo))
  )
    throw new ConvexError("Assignment crosses owner transition");
  await authorizeWrite(ctx, actor, "territory.manage", owner.orgUnitId);
  await assertPersonWithin(
    ctx,
    args.profileId,
    owner.orgUnitId,
    args.effectiveFrom,
    args.effectiveTo,
    actor,
  );
  const kind = args.kind ?? "primary";
  if (
    (await assignments(ctx, territory._id)).some(
      (row) =>
        row.profileId === args.profileId &&
        (row.kind ?? "primary") === kind &&
        overlaps(row, args.effectiveFrom, args.effectiveTo),
    )
  )
    throw new ConvexError("Overlapping salesperson assignment");
  const reason = required(args.reason, "Reason");
  const now = Date.now();
  const id = await ctx.db.insert("territorySalespeople", {
    territoryId: territory._id,
    profileId: args.profileId,
    kind,
    effectiveFrom: args.effectiveFrom,
    effectiveTo: args.effectiveTo,
    actorSubject,
    reason,
    createdAt: now,
  });
  await audit(
    ctx,
    actorSubject,
    "territory.salesperson_assigned",
    "territorySalesperson",
    id,
    reason,
    now,
  );
  return id;
}

export const endSalespersonAssignment = mutation({
  args: {
    assignmentId: v.id("territorySalespeople"),
    effectiveTo: v.number(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    prospective(args.effectiveTo);
    const row = await ctx.db.get(args.assignmentId);
    if (!row) throw new ConvexError("Assignment not found");
    const { identity } = await requireTerritoryCapability(
      ctx,
      "territory.manage",
      row.territoryId,
    );
    const endOwner = await resolveTerritoryOwnerAt(
      ctx,
      row.territoryId,
      args.effectiveTo - 1,
    );
    if (endOwner)
      await requireCapability(ctx, "territory.manage", endOwner.orgUnitId);
    const person = await ctx.db.get(row.profileId);
    if (!person?.orgUnitId) throw new ConvexError("Salesperson has no unit");
    await requireCapability(ctx, "territory.manage", person.orgUnitId);
    if (
      args.effectiveTo <= row.effectiveFrom ||
      (row.effectiveTo !== undefined && row.effectiveTo <= args.effectiveTo)
    )
      throw new ConvexError("Invalid assignment end");
    const reason = required(args.reason, "Reason");
    const now = Date.now();
    await ctx.db.patch(row._id, { effectiveTo: args.effectiveTo });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "territory.salesperson_ended",
      "territorySalesperson",
      row._id,
      reason,
      now,
    );
    return null;
  },
});

export const deactivate = mutation({
  args: {
    territoryId: v.id("territories"),
    effectiveTo: v.number(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { territory, identity } = await activeTerritory(
      ctx,
      args.territoryId,
      args.effectiveTo,
    );
    if (
      territory.effectiveFrom >= args.effectiveTo ||
      territory.effectiveTo !== undefined
    )
      throw new ConvexError("Territory already ends");
    const reason = required(args.reason, "Reason");
    // Never orphan an active route or outlet membership after retiring its territory.
    for (const table of ["routeTerritories", "outletAssignments"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_territoryId_and_effectiveFrom", (q) =>
          q.eq("territoryId", territory._id),
        )
        .take(501);
      if (
        rows.length > 500 ||
        rows.some(
          (row) =>
            row.effectiveTo === undefined || row.effectiveTo > args.effectiveTo,
        )
      )
        throw new ConvexError("Territory has dependent coverage intervals");
    }
    const rows = await assignments(ctx, territory._id);
    for (const row of rows) {
      if (row.effectiveFrom >= args.effectiveTo)
        throw new ConvexError(
          "Future salesperson assignment conflicts with deactivation",
        );
      if (row.effectiveTo === undefined || row.effectiveTo > args.effectiveTo) {
        const person = await ctx.db.get(row.profileId);
        if (!person?.orgUnitId)
          throw new ConvexError("Salesperson has no unit");
        await requireCapability(ctx, "territory.manage", person.orgUnitId);
        await ctx.db.patch(row._id, { effectiveTo: args.effectiveTo });
      }
    }
    const owners = await ownerships(ctx, territory._id);
    const last = owners.at(-1);
    if (!last || last.effectiveFrom >= args.effectiveTo)
      throw new ConvexError("Invalid ownership end");
    await requireCapability(ctx, "territory.manage", last.orgUnitId);
    if (last.effectiveTo === undefined || last.effectiveTo > args.effectiveTo)
      await ctx.db.patch(last._id, { effectiveTo: args.effectiveTo });
    const now = Date.now();
    await ctx.db.patch(territory._id, {
      effectiveTo: args.effectiveTo,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(
      args.effectiveTo,
      internal.territories.mutations.applyProjection,
      { territoryId: territory._id },
    );
    await audit(
      ctx,
      identity.tokenIdentifier,
      "territory.deactivated",
      "territory",
      territory._id,
      reason,
      now,
    );
    return null;
  },
});

/** Status is only a projection; effectiveTo and ownership rows remain authoritative. */
export const applyProjection = internalMutation({
  args: { territoryId: v.id("territories") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.territoryId);
    if (row?.effectiveTo !== undefined && row.effectiveTo <= Date.now())
      await ctx.db.patch(row._id, {
        status: "inactive",
        updatedAt: Date.now(),
      });
    return null;
  },
});
