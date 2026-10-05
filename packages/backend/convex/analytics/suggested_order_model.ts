/**
 * ANA-009 suggested order (ICO) engine v1: pure, deterministic rules. Nothing here touches
 * the database; `suggested_orders.ts` reads the facts and applies these rules.
 *
 * The 2 Oct 2026 client call defines ICO (Inventory Control Order) as a suggested order:
 *
 *   store's daily demand × (days until the next visit + delivery lead time)
 *   − the stock the store already has
 *
 * v1 makes each term explainable:
 *  - daily demand = the store's ordered quantity of the SKU over the history window ÷ the
 *    days of history (historical velocity), raised by an active promotion's uplift;
 *  - days until next visit = the next signed MCP stop, else the store's visit cycle;
 *  - lead time = a provisional default until the client sends its ICO form;
 *  - store stock = the latest count seen at the store since its last purchase, run down by
 *    daily demand; without a count, the last purchase run down by daily demand over the
 *    days since that purchase (days since last purchase);
 *  - availability = the selling location's available stock, which caps the suggestion.
 *
 * Quantities are in the SKU's selling unit as written on order lines (`products.uom`).
 * Meanings and open questions: docs/architecture/SUGGESTED_ORDER_ENGINE.md.
 */
import { v, type Infer } from "convex/values";
import { addDays, daysBetween } from "./customer_model";

export const SUGGESTED_ORDER_VERSION = "suggested-order/v1/2026-10-05";
export const SUGGESTED_ORDER_SOURCE =
  "Client call 2 Oct 2026 (ICO = daily demand × (days to next visit + lead time) − store stock); blueprint §15; ANA-009";

/** History window read for velocity (12 whole weeks). */
export const HISTORY_DAYS = 84;
/** A newer customer's velocity is never divided by fewer days than this. */
export const MIN_HISTORY_DAYS = 28;
/** Provisional delivery lead time until the client's ICO form says otherwise. */
export const DEFAULT_LEAD_TIME_DAYS = 1;
export const MAX_LEAD_TIME_DAYS = 30;
/** Visit cycle used when the store has no next stop and no cycle on record. */
export const DEFAULT_CYCLE_DAYS = 7;
export const MAX_UPLIFT_PCT = 300;

export const lineStatus = v.union(
  v.literal("suggest"),
  v.literal("enough_stock"),
  v.literal("no_history"),
  v.literal("unavailable"),
);
export type LineStatus = Infer<typeof lineStatus>;

export const stockSource = v.union(
  v.literal("counted"),
  v.literal("reported_out"),
  v.literal("estimated"),
  v.literal("none"),
);
export type StockSource = Infer<typeof stockSource>;

export const nextVisitSource = v.union(
  v.literal("planned_stop"),
  v.literal("cycle"),
  v.literal("default"),
);
export type NextVisitSource = Infer<typeof nextVisitSource>;

/** Days of history velocity divides by: from the customer's first order in the window. */
export function historyDays(
  firstOrderDate: string | null,
  asOfDate: string,
  windowDays = HISTORY_DAYS,
) {
  if (!firstOrderDate) return windowDays;
  const span = daysBetween(firstOrderDate, asOfDate) + 1;
  return Math.min(windowDays, Math.max(MIN_HISTORY_DAYS, span));
}

/** First day of the history window ending on `asOfDate` (inclusive). */
export function historyFrom(asOfDate: string, windowDays = HISTORY_DAYS) {
  return addDays(asOfDate, -(windowDays - 1));
}

/** Days until the next visit: the next planned stop, else the cycle, else the default. */
export function daysToNextVisit(input: {
  asOfDate: string;
  nextStopDate: string | null;
  cycleDays: number | null;
}): { days: number; source: NextVisitSource; date: string | null } {
  if (input.nextStopDate && input.nextStopDate > input.asOfDate)
    return {
      days: daysBetween(input.asOfDate, input.nextStopDate),
      source: "planned_stop",
      date: input.nextStopDate,
    };
  if (input.cycleDays && input.cycleDays > 0)
    return { days: input.cycleDays, source: "cycle", date: null };
  return { days: DEFAULT_CYCLE_DAYS, source: "default", date: null };
}

