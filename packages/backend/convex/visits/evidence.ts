import { ConvexError, v } from "convex/values";
import { mutation } from "../_generated/server";
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
export const generateUploadUrl = mutation({
  args: { visitId: v.id("visitExecutions") },
  returns: v.object({ url: v.string(), uploadTokenRef: v.string() }),
  handler: async (ctx, { visitId }) => {
    await owner(ctx, visitId);
    const url = await ctx.storage.generateUploadUrl();
    // The reference is advisory: Convex storage has no per-URL attachment ownership table in v1 schema.
    return { url, uploadTokenRef: visitId };
  },
});
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
    const stored = await ctx.storage.getMetadata(args.storageId);
    if (
      !stored ||
      stored.size !== args.size ||
      stored.contentType !== args.mime ||
      !matchesChecksum(stored.sha256, args.checksum)
    )
      throw new ConvexError("invalid_evidence");
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
    const { identity } = await requireCapability(
      ctx,
      "visit.record",
      visit.orgUnitId,
    );
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
