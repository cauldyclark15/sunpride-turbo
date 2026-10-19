import Link from "next/link";
import {
  formatDelta,
  formatKpiValue,
  formatPct,
  formatValue,
  STATUS_LABEL,
} from "../format";
import type { Kpi } from "../types";
import { TONE_BAR, TONE_TEXT } from "./tone";

/** Measures where a smaller number is the good direction. */
export const LOWER_IS_BETTER = new Set([
  "balanceToSell",
  "perDayNeeded",
  "missedStops",
  "offPlanVisits",
  "overdue",
  "creditBreaches",
  "heldOrders",
  "skusOutAtDepot",
  "lowStock",
  "nearExpiry",
  "badOrders",
  "lostStores",
  "dormant",
  "stockVarianceCases",
]);

/** Sales measures that take a target from the Sales & targets page. */
export const TARGETED = new Set([
  "salesToday",
  "mtdSales",
  "sales",
  "attainment",
]);

export const SET_TARGET_HREF = "/sales?tab=targets";

function targetCaption(kpi: Kpi): string | null {
  if (kpi.target === null) return null;
  const target = formatValue(kpi.target, kpi.unit);
  if (kpi.key === "balanceToSell") {
    const sold =
      kpi.value === null || !kpi.target ? null : 1 - kpi.value / kpi.target;
    return sold === null
      ? `of ${target} monthly target`
      : `${formatPct(Math.round(Math.max(0, sold) * 1000) / 10)} of ${target} sold`;
  }
  if (kpi.unit === "pct") return `target ${target}`;
  if (LOWER_IS_BETTER.has(kpi.key)) return `target ${target} or less`;
  if (kpi.value === null || kpi.target === 0) return `target ${target}`;
  return `${formatPct(Math.round((kpi.value / kpi.target) * 1000) / 10)} of ${target}`;
}

function progress(kpi: Kpi): number | null {
  if (kpi.value === null || kpi.target === null || kpi.target <= 0) return null;
  if (kpi.key === "balanceToSell")
    return Math.max(0, Math.min(1, 1 - kpi.value / kpi.target));
  if (LOWER_IS_BETTER.has(kpi.key)) return null;
  return Math.max(0, Math.min(1, kpi.value / kpi.target));
}

/**
 * One measure: the value, a bar against target, the change against the
 * prior period, a status colour and the definition behind an info toggle.
 */
export function KpiCard({
  kpi,
  setTargetHref = SET_TARGET_HREF,
  canSetTarget = true,
}: {
  kpi: Kpi;
  setTargetHref?: string;
  canSetTarget?: boolean;
}) {
  const delta = formatDelta(kpi.deltaPct);
  const good =
    delta.direction === "none" || delta.direction === "flat"
      ? null
      : (delta.direction === "up") !== LOWER_IS_BETTER.has(kpi.key);
  const share = progress(kpi);
  const caption = targetCaption(kpi);
  const tone = kpi.status === "unknown" ? "neutral" : kpi.status;
  return (
    <article
      data-kpi={kpi.key}
      data-status={kpi.status}
      className="ck-kpi relative flex min-w-0 flex-col rounded-2xl border border-border bg-surface px-4 py-3.5"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-h-[2lh] text-[12px] font-medium leading-tight text-muted sm:min-h-0">
          {kpi.label}
        </h3>
        <details className="ck-info group relative shrink-0">
          <summary
            aria-label={`What "${kpi.label}" means`}
            className="grid size-5 cursor-pointer list-none place-items-center rounded-full border border-foreground/35 text-[10px] font-semibold text-foreground/70 hover:border-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
          >
            i
          </summary>
          <p
            role="note"
            className="absolute right-0 top-6 z-30 w-64 rounded-xl border border-border bg-surface p-3 text-[12px] leading-5 text-foreground shadow-lg"
          >
            {kpi.definition}
          </p>
        </details>
      </div>
      <p
        className={`mt-1.5 text-[21px] font-semibold leading-none tracking-tight tabular-nums sm:text-[26px] ${
          kpi.value === null ? "text-muted" : "text-foreground"
        }`}
      >
        {formatKpiValue(kpi)}
      </p>
      {kpi.value === null ? (
        <p className="mt-2 text-[12.5px] text-muted">
          {["cashRemitted", "cashVariance", "stockVarianceCases"].includes(
            kpi.key,
          )
            ? "Pending trip settlement"
            : kpi.key === "perDayNeeded"
              ? "Not applicable to this period"
              : "Not measured yet"}
        </p>
      ) : (
        <div className="mt-auto">
          {share !== null ? (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-default-soft">
              <div
                className={`h-full rounded-full ${TONE_BAR[tone]}`}
                style={{ width: `${Math.round(share * 100)}%` }}
              />
            </div>
          ) : (
            <div className="mt-3 h-1.5" aria-hidden />
          )}
          <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[12.5px]">
            {caption ? (
              <span className="text-muted tabular-nums">{caption}</span>
            ) : TARGETED.has(kpi.key) && canSetTarget ? (
              <span className="text-muted">
                No target ·{" "}
                <Link
                  href={setTargetHref}
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  Set target
                </Link>
              </span>
            ) : TARGETED.has(kpi.key) ? (
              <span className="text-muted">No target set</span>
            ) : (
              <span className="text-muted">
                {kpi.status === "unknown" ? "Not judged against a target" : ""}
              </span>
            )}
            <span
              className={`tabular-nums ${
                good === null
                  ? "text-muted"
                  : good
                    ? "text-[#1f7a43]"
                    : "text-[#b4101f]"
              }`}
              title="Change against the comparison period"
            >
              {delta.direction === "none"
                ? delta.text
                : `${delta.text} vs prior`}
            </span>
          </div>
          {kpi.status !== "unknown" ? (
            <span
              className={`mt-1 block text-[11px] font-semibold uppercase tracking-wider ${TONE_TEXT[tone]}`}
            >
              {STATUS_LABEL[kpi.status]}
            </span>
          ) : null}
        </div>
      )}
    </article>
  );
}

/** Columns that leave no lonely card in the last row. */
export function gridColumns(count: number) {
  if (count % 4 === 0 || count === 7) return "md:grid-cols-3 xl:grid-cols-4";
  if (count === 5) return "md:grid-cols-3 xl:grid-cols-5";
  if (count === 6) return "md:grid-cols-3 2xl:grid-cols-6";
  return "md:grid-cols-3";
}

export function KpiGrid({
  kpis,
  canSetTarget = true,
}: {
  kpis: Kpi[];
  canSetTarget?: boolean;
}) {
  return (
    <div
      className={`grid grid-cols-2 gap-3 ${gridColumns(kpis.length)} ${kpis.length % 2 ? "max-md:[&>*:last-child]:col-span-2" : ""}`}
    >
      {kpis.map((kpi) => (
        <KpiCard key={kpi.key} kpi={kpi} canSetTarget={canSetTarget} />
      ))}
    </div>
  );
}
