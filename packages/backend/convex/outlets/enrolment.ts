/**
 * CALL-07 new-store enrolment (2 Oct 2026 call, answer 15).
 *
 * A salesperson/DSP proposes a store with a GPS pin and a customer information sheet (CIS)
 * or store photo. The outlet is created at once as an ACTIVE, `provisional` outlet so it can
 * be visited that day, carrying a placeholder `PROV-` code. A supervisor or manager in scope
 * (never the proposer) approves or rejects it. Approval issues the system customer code
 * (configurable prefix + zero-padded sequence, default SP + 6 digits) and verifies the pin;
 * rejection deactivates the outlet. Imported outlets never pass through here and keep their
 * codes. Every status change is appended to `outletEnrolmentEvents`, the leaders' feed.
 *
 * Phone apps call the same public functions with their Convex JWT.
 */
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { assertNotLockedByApprovedPlan } from "../coverage/lock";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds } from "../lib/scope";
import { activeAt, audit } from "../org/validation";
import schema from "../schema";
import { resolveTerritoryOwnerAt } from "../territories/validation";
import {
  DEFAULT_RADIUS_METERS,
  outletRows,
  required,
  requireOutletCapability,
  validatePin,
  validateProfile,
} from "./validation";

type Ctx = QueryCtx | MutationCtx;

export const DEFAULT_CODE_PREFIX = "SP";
export const DEFAULT_CODE_DIGITS = 6;
export const PROVISIONAL_CODE_PREFIX = "PROV-";
const MAX_PHOTOS = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CODE_PROBES = 1000;
const MAX_PAGE = 50;
const MAX_FEED_SCAN = 500;

export function formatCustomerCode(
  prefix: string,
  digits: number,
  sequence: number,
) {
  const number = String(sequence);
  if (number.length > digits)
    throw new ConvexError("Customer code sequence exhausted for this format");
  return `${prefix}${number.padStart(digits, "0")}`;
}

export function validateCodeFormat(prefix: string, digits: number) {
  if (!/^[A-Z][A-Z0-9]{0,5}$/.test(prefix))
    throw new ConvexError(
      "Code prefix must be 1–6 capital letters or digits, starting with a letter",
    );
  if (!Number.isInteger(digits) || digits < 4 || digits > 10)
    throw new ConvexError("Code digits must be between 4 and 10");
  if (prefix === PROVISIONAL_CODE_PREFIX.slice(0, -1))
    throw new ConvexError("Code prefix is reserved");
}

async function codeSettings(ctx: Ctx) {
  return await ctx.db
    .query("outletCodeSettings")
    .withIndex("by_organizationId", (q) =>
      q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
    )
    .unique();
}

async function ensureCodeSettings(ctx: MutationCtx, actor: string) {
  const existing = await codeSettings(ctx);
  if (existing) return existing;
  const now = Date.now();
  const id = await ctx.db.insert("outletCodeSettings", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    prefix: DEFAULT_CODE_PREFIX,
    digits: DEFAULT_CODE_DIGITS,
    nextSequence: 1,
    nextProvisionalSequence: 1,
    updatedBy: actor,
    updatedAt: now,
  });
  return (await ctx.db.get(id))!;
}

async function codeTaken(ctx: Ctx, code: string) {
  return !!(await ctx.db
    .query("outlets")
    .withIndex("by_organizationId_and_code", (q) =>
      q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("code", code),
    )
    .first());
}

/** Allocates the next unused code; imported codes inside the sequence are skipped. */
async function allocateCode(
  ctx: MutationCtx,
  settings: Doc<"outletCodeSettings">,
  kind: "customer" | "provisional",
) {
  let sequence =
    kind === "customer"
      ? settings.nextSequence
      : settings.nextProvisionalSequence;
  for (let probe = 0; probe < MAX_CODE_PROBES; probe++, sequence++) {
    const code =
      kind === "customer"
        ? formatCustomerCode(settings.prefix, settings.digits, sequence)
        : formatCustomerCode(PROVISIONAL_CODE_PREFIX, 6, sequence);
    if (await codeTaken(ctx, code)) continue;
    await ctx.db.patch(
      settings._id,
      kind === "customer"
        ? { nextSequence: sequence + 1 }
        : { nextProvisionalSequence: sequence + 1 },
    );
    return code;
  }
  throw new ConvexError("No free customer code found; check the code format");
}

