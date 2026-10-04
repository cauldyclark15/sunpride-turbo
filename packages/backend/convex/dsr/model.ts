/* Daily Sales Report (Annex B, SOP-007): pure rules shared by the report query and its
 * tests. Nothing here touches the database.
 *
 * The DSR is generated from what the field already records (orders and visits), never
 * re-keyed. Column layout follows the memo's Annex B as read from the degraded scan
 * (docs/requirements/SALES_OPS_STANDARDS_MEMO_2026-01-20.md §7); the original XLSX is still
 * awaited from Sunpride (open question #10), so labels may be adjusted once it arrives.
 *
 * Money: order totals are stored in pesos (the web formats them as PHP directly), while
 * sales targets are PHP minor units (centavos). Every amount this report returns is in
 * centavos so sales and targets compare without unit mistakes.
 */
import type { Doc } from "../_generated/dataModel";

/** Orders that never became a sale. Returns post as negative orders and do count. */
const NOT_A_SALE = new Set<Doc<"orders">["status"]>([
  "draft",
  "rejected",
  "voided",
]);

export function countsAsSale(status: Doc<"orders">["status"]) {
  return !NOT_A_SALE.has(status);
}

/** Pesos (as stored on orders) to centavos (as stored on targets). */
export function toMinor(pesos: number) {
  return Number.isFinite(pesos) ? Math.round(pesos * 100) : 0;
}

/**
 * An order made offline belongs to the day the salesman wrote it, not the day it synced.
 * The phone clock is trusted only within LATE_ORDER_WINDOW_MS before the server receipt.
 */
export const LATE_ORDER_WINDOW_MS = 3 * 86_400_000;

export function saleInstant(order: {
  createdAt: number;
  offlineCreatedAt?: number;
}) {
  const offline = order.offlineCreatedAt;
  if (
    offline !== undefined &&
    Number.isFinite(offline) &&
    offline <= order.createdAt &&
    offline >= order.createdAt - LATE_ORDER_WINDOW_MS
  )
    return offline;
  return order.createdAt;
}

/** The memo's Annex B category blocks, in sheet order. */
export const MEMO_CATEGORIES = ["Canned", "Mixes", "Frozen"] as const;

/**
 * Maps a product master category onto the memo's blocks (case-insensitive). Anything else
 * keeps its own name so no sale disappears from the roll-up.
 */
export function memoCategory(category: string | undefined) {
  const text = (category ?? "").trim();
  const lower = text.toLowerCase();
  if (lower.includes("canned")) return "Canned";
  if (lower.includes("mix")) return "Mixes";
  if (lower.includes("frozen")) return "Frozen";
  return text || "Uncategorized";
}

export function compareCategories(a: string, b: string) {
  const ia = (MEMO_CATEGORIES as readonly string[]).indexOf(a);
  const ib = (MEMO_CATEGORIES as readonly string[]).indexOf(b);
  if (ia !== -1 || ib !== -1)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a.localeCompare(b);
}

export type DailyTargetSource = "set" | "derived_from_monthly";

/**
 * Today's sales target: the daily target when one is set; otherwise the monthly target
 * spread evenly over the month's selling days (rounded to the centavo). A non-selling day
 * has no daily target unless one is explicitly set.
 */
export function dailyTarget(input: {
  daily: number | null;
  monthly: number | null;
  sellingDay: boolean;
  sellingDaysInMonth: number;
}): { value: number | null; source: DailyTargetSource | null } {
  if (input.daily !== null) return { value: input.daily, source: "set" };
  if (
    input.monthly === null ||
    !input.sellingDay ||
    input.sellingDaysInMonth <= 0
  )
    return { value: null, source: null };
  return {
    value: Math.round(input.monthly / input.sellingDaysInMonth),
    source: "derived_from_monthly",
  };
}

/** Whole percent, rounded down; null without a positive target. */
export function percentOf(actual: number, target: number | null) {
  if (target === null || target <= 0) return null;
  return Math.floor((actual * 100) / target);
}

/** MTD balance to sell: what is left of the monthly target, never negative. */
export function balanceToSell(mtd: number, monthly: number | null) {
  return monthly === null ? null : Math.max(monthly - mtd, 0);
}

/** Manila month (`YYYY-MM`) of a service date. */
export function monthOf(serviceDate: string) {
  return serviceDate.slice(0, 7);
}

/** Manila date of an instant. */
export function manilaDateOf(instant: number) {
  return new Date(instant + 8 * 3_600_000).toISOString().slice(0, 10);
}
