import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { employeeAt, manilaDate } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { capabilityRoles } from "../lib/capabilities";
import { outletRows, resolveOutletScopeAt } from "../outlets/validation";
import { activeAt } from "../org/validation";
import type { AuthorizedDevice } from "./types";
import {
  referenceProjection,
  type Availability,
  type CatalogItem,
  type ReferenceProjection,
} from "./reference";
import {
  accountFor,
  phoneCallSheet,
  type PhoneCallSheet,
} from "../callSheets/model";
import { phoneRules, rulesAt } from "../visits/activity_rules";
import {
  orderTermsFor,
  pricingCache,
  type OrderTerms,
  type PricingCache,
} from "../pricing/model";
import {
  EVIDENCE_PHOTO_TYPES,
  EVIDENCE_PHOTO_TYPES_VERSION,
} from "../visits/policy";
import {
  MAX_WORKING_SET_PRODUCTS,
  MAX_WORKING_SET_VISITS,
  WORKING_SET_TOO_LARGE,
} from "./budget";

/** AND-016 phone wire: the photo types visit evidence may carry. */
export const photoTypeDTO = v.object({ code: v.string(), label: v.string() });
export function phonePhotoTypes() {
  return EVIDENCE_PHOTO_TYPES.map(({ code, label }) => ({ code, label }));
}

