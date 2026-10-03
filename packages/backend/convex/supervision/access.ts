import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { localDate } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { capabilityRoles, requireCapability } from "../lib/capabilities";
import type { AppRole } from "../lib/roles";
import { activeAt, topology } from "../org/validation";
import { channelOf, MAX_DAY_ROWS, MAX_PEOPLE } from "./model";

/** Shared filters for every supervision read. Scope is always the caller's, never widened. */
export const supervisionArgs = {
  serviceDate: v.string(),
  orgUnitId: v.optional(v.id("orgUnits")),
  channel: v.optional(v.string()),
  directOnly: v.optional(v.boolean()),
};

export type SupervisionFilters = {
  serviceDate: string;
  orgUnitId?: Id<"orgUnits">;
  channel?: string;
  directOnly?: boolean;
};

export const DECISION_KIND = "location.exception.decided";

/**
 * Supervision is people-reading plus visit-reading: the caller must hold BOTH `people.read`
 * and `visit.read` (super_admin, admin, manager, analyst, viewer). Field `sales` never sees a
 * team view. Raw device fixes and decisions additionally need
 * `visit.locationException.approve`.
 */
export async function supervisorContext(
  ctx: QueryCtx,
  filters: SupervisionFilters,
) {
  localDate(filters.serviceDate);
  if (filters.channel !== undefined && filters.channel.length > 80)
    throw new ConvexError("invalid_request");
  const { identity, profile } = await requireCapability(ctx, "people.read");
  await requireCapability(ctx, "visit.read");
  // Scope is resolved at the current instant, exactly as requireCapability does.
  const tree = await topology(ctx, Date.now());
  const children = new Map<Id<"orgUnits">, Id<"orgUnits">[]>();
  for (const unit of tree)
    if (unit.parentId)
      children.set(unit.parentId, [
        ...(children.get(unit.parentId) ?? []),
        unit._id,
      ]);
  const subtree = (root: Id<"orgUnits">) => {
    const ids = [root];
    for (let i = 0; i < ids.length; i++)
      ids.push(...(children.get(ids[i]!) ?? []));
    return ids;
  };
  const crossScope =
    profile.role === "super_admin" || profile.role === "analyst";
  let scope: Id<"orgUnits">[];
  if (crossScope) scope = tree.map((unit) => unit._id);
  else {
    if (
      !profile.orgUnitId ||
      !tree.some((unit) => unit._id === profile.orgUnitId)
    )
      throw new ConvexError("Your access has no organizational scope");
    scope = subtree(profile.orgUnitId);
  }
  const scopeSet = new Set(scope);
  if (filters.orgUnitId && !scopeSet.has(filters.orgUnitId))
    throw new ConvexError(
      "Requested scope is outside your organizational scope",
    );
  const units = new Set(filters.orgUnitId ? subtree(filters.orgUnitId) : scope);
  const canDecide =
    profile.role === "super_admin" ||
    (
      capabilityRoles("visit.locationException.approve") as readonly AppRole[]
    ).includes(profile.role as AppRole);
  return {
    identity,
    profile,
    scope: scopeSet,
    units,
    canDecide,
    unitOptions: tree
      .filter((unit) => scopeSet.has(unit._id))
      .map((unit) => ({ id: unit._id, code: unit.code, name: unit.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
export type SupervisorContext = Awaited<ReturnType<typeof supervisorContext>>;

export type TeamMember = {
  profile: Doc<"profiles">;
  assignment: Doc<"employeeAssignments">;
  positionLabel: string | null;
  channel: string;
  direct: boolean;
};

/**
 * Active field people (`sales`) whose CURRENT employee assignment sits inside the selected
 * units. Enumerated through the profile unit projection, then confirmed against the
 * effective assignment so a stale projection never widens the view.
 */
export async function teamMembers(
  ctx: QueryCtx,
  sc: SupervisorContext,
  filters: SupervisionFilters,
) {
  const now = Date.now();
  const members: TeamMember[] = [];
  const channels = new Set<string>();
  let truncated = false;
  const positions = new Map<Id<"positions">, string | null>();
  for (const unitId of sc.units) {
    const profiles = await ctx.db
      .query("profiles")
      .withIndex("by_orgUnitId", (q) => q.eq("orgUnitId", unitId))
      .take(MAX_PEOPLE * 4);
    for (const profile of profiles) {
      if (profile.status !== "active" || profile.role !== "sales") continue;
      const rows = await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", profile._id),
        )
        .take(100);
      const current = rows.filter((row) =>
        activeAt(row.effectiveFrom, row.effectiveTo, now),
      );
      const assignment = current.length === 1 ? current[0]! : null;
      if (!assignment?.orgUnitId || !sc.units.has(assignment.orgUnitId))
        continue;
      const positionId = assignment.positionId ?? profile.positionId;
      let positionLabel: string | null = null;
      if (positionId) {
        if (!positions.has(positionId))
          positions.set(
            positionId,
            (await ctx.db.get(positionId))?.label ?? null,
          );
        positionLabel = positions.get(positionId) ?? null;
      }
      const channel = channelOf(
        profile.channelScope,
        positionLabel ?? undefined,
      );
      const direct =
        assignment.supervisorId === sc.profile._id ||
        profile.supervisorSubject === sc.identity.tokenIdentifier;
      channels.add(channel);
      if (filters.channel && channel !== filters.channel) continue;
      if (filters.directOnly && !direct) continue;
      if (members.length >= MAX_PEOPLE) {
        truncated = true;
        continue;
      }
      members.push({ profile, assignment, positionLabel, channel, direct });
    }
  }
  members.sort((a, b) => a.profile.name.localeCompare(b.profile.name));
  return { members, truncated, channels: [...channels].sort() };
}

/** One person's planned stops and executed visits for a Manila service date, in scope. */
export async function personDay(
  ctx: QueryCtx,
  sc: SupervisorContext,
  profileId: Id<"profiles">,
  serviceDate: string,
) {
  const planned = await ctx.db
    .query("plannedVisits")
    .withIndex("by_assigneeProfileId_and_serviceDate", (q) =>
      q.eq("assigneeProfileId", profileId).eq("serviceDate", serviceDate),
    )
    .take(MAX_DAY_ROWS);
  const visits = (
    await ctx.db
      .query("visitExecutions")
      .withIndex(
        "by_organizationId_and_assigneeProfileId_and_serviceDate",
        (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("assigneeProfileId", profileId)
            .eq("serviceDate", serviceDate),
      )
      .take(MAX_DAY_ROWS)
  ).filter((visit) => sc.scope.has(visit.orgUnitId));
  return {
    planned: planned.filter((row) =>
      sc.scope.has(row.approvedSnapshot.orgUnitId),
    ),
    visits,
  };
}

export async function visitEvidence(
  ctx: QueryCtx,
  visitId: Id<"visitExecutions">,
) {
  return await ctx.db
    .query("visitLocationEvidence")
    .withIndex("by_visitId_and_serverTime", (q) => q.eq("visitId", visitId))
    .take(10);
}

/** The independently authored decision event for one evidence row (location.ts writes it). */
export async function evidenceDecision(
  ctx: QueryCtx,
  evidenceId: Id<"visitLocationEvidence">,
) {
  const rows = await ctx.db
    .query("executionEvents")
    .withIndex("by_entityType_and_entityId_and_serverAt", (q) =>
      q.eq("entityType", "visit").eq("entityId", evidenceId),
    )
    .take(5);
  return rows.find((row) => row.kind === DECISION_KIND) ?? null;
}

/** Open = needs a supervisor: not inside the radius and no decision recorded yet. */
export async function openEvidence(
  ctx: QueryCtx,
  evidence: readonly Doc<"visitLocationEvidence">[],
) {
  const open: Doc<"visitLocationEvidence">[] = [];
  for (const row of evidence)
    if (
      row.reviewStatus === "pending_review" &&
      !(await evidenceDecision(ctx, row._id))
    )
      open.push(row);
  return open;
}

/** Resolve actor tokens to display names; never return the token itself. */
export function actorNames(ctx: QueryCtx) {
  const cache = new Map<string, string>();
  return async (subject: string) => {
    const hit = cache.get(subject);
    if (hit) return hit;
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_subject", (q) => q.eq("authSubject", subject))
      .first();
    const name = profile?.name ?? "Former user";
    cache.set(subject, name);
    return name;
  };
}
