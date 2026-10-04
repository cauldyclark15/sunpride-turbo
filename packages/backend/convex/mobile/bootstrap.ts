import { ConvexError, v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { manilaDate } from "../coverage/validation";
import { nextDayCloseAt } from "../visits/policy";
import { activityRuleDTO } from "../visits/activity_rules";
import {
  actorValidator,
  CURSOR_TTL_MS,
  readCursor,
  signCursor,
  type Cursor,
} from "./cursor";
import {
  assertDevice,
  callSheetDTO,
  customerDTO,
  dayProjection,
  outletDTO,
  phonePhotoTypes,
  photoTypeDTO,
  productDTO,
  routeDTO,
  taskDTO,
  visitDTO,
} from "./projection";
import {
  jsonBytes,
  MAX_BOOTSTRAP_PAGE_BYTES,
  MAX_BOOTSTRAP_PAGES,
  PAGE_ENVELOPE_RESERVE_BYTES,
  pageCount,
  pageEnd,
  WORKING_SET_TOO_LARGE,
} from "./budget";

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
    callSheets: v.array(callSheetDTO),
    activityRules: v.array(activityRuleDTO),
    photoTypes: v.array(photoTypeDTO),
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
    const { entries, manifest, activityRules } = await dayProjection(
      ctx,
      actor,
      day,
      now,
    );
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
    // QSR-013: each account's Annex C sheet ships once per snapshot, with the first visit
    // to that outlet; a later horizon day at the same outlet reuses it on the phone.
    const sheetAt = new Set<number>();
    const shipped = new Set<string>();
    entries.forEach((e, i) => {
      if (
        e.kind === "visit" &&
        e.value.callSheet &&
        !shipped.has(e.value.outlet.id)
      ) {
        shipped.add(e.value.outlet.id);
        sheetAt.add(i);
      }
    });
    // Pages are cut by entry count AND by uncompressed bytes, so a page stays below
    // MAX_BOOTSTRAP_PAGE_BYTES however large the call sheets are.
    const sizes = entries.map((e, i) =>
      e.kind === "task"
        ? jsonBytes(e.value)
        : jsonBytes(e.value.visit) +
          jsonBytes(e.value.outlet) +
          (e.value.customer ? jsonBytes(e.value.customer) + 1 : 0) +
          (sheetAt.has(i) ? jsonBytes(e.value.callSheet) + 1 : 0) +
          2,
    );
    const budget =
      MAX_BOOTSTRAP_PAGE_BYTES -
      PAGE_ENVELOPE_RESERVE_BYTES -
      jsonBytes(activityRules) -
      jsonBytes(phonePhotoTypes());
    const pageLimit = limit ?? 100;
    if (
      sizes.some((size) => size + 1 > budget) ||
      pageCount(sizes, pageLimit, budget) > MAX_BOOTSTRAP_PAGES
    )
      throw new ConvexError(WORKING_SET_TOO_LARGE);
    const pageEntries = entries.slice(
      cursor.after,
      pageEnd(sizes, cursor.after, pageLimit, budget),
    );
    const visits = pageEntries.flatMap((e, i) =>
      e.kind === "visit"
        ? [{ ...e.value, sheet: sheetAt.has(cursor.after + i) }]
        : [],
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
        // Client answer 14: the field day closes at 10 PM Manila (no 24-hour lease).
        offlineLeaseExpiresAt: nextDayCloseAt(now),
        cacheExpiresAt: nextDayCloseAt(now),
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
      // One Annex C sheet per account per snapshot (outlets repeat across horizon days).
      callSheets: visits.flatMap((e) =>
        e.sheet && e.callSheet ? [e.callSheet] : [],
      ),
      // AND-013: same small rule set on every page; the phone requires them to agree.
      activityRules,
      // AND-016: visit photo types, the same small list on every page.
      photoTypes: phonePhotoTypes(),
      page: base.page,
      nextPageCursor: hasMore ? await signCursor(base) : null,
      syncCursor: hasMore
        ? null
        : await signCursor({ ...base, kind: "pull", after: cursor.watermark }),
    };
  },
});
