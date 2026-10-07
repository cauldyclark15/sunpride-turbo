import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { capabilityRoles, requireCapability } from "../lib/capabilities";
import type { AppRole } from "../lib/roles";
import { collectScopeUnitIds } from "../lib/scope";
import { audit } from "../org/validation";
import { requireCurrentDeviceActor } from "./access";
import { postDamageReversal } from "./ledger";
import {
  actorValidator,
  boundedText,
  damageStatusValidator,
  VAN_DAMAGE_POLICY,
  type DamageStatus,
} from "./model";

/**
 * VAN-020: damaged/spoiled stock on the truck. The device records it (van/device.ts
 * `truck.damage`), which moves the quantity available → damaged at once through
 * postMovement and writes a `vanDamageRecords` row. Records at or above the approval
 * threshold wait for a supervisor here; a rejection posts a reversal movement.
 */

export const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_TRIP_RECORDS = 200;
/** Same cross-scope readers as lib/capabilities.ts (whole organization, read-only). */
const CROSS_SCOPE_ROLES: readonly AppRole[] = ["super_admin", "analyst"];

/** A van device's photo, found by its digest; only the uploader's own photos match. */
export async function photoFor(
  ctx: QueryCtx,
  profileId: Id<"profiles">,
  sha256: string,
) {
  return ctx.db
    .query("vanDamagePhotos")
    .withIndex("by_profileId_and_sha256", (q) =>
      q.eq("profileId", profileId).eq("sha256", sha256),
    )
    .unique();
}

/** Upload step 1 (evidence route): skip storing bytes the server already holds. */
export const photoExists = internalQuery({
  args: { actor: actorValidator, sha256: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { actor, sha256 }) => {
    await requireCurrentDeviceActor(ctx, actor);
    return (await photoFor(ctx, actor.profileId, sha256)) !== null;
  },
});

/**
 * Upload step 2: bind a stored JPEG to the uploading seller and device. Idempotent per
 * (seller, digest); returns false when another upload won, so the caller deletes its copy.
 */
export const registerPhoto = internalMutation({
  args: {
    actor: actorValidator,
    sha256: v.string(),
    storageId: v.id("_storage"),
    size: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, { actor, sha256, storageId, size }) => {
    await requireCurrentDeviceActor(ctx, actor);
    const roles = capabilityRoles("van.operate") as readonly AppRole[];
    if (actor.role !== "super_admin" && !roles.includes(actor.role))
      throw new ConvexError("out_of_scope");
    if (
      !SHA256_HEX.test(sha256) ||
      size <= 0 ||
      size > VAN_DAMAGE_POLICY.photoMaxBytes
    )
      throw new ConvexError("invalid_request");
    if (await photoFor(ctx, actor.profileId, sha256)) return false;
    await ctx.db.insert("vanDamagePhotos", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      profileId: actor.profileId,
      deviceId: actor.deviceId,
      sha256,
      storageId,
      size,
      createdAt: Date.now(),
    });
    return true;
  },
});

/** Wire view of one trip's damage records for the device bootstrap, newest first. */
export async function tripDamageRecords(ctx: QueryCtx, tripId: Id<"vanTrips">) {
  const rows = await ctx.db
    .query("vanDamageRecords")
    .withIndex("by_tripId_and_recordedAt", (q) => q.eq("tripId", tripId))
    .order("desc")
    .take(MAX_TRIP_RECORDS);
  return rows.map((row) => ({
    damageId: row._id,
    clientRequestId: row.clientRequestId,
    productId: row.productId,
    // Frozen when recorded: a later product unit change never relabels history.
    uomCode: row.uomCode,
    quantityScale: String(row.quantityScale),
    quantityBase: String(row.quantityBase),
    reason: row.reason,
    status: row.status,
    recordedAt: row.recordedAt,
    decisionNote: row.decisionNote ?? null,
  }));
}

const reviewRow = v.object({
  damageId: v.id("vanDamageRecords"),
  tripId: v.id("vanTrips"),
  tripNumber: v.string(),
  serviceDate: v.string(),
  orgUnitId: v.id("orgUnits"),
  sellerName: v.string(),
  productCode: v.string(),
  productName: v.string(),
  uomCode: v.string(),
  quantityBase: v.int64(),
  quantityScale: v.int64(),
  reason: v.string(),
  note: v.union(v.string(), v.null()),
  photoUrl: v.union(v.string(), v.null()),
  needsApproval: v.boolean(),
  status: damageStatusValidator,
  recordedAt: v.number(),
  decidedAt: v.union(v.number(), v.null()),
  decisionNote: v.union(v.string(), v.null()),
  canDecide: v.boolean(),
});

