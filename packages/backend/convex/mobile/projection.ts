import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { employeeAt, manilaDate } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { capabilityRoles } from "../lib/capabilities";
import { resolveOutletScopeAt } from "../outlets/validation";
import { activeAt } from "../org/validation";
import type { AuthorizedDevice } from "./types";

export const DAY_MS = 86_400_000;
export const HORIZON_DAYS = 3;
export const MAX_DAY_ROWS = 500;
export const leaseMs = DAY_MS;
export const visitDTO = v.object({
  id: v.string(),
  outletId: v.string(),
  serviceDate: v.string(),
  planId: v.string(),
  planVersion: v.number(),
  intents: v.array(v.string()),
});
export const outletDTO = v.object({
  id: v.string(),
  name: v.string(),
  routeId: v.union(v.string(), v.null()),
});
export const customerDTO = v.object({ id: v.string(), code: v.string() });
export const routeDTO = v.union(
  v.object({ id: v.string(), code: v.string() }),
  v.null(),
);
export const taskDTO = v.object({
  id: v.string(),
  kind: v.string(),
  required: v.boolean(),
});
export const productDTO = v.object({
  id: v.string(),
  code: v.string(),
  name: v.string(),
  uom: v.string(),
});
export type Visit = typeof visitDTO.type;
export type Task = typeof taskDTO.type;
export type Projected = {
  visit: Visit;
  outlet: typeof outletDTO.type;
  customer: typeof customerDTO.type | null;
  route: Exclude<typeof routeDTO.type, null> | null;
  stamp: string;
};

