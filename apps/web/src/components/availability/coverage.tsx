"use client";

import Link from "next/link";
import { useState } from "react";
import { DrillTable, EmptyState, Panel, TrendChart } from "../cockpit/kit";
import { formatCount, formatPct } from "../cockpit/format";
import type { RetailAvailability } from "./types";

/** F-214/F-215/F-220: lives inside Coverage & people and inherits its one scope/period. */
export function AvailabilityCoverage({ data }: { data: RetailAvailability }) {
  const [sku, setSku] = useState<string | null>(null);
  const selected = data.rows.find((r) => r.productId === sku);
  const selectedGaps = selected?.shelfGaps ?? selected?.gaps ?? [];
  return (
    <div className="grid gap-4">
      <Panel
        title="Shelf gaps to act on"
        question="Which must-stock products are missing, and where should we send the team?"
      >
        {!data.universe ? (
          <EmptyState
            variant="setup"
            title="Publish a validated outlet universe"
            action={{
              label: "Open Trade Marketing setup",
              href: "/admin?section=availability",
            }}
          >
            No denominator has been approved. Distribution is unknown, not zero.
          </EmptyState>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted">
              {data.universe.sample ? "Sample data · " : ""}
              {data.universe.label} · {data.universe.members} stores ·{" "}
              {data.universe.date}
              {!data.universe.fresh
                ? " · Stale universe — refresh before using ND or WD"
                : ""}
            </p>
            <p className="mb-3 text-sm text-muted">
              {formatCount(data.checked)} of {formatCount(data.required)}{" "}
              required MSL lines checked ({formatPct(data.completeness)}).
              Unknown distribution means missing or stale observations; the
              confirmed lower bound is shown separately.
            </p>
            <DrillTable
              label="Stocking distribution"
              rows={data.rows}
              rowKey={(r) => r.productId}
              columns={[
                {
                  key: "name",
                  label: "Product",
                  render: (r) => (
                    <button
                      type="button"
                      className="text-left underline"
                      onClick={() => setSku(r.productId)}
                    >
                      {r.name}
                    </button>
                  ),
                  sort: (r) => r.name,
                },
                {
                  key: "stocking",
                  label: "Stocking / universe",
                  align: "right",
                  render: (r) => `${r.stocking} / ${r.universe}`,
                  sort: (r) => r.stocking,
                },
                {
                  key: "nd",
                  label: "Numeric distribution",
                  align: "right",
                  render: (r) =>
                    r.ndPct == null
                      ? `Unknown · ≥ ${formatPct(r.ndLowerPct)} confirmed`
                      : formatPct(r.ndPct),
                },
                {
                  key: "wd",
                  label: "Weighted distribution",
                  align: "right",
                  render: (r) =>
                    r.wdPct == null
                      ? `Unknown${r.weightsKnown ? ` · ≥ ${formatPct(r.wdLowerPct)} confirmed` : " · turnover weights needed"}`
                      : formatPct(r.wdPct),
                },
                {
                  key: "shelfGaps",
                  label: "Missing on shelf",
                  align: "right",
                  render: (r) =>
                    formatCount(
                      r.shelfGaps?.filter((g) => g.state === "absent").length ??
                        null,
                    ),
                },
                {
                  key: "unknown",
                  label: "Unmeasured / stale",
                  align: "right",
                  render: (r) => String(r.unknown),
                  sort: (r) => r.unknown,
                },
              ]}
            />
          </>
        )}
        {selected && (
          <div className="mt-4 border-t border-border pt-4">
            <h3 className="font-medium">{selected.name} · next calls</h3>
            <ul className="mt-2 grid gap-2">
              {selectedGaps.slice(0, 100).map((g) => (
                <li
                  key={g.outletId}
                  className="flex justify-between gap-4 text-sm"
                >
                  <Link
                    className="underline"
                    href={`/customers/customer?storeId=${encodeURIComponent(g.outletId)}`}
                  >
                    {g.name}
                  </Link>
                  <span>
                    {g.state === "absent"
                      ? (g.backroomBase ?? 0) > 0
                        ? "Replenish the shelf from back-room stock"
                        : "Out of stock — review proposed order"
                      : "Check every MSL line on the next call"}
                  </span>
                </li>
              ))}
            </ul>
            {selectedGaps.length > 100 && (
              <p className="mt-2 text-sm text-muted">
                Showing 100 of {selectedGaps.length} stores. Narrow the area
                filter.
              </p>
            )}
          </div>
        )}
      </Panel>
      <Panel
        title="Availability and measurement trend"
        question="A good OSA figure is only useful when every required line was checked."
      >
        <TrendChart
          dates={data.trend.map((r) => r.date)}
          unit="pct"
          label="On-shelf availability and completeness"
          series={[
            {
              key: "osa",
              label: "Present / required",
              kind: "line",
              values: data.trend.map((r) => r.osa),
            },
            {
              key: "checked",
              label: "MSL lines checked",
              kind: "target",
              values: data.trend.map((r) => r.completeness),
            },
          ]}
        />
      </Panel>
      <Panel
        title="Distribution depth by store"
        question="Stocked products are different from products bought in the period."
      >
        <DrillTable
          label="SKU depth"
          rows={data.depths}
          rowKey={(r) => r.outletId}
          rowHref={(r) =>
            `/customers/customer?storeId=${encodeURIComponent(r.outletId)}`
          }
          columns={[
            {
              key: "name",
              label: "Store",
              render: (r) => r.name,
              sort: (r) => r.name,
            },
            {
              key: "stocked",
              label: "Stocked SKUs",
              align: "right",
              render: (r) => formatCount(r.stockedSkus),
              sort: (r) => r.stockedSkus,
            },
            {
              key: "unknown",
              label: "SKUs needing a check",
              align: "right",
              render: (r) => formatCount(r.unknownSkus),
            },
            {
              key: "frequency",
              label: "Calls / plan",
              align: "right",
              render: (r) =>
                `${formatCount(r.actual ?? null)} / ${formatCount(r.planned ?? null)}`,
            },
            {
              key: "bought",
              label: "SKUs bought this period",
              align: "right",
              render: (r) => formatCount(r.boughtSkus),
            },
          ]}
        />
      </Panel>
    </div>
  );
}
