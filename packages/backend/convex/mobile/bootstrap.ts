import { ConvexError, v } from "convex/values";
import { internalQuery, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { standardAt, standardsFor } from "../sfa/standards";
import { productiveCallRuleValidator } from "../sfa/productive_call";
import {
  DEFAULT_SELLING_WEEKDAYS,
  isSellingDay,
  sellingDatesInMonth,
} from "../sfa/selling_days";
import { subjectTargetAt } from "../targets/sales";
import {
  countsAsSale,
  dailyTarget,
  manilaDateOf,
  monthOf,
  saleInstant,
  toMinor,
} from "../dsr/model";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { localDate, manilaDate, monthBounds } from "../coverage/validation";
import { nextDayCloseAt } from "../visits/policy";
import { activityRuleDTO } from "../visits/activity_rules";
import {
  actorValidator,
  CURSOR_TTL_MS,
  readCursor,
  signCursor,
  type Cursor,
} from "./cursor";
import { REFERENCE_OVERLAP_MS } from "./reference";
import { mobilePricing } from "../pricing/wire";
import {
  assertDevice,
  availabilityDTO,
  callSheetDTO,
  customerDTO,
  dayProjection,
  outletDTO,
  phonePhotoTypes,
  photoTypeDTO,
  pricingDTO,
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
import {
  ACCOUNT_SUMMARY_MAX_BYTES,
  accountSummary,
  accountSummaryDTO,
  summaryViewer,
} from "./account_summary";

const MAX_ASSIGNMENT_HISTORY = 50;

/** Additive optional v1 field: the person's daily position standard (client memo, call answer 1). */
const dayTargetValidator = v.object({
  dailyCalls: v.optional(v.number()),
  productivePct: v.optional(v.number()),
  sourceRef: v.optional(v.string()),
  /** The governed productive-call rule (sfa/productive_call.ts) the phone counts calls with. */
  productiveCallRule: v.optional(productiveCallRuleValidator),
});

/**
 * Additive optional v1 field: today's sales as the server has them (Manila day, centavos), with
 * the person's daily sales target. The phone shows them as of the last sync; order capture is
 * not on the phone, so the server total is the whole of the day's sales.
 */
const daySalesValidator = v.object({
  amountMinor: v.number(),
  orders: v.number(),
  targetMinor: v.optional(v.number()),
});

/** A salesman's orders on one day; well above a field day's calls. */
const MAX_DAY_ORDERS = 500;

/**
 * The standard in effect now (bootstrap only serves Manila today), resolved through the
 * current employee assignment like the manager's daily scorecard (sfa/standards.ts). Read at
 * `now`, not Manila noon, so a person assigned after noon still gets today's target.
 */
async function currentStandard(
  ctx: QueryCtx,
  profileId: Id<"profiles">,
  instant: number,
) {
  const assignments = await ctx.db
    .query("employeeAssignments")
    .withIndex("by_profileId_and_effectiveFrom", (q) =>
      q.eq("profileId", profileId).lte("effectiveFrom", instant),
    )
    .order("desc")
    .take(MAX_ASSIGNMENT_HISTORY);
  const assignment = assignments.find(
    (row) => row.effectiveTo === undefined || row.effectiveTo > instant,
  );
  const positionId =
    assignment?.positionId ?? (await ctx.db.get(profileId))?.positionId;
  if (!positionId) return null;
  return standardAt(await standardsFor(ctx, positionId), instant);
}

/**
 * Omitted when the person has no position standard or it sets neither call targets nor a
 * productive-call rule ("No target set"; the phone then applies the default rule).
 */
function dayTarget(standard: Doc<"positionStandards"> | null) {
  if (
    !standard ||
    (standard.dailyCallsTarget === undefined &&
      standard.productiveCallTargetPct === undefined &&
      standard.productiveCallRule === undefined)
  )
    return undefined;
  return {
    ...(standard.dailyCallsTarget === undefined
      ? {}
      : { dailyCalls: standard.dailyCallsTarget }),
    ...(standard.productiveCallTargetPct === undefined
      ? {}
      : { productivePct: standard.productiveCallTargetPct }),
    sourceRef: standard.sourceRef,
    ...(standard.productiveCallRule === undefined
      ? {}
      : { productiveCallRule: standard.productiveCallRule }),
  };
}

/**
 * Today's sales, counted like the Daily Sales Report (dsr/report.ts): the person's orders that
 * became a sale, attributed to the day the salesman wrote them. The daily target is the set
 * daily sales target, else the monthly one spread over the position's selling days. Omitted
 * (the phone says "Not available") when the day has more orders than one bounded read.
 */
async function daySales(
  ctx: QueryCtx,
  profileId: Id<"profiles">,
  standard: Doc<"positionStandards"> | null,
  day: string,
  now: number,
) {
  const person = await ctx.db.get(profileId);
  if (!person) return undefined;
  const dayStart = localDate(day);
  const orders = await ctx.db
    .query("orders")
    .withIndex("by_salespersonSubject_and_createdAt", (q) =>
      q
        .eq("salespersonSubject", person.authSubject)
        .gte("createdAt", dayStart)
        .lte("createdAt", now),
    )
    .take(MAX_DAY_ORDERS + 1);
  if (orders.length > MAX_DAY_ORDERS) return undefined;
  const sales = orders.filter(
    (order) =>
      (order.organizationId === undefined ||
        order.organizationId === SUNPRIDE_ORGANIZATION_ID) &&
      countsAsSale(order.status) &&
      manilaDateOf(saleInstant(order)) === day,
  );
  const localMonth = monthOf(day);
  const sellingWeekdays = standard?.sellingWeekdays ?? [
    ...DEFAULT_SELLING_WEEKDAYS,
  ];
  const subject = { kind: "employee" as const, profileId };
  const daily = await subjectTargetAt(
    ctx,
    subject,
    "daily",
    "sales_value",
    dayStart,
  );
  const monthly = await subjectTargetAt(
    ctx,
    subject,
    "monthly",
    "sales_value",
    monthBounds(localMonth).from,
  );
  const target = dailyTarget({
    daily: daily?.value ?? null,
    monthly: monthly?.value ?? null,
    sellingDay: isSellingDay(day, sellingWeekdays),
    sellingDaysInMonth: sellingDatesInMonth(localMonth, sellingWeekdays).length,
  }).value;
  return {
    amountMinor: sales.reduce((sum, order) => sum + toMinor(order.total), 0),
    orders: sales.length,
    ...(target === null ? {} : { targetMinor: target }),
  };
}

export const snapshot = internalQuery({
  args: {
    actor: actorValidator,
    dayFrom: v.optional(v.string()),
    pageCursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    referenceData: v.optional(v.boolean()),
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
    inventoryAvailability: v.optional(v.array(availabilityDTO)),
    callSheets: v.array(callSheetDTO),
    activityRules: v.array(activityRuleDTO),
    photoTypes: v.array(photoTypeDTO),
    accountSummaries: v.array(accountSummaryDTO),
    page: v.number(),
    nextPageCursor: v.union(v.string(), v.null()),
    syncCursor: v.union(v.string(), v.null()),
    dayTarget: v.optional(dayTargetValidator),
    daySales: v.optional(daySalesValidator),
    pricing: v.optional(pricingDTO),
  }),
  handler: async (
    ctx,
    { actor, dayFrom, pageCursor, limit, referenceData },
  ) => {
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
    const prior = pageCursor
      ? await readCursor(pageCursor, "bootstrap", actor, now)
      : null;
    // Continuation pages keep the first page's mode; a different request is malformed.
    const reference = prior ? !!prior.reference : referenceData === true;
    if (prior && referenceData !== undefined && referenceData !== reference)
      throw new ConvexError("invalid_request");
    const { entries, manifest, activityRules } = await dayProjection(
      ctx,
      actor,
      day,
      now,
      reference,
    );
    let cursor: Cursor;
    if (prior) {
      cursor = prior;
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
        // Rows changed after this first page are re-sent by the first pull.
        ...(reference
          ? {
              reference: {
                low: Math.max(0, now - REFERENCE_OVERLAP_MS),
                high: Math.max(0, now - REFERENCE_OVERLAP_MS),
                pos: null,
              },
            }
          : {}),
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
    // IOS-011: each linked account's cached summary ships once, with the first visit to its
    // outlet. Its bounded size is reserved before paging; figures are read only for this page.
    const summaryAt = new Set<number>();
    const summarized = new Set<string>();
    const planOutlets = new Set<string>();
    entries.forEach((e, i) => {
      if (e.kind !== "visit") return;
      planOutlets.add(e.value.outlet.id);
      if (e.value.customer && !summarized.has(e.value.outlet.id)) {
        summarized.add(e.value.outlet.id);
        summaryAt.add(i);
      }
    });
    // Pages are cut by entry count AND by uncompressed bytes, so a page stays below
    // MAX_BOOTSTRAP_PAGE_BYTES however large the call sheets are.
    const sizes = entries.map((e, i) =>
      e.kind !== "visit"
        ? jsonBytes(e.value) + 1
        : jsonBytes(e.value.visit) +
          jsonBytes(e.value.outlet) +
          (e.value.customer ? jsonBytes(e.value.customer) + 1 : 0) +
          (sheetAt.has(i) ? jsonBytes(e.value.callSheet) + 1 : 0) +
          (summaryAt.has(i) ? ACCOUNT_SUMMARY_MAX_BYTES + 1 : 0) +
          2,
    );
    // SP-0129 / ADR-008: governed prices for every outlet in the working set, the same on
    // every page (like the activity rules), so its size is reserved before paging.
    const pricingOutlets = [];
    for (const outletId of planOutlets) {
      const outlet = await ctx.db.get(outletId as Id<"outlets">);
      if (outlet) pricingOutlets.push(outlet);
    }
    const pricing = await mobilePricing(ctx, pricingOutlets, now);
    const hasPricing = pricing.outletPriceLists.length > 0;
    const budget =
      MAX_BOOTSTRAP_PAGE_BYTES -
      PAGE_ENVELOPE_RESERVE_BYTES -
      jsonBytes(activityRules) -
      jsonBytes(phonePhotoTypes()) -
      (hasPricing ? jsonBytes(pricing) + 12 : 0);
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
        ? [
            {
              ...e.value,
              sheet: sheetAt.has(cursor.after + i),
              summary: summaryAt.has(cursor.after + i),
            },
          ]
        : [],
    );
    const accountSummaries = [];
    const viewer = visits.some((e) => e.summary && e.customer)
      ? await summaryViewer(ctx, actor)
      : null;
    for (const e of visits) {
      if (!viewer) break;
      if (!e.summary || !e.customer) continue;
      accountSummaries.push(
        await accountSummary(
          ctx,
          e.outlet.id,
          e.customer.id as Id<"customers">,
          planOutlets,
          viewer,
          now,
        ),
      );
    }
    const tasks = pageEntries.flatMap((e) =>
      e.kind === "task" ? [e.value] : [],
    );
    const products = pageEntries.flatMap((e) =>
      e.kind === "product" ? [e.value] : [],
    );
    const availability = pageEntries.flatMap((e) =>
      e.kind === "inventory" ? [e.value] : [],
    );
    const next = cursor.after + pageEntries.length;
    const hasMore = next < entries.length;
    const base = { ...cursor, after: next, page: cursor.page + 1 };
    const standard = await currentStandard(ctx, actor.profileId, now);
    const target = dayTarget(standard);
    const sales = await daySales(ctx, actor.profileId, standard, day, now);
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
      productCatalog: products,
      ...(reference ? { inventoryAvailability: availability } : {}),
      // One Annex C sheet per account per snapshot (outlets repeat across horizon days).
      callSheets: visits.flatMap((e) =>
        e.sheet && e.callSheet ? [e.callSheet] : [],
      ),
      // AND-013: same small rule set on every page; the phone requires them to agree.
      activityRules,
      // AND-016: visit photo types, the same small list on every page.
      photoTypes: phonePhotoTypes(),
      // IOS-011: account figures for this page's newly shipped outlets (as of serverTime).
      accountSummaries,
      page: base.page,
      nextPageCursor: hasMore ? await signCursor(base) : null,
      syncCursor: hasMore
        ? null
        : await signCursor({ ...base, kind: "pull", after: cursor.watermark }),
      ...(target ? { dayTarget: target } : {}),
      ...(sales ? { daySales: sales } : {}),
      ...(hasPricing ? { pricing } : {}),
    };
  },
});