export function leadTimeError(days: number) {
  if (!Number.isInteger(days) || days < 0 || days > MAX_LEAD_TIME_DAYS)
    return `Lead time must be a whole number of days from 0 to ${MAX_LEAD_TIME_DAYS}`;
  return null;
}

export function upliftError(pct: number) {
  if (!Number.isInteger(pct) || pct < 1 || pct > MAX_UPLIFT_PCT)
    return `Promotion uplift must be a whole percentage from 1 to ${MAX_UPLIFT_PCT}`;
  return null;
}

/** One store observation of a SKU: a counted quantity, or an audit that found none. */
export type StockObservation = {
  date: string;
  /** Counted quantity in the selling unit; 0 for an out-of-stock / not-carried finding. */
  quantity: number;
  source: "counted" | "reported_out";
};

export type SkuFacts = {
  code: string;
  unit: string;
  /** Quantity ordered in the history window (returns excluded). */
  historyQuantity: number;
  lastPurchaseDate: string | null;
  lastPurchaseQuantity: number | null;
  /** Latest store observation, if any. */
  observation: StockObservation | null;
  /** Active promotion uplift, if any. */
  promotion: { programRef: string; upliftPct: number } | null;
  /** Available quantity at the selling location; null when unknown. */
  available: number | null;
};

export type Settings = {
  asOfDate: string;
  historyDays: number;
  coverDays: number;
  nextVisitDays: number;
  leadTimeDays: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) =>
  Number.isInteger(round2(n)) ? String(round2(n)) : round2(n).toFixed(2);

/** Store stock today from the latest observation or the last purchase, run down by demand. */
export function storeStock(
  facts: Pick<
    SkuFacts,
    "lastPurchaseDate" | "lastPurchaseQuantity" | "observation"
  >,
  dailyDemand: number,
  asOfDate: string,
): { quantity: number; source: StockSource; reason: string | null } {
  const obs = facts.observation;
  const usable =
    obs &&
    obs.date <= asOfDate &&
    (!facts.lastPurchaseDate || obs.date >= facts.lastPurchaseDate);
  if (usable) {
    const days = daysBetween(obs.date, asOfDate);
    const quantity = Math.max(0, obs.quantity - dailyDemand * days);
    return {
      quantity,
      source: obs.source,
      reason:
        obs.source === "reported_out"
          ? `Store had none on ${obs.date}`
          : days === 0
            ? `Store counted ${fmt(obs.quantity)} today`
            : `Store counted ${fmt(obs.quantity)} on ${obs.date}; ${days} day(s) of sales leave about ${fmt(quantity)}`,
    };
  }
  if (facts.lastPurchaseDate && facts.lastPurchaseQuantity !== null) {
    const days = daysBetween(facts.lastPurchaseDate, asOfDate);
    const quantity = Math.max(
      0,
      facts.lastPurchaseQuantity - dailyDemand * days,
    );
    return {
      quantity,
      source: "estimated",
      reason: `Last bought ${fmt(facts.lastPurchaseQuantity)} on ${facts.lastPurchaseDate}, ${days} day(s) ago; about ${fmt(quantity)} left`,
    };
  }
  return { quantity: 0, source: "none", reason: null };
}

export type SuggestedLine = {
  code: string;
  unit: string;
  status: LineStatus;
  suggestedQuantity: number;
  /** Uncapped ICO quantity (rounded), before availability. */
  icoQuantity: number;
  dailyDemand: number;
  historyQuantity: number;
  daysSinceLastPurchase: number | null;
  storeStock: number;
  stockSource: StockSource;
  promotion: { programRef: string; upliftPct: number } | null;
  available: number | null;
  cappedByAvailability: boolean;
  reasons: string[];
};

