import { ConvexError, v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { manilaDate } from "../coverage/validation";
import {
  actorValidator,
  CURSOR_TTL_MS,
  readCursor,
  signCursor,
  type Cursor,
} from "./cursor";
import {
  assertDevice,
  customerDTO,
  dayProjection,
  leaseMs,
  outletDTO,
  productDTO,
  routeDTO,
  taskDTO,
  visitDTO,
} from "./projection";

export const snapshot = internalQuery({
  args: {
    actor: actorValidator,
    dayFrom: v.optional(v.string()),
    pageCursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    type: v.literal("bootstrap.response"),
    contractVersion: v.literal(1),
    serverTime: v.number(),
    permissions: v.array(v.string()),
    employee: v.object({
      id: v.string(),
      role: v.string(),
      orgUnitId: v.string(),
    }),
    scope: v.object({
      fingerprint: v.string(),
      orgUnitIds: v.array(v.string()),
    }),
    appConfig: v.object({
      offlineLeaseExpiresAt: v.number(),
      cacheExpiresAt: v.number(),
      orderCaptureEnabled: v.boolean(),
      priceAvailability: v.literal("unavailable"),
      promotionsAvailability: v.literal("unavailable"),
    }),
    plannedVisits: v.array(visitDTO),
    outlets: v.array(outletDTO),
    localCustomers: v.array(customerDTO),
    route: routeDTO,
    tasks: v.array(taskDTO),
    productCatalog: v.array(productDTO),
    page: v.number(),
    nextPageCursor: v.union(v.string(), v.null()),
    syncCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { actor, dayFrom, pageCursor, limit }) => {
    const now = Date.now();
    await assertDevice(ctx, actor, now);
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    )
      throw new ConvexError("invalid_request");
    const day = manilaDate(now);
    if (dayFrom !== undefined && dayFrom !== day)
      throw new ConvexError("invalid_request");
    const { entries, manifest } = await dayProjection(ctx, actor, day, now);
    let cursor: Cursor;
    if (pageCursor) {
      cursor = await readCursor(pageCursor, "bootstrap", actor, now);
      if (
        cursor.day !== day ||
        cursor.manifest !== manifest ||
        cursor.after > entries.length
      )
        throw new ConvexError("rebootstrap_required");
    } else {
      const latest = await ctx.db
        .query("mobileChanges")
        .withIndex("by_organizationId_and_sequence", (q) =>
          q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
        )
        .order("desc")
        .first();
      cursor = {
        kind: "bootstrap",
        version: 1,
        device: actor.deviceId,
        person: actor.profileId,
        scope: actor.scopeFingerprint,
        watermark: latest?.sequence ?? 0,
        after: 0,
        tie: latest?._id ?? "",
        expires: now + CURSOR_TTL_MS,
        day,
        manifest,
        page: 0,
      };
    }
    const pageEntries = entries.slice(
      cursor.after,
      cursor.after + (limit ?? 100),
    );
    const visits = pageEntries.flatMap((e) =>
      e.kind === "visit" ? [e.value] : [],
    );
    const tasks = pageEntries.flatMap((e) =>
      e.kind === "task" ? [e.value] : [],
    );
    const next = cursor.after + pageEntries.length;
    const hasMore = next < entries.length;
    const base = { ...cursor, after: next, page: cursor.page + 1 };
    return {
      type: "bootstrap.response" as const,
      contractVersion: 1 as const,
      serverTime: now,
      permissions: [
        "visit.read",
        ...(actor.role === "sales" ||
        actor.role === "manager" ||
        actor.role === "super_admin"
          ? ["visit.record"]
          : []),
      ],
      employee: {
        id: actor.profileId,
        role: actor.role,
        orgUnitId: actor.orgUnitId,
      },
      scope: {
        fingerprint: actor.scopeFingerprint,
        orgUnitIds: [actor.orgUnitId],
      },
      appConfig: {
        offlineLeaseExpiresAt: now + leaseMs,
        cacheExpiresAt: now + leaseMs,
        orderCaptureEnabled: false,
        priceAvailability: "unavailable" as const,
        promotionsAvailability: "unavailable" as const,
      },
      plannedVisits: visits.map((e) => e.visit),
      outlets: visits.map((e) => e.outlet),
      localCustomers: visits.flatMap((e) => (e.customer ? [e.customer] : [])),
      route: visits.find((e) => e.route)?.route ?? null,
      tasks,
      productCatalog: [],
      page: base.page,
      nextPageCursor: hasMore ? await signCursor(base) : null,
      syncCursor: hasMore
        ? null
        : await signCursor({ ...base, kind: "pull", after: cursor.watermark }),
    };
  },
});
