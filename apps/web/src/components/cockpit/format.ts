import type { Kpi, KpiStatus, KpiUnit } from "./types";

/** Display helpers. Every number on a cockpit page goes through one of these. */

const grouped = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 0 });
const grouped2 = new Intl.NumberFormat("en-PH", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const oneDecimal = new Intl.NumberFormat("en-PH", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const MINUS = "−";

/** Integer centavos → `₱1,248,350` (whole pesos) or `₱1,248,350.25` with `cents`. */
export function formatPhp(
  centavos: number | null | undefined,
  options: { cents?: boolean; signed?: boolean } = {},
): string {
  if (centavos === null || centavos === undefined || !Number.isFinite(centavos))
    return "—";
  const pesos = Math.abs(centavos) / 100;
  const body = options.cents
    ? grouped2.format(pesos)
    : grouped.format(Math.round(pesos));
  const negative = centavos < 0 && body !== "0" && body !== "0.00";
  const sign = negative ? MINUS : options.signed && centavos > 0 ? "+" : "";
  return `${sign}₱${body}`;
}

/** Compact peso figure for chart axes: `₱1.2M`, `₱850K`, `₱900`. */
export function formatPhpCompact(centavos: number): string {
  const pesos = centavos / 100;
  const abs = Math.abs(pesos);
  const sign = pesos < 0 ? MINUS : "";
  if (abs >= 1_000_000)
    return `${sign}₱${trimZero((abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1))}M`;
  if (abs >= 1_000)
    return `${sign}₱${trimZero((abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1))}K`;
  return `${sign}₱${Math.round(abs)}`;
}

function trimZero(value: string) {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  return `${oneDecimal.format(value)}%`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  return Number.isInteger(value)
    ? grouped.format(value)
    : oneDecimal.format(Math.round(value * 10) / 10);
}

export function formatCases(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded)
    ? grouped.format(rounded)
    : oneDecimal.format(rounded);
  return `${rounded < 0 ? text.replace("-", MINUS) : text} cs`;
}

/** Cases + pieces, e.g. `12 cs 4 pc`; pieces are dropped when zero. */
export function formatCasesPieces(cases: number, pieces: number): string {
  const head = `${grouped.format(cases)} cs`;
  return pieces ? `${head} ${grouped.format(pieces)} pc` : head;
}

export function formatMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  const minutes = Math.round(value);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function formatValue(value: number | null, unit: KpiUnit): string {
  switch (unit) {
    case "php":
      return formatPhp(value);
    case "pct":
      return formatPct(value);
    case "cases":
      return formatCases(value);
    case "minutes":
      return formatMinutes(value);
    default:
      return formatCount(value);
  }
}

export function formatKpiValue(kpi: Pick<Kpi, "value" | "unit">): string {
  return formatValue(kpi.value, kpi.unit);
}

/** `▲ 12.4%` / `▼ 3.0%` / `0.0%`, plus the direction for colour. */
export function formatDelta(deltaPct: number | null | undefined): {
  text: string;
  direction: "up" | "down" | "flat" | "none";
} {
  if (deltaPct === null || deltaPct === undefined || !Number.isFinite(deltaPct))
    return { text: "No prior figure", direction: "none" };
  const rounded = Math.round(deltaPct * 10) / 10;
  if (rounded === 0) return { text: "0.0%", direction: "flat" };
  return {
    text: `${rounded > 0 ? "▲" : "▼"} ${oneDecimal.format(Math.abs(rounded))}%`,
    direction: rounded > 0 ? "up" : "down",
  };
}

const manilaTime = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const manilaDay = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
});
const manilaDayTime = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** `2:10 PM` in Manila time. */
export function formatTime(at: number | null | undefined): string {
  if (at === null || at === undefined) return "—";
  return manilaTime
    .format(at)
    .replace(/\s?([ap])\.?m\.?$/i, (_, p: string) => ` ${p.toUpperCase()}M`);
}

export function formatDayTime(at: number | null | undefined): string {
  if (at === null || at === undefined) return "—";
  return manilaDayTime
    .format(at)
    .replace(/\s?([ap])\.?m\.?$/i, (_, p: string) => ` ${p.toUpperCase()}M`);
}

/** `Oct 14` for a Manila `YYYY-MM-DD` date. */
export function formatDate(date: string | null | undefined): string {
  if (!date) return "—";
  return manilaDay.format(Date.parse(`${date}T12:00:00+08:00`));
}

export function formatDateRange(from: string, to: string): string {
  return from === to
    ? formatDate(from)
    : `${formatDate(from)} – ${formatDate(to)}`;
}

/** `5 min`, `3 h`, `2 days` between two instants (now defaults to Date.now()). */
export function formatAge(since: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - since) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** `Mon, Oct 19` style relative day for "last order" columns. */
export function formatSince(at: number | null | undefined, now = Date.now()) {
  if (at === null || at === undefined) return "Never";
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 60) return `${days} days ago`;
  return manilaDay.format(at);
}

export const STATUS_LABEL: Record<KpiStatus, string> = {
  ok: "On track",
  watch: "Watch",
  behind: "Behind",
  unknown: "Not measured",
};

const KNOWN_LABELS: Record<string, string> = {
  ...STATUS_LABEL,
  gt: "General trade",
  pmot: "Public market & open trade",
  kas: "Key accounts",
  supermarket: "Supermarkets",
  no_plan: "No plan",
  not_started: "Not started",
  in_call: "In a call",
  working: "Working",
  done: "Done",
  idle: "Idle",
  loading: "Loading",
  on_route: "On route",
  returned: "Returned",
  settled: "Settled",
  unclosed: "Not closed",
  active: "Buying",
  dormant: "Dormant",
  new: "New",
  lost: "Lost",
  never: "Never bought",
  low: "Low",
  out: "Out of stock",
  overstock: "Overstock",
  current: "Current",
  overdue: "Overdue",
  over_limit: "Over limit",
  held: "Held",
  depot: "Depot",
  truck: "Truck",
  other: "Other",
};

/** Plain words for a server status code; unknown codes lose their underscores. */
export function humanize(code: string | null | undefined): string {
  if (!code) return "—";
  const known = KNOWN_LABELS[code];
  if (known) return known;
  const words = code.replaceAll("_", " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type Tone = "ok" | "watch" | "behind" | "neutral" | "info";

/** Status colour for any status string the contract returns. */
export function toneFor(status: string | null | undefined): Tone {
  switch (status) {
    case "ok":
    case "done":
    case "settled":
    case "active":
    case "current":
      return "ok";
    case "watch":
    case "low":
    case "dormant":
    case "idle":
    case "not_started":
    case "loading":
    case "overstock":
    case "medium":
      return "watch";
    case "behind":
    case "out":
    case "lost":
    case "unclosed":
    case "overdue":
    case "over_limit":
    case "held":
    case "high":
      return "behind";
    case "in_call":
    case "working":
    case "on_route":
    case "new":
      return "info";
    default:
      return "neutral";
  }
}