/** Pure so it is testable: convex-test does not record storage content types. */
export function attachmentProblem(
  file: { size: number; contentType?: string } | null,
  kind: "photo" | "cis",
) {
  if (!file) return "Attachment not found";
  if (file.size > MAX_FILE_BYTES) return "Attachment larger than 10 MB";
  const type = file.contentType ?? "";
  // Content type is optional in storage metadata; enforce it only when present.
  if (
    type &&
    !type.startsWith("image/") &&
    !(kind === "cis" && type === "application/pdf")
  )
    return kind === "cis"
      ? "Customer information sheet must be an image or PDF"
      : "Store photo must be an image";
  return null;
}

async function assertFile(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
  kind: "photo" | "cis",
) {
  const problem = attachmentProblem(await ctx.db.system.get(storageId), kind);
  if (problem) throw new ConvexError(problem);
}

async function scopeFilter(ctx: Ctx, profile: Doc<"profiles">) {
  if (profile.role === "super_admin" || profile.role === "analyst") return null;
  return new Set(
    profile.orgUnitId ? await collectScopeUnitIds(ctx, profile.orgUnitId) : [],
  );
}

async function event(
  ctx: MutationCtx,
  enrolment: Doc<"outletEnrolments">,
  kind: "proposed" | "approved" | "rejected",
  outlet: { name: string; code: string },
  actor: Doc<"profiles">,
  now: number,
  reason?: string,
) {
  await ctx.db.insert("outletEnrolmentEvents", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    enrolmentId: enrolment._id,
    outletId: enrolment.outletId,
    orgUnitId: enrolment.orgUnitId,
    kind,
    outletName: outlet.name,
    outletCode: outlet.code,
    actorName: actor.name,
    proposedByProfileId: enrolment.proposedByProfileId,
    reason,
    createdAt: now,
  });
}

export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await requireCapability(ctx, "outlet.enrol.propose");
    return await ctx.storage.generateUploadUrl();
  },
});

