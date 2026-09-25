import { ConvexError, v } from "convex/values";
import { mutation, type MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { append } from "./events";
import { EVIDENCE_MIME, MAX_EVIDENCE_BYTES } from "./policy";
import { accessVisit } from "./validation";

async function owner(
  ctx: Parameters<typeof accessVisit>[0],
  visitId: Parameters<typeof accessVisit>[1]["_id"],
) {
  const visit = await ctx.db.get(visitId);
  if (!visit || visit.organizationId !== SUNPRIDE_ORGANIZATION_ID)
    throw new ConvexError("out_of_scope");
  const { profile } = await accessVisit(ctx, visit, "visit.read");
  await requireCapability(ctx, "visit.record", visit.orgUnitId);
  if (
    profile._id !== visit.assigneeProfileId ||
    !["checked-in", "in-progress", "checked-out"].includes(visit.state)
  )
    throw new ConvexError("out_of_scope");
  return { visit, profile };
}
export const UPLOAD_CLAIM_TTL_MS = 10 * 60_000;
export const generateUploadUrl = mutation({
  args: { visitId: v.id("visitExecutions") },
  returns: v.object({ url: v.string(), uploadTokenRef: v.string() }),
  handler: async (ctx, { visitId }) => {
    const { profile } = await owner(ctx, visitId);
    const { identity } = await requireCapability(ctx, "visit.record");
    const url = await ctx.storage.generateUploadUrl();
    const now = Date.now();
    const claimId = await ctx.db.insert("evidenceUploadClaims", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      visitId,
      profileId: profile._id,
      subject: identity.tokenIdentifier,
      issuedAt: now,
      expiresAt: now + UPLOAD_CLAIM_TTL_MS,
    });
    return { url, uploadTokenRef: claimId };
  },
});

/** Must run in the attachment transaction. A failed downstream check rolls this patch back. */
export async function consumeUploadClaim(
  ctx: MutationCtx,
  args: {
    claimId: Id<"evidenceUploadClaims">;
    visitId: Id<"visitExecutions">;
    profileId: Id<"profiles">;
    subject: string;
    storageId: Id<"_storage">;
    now: number;
  },
): Promise<void> {
  const claim = await ctx.db.get(args.claimId);
  if (
    !claim ||
    claim.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
    claim.visitId !== args.visitId ||
    claim.profileId !== args.profileId ||
    claim.subject !== args.subject ||
    claim.issuedAt > args.now ||
    claim.expiresAt <= args.now ||
    claim.consumedAt !== undefined ||
    claim.storageId !== undefined
  )
    throw new ConvexError("invalid_evidence");
  const used = await ctx.db
    .query("evidenceUploadClaims")
    .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
    .take(1);
  if (used.length) throw new ConvexError("conflict");
  await ctx.db.patch(claim._id, {
    consumedAt: args.now,
    storageId: args.storageId,
  });
}

/** Isolated because convex-test does not implement getMetadata. */
export async function verifyStoredEvidence(
  storage: Pick<MutationCtx["storage"], "getMetadata">,
  storageId: Id<"_storage">,
  size: number,
  mime: string,
  checksum: string,
): Promise<void> {
  const stored = await storage.getMetadata(storageId);
  if (
    !stored ||
    stored.size !== size ||
    stored.contentType !== mime ||
    !matchesChecksum(stored.sha256, checksum)
  )
    throw new ConvexError("invalid_evidence");
}
export function matchesChecksum(storedBase64: string, suppliedHex: string) {
  if (!/^[0-9a-f]{64}$/i.test(suppliedHex)) return false;
  try {
    const bytes = atob(storedBase64);
    return (
      bytes.length === 32 &&
      Array.from(bytes, (c) =>
        c.charCodeAt(0).toString(16).padStart(2, "0"),
      ).join("") === suppliedHex.toLowerCase()
    );
  } catch {
    return false;
  }
}

export const attach = mutation({
  args: {
    uploadTokenRef: v.optional(v.string()),
    visitId: v.id("visitExecutions"),
    storageId: v.id("_storage"),
    mime: v.string(),
    size: v.number(),
    checksum: v.string(),
    capturedAt: v.number(),
    activityId: v.optional(v.id("visitActivities")),
  },
  returns: v.object({ evidenceId: v.id("fieldEvidenceFiles") }),
  handler: async (ctx, args) => {
    const { visit, profile } = await owner(ctx, args.visitId);
    if (
      !EVIDENCE_MIME.includes(args.mime as (typeof EVIDENCE_MIME)[number]) ||
      !Number.isSafeInteger(args.size) ||
      args.size < 1 ||
      args.size > MAX_EVIDENCE_BYTES ||
      !/^[0-9a-f]{64}$/i.test(args.checksum) ||
      !Number.isSafeInteger(args.capturedAt) ||
      args.capturedAt < visit.checkedInAt! - 24 * 3600000 ||
      args.capturedAt > Date.now() + 60000
    )
      throw new ConvexError("invalid_request");
    const { identity } = await requireCapability(
      ctx,
      "visit.record",
      visit.orgUnitId,
    );
    if (!args.uploadTokenRef) throw new ConvexError("invalid_evidence");
    const claimId = ctx.db.normalizeId(
      "evidenceUploadClaims",
      args.uploadTokenRef,
    );
    if (!claimId) throw new ConvexError("invalid_evidence");
    await consumeUploadClaim(ctx, {
      claimId,
      visitId: visit._id,
      profileId: profile._id,
      subject: identity.tokenIdentifier,
      storageId: args.storageId,
      now: Date.now(),
    });
    await verifyStoredEvidence(
      ctx.storage,
      args.storageId,
      args.size,
      args.mime,
      args.checksum,
    );
    if (args.activityId) {
      const activity = await ctx.db.get(args.activityId);
      if (
        !activity ||
        activity.visitId !== visit._id ||
        activity.assigneeProfileId !== profile._id ||
        activity.orgUnitId !== visit.orgUnitId
      )
        throw new ConvexError("out_of_scope");
    }
    const duplicate = await ctx.db
      .query("fieldEvidenceFiles")
      .withIndex("by_visitId_and_uploadedAt", (q) => q.eq("visitId", visit._id))
      .take(501);
    if (
      duplicate.length > 500 ||
      duplicate.some((file) => file.storageId === args.storageId)
    )
      throw new ConvexError("conflict");
    // Also reject a storage ID attached to any other visit. No global storage index exists in slice A.
    // Until a durable upload claim table is added, do not certify media solely from this attachment.
    const evidenceId = await ctx.db.insert("fieldEvidenceFiles", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      orgUnitId: visit.orgUnitId,
      storageId: args.storageId,
      visitId: visit._id,
      activityId: args.activityId,
      ownerProfileId: profile._id,
      outletId: visit.outletId,
      mime: args.mime,
      sizeBytes: args.size,
      checksum: args.checksum.toLowerCase(),
      capturedAt: args.capturedAt,
      uploadedAt: Date.now(),
      status: "pending",
    });
    await append(ctx, {
      orgUnitId: visit.orgUnitId,
      entityType: "visit",
      entityId: visit._id,
      kind: "evidence.attached",
      actorSubject: identity.tokenIdentifier,
      actorRole: profile.role,
      actorOrgUnitId: visit.orgUnitId,
      source: "web",
      occurredAt: args.capturedAt,
      serverAt: Date.now(),
      ownerProfileId: profile._id,
      summary: { after: "pending" },
    });
    return { evidenceId };
  },
});
