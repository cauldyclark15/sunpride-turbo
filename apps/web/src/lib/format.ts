/**
 * The one place the office web turns dates, periods and status words into text
 * people read. Philippine English, Asia/Manila time, no ISO strings on screen.
 *
 *   formatDate("2026-11-12")            → "Nov 12, 2026"   (date-only = that Manila day)
 *   formatDate(1762934400000)           → "Nov 12, 2026"   (instant, shown in Manila)
 *   formatDay("2026-11-09")             → "Nov 9" (this year) / "Nov 9, 2025"
 *   formatDateTime("2026-11-12T10:27Z") → "Nov 12, 2026, 6:27 PM"
 *   formatPeriod("2026-10-29", "2026-11-12") → "Oct 29 – Nov 12, 2026"
 *   formatMonth("2026-12")              → "December 2026"
 *   formatStatus("needs_evidence")      → "Needs evidence"
 *
 * Empty input renders "—". Unparseable input is returned as given (never throws),
 * so a bad value is visible rather than crashing a page.
 *
 * Keep ISO strings for URLs, API calls, CSV `text` and <input type="date"> values;
 * use these only for what a person reads. `format.lint.test.ts` fails if a page
 * component renders a raw `toISOString()` / `toLocaleDateString()` instead.
 */

export type DateInput = string | number | Date | null | undefined;

const TZ = "Asia/Manila";
const LOCALE = "en-PH";
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_ONLY = /^(\d{4})-(\d{2})$/;

const dayFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TZ,
  year: "numeric",
  month: "short",
  day: "numeric",
});
const dayNoYearFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TZ,
  month: "short",
  day: "numeric",
});
const timeFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TZ,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const monthFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TZ,
  year: "numeric",
  month: "long",
});
const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Instant in ms, or null. A bare `YYYY-MM-DD` means noon of that Manila day. */
export function toInstant(value: DateInput): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = value.trim();
  if (DATE_ONLY.test(text)) return Date.parse(`${text}T12:00:00+08:00`);
  if (MONTH_ONLY.test(text)) return Date.parse(`${text}-01T12:00:00+08:00`);
  if (/^\d{10,}$/.test(text)) return Number(text);
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : t;
}

/** The Manila calendar day of a value as `YYYY-MM-DD` (for comparing, not showing). */
export function manilaDay(value: DateInput): string | null {
  const t = toInstant(value);
  return t === null ? null : partsFmt.format(t);
}

const ampm = (s: string) =>
  s.replace(/\s?([ap])\.?\s?m\.?$/i, (_, p: string) => ` ${p.toUpperCase()}M`);

/** "Nov 12, 2026". */
export function formatDate(value: DateInput): string {
  if (value === null || value === undefined || value === "") return "—";
  const t = toInstant(value);
  return t === null ? String(value) : dayFmt.format(t);
}

/** "Nov 9" when it falls in the current Manila year, otherwise "Nov 9, 2025". */
export function formatDay(value: DateInput, now: number = Date.now()): string {
  if (value === null || value === undefined || value === "") return "—";
  const t = toInstant(value);
  if (t === null) return String(value);
  return manilaDay(t)!.slice(0, 4) === manilaDay(now)!.slice(0, 4)
    ? dayNoYearFmt.format(t)
    : dayFmt.format(t);
}

/** "Nov 12, 2026, 6:27 PM" (Manila). A date-only value shows just the day. */
export function formatDateTime(value: DateInput): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" && DATE_ONLY.test(value.trim()))
    return formatDate(value);
  const t = toInstant(value);
  return t === null
    ? String(value)
    : `${dayFmt.format(t)}, ${ampm(timeFmt.format(t))}`;
}

/** "6:27 PM" (Manila). */
export function formatTime(value: DateInput): string {
  const t = toInstant(value);
  return t === null ? "—" : ampm(timeFmt.format(t));
}

/**
 * "Oct 29 – Nov 12, 2026"; one day → "Nov 12, 2026"; across years →
 * "Dec 29, 2026 – Jan 4, 2027". An open end reads "From Nov 12, 2026".
 */
export function formatPeriod(from: DateInput, to: DateInput): string {
  const a = toInstant(from);
  const b = toInstant(to);
  if (a === null && b === null) return "—";
  if (b === null) return `From ${formatDate(from)}`;
  if (a === null) return `Until ${formatDate(to)}`;
  const da = manilaDay(a)!;
  const db = manilaDay(b)!;
  if (da === db) return dayFmt.format(a);
  if (da.slice(0, 4) === db.slice(0, 4))
    return `${dayNoYearFmt.format(a)} – ${dayFmt.format(b)}`;
  return `${dayFmt.format(a)} – ${dayFmt.format(b)}`;
}

/** "December 2026" for `2026-12` (or any date inside that month). */
export function formatMonth(value: DateInput): string {
  if (value === null || value === undefined || value === "") return "—";
  const t = toInstant(value);
  return t === null ? String(value) : monthFmt.format(t);
}

/**
 * A stored status/enum word as a person reads it: "needs_evidence",
 * "needs-evidence", "NEEDS EVIDENCE" → "Needs evidence". Pass `labels` for
 * words that need different wording ("sap_ack" → "Waiting for SAP").
 */
export function formatStatus(
  value: string | null | undefined,
  labels?: Record<string, string>,
): string {
  if (!value) return "—";
  const known = labels?.[value];
  if (known) return known;
  const text = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "—";
  // "NEEDS_EVIDENCE" → "needs evidence"; a lone acronym ("SAP", "POSM") stays.
  const lower =
    text === text.toUpperCase() && text.includes(" ")
      ? text.toLowerCase()
      : text;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