export const DAY_MS = 86_400_000;
export const HORIZON_DAYS = 3;
export const MAX_DAY_ROWS = 500;
export const visitDTO = v.object({
  id: v.string(),
  outletId: v.string(),
  serviceDate: v.string(),
  planId: v.string(),
  planVersion: v.number(),
  intents: v.array(v.string()),
  /** MCP order of the day (lower first); optional in contract v1. */
  sequence: v.optional(v.number()),
});
export const outletDTO = v.object({
  id: v.string(),
  name: v.string(),
  routeId: v.union(v.string(), v.null()),
  /** Daily route screen (AND-010); optional in contract v1, older servers omit them. */
  code: v.optional(v.string()),
  customerId: v.optional(v.string()),
  address: v.optional(v.string()),
  /** Current verified pin; both present or both absent. */
  latitude: v.optional(v.number()),
  longitude: v.optional(v.number()),
  /** Order drafts (SP-0061); optional in contract v1. */
  territoryId: v.optional(v.string()),
  territoryCode: v.optional(v.string()),
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
export { availabilityDTO, catalogItemDTO as productDTO } from "./reference";
const nullableText = v.union(v.string(), v.null());
export const callSheetDTO = v.object({
  outletId: v.string(),
  revision: v.number(),
  header: v.object({
    accountName: v.string(),
    address: nullableText,
    buyerName: nullableText,
    contactNumber: nullableText,
    accountInCharge: nullableText,
    receivingInCharge: nullableText,
    distributorName: nullableText,
    distributorSchedule: nullableText,
    foc: nullableText,
    pricing: nullableText,
  }),
  lines: v.array(
    v.object({
      productId: v.string(),
      code: v.string(),
      name: v.string(),
      uom: v.string(),
      barcode: nullableText,
      pricing: nullableText,
    }),
  ),
});
/**
 * SP-0088 phone wire: one outlet's order terms (price list and every orderable unit of its
 * account-setup products, priced when the list has exactly one price). Optional in contract v1.
 */
export const orderTermsDTO = v.object({
  outletId: v.string(),
  priceList: v.union(
    v.object({
      id: v.string(),
      code: v.string(),
      name: v.string(),
      currency: v.string(),
      sample: v.boolean(),
    }),
    v.null(),
  ),
  lines: v.array(
    v.object({
      productId: v.string(),
      uom: v.string(),
      unitPriceMinor: v.union(v.number(), v.null()),
    }),
  ),
});
type CallSheetCache = {
  /** SP-0088: one order-terms projection per outlet per snapshot. */
  terms: Map<Id<"outlets">, { terms: OrderTerms; stamp: string } | null>;
  pricing: PricingCache;
  accounts: Map<
    Id<"outlets">,
    { sheet: PhoneCallSheet; stamp: string; membershipStamp: string } | null
  >;
  products: Parameters<typeof phoneCallSheet>[2];
  /** QSR-013: one read per plan/outlet per snapshot keeps the transaction within its range budget. */
  plans: Map<Id<"coveragePlans">, Doc<"coveragePlans"> | null>;
  outlets: Map<
    Id<"outlets">,
    {
      current: Awaited<ReturnType<typeof resolveOutletScopeAt>>;
      pins: Doc<"outletPins">[];
    }
  >;
};
export type Visit = typeof visitDTO.type;
export type Task = typeof taskDTO.type;
export type Projected = {
  visit: Visit;
  outlet: typeof outletDTO.type;
  customer: typeof customerDTO.type | null;
  route: Exclude<typeof routeDTO.type, null> | null;
  callSheet: PhoneCallSheet | null;
  orderTerms: OrderTerms | null;
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
  cache: CallSheetCache,
  reference: boolean,
): Promise<Projected> {
  let plan = cache.plans.get(row.planId);
  if (plan === undefined) {
    plan = await ctx.db.get(row.planId);
    cache.plans.set(row.planId, plan);
  }
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
  let outletState = cache.outlets.get(row.outletId);
  if (!outletState) {
    outletState = {
      current: await resolveOutletScopeAt(ctx, row.outletId, now),
      pins: await outletRows(ctx, "outletPins", row.outletId),
    };
    cache.outlets.set(row.outletId, outletState);
  }
  const current = outletState.current;
  // No inherited unit/territory grant for a field phone: only its own current unit.
  if (
    current.orgUnitId !== actor.orgUnitId ||
    current.outlet.status === "inactive"
  )
    throw new ConvexError("rebootstrap_required");
  const customer = s.customerId ? await ctx.db.get(s.customerId) : null;
  if (s.customerId && !customer) throw new ConvexError("rebootstrap_required");
  const slot = await ctx.db.get(row.planSlotId);
  if (!slot || slot.planId !== row.planId)
    throw new ConvexError("rebootstrap_required");
  // Annex C account sheet; office edits change the stamp and force a fresh snapshot.
  let callSheet = cache.accounts.get(row.outletId);
  if (callSheet === undefined) {
    const account = await accountFor(ctx, row.outletId);
    callSheet = account
      ? await phoneCallSheet(ctx, account, cache.products)
      : null;
    cache.accounts.set(row.outletId, callSheet);
  }
  // SP-0088: prices for the account-setup products, at the snapshot instant.
  let terms = cache.terms.get(row.outletId);
  if (terms === undefined) {
    // Product rows come from the call sheet's own reads, the outlet from scope resolution.
    terms = callSheet
      ? await orderTermsFor(
          ctx,
          current.outlet,
          customer,
          callSheet.sheet.lines.flatMap((line) => {
            const product = cache.products.get(
              line.productId as Id<"products">,
            )?.product;
            return product ? [product] : [];
          }),
          now,
          cache.pricing,
        )
      : null;
    cache.terms.set(row.outletId, terms);
  }
  // Navigation target: only an unambiguous current verified pin. Missing or conflicting
  // pins send no coordinates (the phone falls back to the address), never a guess.
  const pins = outletState.pins.filter(
    (p) =>
      p.status === "verified" && activeAt(p.effectiveFrom, p.effectiveTo, now),
  );
  const pin =
    pins.length === 1 &&
    Number.isFinite(pins[0]!.latitude) &&
    Math.abs(pins[0]!.latitude) <= 90 &&
    Number.isFinite(pins[0]!.longitude) &&
    Math.abs(pins[0]!.longitude) <= 180
      ? pins[0]!
      : null;
  const address = current.outlet.address?.trim() || undefined;
  return {
    visit: {
      id: row._id,
      outletId: row.outletId,
      serviceDate: row.serviceDate,
      planId: row.planId,
      planVersion: row.planVersion,
      intents: row.intents,
      sequence: slot.sequence,
    },
    outlet: {
      id: s.outletId,
      name: s.outletName,
      routeId: s.routeId ?? null,
      code: s.outletCode,
      ...(s.customerId ? { customerId: s.customerId } : {}),
      territoryId: s.territoryId,
      territoryCode: s.territoryCode,
      ...(address ? { address } : {}),
      ...(pin ? { latitude: pin.latitude, longitude: pin.longitude } : {}),
    },
    customer: customer ? { id: customer._id, code: customer.code } : null,
    route:
      s.routeId && s.routeCode ? { id: s.routeId, code: s.routeCode } : null,
    callSheet: callSheet?.sheet ?? null,
    orderTerms: terms?.terms ?? null,
    stamp: `${terms?.stamp ?? ""}|${(reference ? callSheet?.membershipStamp : callSheet?.stamp) ?? ""}|${row._id}|${row.status}|${row._creationTime}|${row.generatedAt}|${JSON.stringify(s)}|${JSON.stringify(row.intents)}|${current.assignment?._id ?? ""}|${current.assignment?.routeId ?? ""}|${current.assignment?.sequence ?? ""}|${current.orgUnitId}|${current.outlet.status}|${customer?.code ?? ""}|${slot.sequence}|${address ?? ""}|${pin?._id ?? ""}|${pin?.latitude ?? ""}|${pin?.longitude ?? ""}`,
  };
}

export type DayEntry =
  | { kind: "visit"; value: Projected }
  | { kind: "task"; value: Task }
  | { kind: "product"; value: CatalogItem }
  | { kind: "inventory"; value: Availability };

/**
 * Bounded, indexed per-person day scan. Reject oversized days rather than truncate.
 * With `reference` (SP-0051 opt-in) the entries also carry the phone's products and stock, and
 * product content leaves the manifest: it travels as revisioned pull changes instead.
 */
export async function dayProjection(
  ctx: QueryCtx,
  actor: AuthorizedDevice,
  day: string,
  now: number,
  reference = false,
): Promise<{
  entries: DayEntry[];
  manifest: string;
  activityRules: ReturnType<typeof phoneRules>;
  reference: ReferenceProjection | null;
}> {
  const start = Date.parse(`${day}T00:00:00Z`);
  if (
    !Number.isFinite(start) ||
    new Date(start).toISOString().slice(0, 10) !== day ||
    day !== manilaDate(now)
  )
    throw new ConvexError("rebootstrap_required");
  const visits: Projected[] = [];
  const cache: CallSheetCache = {
    terms: new Map(),
    pricing: pricingCache(),
    accounts: new Map(),
    products: new Map(),
    plans: new Map(),
    outlets: new Map(),
  };
  const planned: Doc<"plannedVisits">[] = [];
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
    // Superseded/cancelled lineage remains in storage but is not a phone assignment.
    planned.push(...rows.filter((row) => row.status === "planned"));
  }
  // QSR-013: refuse an oversized working set explicitly before reading its projection
  // (no silent truncation); the office has to split the plan.
  if (planned.length > MAX_WORKING_SET_VISITS)
    throw new ConvexError(WORKING_SET_TOO_LARGE);
  for (const row of planned) {
    visits.push(await visitProjection(ctx, row, actor, now, cache, reference));
    if (cache.products.size > MAX_WORKING_SET_PRODUCTS)
      throw new ConvexError(WORKING_SET_TOO_LARGE);
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
  const referenceData = reference
    ? await referenceProjection(
        ctx,
        actor,
        [...cache.accounts.values()].flatMap((account) =>
          account
            ? account.sheet.lines.map(
                (line) => line.productId as Id<"products">,
              )
            : [],
        ),
        now,
      )
    : null;
  const entries: DayEntry[] = [
    ...visits.map((v) => ({ kind: "visit" as const, value: v })),
    ...projectedTasks.map((t) => ({ kind: "task" as const, value: t })),
    ...(referenceData?.products ?? []).map((p) => ({
      kind: "product" as const,
      value: p,
    })),
    ...(referenceData?.availability ?? []).map((a) => ({
      kind: "inventory" as const,
      value: a,
    })),
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
  // AND-013: activity-form rules in effect now; a rule change forces a fresh snapshot.
  const activityRules = phoneRules(await rulesAt(ctx, now));
  // Never a nationwide catalog: only the reference opt-in's call-sheet products (SP-0051).
  const manifestInput = JSON.stringify({
    day,
    memberships,
    activityRules,
    // AND-016: a photo-type list change forces a fresh snapshot, like a rule change.
    photoTypes: EVIDENCE_PHOTO_TYPES_VERSION,
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
    ...(referenceData ? { reference: referenceData.membership } : {}),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(manifestInput),
  );
  const manifest = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return { entries, manifest, activityRules, reference: referenceData };
}
