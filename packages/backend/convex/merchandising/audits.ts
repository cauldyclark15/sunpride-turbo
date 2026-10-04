import { ConvexError, v } from "convex/values";
import type { Infer } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { localDate } from "../coverage/validation";
import { append } from "../visits/events";
import { flagLateWork } from "../visits/commands";
import { accessVisit, validTime } from "../visits/validation";
import { assortmentAt, usableProduct } from "./assortments";
import {
  availabilityLineInput,
  availabilityStatus,
  competitorObservationInput,
  competitorObservationKind,
  complianceCheckInput,
  complianceFinding,
  complianceKind,
  MAX_AUDIT_PHOTOS,
  MAX_AVAILABILITY_LINES,
  MAX_COMPETITOR_OBSERVATIONS,
  MAX_COMPLIANCE_CHECKS,
  MERCHANDISING_AUDIT_VERSION,
} from "./validators";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LINKED_PHOTOS = 100;

const recordArgsValidator = v.object({
  clientAuditId: v.string(),
  visitId: v.id("visitExecutions"),
  deviceTime: v.number(),
  availability: v.array(availabilityLineInput),
  compliance: v.array(complianceCheckInput),
  competitors: v.array(competitorObservationInput),
  /** General audit photos (store front, shelf overview). */
  evidenceIds: v.optional(v.array(v.id("fieldEvidenceFiles"))),
  /** The field phone labels its own submissions; the web keeps the default. */
  source: v.optional(v.literal("mobile")),
});
type RecordArgs = Infer<typeof recordArgsValidator>;

function invalid(): never {
  throw new ConvexError("invalid_request");
}
/** Optional free text: trimmed, non-empty when present, bounded. */
function optionalText(text: string | undefined, max: number) {
  if (text === undefined) return undefined;
  const value = text.trim();
  if (!value || text.length > max) invalid();
  return value;
}
function requiredText(text: string | undefined, max: number) {
  const value = optionalText(text, max);
  if (value === undefined) invalid();
  return value;
}
function photos(ids: Id<"fieldEvidenceFiles">[] | undefined) {
  const list = ids ?? [];
  if (list.length > MAX_AUDIT_PHOTOS || new Set(list).size !== list.length)
    invalid();
  return list;
}

/**
 * Validates and canonicalizes a submission. The canonical form fixes key order and trims
 * text, so the replay hash does not depend on how the client serialized its JSON.
 */
export function normalizeAudit(args: RecordArgs) {
  if (!uuid.test(args.clientAuditId)) invalid();
  if (
    args.availability.length > MAX_AVAILABILITY_LINES ||
    args.compliance.length > MAX_COMPLIANCE_CHECKS ||
    args.competitors.length > MAX_COMPETITOR_OBSERVATIONS
  )
    invalid();
  if (
    !args.availability.length &&
    !args.compliance.length &&
    !args.competitors.length
  )
    invalid();
  const products = args.availability.map((line) => line.productId);
  if (new Set(products).size !== products.length) invalid();
  const availability = args.availability.map((line) => {
    if (
      line.facings !== undefined &&
      (!Number.isSafeInteger(line.facings) ||
        line.facings < 0 ||
        line.facings > 10_000)
    )
      invalid();
    // A product the store does not carry or has none of cannot show facings.
    if (
      line.facings !== undefined &&
      line.facings > 0 &&
      (line.status === "out_of_stock" || line.status === "not_carried")
    )
      invalid();
    return {
      productId: line.productId,
      status: line.status,
      facings: line.facings,
      note: optionalText(line.note, 500),
      evidenceIds: photos(line.evidenceIds),
    };
  });
  const compliance = args.compliance.map((check) => {
    const share = check.shareOfShelfPercent;
    if (
      share !== undefined &&
      (check.kind !== "shelf_share" ||
        !Number.isSafeInteger(share) ||
        share < 0 ||
        share > 100)
    )
      invalid();
    return {
      kind: check.kind,
      finding: check.finding,
      programRef:
        check.kind === "promotion"
          ? requiredText(check.programRef, 200)
          : optionalText(check.programRef, 200),
      shareOfShelfPercent: share,
      actionTaken: optionalText(check.actionTaken, 500),
      evidenceIds: photos(check.evidenceIds),
    };
  });
  const competitors = args.competitors.map((row) => {
    const priced = row.observedPriceMinor !== undefined;
    if (
      priced !== (row.currency !== undefined) ||
      (priced &&
        (row.observedPriceMinor! < 0n || !/^[A-Z]{3}$/.test(row.currency!)))
    )
      invalid();
    if (row.kind === "price" && !priced) invalid();
    return {
      kind: row.kind,
      brand: requiredText(row.brand, 100),
      productCategory: optionalText(row.productCategory, 100),
      observedPriceMinor: row.observedPriceMinor,
      currency: row.currency,
      note: optionalText(row.note, 500),
      evidenceIds: photos(row.evidenceIds),
    };
  });
  return {
    clientAuditId: args.clientAuditId.toLowerCase(),
    visitId: args.visitId,
    deviceTime: args.deviceTime,
    availability,
    compliance,
    competitors,
    evidenceIds: photos(args.evidenceIds),
  };
}
type NormalizedAudit = ReturnType<typeof normalizeAudit>;

