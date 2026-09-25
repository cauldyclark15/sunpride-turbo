import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { collectScopeUnitIds } from "../lib/scope";
import { activeAt, prospective } from "../org/validation";

export const MAX_MEMBERSHIPS = 500;

export function required(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new ConvexError(`${label} required`);
  return trimmed;
}

export async function activeUnit(
  ctx: QueryCtx | MutationCtx,
  unitId: Id<"orgUnits">,
  from: number,
) {
  const unit = await ctx.db.get(unitId);
  if (
    !unit ||
    unit.status !== "active" ||
    !activeAt(unit.effectiveFrom, unit.effectiveTo, from)
  )
    throw new ConvexError("Inactive organization unit");
  return unit;
}

export function activeTeam(team: Doc<"teams">, from: number) {
  prospective(from);
  if (
    team.status !== "active" ||
    !activeAt(team.effectiveFrom, team.effectiveTo, from)
  )
    throw new ConvexError("Team is not active at the effective time");
}

/** Team supervisors are active app-role managers/admins, not holders of a job title. */
export async function assertSupervisor(
  ctx: MutationCtx,
  supervisorId: Id<"profiles">,
  teamUnitId: Id<"orgUnits">,
) {
  const supervisor = await ctx.db.get(supervisorId);
  if (
    !supervisor?.orgUnitId ||
    supervisor.status !== "active" ||
    !["manager", "admin", "super_admin"].includes(supervisor.role)
  )
    throw new ConvexError("Supervisor must be a manager or administrator");
  await activeUnit(ctx, supervisor.orgUnitId, Date.now());
  if (
    !(await collectScopeUnitIds(ctx, supervisor.orgUnitId)).includes(teamUnitId)
  )
    throw new ConvexError("Supervisor outside team hierarchy");
}

export async function teamMemberships(
  ctx: QueryCtx | MutationCtx,
  teamId: Id<"teams">,
) {
  const rows = await ctx.db
    .query("teamMemberships")
    .withIndex("by_teamId_and_effectiveFrom", (q) => q.eq("teamId", teamId))
    .take(MAX_MEMBERSHIPS + 1);
  if (rows.length > MAX_MEMBERSHIPS)
    throw new ConvexError("Team membership history exceeds supported size");
  return rows;
}