/** The ICO rule for one SKU. Deterministic: same facts and settings, same line. */
export function suggestLine(facts: SkuFacts, s: Settings): SuggestedLine {
  const reasons: string[] = [];
  const baseDemand =
    s.historyDays > 0 ? facts.historyQuantity / s.historyDays : 0;
  const daysSinceLastPurchase = facts.lastPurchaseDate
    ? daysBetween(facts.lastPurchaseDate, s.asOfDate)
    : null;
  const base = {
    code: facts.code,
    unit: facts.unit,
    historyQuantity: facts.historyQuantity,
    daysSinceLastPurchase,
    promotion: facts.promotion,
    available: facts.available,
  };
  if (facts.historyQuantity <= 0) {
    reasons.push(
      `No orders in the last ${s.historyDays} days, so no velocity to suggest from`,
    );
    return {
      ...base,
      status: "no_history",
      suggestedQuantity: 0,
      icoQuantity: 0,
      dailyDemand: 0,
      storeStock: 0,
      stockSource: "none",
      cappedByAvailability: false,
      reasons,
    };
  }
  reasons.push(
    `Bought ${fmt(facts.historyQuantity)} ${facts.unit} in ${s.historyDays} days: ${fmt(baseDemand)} a day`,
  );
  let dailyDemand = baseDemand;
  if (facts.promotion) {
    dailyDemand = baseDemand * (1 + facts.promotion.upliftPct / 100);
    reasons.push(
      `Promotion ${facts.promotion.programRef} adds ${facts.promotion.upliftPct}%: ${fmt(dailyDemand)} a day`,
    );
  }
  // Stock runs down at the store's ordinary rate; the promotion lifts the cover only.
  const stock = storeStock(facts, baseDemand, s.asOfDate);
  if (stock.reason) reasons.push(stock.reason);
  const need = dailyDemand * s.coverDays;
  reasons.push(
    `Cover ${s.coverDays} day(s) (${s.nextVisitDays} to next visit + ${s.leadTimeDays} lead time): ${fmt(need)} needed`,
  );
  const ico = Math.max(0, Math.round(need - stock.quantity));
  const common = {
    ...base,
    icoQuantity: ico,
    dailyDemand: round2(dailyDemand),
    storeStock: round2(stock.quantity),
    stockSource: stock.source,
  };
  if (ico === 0) {
    reasons.push("Store stock covers the period");
    return {
      ...common,
      status: "enough_stock",
      suggestedQuantity: 0,
      cappedByAvailability: false,
      reasons,
    };
  }
  if (facts.available !== null) {
    const available = Math.max(0, Math.floor(facts.available));
    if (available === 0) {
      reasons.push(`Suggested ${ico}, but none is available to sell`);
      return {
        ...common,
        status: "unavailable",
        suggestedQuantity: 0,
        cappedByAvailability: true,
        reasons,
      };
    }
    if (available < ico) {
      reasons.push(`Suggested ${ico}, limited to the ${available} available`);
      return {
        ...common,
        status: "suggest",
        suggestedQuantity: available,
        cappedByAvailability: true,
        reasons,
      };
    }
  }
  reasons.push(`Suggest ${ico} ${facts.unit}`);
  return {
    ...common,
    status: "suggest",
    suggestedQuantity: ico,
    cappedByAvailability: false,
    reasons,
  };
}

const STATUS_ORDER: Record<LineStatus, number> = {
  suggest: 0,
  unavailable: 1,
  enough_stock: 2,
  no_history: 3,
};

/** Lines in a stable order: suggestions first, then by code. */
export function sortLines<L extends { status: LineStatus; code: string }>(
  lines: L[],
) {
  return [...lines].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      a.code.localeCompare(b.code),
  );
}

/** Two promotion intervals overlap (half-open, open end = forever). */
export function overlaps(
  a: { effectiveFrom: number; effectiveTo?: number },
  b: { effectiveFrom: number; effectiveTo?: number },
) {
  return (
    a.effectiveFrom < (b.effectiveTo ?? Infinity) &&
    b.effectiveFrom < (a.effectiveTo ?? Infinity)
  );
}
