import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { AppRole } from "../lib/roles";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds, requireNationalScope } from "../lib/scope";
import { audit, normalizeCode } from "../org/validation";

export type Assignment = {
  orgUnitId?: Id<"orgUnits">;
  role?: AppRole;
  positionId?: Id<"positions">;
  supervisorId?: Id<"profiles">;
  employeeCode?: string;
};

/** Single writer for legacy role/persona and new assignments; no client-provided actor. */
export async function writeAssignment(
  ctx: MutationCtx,
  target: Doc<"profiles">,
  change: Assignment,
  reason: string,
) {
  const { identity, profile: actor } = target.orgUnitId
    ? await requireCapability(ctx, "admin.manage", target.orgUnitId)
    : await requireNationalScope(ctx, ["admin"]);
  if (change.orgUnitId)
    await requireCapability(ctx, "admin.manage", change.orgUnitId);
  if (target.role === "super_admin" || change.role === "super_admin")
    throw new ConvexError("The bootstrap super admin cannot be changed");
  if (
    (target.role === "admin" || change.role === "admin") &&
    actor.role !== "super_admin"
  )
    throw new ConvexError("Only the super admin can manage administrators");
  const unitId = change.orgUnitId ?? target.orgUnitId;
  if (unitId) {
    const unit = await ctx.db.get(unitId);
    if (
      !unit ||
      unit.status !== "active" ||
      unit.effectiveFrom > Date.now() ||
      (unit.effectiveTo !== undefined && unit.effectiveTo <= Date.now())
    )
      throw new ConvexError("Inactive organization unit");
  }
  if (change.positionId) {
    const position = await ctx.db.get(change.positionId);
    if (!position?.active)
      throw new ConvexError("Unknown or inactive position");
  }
  if (change.supervisorId) {
    let cursor: Id<"profiles"> | undefined = change.supervisorId;
    const seen = new Set<Id<"profiles">>([target._id]);
    for (let i = 0; cursor && i < 500; i++) {
      if (seen.has(cursor)) throw new ConvexError("Supervisor cycle");
      seen.add(cursor);
      const supervisor: Doc<"profiles"> | null = await ctx.db.get(cursor);
      if (!supervisor?.orgUnitId || !unitId)
        throw new ConvexError("Invalid supervisor");
      await requireCapability(ctx, "admin.manage", supervisor.orgUnitId);
      if (
        !(await collectScopeUnitIds(ctx, supervisor.orgUnitId)).includes(unitId)
      )
        throw new ConvexError("Supervisor outside employee hierarchy");
      cursor = supervisor.supervisorSubject
        ? (
            await ctx.db
              .query("profiles")
              .withIndex("by_subject", (q) =>
                q.eq("authSubject", supervisor.supervisorSubject!),
              )
              .unique()
          )?._id
        : undefined;
    }
    if (cursor) throw new ConvexError("Supervisor chain too long");
  }
  let employeeCode = target.employeeCode;
  if (change.employeeCode !== undefined) {
    const code = normalizeCode(change.employeeCode);
    if (employeeCode && employeeCode !== code)
      throw new ConvexError("Employee code is immutable");
    const holder = await ctx.db
      .query("profiles")
      .withIndex("by_employeeCode", (q) => q.eq("employeeCode", code))
      .first();
    if (holder && holder._id !== target._id)
      throw new ConvexError("Duplicate employee code");
    employeeCode = code;
  }
  const now = Date.now();
  const rows = await ctx.db
    .query("employeeAssignments")
    .withIndex("by_profileId_and_effectiveFrom", (q) =>
      q.eq("profileId", target._id),
    )
    .order("desc")
    .take(2);
  const current = rows[0];
  const effectiveFrom = Math.max(
    now,
    (current?.effectiveFrom ?? -Infinity) + 1,
  );
  if (current && current.effectiveTo === undefined) {
    await ctx.db.patch(current._id, { effectiveTo: effectiveFrom });
  } else if (!current && target.effectiveFrom && target.effectiveFrom < now) {
    await ctx.db.insert("employeeAssignments", {
      profileId: target._id,
      orgUnitId: target.orgUnitId,
      role: target.role,
      positionId: target.positionId,
      effectiveFrom: target.effectiveFrom,
      effectiveTo: now,
      actorSubject: "system:backfill",
      reason: "legacy projection",
      createdAt: now,
    });
  }
  const supervisor = change.supervisorId
    ? await ctx.db.get(change.supervisorId)
    : null;
  await ctx.db.insert("employeeAssignments", {
    profileId: target._id,
    orgUnitId: unitId,
    role: change.role ?? target.role,
    positionId: change.positionId ?? target.positionId,
    supervisorId: change.supervisorId ?? current?.supervisorId,
    effectiveFrom,
    actorSubject: identity.tokenIdentifier,
    reason,
    createdAt: now,
  });
  await ctx.db.patch(target._id, {
    role: change.role ?? target.role,
    orgUnitId: unitId,
    positionId: change.positionId ?? target.positionId,
    ...(supervisor ? { supervisorSubject: supervisor.authSubject } : {}),
    ...(employeeCode ? { employeeCode } : {}),
    effectiveFrom,
    updatedAt: now,
  });
  await audit(
    ctx,
    identity.tokenIdentifier,
    "person.assigned",
    "profile",
    target._id,
    reason,
    now,
  );
}