export const propose = mutation({
  args: {
    clientRequestId: v.string(),
    name: v.string(),
    address: v.string(),
    channel: v.string(),
    contactName: v.string(),
    contactPhone: v.optional(v.string()),
    latitude: v.number(),
    longitude: v.number(),
    territoryId: v.optional(v.id("territories")),
    cisStorageId: v.optional(v.id("_storage")),
    photoStorageIds: v.optional(v.array(v.id("_storage"))),
    note: v.optional(v.string()),
  },
  returns: v.object({
    outletId: v.id("outlets"),
    enrolmentId: v.id("outletEnrolments"),
    provisionalCode: v.string(),
    replayed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { identity, profile } = await requireCapability(
      ctx,
      "outlet.enrol.propose",
    );
    const clientRequestId = required(
      args.clientRequestId,
      "Client request id",
      100,
    );
    const now = Date.now();
    // Resolve the scope first so a replay can never bypass it.
    let orgUnitId: Id<"orgUnits">;
    if (args.territoryId) {
      const territory = await ctx.db.get(args.territoryId);
      if (
        !territory ||
        territory.status !== "active" ||
        !activeAt(territory.effectiveFrom, territory.effectiveTo, now)
      )
        throw new ConvexError("Territory not active");
      const owner = await resolveTerritoryOwnerAt(ctx, args.territoryId, now);
      if (!owner) throw new ConvexError("Territory has no owner");
      orgUnitId = owner.orgUnitId;
      if (profile.role === "sales") {
        const rows = await ctx.db
          .query("territorySalespeople")
          .withIndex("by_territoryId_and_effectiveFrom", (q) =>
            q.eq("territoryId", args.territoryId!).lte("effectiveFrom", now),
          )
          .take(501);
        if (
          !rows.some(
            (row) =>
              row.profileId === profile._id &&
              activeAt(row.effectiveFrom, row.effectiveTo, now),
          )
        )
          throw new ConvexError("Territory outside salesperson assignment");
      }
    } else {
      if (!profile.orgUnitId)
        throw new ConvexError("Your access has no organizational scope");
      orgUnitId = profile.orgUnitId;
    }
    await requireCapability(ctx, "outlet.enrol.propose", orgUnitId);

    const existing = await ctx.db
      .query("outletEnrolments")
      .withIndex("by_proposedBy_and_clientRequestId", (q) =>
        q
          .eq("proposedBy", identity.tokenIdentifier)
          .eq("clientRequestId", clientRequestId),
      )
      .unique();
    if (existing) {
      const outlet = await ctx.db.get(existing.outletId);
      if (!outlet || outlet.name !== args.name.trim())
        throw new ConvexError("Client request id reused for another store");
      return {
        outletId: existing.outletId,
        enrolmentId: existing._id,
        provisionalCode: existing.provisionalCode,
        replayed: true,
      };
    }

    const name = required(args.name, "Store name", 200);
    const address = required(args.address, "Address", 500);
    const channel = required(args.channel, "Channel", 100);
    const contactName = required(args.contactName, "Contact name", 100);
    const contactPhone = args.contactPhone?.trim() || undefined;
    validateProfile({
      name,
      address,
      channel,
      contacts: [{ name: contactName, phone: contactPhone }],
    });
    validatePin(args.latitude, args.longitude, DEFAULT_RADIUS_METERS);
    const photos = [...new Set(args.photoStorageIds ?? [])];
    if (!args.cisStorageId && photos.length === 0)
      throw new ConvexError(
        "Attach a customer information sheet or a store photo",
      );
    if (photos.length > MAX_PHOTOS)
      throw new ConvexError(`At most ${MAX_PHOTOS} store photos`);
    for (const id of photos) await assertFile(ctx, id, "photo");
    if (args.cisStorageId) await assertFile(ctx, args.cisStorageId, "cis");
    if (args.note !== undefined && args.note.length > 500)
      throw new ConvexError("Note too long");

    const settings = await ensureCodeSettings(ctx, identity.tokenIdentifier);
    const provisionalCode = await allocateCode(ctx, settings, "provisional");
    const outletId = await ctx.db.insert("outlets", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      code: provisionalCode,
      name,
      // Active so it can be visited today; `enrolmentStatus` flags it as unapproved.
      status: "active",
      enrolmentStatus: "provisional",
      custodianOrgUnitId: orgUnitId,
      channel,
      address,
      contacts: [{ name: contactName, phone: contactPhone }],
      photoStorageIds: photos.length ? photos : undefined,
      createdBy: identity.tokenIdentifier,
      createdAt: now,
      updatedAt: now,
    });
    const pinId = await ctx.db.insert("outletPins", {
      outletId,
      latitude: args.latitude,
      longitude: args.longitude,
      radiusMeters: DEFAULT_RADIUS_METERS,
      source: "new_store_enrolment",
      evidenceStorageId: photos[0] ?? args.cisStorageId,
      evidenceNote: args.note?.trim() || undefined,
      status: "pending",
      effectiveFrom: now,
      proposedBy: identity.tokenIdentifier,
      proposedAt: now,
      createdAt: now,
    });
    if (args.territoryId)
      await ctx.db.insert("outletAssignments", {
        outletId,
        territoryId: args.territoryId,
        effectiveFrom: now,
        actorSubject: identity.tokenIdentifier,
        reason: "New store enrolment",
        createdAt: now,
      });
    const enrolmentId = await ctx.db.insert("outletEnrolments", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      outletId,
      orgUnitId,
      territoryId: args.territoryId,
      pinId,
      status: "pending",
      provisionalCode,
      cisStorageId: args.cisStorageId,
      photoStorageIds: photos,
      clientRequestId,
      proposedBy: identity.tokenIdentifier,
      proposedByProfileId: profile._id,
      proposedAt: now,
    });
    const enrolment = (await ctx.db.get(enrolmentId))!;
    await event(
      ctx,
      enrolment,
      "proposed",
      { name, code: provisionalCode },
      profile,
      now,
    );
    await audit(
      ctx,
      identity.tokenIdentifier,
      "outlet.enrolment_proposed",
      "outlet",
      outletId,
      "New store proposed",
      now,
    );
    return { outletId, enrolmentId, provisionalCode, replayed: false };
  },
});

