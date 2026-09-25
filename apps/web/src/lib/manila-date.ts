const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Convert a date-only control's value to midnight in Asia/Manila (UTC+08, no DST). */
export function manilaDateToUtcMs(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid date");
  const [year = NaN, month = NaN, day = NaN] = value.split("-").map(Number);
  const midnightUtc = Date.UTC(year, month - 1, day);
  const parsed = new Date(midnightUtc);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  )
    throw new Error("Invalid date");
  return midnightUtc - MANILA_OFFSET_MS;
}

export function formatManilaDate(value: number): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(value);
}

export function futureManilaDateToUtcMs(value: string): number {
  const instant = manilaDateToUtcMs(value);
  if (instant <= Date.now()) throw new Error("Choose a future effective date.");
  return instant;
}
