/* IOS-011 / AND-011: cached account summary for the phone's outlet detail.
 *
 * One small, bounded figure set per planned outlet's linked customer: sales over the last 13
 * weeks (DSR sale rule), the last 4 weeks, the last order, orders still open (not yet fulfilled
 * or posted) and the account's credit limit. Amounts are PHP centavos.
 *
 * Scope: a customer (accounting account) can be shared by several outlets, and a shared
 * account is never an access key. Figures ship only when EVERY outlet currently linked to the
 * customer is on this person's own downloaded plan (each of those was already verified to be
 * in the person's own unit). Otherwise the summary is `withheld` with no figures.
 *
 * Current outlet membership is still not authorization for the account's ORDERS: each source
 * order is gated like `domains/orders.orderAccessible` — a `sales` person counts only their own
 * orders, anyone else only orders whose author is an active profile currently in their unit
 * subtree, and an order's source location (when set) must be an active location in that subtree.
 * Foreign or historical-region orders sharing the customer code never contribute.
 *
 * There is no receivables (AR) feed in the platform, so "outstanding" here is open orders,
 * never an invoice balance.
 */
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { collectScopeUnitIds } from "../lib/scope";
import { countsAsSale, manilaDateOf, saleInstant, toMinor } from "../dsr/model";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { activeAt } from "../org/validation";

export const SUMMARY_DAYS = 91;
export const RECENT_DAYS = 28;
/** Newest orders read per customer; a busier account reports a shorter, flagged window. */
export const MAX_SUMMARY_ORDERS = 60;
/** Customer links read per account; more than this is treated as shared and withheld. */
export const MAX_ACCOUNT_LINKS = 20;
/** Upper bound of one serialized summary, reserved in the page byte budget before paging. */
export const ACCOUNT_SUMMARY_MAX_BYTES = 640;

/** Submitted but not yet fulfilled/posted: the field's outstanding orders. */
const OPEN_STATUSES = new Set<Doc<"orders">["status"]>([
  "submitted",
  "pending_approval",
  "approved",
  "sent_to_sap",
  "review_required",
]);

const nullableNumber = v.union(v.number(), v.null());
const nullableText = v.union(v.string(), v.null());
export const accountSummaryDTO = v.object({
  outletId: v.string(),
  asOfDate: v.string(),
  availability: v.union(v.literal("available"), v.literal("withheld")),
  creditLimitMinor: nullableNumber,
  sales: v.union(
    v.object({
      from: v.string(),
      to: v.string(),
      complete: v.boolean(),
      orders: v.number(),
      amountMinor: v.number(),
      recentOrders: v.number(),
      recentAmountMinor: v.number(),
      lastOrderDate: nullableText,
      lastOrderAmountMinor: nullableNumber,
    }),
    v.null(),
  ),
  openOrders: v.union(
    v.object({ count: v.number(), amountMinor: v.number() }),
    v.null(),
  ),
});
export type AccountSummary = typeof accountSummaryDTO.type;

function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Pure figures from a customer's orders, newest first. `capped` means more orders exist than
 * were read: the window then starts at the oldest read order and is flagged incomplete.
 */
export function summarizeOrders(
  orders: Pick<
    Doc<"orders">,
    "status" | "total" | "createdAt" | "offlineCreatedAt" | "organizationId"
  >[],
  asOfDate: string,
  capped: boolean,
) {
  let from = addDays(asOfDate, -(SUMMARY_DAYS - 1));
  const recentFrom = addDays(asOfDate, -(RECENT_DAYS - 1));
  let complete = true;
  if (capped && orders.length === 0) {
    // Every order read was out of scope: nothing in the window can be vouched for.
    from = asOfDate;
    complete = false;
  } else if (capped) {
    const oldest = manilaDateOf(saleInstant(orders[orders.length - 1]!));
    if (oldest > from) {
      from = oldest;
      complete = false;
    }
  }
  const sales = {
    from,
    to: asOfDate,
    complete,
    orders: 0,
    amountMinor: 0,
    recentOrders: 0,
    recentAmountMinor: 0,
    lastOrderDate: null as string | null,
    lastOrderAmountMinor: null as number | null,
  };
  let lastInstant = -Infinity;
  const open = { count: 0, amountMinor: 0 };
  for (const order of orders) {
    if (
      order.organizationId !== undefined &&
      order.organizationId !== SUNPRIDE_ORGANIZATION_ID
    )
      continue;
    if (OPEN_STATUSES.has(order.status)) {
      open.count++;
      open.amountMinor += toMinor(order.total);
    }
    if (!countsAsSale(order.status)) continue;
    const instant = saleInstant(order);
    const date = manilaDateOf(instant);
    if (date > asOfDate || date < from) continue;
    const amount = toMinor(order.total);
    sales.orders++;
    sales.amountMinor += amount;
    if (date >= recentFrom) {
      sales.recentOrders++;
      sales.recentAmountMinor += amount;
    }
    // A return (negative order) reduces sales but is never "the last order".
    if (order.total > 0 && instant > lastInstant) {
      lastInstant = instant;
      sales.lastOrderDate = date;
      sales.lastOrderAmountMinor = amount;
    }
  }
  return { sales, openOrders: open };
}

