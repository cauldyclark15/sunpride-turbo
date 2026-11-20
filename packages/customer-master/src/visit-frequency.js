// SP-0223: office-owned customer visit requirement, shared by forms, uploads and writers.
// Calendar cadences are NOT rounded into a monthly count. Explicit monthly counts are exact.
export const VISIT_FREQUENCY_HINT =
  "Choose Weekly, Every 2 weeks, Monthly, or N times a month (1–31).";

/** @param {unknown} input */
export function parseVisitFrequency(input) {
  if (typeof input !== "string") throw new Error(VISIT_FREQUENCY_HINT);
  const value = input.trim().replace(/\s+/g, " ").toLowerCase();
  if (value === "weekly") return { label: "Weekly", days: 7, perMonth: null };
  if (value === "every 2 weeks")
    return { label: "Every 2 weeks", days: 14, perMonth: null };
  if (value === "monthly")
    return { label: "Monthly", days: 30, perMonth: null };
  const match = /^(\d+) times? a month$/.exec(value);
  const count = match ? Number(match[1]) : 0;
  if (!Number.isInteger(count) || count < 1 || count > 31)
    throw new Error(VISIT_FREQUENCY_HINT);
  return {
    label: `${count} ${count === 1 ? "time" : "times"} a month`,
    // Compatibility projection for existing cycle/dormancy readers only, never the monthly target.
    days: Math.max(1, Math.floor(30 / count)),
    perMonth: count,
  };
}

/** Read without changing legacy day-based requirements. @param {number|null|undefined} days @param {number|null|undefined} perMonth */
export function visitFrequencyLabel(days, perMonth) {
  if (perMonth != null)
    return `${perMonth} ${perMonth === 1 ? "time" : "times"} a month`;
  return days === 7
    ? "Weekly"
    : days === 14
      ? "Every 2 weeks"
      : days === 30
        ? "Monthly"
        : days
          ? `Every ${days} days`
          : "Not set";
}

/** Display a monthly requirement honestly: weekly cadence is not always four visits/month.
 * @param {number|null|undefined} days @param {number|null|undefined} perMonth */
export function visitFrequencySummary(days, perMonth) {
  if (perMonth != null)
    return `${perMonth} ${perMonth === 1 ? "visit" : "visits"}/month`;
  if (days === 30) return "1 visit/month";
  if (days === 7) return "Weekly · 4–5 visits/month";
  if (days === 14) return "Every 2 weeks · 2–3 visits/month";
  return visitFrequencyLabel(days, perMonth);
}
