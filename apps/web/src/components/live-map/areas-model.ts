export type Metric =
  "sales" | "customers" | "visits" | "active" | "newCustomers";
export const METRICS: { id: Metric; label: string }[] = [
  { id: "sales", label: "Sales" },
  { id: "customers", label: "Customers" },
  { id: "visits", label: "Visits done / planned" },
  { id: "active", label: "Active salesmen" },
  { id: "newCustomers", label: "New customers" },
];
export const COLORS = ["#dceaf3", "#b5d4e9", "#83b5d9", "#4b93c7", "#226da8"];
export const NO_DATA = "#dadddf";
export type AreaFacts = {
  customers: number;
  newCustomers: number;
  sales: number | null;
  unknownSales: number;
  done: number;
  planned: number;
  active: number;
  sources: number;
};
export type AreaData = {
  from: string;
  to: string;
  areas: Record<string, AreaFacts>;
  unlocated: AreaFacts | null;
  definition: string;
};
export function metricValue(
  f: AreaFacts | undefined,
  metric: Metric,
): number | null {
  if (!f?.sources) return null;
  return metric === "visits" ? f.done : f[metric];
}
export function steps(values: (number | null)[]) {
  const sorted = values
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  return [
    ...new Set(
      [1, 2, 3, 4]
        .map((i) => sorted[Math.floor(((sorted.length - 1) * i) / 5)])
        .filter(
          (v): v is number => v !== undefined && v < sorted[sorted.length - 1]!,
        ),
    ),
  ];
}
export function bin(value: number | null, breaks: number[]) {
  if (value === null || !Number.isFinite(value)) return -1;
  return breaks.filter((b) => value > b).length;
}
export function rankAreas<
  T extends { id: string; name: string; value: number | null },
>(areas: T[]) {
  return [...areas]
    .sort(
      (a, b) =>
        (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0) ||
        (b.value ?? 0) - (a.value ?? 0) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )
    .map((a, i) => ({ ...a, rank: a.value === null ? null : i + 1 }));
}
export function ordinal(n: number) {
  return `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th")}`;
}
export function listIndex(key: string, current: number, count: number) {
  if (!count) return 0;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return Math.max(
    0,
    Math.min(
      count - 1,
      current + (key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0),
    ),
  );
}
export function escapeAction(pinned: number | null, depth: number) {
  return pinned !== null ? "unpin" : depth ? "back" : "none";
}
export function formatMetric(value: number | null, metric: Metric) {
  if (value === null) return "No data";
  return metric === "sales"
    ? new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
        maximumFractionDigits: 0,
      }).format(value / 100)
    : new Intl.NumberFormat("en-PH", { maximumFractionDigits: 0 }).format(
        value,
      );
}
export function periodDates(period: string, today: string) {
  return {
    to: today,
    from:
      period === "today"
        ? today
        : period === "week"
          ? new Date(Date.parse(today) - 6 * 86400000)
              .toISOString()
              .slice(0, 10)
          : `${today.slice(0, 7)}-01`,
  };
}
