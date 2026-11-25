export type Metric =
  "sales" | "customers" | "visits" | "active" | "newCustomers";
export const METRICS: { id: Metric; label: string }[] = [
  { id: "sales", label: "Sales" },
  { id: "customers", label: "Customers" },
  { id: "visits", label: "Visits done / planned" },
  { id: "active", label: "Active salesmen" },
  { id: "newCustomers", label: "New customers" },
];
// Use the application's accent family; no-data is a separate hatched neutral.
export const COLORS = [
  "var(--area-step-1)",
  "var(--area-step-2)",
  "var(--area-step-3)",
  "var(--area-step-4)",
  "var(--area-step-5)",
];
export const NO_DATA = "var(--area-empty)";
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
  if (!sorted.length || sorted[0] === sorted.at(-1)) return [];
  const low = Math.min(0, sorted[0]!);
  const high = Math.max(0, sorted.at(-1)!);
  // Five stable, real intervals even when only two areas have measurements.
  return [1, 2, 3, 4].map((i) =>
    Number((low + ((high - low) * i) / 5).toPrecision(12)),
  );
}

export function compactMetric(value: number, metric: Metric) {
  const amount = metric === "sales" ? value / 100 : value;
  return `${metric === "sales" ? "₱" : ""}${new Intl.NumberFormat("en-PH", { notation: "compact", maximumSignificantDigits: 3 }).format(amount)}`;
}

export function legendRanges(values: (number | null)[], metric: Metric) {
  const measured = values.filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  if (!measured.length) return [];
  const breaks = steps(values);
  const low = Math.min(0, ...measured);
  const high = Math.max(0, ...measured);
  if (!breaks.length)
    return [
      {
        low: measured[0]!,
        high: measured[0]!,
        label: compactMetric(measured[0]!, metric),
        description: formatMetric(measured[0]!, metric),
        color: COLORS[4]!,
      },
    ];
  return [...breaks, high].map((top, i) => {
    const bottom = i ? breaks[i - 1]! : low;
    return {
      low: bottom,
      high: top,
      label: `${compactMetric(bottom, metric)}–${compactMetric(top, metric).replace(/^₱/, "")}`,
      description: `${i ? "Over" : "From"} ${compactMetric(bottom, metric)} to ${compactMetric(top, metric)}`,
      color: COLORS[i]!,
    };
  });
}

export function shortAreaName(name: string) {
  return /^Region [^(]+\((.+)\)$/.exec(name)?.[1] ?? name;
}

export function fitCamera(
  bounds: [[number, number], [number, number]],
  width: number,
  height: number,
  padding = 12,
) {
  const [[x0, y0], [x1, y1]] = bounds;
  if (
    ![x0, y0, x1, y1, width, height].every(Number.isFinite) ||
    width <= 2 * padding ||
    height <= 2 * padding
  )
    return { x: 0, y: 0, scale: 1 };
  const scale = Math.min(
    180,
    (width - 2 * padding) / Math.max(x1 - x0, 1),
    (height - 2 * padding) / Math.max(y1 - y0, 1),
  );
  return {
    scale,
    x: width / 2 - (scale * (x0 + x1)) / 2,
    y: height / 2 - (scale * (y0 + y1)) / 2,
  };
}

export type MapLabel = {
  id: string;
  name: string;
  value: number;
  x: number;
  y: number;
};
export type LabelRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export function placeLabels(
  points: MapLabel[],
  width: number,
  height: number,
  avoid: LabelRect[] = [],
) {
  const placed: LabelRect[] = [];
  return points.map((point) => {
    const boxWidth = Math.min(182, Math.max(132, point.name.length * 7 + 22));
    const candidates = [
      [-boxWidth / 2, -58],
      [14, -21],
      [-boxWidth - 14, -21],
      [-boxWidth / 2, 16],
      [-boxWidth / 2, -110],
      [14, 34],
      [-boxWidth - 14, 34],
    ];
    const boxes = candidates.map(([dx, dy]) => ({
      left: Math.max(8, Math.min(width - boxWidth - 8, point.x + dx!)),
      top: Math.max(8, Math.min(height - 50, point.y + dy!)),
      width: boxWidth,
      height: 42,
    }));
    // Dense city clusters may exhaust nearby offsets. Try a bounded map-wide
    // grid, nearest first, rather than silently accepting an overlapping label.
    boxes.push(
      ...Array.from(
        { length: Math.max(1, Math.floor((height - 16) / 50)) },
        (_, i) =>
          [8, (width - boxWidth) / 2, width - boxWidth - 8].map((left) => ({
            left: Math.max(8, left),
            top: 8 + i * 50,
            width: boxWidth,
            height: 42,
          })),
      )
        .flat()
        .sort(
          (a, b) =>
            Math.hypot(a.left + a.width / 2 - point.x, a.top + 21 - point.y) -
            Math.hypot(b.left + b.width / 2 - point.x, b.top + 21 - point.y),
        ),
    );
    const box =
      boxes.find(
        (b) =>
          ![...placed, ...avoid].some(
            (p) =>
              b.left < p.left + p.width + 6 &&
              b.left + b.width + 6 > p.left &&
              b.top < p.top + p.height + 6 &&
              b.top + b.height + 6 > p.top,
          ),
      ) ?? boxes[0]!;
    placed.push(box);
    return { ...point, ...box };
  });
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