/** The person the summary is built for; `units` is their current org-unit subtree. */
export type SummaryViewer = {
  subject: string;
  role: Doc<"profiles">["role"];
  units: ReadonlySet<Id<"orgUnits">>;
};

export async function summaryViewer(
  ctx: QueryCtx,
  actor: {
    subject: string;
    role: Doc<"profiles">["role"];
    orgUnitId: Id<"orgUnits">;
  },
): Promise<SummaryViewer> {
  return {
    subject: actor.subject,
    role: actor.role,
    units: new Set(await collectScopeUnitIds(ctx, actor.orgUnitId)),
  };
}

/** Source-order scope: author and source location, read from the persisted order. */
function orderScopeCheck(ctx: QueryCtx, viewer: SummaryViewer) {
  const authors = new Map<string, boolean>();
  const locations = new Map<string, boolean>();
  return async (order: Doc<"orders">) => {
    if (viewer.role === "sales" && order.salespersonSubject !== viewer.subject)
      return false;
    let author = authors.get(order.salespersonSubject);
    if (author === undefined) {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_subject", (q) =>
          q.eq("authSubject", order.salespersonSubject),
        )
        .unique();
      author =
        profile?.status === "active" &&
        !!profile.orgUnitId &&
        viewer.units.has(profile.orgUnitId);
      authors.set(order.salespersonSubject, author);
    }
    if (!author) return false;
    if (!order.sourceLocationId) return true;
    let located = locations.get(order.sourceLocationId);
    if (located === undefined) {
      const location = await ctx.db.get(order.sourceLocationId);
      located =
        !!location &&
        location.active &&
        location.organizationId === SUNPRIDE_ORGANIZATION_ID &&
        !!location.orgUnitId &&
        viewer.units.has(location.orgUnitId);
      locations.set(order.sourceLocationId, located);
    }
    return located;
  };
}

/**
 * The summary for one planned outlet. `planOutlets` is every outlet on this person's verified
 * downloaded plan. Three index ranges: customer, links, orders.
 */
export async function accountSummary(
  ctx: QueryCtx,
  outletId: string,
  customerId: Id<"customers">,
  planOutlets: ReadonlySet<string>,
  viewer: SummaryViewer,
  now: number,
): Promise<AccountSummary> {
  const asOfDate = manilaDateOf(now);
  const withheld: AccountSummary = {
    outletId,
    asOfDate,
    availability: "withheld",
    creditLimitMinor: null,
    sales: null,
    openOrders: null,
  };
  const customer = await ctx.db.get(customerId);
  if (!customer) return withheld;
  const rows = await ctx.db
    .query("outletCustomerLinks")
    .withIndex("by_customerId_and_effectiveFrom", (q) =>
      q.eq("customerId", customerId).lte("effectiveFrom", now),
    )
    .take(MAX_ACCOUNT_LINKS + 1);
  if (rows.length > MAX_ACCOUNT_LINKS) return withheld;
  const linked = rows.filter((row) =>
    activeAt(row.effectiveFrom, row.effectiveTo, now),
  );
  if (linked.some((row) => !planOutlets.has(row.outletId))) return withheld;
  const orders = await ctx.db
    .query("orders")
    .withIndex("by_customer", (q) => q.eq("customerCode", customer.code))
    .order("desc")
    .take(MAX_SUMMARY_ORDERS + 1);
  const capped = orders.length > MAX_SUMMARY_ORDERS;
  if (capped) orders.length = MAX_SUMMARY_ORDERS;
  const inScope = orderScopeCheck(ctx, viewer);
  const visible: Doc<"orders">[] = [];
  for (const order of orders) if (await inScope(order)) visible.push(order);
  const { sales, openOrders } = summarizeOrders(visible, asOfDate, capped);
  return {
    outletId,
    asOfDate,
    availability: "available",
    creditLimitMinor:
      Number.isFinite(customer.creditLimit) && customer.creditLimit > 0
        ? toMinor(customer.creditLimit)
        : null,
    sales,
    openOrders,
  };
}
