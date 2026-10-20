import { suggest as availabilitySuggest } from "../availability/rules.js";
import { addDays, daysBetween } from "./measures.js";
export const HISTORY_DAYS = 84,
  MIN_HISTORY_DAYS = 28,
  DEFAULT_LEAD_TIME_DAYS = 1,
  DEFAULT_CYCLE_DAYS = 7;
/** @param {string|null} first @param {string} asOf */
export const historyDays = (first, asOf) =>
  first ? Math.min(84, Math.max(28, daysBetween(first, asOf) + 1)) : 84;
/** Exact ICO arithmetic ported from suggested_order_model.ts; quantities use one selling unit.
 * @param {any} f @param {any} s */
export function suggestLine(f, s) {
  if (f.historyQuantity <= 0)
    return {
      quantity: 0,
      status: "no_history",
      reason: `No orders in ${s.historyDays} days; demand is unknown`,
    };
  const ordinary = f.historyQuantity / s.historyDays;
  const demand = ordinary * (1 + (f.upliftPct ?? 0) / 100);
  const observation = f.observation;
  const usable =
    observation &&
    observation.date <= s.asOfDate &&
    (!f.lastPurchaseDate || observation.date >= f.lastPurchaseDate);
  const stock = usable
    ? Math.max(
        0,
        observation.quantity -
          ordinary * daysBetween(observation.date, s.asOfDate),
      )
    : f.lastPurchaseDate && f.lastPurchaseQuantity !== null
      ? Math.max(
          0,
          f.lastPurchaseQuantity -
            ordinary * daysBetween(f.lastPurchaseDate, s.asOfDate),
        )
      : 0;
  const recommendation = availabilitySuggest(
    {
      historyDailyBase: ordinary,
      stockBase: stock,
      minimumBase: f.minimumBase ?? 0,
      absent: f.absent ?? false,
      focus: f.focus,
      upliftPct: f.upliftPct,
      availableBase:
        f.available == null ? null : Math.max(0, Math.floor(f.available)),
    },
    { coverDays: s.nextVisitDays + s.leadTimeDays },
  );
  const quantity = recommendation.quantityBase;
  return {
    quantity,
    status:
      recommendation.status === "enough_stock"
        ? "enough_stock"
        : quantity === 0
          ? "unavailable"
          : "suggest",
    reason:
      recommendation.reasons.join("; ") +
      (f.available == null
        ? "; selling-location availability unknown"
        : `; capped at ${quantity} available`),
  };
}
export { addDays };
