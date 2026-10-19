"use client";

import { useEffect, useRef, useState } from "react";
import { formatDate, formatPhpCompact, formatValue } from "../format";
import type { KpiUnit } from "../types";

export type TrendSeries = {
  key: string;
  label: string;
  values: Array<number | null>;
  /** bar = actuals, line = actual line, target = dashed target, prior = grey comparison. */
  kind: "bar" | "line" | "target" | "prior";
};

const COLOR: Record<TrendSeries["kind"], string> = {
  bar: "#27272a",
  line: "#18181b",
  target: "#c8102e",
  prior: "#a1a1aa",
};

function niceMax(max: number) {
  if (max <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10])
    if (max <= step * exp) return step * exp;
  return 10 * exp;
}

function axisLabel(value: number, unit: KpiUnit) {
  return unit === "php" ? formatPhpCompact(value) : formatValue(value, unit);
}

function useWidth(initial: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/**
 * In-house responsive SVG trend: bars or lines for actuals, a dashed target,
 * a grey prior line, hover values, and a hidden data table for screen readers.
 */
export function TrendChart({
  dates,
  series,
  unit = "php",
  height = 200,
  label,
}: {
  dates: string[];
  series: TrendSeries[];
  unit?: KpiUnit;
  height?: number;
  label: string;
}) {
  const { ref, width } = useWidth(720);
  const [hover, setHover] = useState<number | null>(null);
  const count = dates.length;
  const left = 48;
  const right = 8;
  const top = 10;
  const bottom = 24;
  const plotW = Math.max(10, width - left - right);
  const plotH = height - top - bottom;
  const all = series.flatMap((s) =>
    s.values.filter((v): v is number => v !== null),
  );
  const max = niceMax(Math.max(0, ...all));
  const step = count ? plotW / count : plotW;
  const x = (i: number) => left + step * i + step / 2;
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const active = hover ?? (count ? count - 1 : null);
  const hasBars = series.some((s) => s.kind === "bar");
  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(count / Math.max(2, plotW / 64)));

  const line = (values: Array<number | null>) => {
    let path = "";
    values.forEach((v, i) => {
      if (v === null) return;
      path += `${path && values[i - 1] !== null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    return path;
  };

  return (
    <figure className="ck-chart m-0 min-w-0" aria-label={label}>
      <div className="mb-2 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1 text-[12px] tabular-nums">
        {active !== null ? (
          <>
            <span className="font-medium text-foreground">
              {formatDate(dates[active])}
            </span>
            {series.map((s) => (
              <span key={s.key} className="text-muted">
                {s.label}{" "}
                <span className="font-medium text-foreground">
                  {formatValue(s.values[active] ?? null, unit)}
                </span>
              </span>
            ))}
          </>
        ) : null}
      </div>
      <div ref={ref} className="w-full">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden
          className="block max-w-full overflow-visible"
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={left}
                x2={width - right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="#e4e4e7"
                strokeWidth={1}
              />
              <text
                x={left - 6}
                y={y(tick) + 4}
                textAnchor="end"
                fontSize={11}
                fill="#71717a"
              >
                {axisLabel(tick, unit)}
              </text>
            </g>
          ))}
          {series
            .filter((s) => s.kind === "bar")
            .map((s) =>
              s.values.map((v, i) =>
                v === null ? null : (
                  <rect
                    key={`${s.key}${i}`}
                    x={x(i) - Math.min(18, step * 0.32)}
                    width={Math.min(36, step * 0.64)}
                    y={y(v)}
                    height={Math.max(0, top + plotH - y(v))}
                    rx={2}
                    fill={COLOR.bar}
                    opacity={active === i ? 1 : 0.82}
                  />
                ),
              ),
            )}
          {hasBars
            ? series
                .filter((s) => s.kind === "target")
                .map((s) =>
                  s.values.map((v, i) =>
                    v === null ? null : (
                      <line
                        key={`${s.key}${i}`}
                        x1={x(i) - Math.min(22, step * 0.42)}
                        x2={x(i) + Math.min(22, step * 0.42)}
                        y1={y(v)}
                        y2={y(v)}
                        stroke={COLOR.target}
                        strokeWidth={1.75}
                        strokeDasharray="4 3"
                      />
                    ),
                  ),
                )
            : null}
          {series
            .filter(
              (s) => s.kind !== "bar" && !(hasBars && s.kind === "target"),
            )
            .map((s) => (
              <path
                key={s.key}
                d={line(s.values)}
                fill="none"
                stroke={COLOR[s.kind]}
                strokeWidth={s.kind === "line" ? 2.5 : 1.5}
                strokeDasharray={
                  s.kind === "target"
                    ? "5 4"
                    : s.kind === "prior"
                      ? "2 3"
                      : undefined
                }
              />
            ))}
          {active !== null ? (
            <line
              x1={x(active)}
              x2={x(active)}
              y1={top}
              y2={top + plotH}
              stroke="#18181b"
              strokeOpacity={0.15}
            />
          ) : null}
          {dates.map((date, i) =>
            i === count - 1 ||
            (i % labelEvery === 0 &&
              count - 1 - i >= Math.ceil(labelEvery * 0.7)) ? (
              <text
                key={date}
                x={x(i)}
                y={height - 6}
                textAnchor="middle"
                fontSize={11}
                fill="#71717a"
              >
                {formatDate(date)}
              </text>
            ) : null,
          )}
          {dates.map((date, i) => (
            <rect
              key={`hit${date}`}
              x={left + step * i}
              y={top}
              width={step}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onTouchStart={() => setHover(i)}
            />
          ))}
        </svg>
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-0.5 w-4"
              style={{
                background:
                  s.kind === "target"
                    ? `repeating-linear-gradient(90deg, ${COLOR.target} 0 4px, transparent 4px 7px)`
                    : COLOR[s.kind],
                height: s.kind === "bar" ? 8 : 2,
              }}
            />
            {s.label}
          </span>
        ))}
      </figcaption>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th>Date</th>
            {series.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dates.map((date, i) => (
            <tr key={date}>
              <td>{formatDate(date)}</td>
              {series.map((s) => (
                <td key={s.key}>{formatValue(s.values[i] ?? null, unit)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Running totals; a null stays null. */
export function cumulative(values: Array<number | null>): Array<number | null> {
  let total = 0;
  return values.map((v) => {
    if (v === null) return null;
    total += v;
    return total;
  });
}
