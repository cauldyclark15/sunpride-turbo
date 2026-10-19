/**
 * Period and scope state shared by every cockpit page. The URL holds it
 * (`?from&to&unitId&channel&compare`, ANALYTICS_V2 §2) so a link or a
 * refresh reproduces the same view.
 */

export type PeriodPreset = "today" | "week" | "mtd" | "last_month" | "custom";
export type CompareMode = "prior" | "ly";

export const PERIOD_PRESETS: Array<{
  id: Exclude<PeriodPreset, "custom">;
  label: string;
}> = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "mtd", label: "Month to date" },
  { id: "last_month", label: "Last month" },
];

/** Channel keys of the demo company; the server returns the same keys and labels. */
export const CHANNELS: Array<{ key: string; label: string }> = [
  { key: "gt", label: "General trade" },
  { key: "pmot", label: "Public market (PMOT)" },
  { key: "mt", label: "Supermarkets" },
  { key: "kas", label: "Key accounts (KAS)" },
  { key: "van", label: "Van selling" },
];

export function channelLabel(key: string | null | undefined) {
  if (!key) return "All channels";
  return CHANNELS.find((channel) => channel.key === key)?.label ?? key;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string | null | undefined): value is string {
  if (!value || !DATE_RE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value
  );
}

/** Today's Manila calendar date. */
export function manilaToday(now = Date.now()): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return (
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86_400_000,
    ) + 1
  );
}

function weekday(date: string) {
  // 0 = Monday … 6 = Sunday
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export function presetRange(
  preset: Exclude<PeriodPreset, "custom">,
  today: string,
): { from: string; to: string } {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "week":
      return { from: addDays(today, -weekday(today)), to: today };
    case "last_month": {
      const firstThis = `${today.slice(0, 8)}01`;
      const lastPrior = addDays(firstThis, -1);
      return { from: `${lastPrior.slice(0, 8)}01`, to: lastPrior };
    }
    default:
      return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

export function presetOf(
  from: string,
  to: string,
  today: string,
): PeriodPreset {
  for (const { id } of PERIOD_PRESETS) {
    const range = presetRange(id, today);
    if (range.from === from && range.to === to) return id;
  }
  return "custom";
}

export type CommonQuery = {
  from?: string;
  to?: string;
  unitId?: string;
  channel?: string;
  compare?: CompareMode;
};

/** Common params from the URL; invalid values are dropped (the server then uses its defaults). */
export function readCommon(search: URLSearchParams): CommonQuery {
  const query: CommonQuery = {};
  const from = search.get("from");
  const to = search.get("to");
  if (isIsoDate(from) && isIsoDate(to) && from <= to) {
    query.from = from;
    query.to = to;
  }
  const unitId = search.get("unitId");
  if (unitId) query.unitId = unitId;
  const channel = search.get("channel");
  if (channel) query.channel = channel;
  const compare = search.get("compare");
  if (compare === "ly" || compare === "prior") query.compare = compare;
  return query;
}

/** The effective range the page shows: the URL's, or month to date. */
export function effectiveRange(query: CommonQuery, today: string) {
  return query.from && query.to
    ? { from: query.from, to: query.to }
    : presetRange("mtd", today);
}

/** `2026-10` from a Manila date. */
export function monthOf(date: string) {
  return date.slice(0, 7);
}
