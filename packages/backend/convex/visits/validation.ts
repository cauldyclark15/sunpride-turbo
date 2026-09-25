import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { employeeAt, localDate, manilaDate } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import type { AuthorizedDevice } from "../mobile/types";
import { activeAt } from "../org/validation";
import { outletRows, resolveOutletScopeAt } from "../outlets/validation";
import { VISIT_LOCATION_POLICY } from "./policy";

type Ctx = MutationCtx | QueryCtx;
export function validTime(time: number, now: number) {
  if (
    !Number.isSafeInteger(time) ||
    time < 0 ||
    Math.abs(now - time) > VISIT_LOCATION_POLICY.maxDeviceSkewMs
  )
    throw new ConvexError("invalid_request");
}
export function boundedText(text: string, max = 200) {
  if (!text.trim() || text.length > max)
    throw new ConvexError("invalid_request");
  return text.trim();
}
export async function authorizeActor(
  ctx: MutationCtx,
  actor: AuthorizedDevice,
  unitId: Id<"orgUnits">,
) {
  const { identity, profile } = await requireCapability(
    ctx,
    "visit.record",
    unitId,
  );
  const assignment = await employeeAt(ctx, actor.profileId, Date.now());
  const device = await ctx.db.get(actor.deviceId);
  if (
    identity.tokenIdentifier !== actor.subject ||
    profile._id !== actor.profileId ||
    profile.role !== actor.role ||
    actor.orgUnitId !== assignment.orgUnitId ||
    profile.orgUnitId !== actor.orgUnitId ||
    device?.status !== "active" ||
    device.profileId !== profile._id ||
    device.boundSubject !== actor.subject ||
    device.orgUnitId !== actor.orgUnitId ||
    device.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
    !actor.scopeFingerprint ||
    device.allowedApp === "VAN_ANDROID"
  )
    throw new ConvexError("unauthorized");
  return profile;
}
export async function accessVisit(
  ctx: Ctx,
  visit: Doc<"visitExecutions">,
  capability: "visit.read" | "visit.record",
) {
  const { profile } = await requireCapability(ctx, capability, visit.orgUnitId);
  if (
    visit.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
    (profile.role === "sales" && profile._id !== visit.assigneeProfileId)
  )
    throw new ConvexError("out_of_scope");
  const current = await employeeAt(ctx, visit.assigneeProfileId, Date.now());
  await requireCapability(ctx, capability, current.orgUnitId!);
  const outlet = await resolveOutletScopeAt(ctx, visit.outletId, Date.now());
  await requireCapability(ctx, capability, outlet.orgUnitId);
  if (
    outlet.orgUnitId !== current.orgUnitId ||
    outlet.outlet.status !== "active" ||
    !outlet.assignment
  )
    throw new ConvexError("out_of_scope");
  return { profile, outlet };
}
export async function accessOwnedVisit(
  ctx: MutationCtx,
  actor: AuthorizedDevice,
  visitId: Id<"visitExecutions">,
) {
  const visit = await ctx.db.get(visitId);
  if (!visit || visit.assigneeProfileId !== actor.profileId)
    throw new ConvexError("out_of_scope");
  await authorizeActor(ctx, actor, visit.orgUnitId);
  await accessVisit(ctx, visit, "visit.record");
  return visit;
}
export async function visitTarget(
  ctx: MutationCtx,
  actor: AuthorizedDevice,
  outletId: Id<"outlets">,
  date: string,
) {
  localDate(date);
  const current = await resolveOutletScopeAt(ctx, outletId, Date.now());
  if (
    current.outlet.status !== "active" ||
    !current.assignment ||
    current.orgUnitId !== actor.orgUnitId
  )
    throw new ConvexError("out_of_scope");
  await authorizeActor(ctx, actor, current.orgUnitId);
  const rows = await outletRows(ctx, "outletCustomerLinks", outletId);
  const links = rows.filter((row) =>
    activeAt(row.effectiveFrom, row.effectiveTo, Date.now()),
  );
  if (links.length > 1) throw new ConvexError("invalid_request");
  return { current, customerId: links[0]?.customerId };
}
export function assertToday(date: string, now: number) {
  localDate(date);
  if (date !== manilaDate(now + VISIT_LOCATION_POLICY.checkInGraceMs))
    throw new ConvexError("wrong_date");
}