export async function assertDevice(
  ctx: QueryCtx,
  actor: AuthorizedDevice,
  now: number,
) {
  const identity = await ctx.auth.getUserIdentity();
  const device = await ctx.db.get(actor.deviceId);
  const profile = await ctx.db.get(actor.profileId);
  if (
    !identity ||
    identity.tokenIdentifier !== actor.subject ||
    !device ||
    device.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
    device.status !== "active" ||
    device.profileId !== actor.profileId ||
    device.boundSubject !== actor.subject ||
    device.allowedApp === "VAN_ANDROID" ||
    !device.credentialId ||
    !device.publicKey ||
    !profile ||
    profile.authSubject !== actor.subject ||
    profile.status !== "active" ||
    !capabilityRoles("visit.read").includes(actor.role)
  )
    throw new ConvexError("rebootstrap_required");
  const assignment = await employeeAt(ctx, profile._id, now);
  if (
    !assignment.orgUnitId ||
    assignment.orgUnitId !== device.orgUnitId ||
    assignment.orgUnitId !== actor.orgUnitId ||
    assignment.role !== actor.role ||
    profile.orgUnitId !== actor.orgUnitId ||
    profile.role !== actor.role
  )
    throw new ConvexError("rebootstrap_required");
  const source = `${profile._id}|${actor.subject}|${assignment._id}|${assignment.orgUnitId}|${assignment.role}|${device._id}|${device.allowedApp}|${device.credentialId}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  if (fingerprint !== actor.scopeFingerprint)
    throw new ConvexError("rebootstrap_required");
  return profile;
}

async function visitProjection(
  ctx: QueryCtx,
  row: Doc<"plannedVisits">,
  actor: AuthorizedDevice,
  now: number,
): Promise<Projected> {
  const plan = await ctx.db.get(row.planId);
  const s = row.approvedSnapshot;
  if (
    !plan ||
    plan.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
    plan.assigneeProfileId !== actor.profileId ||
    !plan.approvalSignature ||
    row.assigneeProfileId !== actor.profileId ||
    s.approvedAssigneeProfileId !== actor.profileId ||
    s.outletId !== row.outletId ||
    row.status !== "planned"
  )
    throw new ConvexError("rebootstrap_required");
  const current = await resolveOutletScopeAt(ctx, row.outletId, now);
  // No inherited unit/territory grant for a field phone: only its own current unit.
  if (
    current.orgUnitId !== actor.orgUnitId ||
    current.outlet.status === "inactive"
  )
    throw new ConvexError("rebootstrap_required");
  const customer = s.customerId ? await ctx.db.get(s.customerId) : null;
  if (s.customerId && !customer) throw new ConvexError("rebootstrap_required");
  return {
    visit: {
      id: row._id,
      outletId: row.outletId,
      serviceDate: row.serviceDate,
      planId: row.planId,
      planVersion: row.planVersion,
      intents: row.intents,
    },
    outlet: { id: s.outletId, name: s.outletName, routeId: s.routeId ?? null },
    customer: customer ? { id: customer._id, code: customer.code } : null,
    route:
      s.routeId && s.routeCode ? { id: s.routeId, code: s.routeCode } : null,
    stamp: `${row._id}|${row.status}|${row._creationTime}|${row.generatedAt}|${JSON.stringify(s)}|${JSON.stringify(row.intents)}|${current.assignment?._id ?? ""}|${current.assignment?.routeId ?? ""}|${current.assignment?.sequence ?? ""}|${current.orgUnitId}|${current.outlet.status}|${customer?.code ?? ""}`,
  };
}

/** Bounded, indexed per-person day scan. Reject oversized days rather than truncate. */
export async function dayProjection(
  ctx: QueryCtx,
  actor: AuthorizedDevice,
  day: string,
  now: number,
) {
  const start = Date.parse(`${day}T00:00:00Z`);
  if (
    !Number.isFinite(start) ||
    new Date(start).toISOString().slice(0, 10) !== day ||
    day !== manilaDate(now)
  )
    throw new ConvexError("rebootstrap_required");
  const visits: Projected[] = [];
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const date = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
    const rows = await ctx.db
      .query("plannedVisits")
      .withIndex("by_assigneeProfileId_and_serviceDate", (q) =>
        q.eq("assigneeProfileId", actor.profileId).eq("serviceDate", date),
      )
      .take(MAX_DAY_ROWS + 1);
    if (rows.length > MAX_DAY_ROWS)
      throw new ConvexError("rebootstrap_required");
    for (const row of rows) {
      // Superseded/cancelled lineage remains in storage but is not a phone assignment.
      if (row.status === "planned")
        visits.push(await visitProjection(ctx, row, actor, now));
    }
  }
  const end = start + HORIZON_DAYS * DAY_MS - 8 * 3_600_000;
  const tasks = await ctx.db
    .query("fieldTasks")
    .withIndex("by_assigneeProfileId_and_effectiveFrom", (q) =>
      q.eq("assigneeProfileId", actor.profileId).lt("effectiveFrom", end),
    )
    .order("desc")
    .take(MAX_DAY_ROWS + 1);
  if (tasks.length > MAX_DAY_ROWS)
    throw new ConvexError("rebootstrap_required");
  const relevant = tasks.filter(
    (t) =>
      t.organizationId === SUNPRIDE_ORGANIZATION_ID &&
      t.orgUnitId === actor.orgUnitId &&
      (t.effectiveTo === undefined || t.effectiveTo > start - 8 * 3_600_000),
  );
  const projectedTasks = relevant.map((t) => ({
    id: t._id,
    kind: t.kind,
    required: t.required,
  }));
  const entries = [
    ...visits.map((v) => ({ kind: "visit" as const, value: v })),
    ...projectedTasks.map((t) => ({ kind: "task" as const, value: t })),
  ];
  // Effective route/territory membership has no mobileChanges hook yet. Fold its
  // current projection into the signed manifest and force a fresh snapshot on change.
  const [territoryMembership, routeMembership] = await Promise.all([
    ctx.db
      .query("territorySalespeople")
      .withIndex("by_profileId_and_effectiveFrom", (q) =>
        q.eq("profileId", actor.profileId).lte("effectiveFrom", now),
      )
      .order("desc")
      .take(MAX_DAY_ROWS + 1),
    ctx.db
      .query("routeSalespeople")
      .withIndex("by_profileId_and_effectiveFrom", (q) =>
        q.eq("profileId", actor.profileId).lte("effectiveFrom", now),
      )
      .order("desc")
      .take(MAX_DAY_ROWS + 1),
  ]);
  if (
    territoryMembership.length > MAX_DAY_ROWS ||
    routeMembership.length > MAX_DAY_ROWS
  )
    throw new ConvexError("rebootstrap_required");
  const memberships = [
    territoryMembership
      .filter((r) => activeAt(r.effectiveFrom, r.effectiveTo, now))
      .map((r) => [r._id, r.territoryId, r.kind]),
    routeMembership
      .filter((r) => activeAt(r.effectiveFrom, r.effectiveTo, now))
      .map((r) => [r._id, r.routeId, r.primary]),
  ];
  // No unit/route-authorized product-selling catalog exists in v1. Do not expose nationwide products.
  const manifestInput = JSON.stringify({
    day,
    memberships,
    visits: visits.map((v) => v.stamp),
    tasks: relevant.map((t) => [
      t._id,
      t.status,
      t.effectiveFrom,
      t.effectiveTo,
      t.orgUnitId,
      t.kind,
      t.required,
    ]),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(manifestInput),
  );
  const manifest = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return { entries, manifest };
}