export const decide = mutation({
  args: {
    enrolmentId: v.id("outletEnrolments"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    reason: v.string(),
  },
  returns: v.object({ code: v.string() }),
  handler: async (ctx, args) => {
    const enrolment = await ctx.db.get(args.enrolmentId);
    if (!enrolment || enrolment.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("Enrolment not found");
    const { outlet, identity, profile } = await requireOutletCapability(
      ctx,
      "outlet.enrol.approve",
      enrolment.outletId,
    );
    if (enrolment.status !== "pending")
      throw new ConvexError("Enrolment already decided");
    if (
      enrolment.proposedBy === identity.tokenIdentifier ||
      enrolment.proposedByProfileId === profile._id
    )
      throw new ConvexError("The proposer cannot decide their own store");
    const reason = required(args.reason, "Reason", 500);
    const now = Date.now();
    const pin = await ctx.db.get(enrolment.pinId);
    let code = outlet.code;
    if (args.decision === "approved") {
      if (outlet.status === "inactive")
        throw new ConvexError("Outlet is inactive");
      const settings = await ensureCodeSettings(ctx, identity.tokenIdentifier);
      code = await allocateCode(ctx, settings, "customer");
      await ctx.db.patch(outlet._id, {
        code,
        enrolmentStatus: "approved",
        updatedAt: now,
      });
      if (pin && pin.status === "pending")
        await ctx.db.patch(pin._id, {
          status: "verified",
          effectiveFrom: Math.max(pin.effectiveFrom, now),
          verifiedBy: identity.tokenIdentifier,
          verifiedAt: now,
          reviewerReason: reason,
        });
    } else {
      const assignments = (
        await outletRows(ctx, "outletAssignments", outlet._id)
      ).filter((row) => row.effectiveTo === undefined || row.effectiveTo > now);
      if (assignments.length) {
        await assertNotLockedByApprovedPlan(ctx, {
          outletIds: [outlet._id],
          routeIds: assignments.flatMap((row) =>
            row.routeId ? [row.routeId] : [],
          ),
          from: now,
        });
        for (const row of assignments)
          await ctx.db.patch(row._id, {
            effectiveTo: Math.max(row.effectiveFrom, now),
          });
      }
      if (pin && pin.status === "pending")
        await ctx.db.patch(pin._id, {
          status: "rejected",
          effectiveTo: Math.max(pin.effectiveFrom + 1, now),
          verifiedBy: identity.tokenIdentifier,
          verifiedAt: now,
          reviewerReason: reason,
        });
      await ctx.db.patch(outlet._id, {
        status: "inactive",
        enrolmentStatus: "rejected",
        updatedAt: now,
      });
    }
    await ctx.db.patch(enrolment._id, {
      status: args.decision,
      assignedCode: args.decision === "approved" ? code : undefined,
      decidedBy: identity.tokenIdentifier,
      decidedAt: now,
      decisionReason: reason,
    });
    await event(
      ctx,
      enrolment,
      args.decision,
      { name: outlet.name, code },
      profile,
      now,
      reason,
    );
    await audit(
      ctx,
      identity.tokenIdentifier,
      `outlet.enrolment_${args.decision}`,
      "outlet",
      outlet._id,
      args.decision === "approved"
        ? `New store approved as ${code}`
        : "New store rejected",
      now,
    );
    return { code };
  },
});

export const setCodeFormat = mutation({
  args: { prefix: v.string(), digits: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity } = await requireCapability(ctx, "admin.manage");
    const prefix = args.prefix.trim().toUpperCase();
    validateCodeFormat(prefix, args.digits);
    const settings = await ensureCodeSettings(ctx, identity.tokenIdentifier);
    const now = Date.now();
    await ctx.db.patch(settings._id, {
      prefix,
      digits: args.digits,
      updatedBy: identity.tokenIdentifier,
      updatedAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "outlet.code_format_changed",
      "outletCodeSettings",
      settings._id,
      `Customer code format ${prefix} + ${args.digits} digits`,
      now,
    );
    return null;
  },
});

export const codeFormat = query({
  args: {},
  returns: v.object({
    prefix: v.string(),
    digits: v.number(),
    example: v.string(),
  }),
  handler: async (ctx) => {
    await requireCapability(ctx, "outlet.read");
    const settings = await codeSettings(ctx);
    const prefix = settings?.prefix ?? DEFAULT_CODE_PREFIX;
    const digits = settings?.digits ?? DEFAULT_CODE_DIGITS;
    return {
      prefix,
      digits,
      example: formatCustomerCode(prefix, digits, settings?.nextSequence ?? 1),
    };
  },
});

const enrolmentView = v.object({
  enrolment: schema.doc("outletEnrolments"),
  outlet: schema.doc("outlets"),
  pin: v.union(schema.doc("outletPins"), v.null()),
  proposerName: v.string(),
  cisUrl: v.union(v.string(), v.null()),
  photoUrls: v.array(v.string()),
});

async function view(ctx: QueryCtx, enrolment: Doc<"outletEnrolments">) {
  const outlet = await ctx.db.get(enrolment.outletId);
  if (!outlet) return null;
  const proposer = await ctx.db.get(enrolment.proposedByProfileId);
  const photoUrls: string[] = [];
  for (const id of enrolment.photoStorageIds) {
    const url = await ctx.storage.getUrl(id);
    if (url) photoUrls.push(url);
  }
  return {
    enrolment,
    outlet,
    pin: await ctx.db.get(enrolment.pinId),
    proposerName: proposer?.name ?? "Former user",
    cisUrl: enrolment.cisStorageId
      ? await ctx.storage.getUrl(enrolment.cisStorageId)
      : null,
    photoUrls,
  };
}

function pageSize(numItems: number) {
  if (!Number.isInteger(numItems) || numItems < 1 || numItems > MAX_PAGE)
    throw new ConvexError(`Page size must be 1–${MAX_PAGE}`);
}

/** Approver queue: pending stores inside the caller's scope, oldest first. */
export const pending = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(enrolmentView),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "outlet.enrol.approve");
    pageSize(args.paginationOpts.numItems);
    const allowed = await scopeFilter(ctx, profile);
    const result = await ctx.db
      .query("outletEnrolments")
      .withIndex("by_organizationId_and_status_and_proposedAt", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("status", "pending"),
      )
      .paginate(args.paginationOpts);
    const page = [];
    for (const enrolment of result.page) {
      if (allowed && !allowed.has(enrolment.orgUnitId)) continue;
      const row = await view(ctx, enrolment);
      if (row) page.push(row);
    }
    return { ...result, page };
  },
});