export async function auditHash(audit: NormalizedAudit) {
  const text = JSON.stringify(audit, (_key, value: unknown) =>
    typeof value === "bigint" ? `${value}n` : value,
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function linkedPhotos(audit: NormalizedAudit) {
  return new Set([
    ...audit.evidenceIds,
    ...audit.availability.flatMap((line) => line.evidenceIds),
    ...audit.compliance.flatMap((check) => check.evidenceIds),
    ...audit.competitors.flatMap((row) => row.evidenceIds),
  ]);
}

/** Every linked photo was attached to this visit by this person and is not rejected. */
async function assertPhotos(
  ctx: MutationCtx,
  visit: Doc<"visitExecutions">,
  profileId: Id<"profiles">,
  ids: Set<Id<"fieldEvidenceFiles">>,
) {
  if (ids.size > MAX_LINKED_PHOTOS) invalid();
  for (const id of ids) {
    const file = await ctx.db.get(id);
    if (
      !file ||
      file.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
      file.visitId !== visit._id ||
      file.ownerProfileId !== profileId ||
      file.status === "rejected"
    )
      throw new ConvexError("invalid_evidence");
  }
}

/**
 * CVX-030: records the merchandising audit of an open call (assortment / availability,
 * display and promotion compliance, competitor observations, linked visit photos). One
 * immutable audit per visit; a retry with the same `clientAuditId` and content returns the
 * original, different content under the same ID is a conflict.
 */
export const record = mutation({
  args: recordArgsValidator,
  returns: v.object({ auditId: v.id("merchandisingAudits") }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const audit = normalizeAudit(args);
    validTime(audit.deviceTime, now);
    const visit = await ctx.db.get(audit.visitId);
    if (!visit || visit.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("out_of_scope");
    const { profile } = await accessVisit(ctx, visit, "visit.record");
    const { identity } = await requireCapability(
      ctx,
      "visit.record",
      visit.orgUnitId,
    );
    if (profile._id !== visit.assigneeProfileId)
      throw new ConvexError("out_of_scope");
    const payloadHash = await auditHash(audit);
    const replay = await ctx.db
      .query("merchandisingAudits")
      .withIndex("by_organizationId_and_clientAuditId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("clientAuditId", audit.clientAuditId),
      )
      .first();
    if (replay) {
      if (
        replay.visitId !== visit._id ||
        replay.assigneeProfileId !== profile._id ||
        replay.payloadHash !== payloadHash
      )
        throw new ConvexError("conflict");
      return { auditId: replay._id };
    }
    if (visit.state !== "checked-in" && visit.state !== "in-progress")
      throw new ConvexError("invalid_transition");
    const existing = await ctx.db
      .query("merchandisingAudits")
      .withIndex("by_visitId", (q) => q.eq("visitId", visit._id))
      .first();
    if (existing) throw new ConvexError("conflict");
    for (const line of audit.availability)
      if (!usableProduct(await ctx.db.get(line.productId))) invalid();
    await assertPhotos(ctx, visit, profile._id, linkedPhotos(audit));

    // OSA against the outlet's required assortment in effect now (blueprint §16).
    const assortment = await assortmentAt(ctx, visit.outletId, now);
    const required = new Set(assortment?.productIds ?? []);
    const byProduct = new Map(
      audit.availability.map((line) => [line.productId, line.status]),
    );
    const requiredStatuses = [...required].map((id) => byProduct.get(id));
    const auditId = await ctx.db.insert("merchandisingAudits", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      orgUnitId: visit.orgUnitId,
      visitId: visit._id,
      outletId: visit.outletId,
      assigneeProfileId: profile._id,
      serviceDate: visit.serviceDate,
      clientAuditId: audit.clientAuditId,
      payloadHash,
      auditVersion: MERCHANDISING_AUDIT_VERSION,
      assortmentId: assortment?._id,
      requiredCount: required.size,
      requiredAvailableCount: requiredStatuses.filter(
        (s) => s === "available" || s === "low_stock",
      ).length,
      requiredOutOfStockCount: requiredStatuses.filter(
        (s) => s === "out_of_stock",
      ).length,
      missingRequiredProductIds: [...required].filter(
        (id) => !byProduct.has(id),
      ),
      evidenceIds: audit.evidenceIds,
      actorSubject: identity.tokenIdentifier,
      source: args.source ?? "web",
      deviceTime: audit.deviceTime,
      serverTime: now,
    });
    const common = {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      orgUnitId: visit.orgUnitId,
      auditId,
      outletId: visit.outletId,
      serviceDate: visit.serviceDate,
    };
    for (const line of audit.availability)
      await ctx.db.insert("merchandisingAvailability", {
        ...common,
        ...line,
        required: required.has(line.productId),
      });
    for (const check of audit.compliance)
      await ctx.db.insert("merchandisingComplianceChecks", {
        ...common,
        ...check,
      });
    for (const row of audit.competitors)
      await ctx.db.insert("competitorObservations", { ...common, ...row });
    await ctx.db.patch(visit._id, {
      state: "in-progress",
      lastServerTime: now,
    });
    const late = await flagLateWork(ctx, visit, now);
    await append(ctx, {
      orgUnitId: visit.orgUnitId,
      entityType: "visit",
      entityId: visit._id,
      kind: "merchandising.audit_recorded",
      actorSubject: identity.tokenIdentifier,
      actorRole: profile.role,
      actorOrgUnitId: visit.orgUnitId,
      source: args.source ?? "web",
      operationKey: audit.clientAuditId,
      occurredAt: audit.deviceTime,
      serverAt: now,
      ownerProfileId: profile._id,
      summary: {
        after: "recorded",
        ...(late ? { reasonCode: "late_sync" } : {}),
      },
      policyVersion: MERCHANDISING_AUDIT_VERSION,
    });
    return { auditId };
  },
});

const auditSummaryDTO = {
  auditId: v.id("merchandisingAudits"),
  visitId: v.id("visitExecutions"),
  outletId: v.id("outlets"),
  assigneeProfileId: v.id("profiles"),
  serviceDate: v.string(),
  auditVersion: v.string(),
  requiredCount: v.number(),
  requiredAvailableCount: v.number(),
  requiredOutOfStockCount: v.number(),
  /** On-shelf availability of the required assortment; null without one. */
  onShelfAvailabilityPercent: v.union(v.number(), v.null()),
  missingRequiredProductIds: v.array(v.id("products")),
  source: v.union(v.literal("mobile"), v.literal("web")),
  deviceTime: v.number(),
  serverTime: v.number(),
};
function summary(row: Doc<"merchandisingAudits">) {
  return {
    auditId: row._id,
    visitId: row.visitId,
    outletId: row.outletId,
    assigneeProfileId: row.assigneeProfileId,
    serviceDate: row.serviceDate,
    auditVersion: row.auditVersion,
    requiredCount: row.requiredCount,
    requiredAvailableCount: row.requiredAvailableCount,
    requiredOutOfStockCount: row.requiredOutOfStockCount,
    onShelfAvailabilityPercent: row.requiredCount
      ? Math.round((row.requiredAvailableCount / row.requiredCount) * 1000) / 10
      : null,
    missingRequiredProductIds: row.missingRequiredProductIds,
    source: row.source,
    deviceTime: row.deviceTime,
    serverTime: row.serverTime,
  };
}

/** The visit's audit with every captured row; actor tokens are never returned. */
export const forVisit = query({
  args: { visitId: v.id("visitExecutions") },
  returns: v.union(
    v.null(),
    v.object({
      ...auditSummaryDTO,
      evidenceIds: v.array(v.id("fieldEvidenceFiles")),
      availability: v.array(
        v.object({
          productId: v.id("products"),
          required: v.boolean(),
          status: availabilityStatus,
          facings: v.union(v.number(), v.null()),
          note: v.union(v.string(), v.null()),
          evidenceIds: v.array(v.id("fieldEvidenceFiles")),
        }),
      ),
      compliance: v.array(
        v.object({
          kind: complianceKind,
          finding: complianceFinding,
          programRef: v.union(v.string(), v.null()),
          shareOfShelfPercent: v.union(v.number(), v.null()),
          actionTaken: v.union(v.string(), v.null()),
          evidenceIds: v.array(v.id("fieldEvidenceFiles")),
        }),
      ),
      competitors: v.array(
        v.object({
          kind: competitorObservationKind,
          brand: v.string(),
          productCategory: v.union(v.string(), v.null()),
          observedPriceMinor: v.union(v.int64(), v.null()),
          currency: v.union(v.string(), v.null()),
          note: v.union(v.string(), v.null()),
          evidenceIds: v.array(v.id("fieldEvidenceFiles")),
        }),
      ),
    }),
  ),
  handler: async (ctx, { visitId }) => {
    const visit = await ctx.db.get(visitId);
    if (!visit || visit.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("out_of_scope");
    await accessVisit(ctx, visit, "visit.read");
    const audit = await ctx.db
      .query("merchandisingAudits")
      .withIndex("by_visitId", (q) => q.eq("visitId", visitId))
      .first();
    if (!audit) return null;
    const [availability, compliance, competitors] = await Promise.all([
      ctx.db
        .query("merchandisingAvailability")
        .withIndex("by_auditId", (q) => q.eq("auditId", audit._id))
        .take(MAX_AVAILABILITY_LINES),
      ctx.db
        .query("merchandisingComplianceChecks")
        .withIndex("by_auditId", (q) => q.eq("auditId", audit._id))
        .take(MAX_COMPLIANCE_CHECKS),
      ctx.db
        .query("competitorObservations")
        .withIndex("by_auditId", (q) => q.eq("auditId", audit._id))
        .take(MAX_COMPETITOR_OBSERVATIONS),
    ]);
    return {
      ...summary(audit),
      evidenceIds: audit.evidenceIds,
      availability: availability.map((row) => ({
        productId: row.productId,
        required: row.required,
        status: row.status,
        facings: row.facings ?? null,
        note: row.note ?? null,
        evidenceIds: row.evidenceIds,
      })),
      compliance: compliance.map((row) => ({
        kind: row.kind,
        finding: row.finding,
        programRef: row.programRef ?? null,
        shareOfShelfPercent: row.shareOfShelfPercent ?? null,
        actionTaken: row.actionTaken ?? null,
        evidenceIds: row.evidenceIds,
      })),
      competitors: competitors.map((row) => ({
        kind: row.kind,
        brand: row.brand,
        productCategory: row.productCategory ?? null,
        observedPriceMinor: row.observedPriceMinor ?? null,
        currency: row.currency ?? null,
        note: row.note ?? null,
        evidenceIds: row.evidenceIds,
      })),
    };
  },
});

/**
 * Supervisor / analytics list: audit summaries of one org unit for one Manila day. Sales
 * people read their own audits through `forVisit`.
 */
export const forUnitDay = query({
  args: {
    orgUnitId: v.id("orgUnits"),
    serviceDate: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(v.object(auditSummaryDTO)),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { orgUnitId, serviceDate, paginationOpts }) => {
    localDate(serviceDate);
    if (paginationOpts.numItems < 1 || paginationOpts.numItems > 100) invalid();
    const { profile } = await requireCapability(ctx, "visit.read", orgUnitId);
    if (profile.role === "sales") throw new ConvexError("out_of_scope");
    const page = await ctx.db
      .query("merchandisingAudits")
      .withIndex("by_orgUnitId_and_serviceDate", (q) =>
        q.eq("orgUnitId", orgUnitId).eq("serviceDate", serviceDate),
      )
      .paginate(paginationOpts);
    return {
      page: page.page.map(summary),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
