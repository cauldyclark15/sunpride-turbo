import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability, type Capability } from "../lib/capabilities";
import { activeAt } from "../org/validation";
import {
  resolveOutletScopeAt,
  outletRows,
  assertActiveOutlet,
} from "../outlets/validation";
import { resolveTerritoryOwnerAt } from "../territories/validation";
import { at, routeAt, routeSalespeople } from "../territories/route_validation";

type Ctx = QueryCtx | MutationCtx;
export const MAX_PLAN_ROWS = 500;
const DAY = 86_400_000;
const MANILA_OFFSET = 8 * 3_600_000;

export function monthBounds(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new ConvexError("Invalid Manila month");
  const year = Number(month.slice(0, 4)),
    index = Number(month.slice(5, 7));
  const from = Date.UTC(year, index - 1, 1) - MANILA_OFFSET;
  const to = Date.UTC(year, index, 1) - MANILA_OFFSET;
  if (new Date(from + MANILA_OFFSET).toISOString().slice(0, 7) !== month)
    throw new ConvexError("Invalid Manila month");
  return { from, to };
}
export function localDate(date: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(date))
    throw new ConvexError("Invalid Manila date");
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date)
    throw new ConvexError("Invalid Manila date");
  return ms - MANILA_OFFSET;
}
export function manilaDate(ms: number) {
  return new Date(ms + MANILA_OFFSET).toISOString().slice(0, 10);
}
export function monthDates(month: string) {
  const { from, to } = monthBounds(month);
  const dates: string[] = [];
  for (let ms = from; ms < to; ms += DAY) dates.push(manilaDate(ms));
  return dates;
}
export function planWindow(month: string, from: number, to: number) {
  const bounds = monthBounds(month);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from < bounds.from ||
    to > bounds.to ||
    from >= to
  )
    throw new ConvexError("Coverage interval must be within Manila month");
}
export function required(text: string, label: string) {
  const value = text.trim();
  if (!value || value.length > 500)
    throw new ConvexError(`${label} required (max 500)`);
  return value;
}
export function positive(n: number, label: string) {
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new ConvexError(`${label} must be a positive integer`);
}
export async function bounded<T>(
  promise: Promise<T[]>,
  label: string,
): Promise<T[]> {
  const rows = await promise;
  if (rows.length > MAX_PLAN_ROWS)
    throw new ConvexError(`${label} exceeds limit`);
  return rows;
}
export function overlaps(
  a: { effectiveFrom: number; effectiveTo: number },
  b: { effectiveFrom: number; effectiveTo: number },
) {
  return a.effectiveFrom < b.effectiveTo && b.effectiveFrom < a.effectiveTo;
}
export async function employeeAt(
  ctx: Ctx,
  profileId: Id<"profiles">,
  instant: number,
) {
  const profile = await ctx.db.get(profileId);
  if (!profile || profile.status !== "active")
    throw new ConvexError("Active assignee required");
  const rows = await bounded(
    ctx.db
      .query("employeeAssignments")
      .withIndex("by_profileId_and_effectiveFrom", (q) =>
        q.eq("profileId", profileId),
      )
      .take(MAX_PLAN_ROWS + 1),
    "Employee assignment history",
  );
  const assignment = at(rows, instant);
  if (!assignment?.orgUnitId)
    throw new ConvexError(
      "Assignee has no effective employee assignment with unit",
    );
  return assignment;
}
export async function planAccess(
  ctx: Ctx,
  plan: Doc<"coveragePlans">,
  key: Capability,
) {
  const access = await requireCapability(ctx, key, plan.orgUnitId);
  if (
    access.profile.role === "sales" &&
    access.profile._id !== plan.assigneeProfileId
  )
    throw new ConvexError("Sales may access only own plan");
  const current = await employeeAt(ctx, plan.assigneeProfileId, Date.now());
  await requireCapability(ctx, key, current.orgUnitId!);
  return access;
}
export async function outletAccess(
  ctx: Ctx,
  outletId: Id<"outlets">,
  key: Capability,
) {
  const current = await resolveOutletScopeAt(ctx, outletId, Date.now());
  await requireCapability(ctx, key, current.orgUnitId);
  return current;
}
export async function planRows(ctx: Ctx, planId: Id<"coveragePlans">) {
  const [outlets, slots, assignments] = await Promise.all([
    bounded(
      ctx.db
        .query("coveragePlanOutlets")
        .withIndex("by_planId_and_outletId", (q) => q.eq("planId", planId))
        .take(MAX_PLAN_ROWS + 1),
      "Plan outlets",
    ),
    bounded(
      ctx.db
        .query("coveragePlanSlots")
        .withIndex("by_planId_and_serviceDate", (q) => q.eq("planId", planId))
        .take(MAX_PLAN_ROWS + 1),
      "Plan slots",
    ),
    bounded(
      ctx.db
        .query("coverageAssignments")
        .withIndex("by_planId_and_effectiveFrom", (q) => q.eq("planId", planId))
        .take(MAX_PLAN_ROWS + 1),
      "Plan assignments",
    ),
  ]);
  return { outlets, slots, assignments };
}
/** Slice C consumes the signed rows, never re-resolves mutable master data. */
export async function approvedSlots(ctx: Ctx, plan: Doc<"coveragePlans">) {
  if (
    plan.status !== "approved" &&
    plan.status !== "active" &&
    plan.status !== "superseded"
  )
    throw new ConvexError("Plan has no approved slots");
  const { slots } = await planRows(ctx, plan._id);
  if (
    slots.some((slot) => slot.kind === "outlet_visit" && !slot.approvedSnapshot)
  )
    throw new ConvexError("Approved outlet snapshot missing");
  return slots
    .filter((slot) => slot.kind === "outlet_visit" && slot.approvedSnapshot)
    .sort(
      (a, b) =>
        a.serviceDate.localeCompare(b.serviceDate) ||
        a.sequence - b.sequence ||
        a.slotKey.localeCompare(b.slotKey),
    );
}
export async function snapshotSlot(
  ctx: MutationCtx,
  plan: Doc<"coveragePlans">,
  slot: Doc<"coveragePlanSlots">,
) {
  if (!slot.outletId) throw new ConvexError("Outlet visit requires outlet");
  const instant = localDate(slot.serviceDate);
  if (instant < plan.effectiveFrom || instant >= plan.effectiveTo)
    throw new ConvexError("Slot outside plan effective window");
  await outletAccess(ctx, slot.outletId, "mcp.approve");
  const { outlet, assignment, orgUnitId } = await resolveOutletScopeAt(
    ctx,
    slot.outletId,
    instant,
  );
  assertActiveOutlet(outlet);
  if (outlet.status !== "active")
    throw new ConvexError("Inactive outlet on service date");
  if (!assignment)
    throw new ConvexError("Outlet not assigned or active on service date");
  const owner = await resolveTerritoryOwnerAt(
    ctx,
    assignment.territoryId,
    instant,
  );
  const territory = await ctx.db.get(assignment.territoryId);
  if (
    !owner ||
    !territory ||
    territory.status !== "active" ||
    !activeAt(territory.effectiveFrom, territory.effectiveTo, instant)
  )
    throw new ConvexError("Territory inactive on service date");
  await requireCapability(ctx, "mcp.approve", orgUnitId);
  const employee = await employeeAt(ctx, plan.assigneeProfileId, instant);
  await requireCapability(ctx, "mcp.approve", employee.orgUnitId!);
  if (employee.orgUnitId !== plan.orgUnitId)
    throw new ConvexError("Assignee unit changed; revise plan");
  const territoryPeople = await bounded(
    ctx.db
      .query("territorySalespeople")
      .withIndex("by_territoryId_and_effectiveFrom", (q) =>
        q.eq("territoryId", assignment.territoryId),
      )
      .take(MAX_PLAN_ROWS + 1),
    "Territory salesperson history",
  );
  const territoryPerson = at(territoryPeople, instant);
  let route, routeTerritory, routePerson;
  if (slot.routeId || assignment.routeId) {
    if (slot.routeId !== assignment.routeId)
      throw new ConvexError("Slot route differs from outlet assignment");
    const checked = await routeAt(ctx, slot.routeId!, instant);
    route = checked.route;
    routeTerritory = checked.association;
    if (
      route.status !== "active" ||
      !activeAt(route.effectiveFrom, route.effectiveTo, instant) ||
      routeTerritory?.territoryId !== assignment.territoryId
    )
      throw new ConvexError("Route not in territory on service date");
    routePerson = at(await routeSalespeople(ctx, route._id), instant);
    if (routePerson?.profileId !== plan.assigneeProfileId)
      throw new ConvexError("Route not assigned to assignee on service date");
  } else if (territoryPerson?.profileId !== plan.assigneeProfileId)
    throw new ConvexError("Territory not assigned to assignee on service date");
  const links = await outletRows(ctx, "outletCustomerLinks", outlet._id);
  const link = at(links, instant);
  if (link) {
    const customer = await ctx.db.get(link.customerId);
    if (!customer || !customer.active)
      throw new ConvexError("Invalid outlet customer link");
  }
  return {
    outletId: outlet._id,
    outletCode: outlet.code,
    outletName: outlet.name,
    ...(link
      ? { customerId: link.customerId, outletCustomerLinkId: link._id }
      : {}),
    territoryId: territory._id,
    territoryCode: territory.code,
    ...(route ? { routeId: route._id, routeCode: route.code } : {}),
    sequence: slot.sequence,
    outletAssignmentId: assignment._id,
    territoryOwnershipId: owner._id,
    ...(territoryPerson ? { territorySalespersonId: territoryPerson._id } : {}),
    ...(routeTerritory ? { routeTerritoryId: routeTerritory._id } : {}),
    ...(routePerson ? { routeSalespersonId: routePerson._id } : {}),
    employeeAssignmentId: employee._id,
    orgUnitId,
    activityKind: slot.activityKind ?? "outlet_visit",
    approvedAssigneeProfileId: plan.assigneeProfileId,
  };
}
export async function assertOutletsScoped(
  ctx: Ctx,
  outletIds: Id<"outlets">[],
  key: Capability,
) {
  for (const id of new Set(outletIds)) await outletAccess(ctx, id, key);
}
export function assertOrganization(id: string) {
  if (id !== SUNPRIDE_ORGANIZATION_ID)
    throw new ConvexError("Organization mismatch");
}