/** The proposer's own submissions with their status (view-only for the field). */
export const mine = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(enrolmentView),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "outlet.enrol.propose");
    pageSize(args.paginationOpts.numItems);
    const result = await ctx.db
      .query("outletEnrolments")
      .withIndex("by_proposedByProfileId_and_proposedAt", (q) =>
        q.eq("proposedByProfileId", profile._id),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const page = [];
    for (const enrolment of result.page) {
      const row = await view(ctx, enrolment);
      if (row) page.push(row);
    }
    return { ...result, page };
  },
});

/**
 * Status-change feed for admins and leaders in scope. Salespeople only see changes to
 * their own proposals.
 */
export const notifications = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(schema.doc("outletEnrolmentEvents")),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "outlet.read");
    const limit = args.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE)
      throw new ConvexError(`Limit must be 1–${MAX_PAGE}`);
    const allowed = await scopeFilter(ctx, profile);
    const rows = [];
    // Bounded scan: the feed shows recent changes, not the whole history.
    const recent = await ctx.db
      .query("outletEnrolmentEvents")
      .withIndex("by_organizationId_and_createdAt", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .order("desc")
      .take(MAX_FEED_SCAN);
    for (const row of recent) {
      if (rows.length >= limit) break;
      if (profile.role === "sales") {
        if (row.proposedByProfileId !== profile._id) continue;
      } else if (allowed && !allowed.has(row.orgUnitId)) continue;
      rows.push(row);
    }
    return rows;
  },
});