/**
 * Office review list, newest first. Rows outside the caller's current organizational
 * scope are dropped, so a page may come back short (or empty) with more to load; a
 * salesman sees only his own records. Photos are short-lived signed URLs.
 */
export const listForReview = query({
  args: {
    status: v.optional(damageStatusValidator),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(reviewRow),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const { identity, profile } = await requireCapability(ctx, "van.read");
    const crossScope = CROSS_SCOPE_ROLES.includes(profile.role as AppRole);
    if (!crossScope && !profile.orgUnitId)
      throw new ConvexError("Your access has no organizational scope");
    const scope = crossScope
      ? null
      : new Set(await collectScopeUnitIds(ctx, profile.orgUnitId!));
    const approveRoles = capabilityRoles(
      "van.damage.approve",
    ) as readonly AppRole[];
    const mayApprove =
      profile.role === "super_admin" ||
      approveRoles.includes(profile.role as AppRole);
    const status = args.status;
    const result = await (
      status
        ? ctx.db
            .query("vanDamageRecords")
            .withIndex("by_organizationId_and_status_and_recordedAt", (q) =>
              q
                .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
                .eq("status", status),
            )
        : ctx.db
            .query("vanDamageRecords")
            .withIndex("by_organizationId_and_recordedAt", (q) =>
              q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
            )
    )
      .order("desc")
      .paginate(args.paginationOpts);
    const page = [];
    for (const row of result.page) {
      if (scope && !scope.has(row.orgUnitId)) continue;
      if (profile.role === "sales" && row.recordedProfileId !== profile._id)
        continue;
      const trip = await ctx.db.get(row.tripId);
      const seller = await ctx.db.get(row.recordedProfileId);
      const product = await ctx.db.get(row.productId);
      const photo = row.photoId ? await ctx.db.get(row.photoId) : null;
      page.push({
        damageId: row._id,
        tripId: row.tripId,
        tripNumber: trip?.tripNumber ?? "",
        serviceDate: trip?.serviceDate ?? "",
        orgUnitId: row.orgUnitId,
        sellerName: seller?.name ?? "Former user",
        productCode: row.productCode,
        productName: product?.name ?? row.productCode,
        uomCode: row.uomCode,
        quantityBase: row.quantityBase,
        quantityScale: row.quantityScale,
        reason: row.reason,
        note: row.note ?? null,
        photoUrl: photo ? await ctx.storage.getUrl(photo.storageId) : null,
        needsApproval: row.needsApproval,
        status: row.status,
        recordedAt: row.recordedAt,
        decidedAt: row.decidedAt ?? null,
        decisionNote: row.decisionNote ?? null,
        canDecide:
          mayApprove &&
          row.status === "pending_approval" &&
          row.recordedBy !== identity.tokenIdentifier,
      });
    }
    return {
      page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * VAN-020: a supervisor in scope approves or rejects a damage record waiting for approval.
 * The recorder can never decide his own record. Rejecting needs a note and posts a
 * damaged → available reversal; approving keeps the original movement as the write-off.
 */
export const decide = mutation({
  args: {
    damageId: v.id("vanDamageRecords"),
    decision: v.union(v.literal("approve"), v.literal("reject")),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.damageId);
    if (!record || record.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("Damage record not found");
    const { identity } = await requireCapability(
      ctx,
      "van.damage.approve",
      record.orgUnitId,
    );
    if (record.status !== "pending_approval")
      throw new ConvexError("This damage record is not waiting for approval");
    if (record.recordedBy === identity.tokenIdentifier)
      throw new ConvexError(
        "The person who recorded the damage cannot decide it",
      );
    const note = boundedText(args.note, 300, "Decision note");
    if (args.decision === "reject" && !note)
      throw new ConvexError("Say why the damage is rejected");
    const trip = await ctx.db.get(record.tripId);
    if (!trip) throw new ConvexError("Trip not found");
    const now = Date.now();
    let reversalMovementId: Id<"inventoryMovements"> | undefined;
    if (args.decision === "reject") {
      const movement = await postDamageReversal(ctx, {
        record,
        trip,
        actorSubject: identity.tokenIdentifier,
      });
      reversalMovementId = movement.movementId;
    }
    const status: DamageStatus =
      args.decision === "approve" ? "approved" : "rejected";
    await ctx.db.patch(record._id, {
      status,
      decidedBy: identity.tokenIdentifier,
      decidedAt: now,
      ...(note ? { decisionNote: note } : {}),
      ...(reversalMovementId ? { reversalMovementId } : {}),
      updatedAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      `van.damage.${status}`,
      "vanDamageRecord",
      record._id,
      note ?? status,
      now,
    );
    return null;
  },
});
