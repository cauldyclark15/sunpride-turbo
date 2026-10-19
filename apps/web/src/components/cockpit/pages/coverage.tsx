"use client";

import Link from "next/link";
import { csvHref, useAnalytics } from "../api";
import {
  formatCount,
  formatDate,
  formatMinutes,
  formatPct,
  formatPhp,
  formatTime,
} from "../format";
import {
  CockpitPage,
  DrillTable,
  EmptyState,
  KpiGrid,
  PageData,
  Panel,
  PeriodScopeBar,
  StatusChip,
  type DrillColumn,
} from "../kit";
import { manilaToday } from "../period";
import type {
  AgentDayResponse,
  CoverageResponse,
  CoverageRow,
  TimelineKind,
} from "../types";
import { buttonClass, Segmented, usePageQuery } from "./shared";

function heatClass(pct: number | null | undefined) {
  if (pct === null || pct === undefined)
    return "border border-dashed border-[#a1a1aa] bg-transparent";
  if (pct >= 90) return "bg-[#18181b]";
  if (pct >= 80) return "bg-[#52525b]";
  if (pct >= 70) return "bg-[#d97706]";
  return "bg-[#c8102e]";
}

/** Weekly MCP compliance as a strip of squares: darker is better, red is under 70%. */
export function HeatStrip({
  weeks,
  values,
}: {
  weeks: CoverageResponse["weeks"];
  values: Array<number | null>;
}) {
  return (
    <span className="inline-flex gap-1" aria-label="Weekly compliance">
      {weeks.map((week, i) => {
        const v = values[i] ?? null;
        return (
          <span
            key={week.weekStart}
            title={`Week of ${formatDate(week.weekStart)}: ${v === null ? "no plan" : formatPct(v)}`}
            className={`inline-block size-4 rounded-[3px] ${heatClass(v)}`}
          >
            <span className="sr-only">
              {formatDate(week.weekStart)}{" "}
              {v === null ? "no plan" : formatPct(v)}
            </span>
          </span>
        );
      })}
    </span>
  );
}

export function coverageColumns(
  data: CoverageResponse,
  groupBy: "agent" | "territory",
): DrillColumn<CoverageRow>[] {
  return [
    {
      key: "label",
      label: groupBy === "agent" ? "Person" : "Territory",
      render: (r) => r.label,
      sort: (r) => r.label,
    },
    {
      key: "compliance",
      label: "Compliance",
      align: "right",
      render: (r) => formatPct(r.compliancePct),
      sort: (r) => r.compliancePct,
    },
    {
      key: "weekly",
      label: "Weeks",
      render: (r) => <HeatStrip weeks={data.weeks} values={r.weekly} />,
    },
    {
      key: "stops",
      label: "Visited of planned",
      align: "right",
      wrap: true,
      render: (r) => (
        <span className="flex flex-col items-end">
          <span>
            {formatCount(r.visited)} / {formatCount(r.planned)}
          </span>
          {r.missed || r.offPlan ? (
            <span className="text-[12px] text-muted">
              {r.missed ? (
                <span className="text-[#a15c07]">
                  {formatCount(r.missed)} missed
                </span>
              ) : null}
              {r.missed && r.offPlan ? " · " : null}
              {r.offPlan ? `${formatCount(r.offPlan)} off plan` : null}
            </span>
          ) : null}
        </span>
      ),
      sort: (r) => r.missed,
    },
    {
      key: "strike",
      label: "Strike rate",
      align: "right",
      render: (r) => (
        <span className="flex flex-col items-end">
          <span>{formatPct(r.strikeRatePct)}</span>
          <span className="text-[12px] text-muted">
            {r.linesPerCall === null
              ? "—"
              : `${formatCount(r.linesPerCall)} lines / call`}
          </span>
        </span>
      ),
      sort: (r) => r.strikeRatePct,
    },
    {
      key: "tim",
      label: "Day in market",
      align: "right",
      render: (r) => (
        <span>
          {formatTime(r.firstCallAt)} <span className="text-muted">·</span>{" "}
          {formatMinutes(r.timeInMarketMin)}
        </span>
      ),
      sort: (r) => r.timeInMarketMin,
    },
    {
      key: "ww",
      label: "Work-With",
      align: "right",
      render: (r) => (
        <span
          className={
            r.workWith.required !== null &&
            r.workWith.done < r.workWith.required
              ? "text-[#a15c07]"
              : ""
          }
        >
          {r.workWith.required == null
            ? `${r.workWith.done} recorded · no minimum`
            : `${r.workWith.done} of ${r.workWith.required}`}
        </span>
      ),
      sort: (r) => r.workWith.done / Math.max(1, r.workWith.required ?? 0),
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusChip status={r.status} />,
      sort: (r) => ({ behind: 0, watch: 1, ok: 2, unknown: 3 })[r.status],
    },
  ];
}

export function CoverageView({
  data,
  groupBy,
  csv,
  link = (href) => href,
  onGroupBy,
}: {
  data: CoverageResponse;
  groupBy: "agent" | "territory";
  csv: string;
  link?: (href: string) => string;
  onGroupBy?: (g: "agent" | "territory") => void;
}) {
  const day = data.period.to > manilaToday() ? manilaToday() : data.period.to;
  return (
    <div className="grid gap-4">
      <KpiGrid kpis={data.kpis} />
      <Panel
        csvHref={csv}
        title={
          groupBy === "agent"
            ? "Each person against the plan"
            : "Each territory against the plan"
        }
        question="Lowest compliance first. Click a person to see their day."
        flush
        actions={
          <Segmented
            label="Group by"
            value={groupBy}
            options={[
              { id: "agent", label: "People" },
              { id: "territory", label: "Territories" },
            ]}
            onChange={(g) => onGroupBy?.(g)}
          />
        }
      >
        <DrillTable
          label="MCP compliance"
          columns={coverageColumns(data, groupBy)}
          rows={data.rows}
          rowKey={(r) => r.key}
          rowHref={
            groupBy === "agent"
              ? (r) =>
                  link(
                    `/coverage-people/agent?profileId=${encodeURIComponent(r.key)}&date=${day}`,
                  )
              : undefined
          }
          initialSort={{ key: "compliance", dir: "asc" }}
          empty={
            <EmptyState
              variant="setup"
              title="No approved MCP in this period"
              action={{
                label: "Open coverage plans",
                href: link("/sales-force"),
              }}
            >
              Compliance is measured against an approved monthly coverage plan.
            </EmptyState>
          }
        />
        <p className="px-4 pb-3 pt-2 text-[12px] text-muted sm:px-5">
          Weeks:{" "}
          <span className="inline-block size-2.5 rounded-[2px] bg-[#18181b]" />{" "}
          90% and up ·{" "}
          <span className="inline-block size-2.5 rounded-[2px] bg-[#52525b]" />{" "}
          80–89% ·{" "}
          <span className="inline-block size-2.5 rounded-[2px] bg-[#d97706]" />{" "}
          70–79% ·{" "}
          <span className="inline-block size-2.5 rounded-[2px] bg-[#c8102e]" />{" "}
          under 70% ·{" "}
          <span className="inline-block size-2.5 rounded-[2px] border border-dashed border-[#a1a1aa]" />{" "}
          no plan
        </p>
      </Panel>
    </div>
  );
}

export function CoveragePage() {
  const { query, params, link, set } = usePageQuery(["groupBy"]);
  const groupBy = params.get("groupBy") === "territory" ? "territory" : "agent";
  const full = { ...query, groupBy };
  const result = useAnalytics("coverage", full);
  return (
    <CockpitPage
      title="Coverage & people"
      question="Did my people do the plan?"
      header={result.data}
      bar={<PeriodScopeBar scopeLabel={result.data?.scope.label} />}
    >
      <PageData result={result} label="coverage figures">
        {(data) => (
          <CoverageView
            data={data}
            groupBy={groupBy}
            csv={csvHref("coverage", full)}
            link={link}
            onGroupBy={(g) => set({ groupBy: g === "agent" ? null : g })}
          />
        )}
      </PageData>
    </CockpitPage>
  );
}

// ---------- agent day ----------

const KIND_TEXT: Record<TimelineKind, string> = {
  check_in: "Checked in",
  check_out: "Checked out",
  order: "Order",
  collection: "Collection",
  activity: "Activity",
  gap: "Gap",
};

/** Static SVG of the day's GPS trail; no map tiles, so it works offline and prints. */
export function TrailMap({ trail }: { trail: AgentDayResponse["trail"] }) {
  if (trail.length < 2)
    return (
      <EmptyState variant="unknown" title="No location trail">
        The phone sent fewer than two positions for this day.
      </EmptyState>
    );
  const lats = trail.map((p) => p.lat);
  const lngs = trail.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const span = Math.max(maxLat - minLat, maxLng - minLng, 0.002);
  const size = 260;
  const pad = 18;
  const px = (lng: number) => pad + ((lng - minLng) / span) * (size - pad * 2);
  const py = (lat: number) =>
    size - pad - ((lat - minLat) / span) * (size - pad * 2);
  const path = trail
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${px(p.lng).toFixed(1)},${py(p.lat).toFixed(1)}`,
    )
    .join("");
  const first = trail[0]!;
  const last = trail[trail.length - 1]!;
  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="aspect-square w-full max-w-[320px] rounded-xl border border-border bg-[repeating-linear-gradient(0deg,#f4f4f5_0_1px,transparent_1px_26px),repeating-linear-gradient(90deg,#f4f4f5_0_1px,transparent_1px_26px)]"
        aria-label="Location trail"
      >
        <path
          d={path}
          fill="none"
          stroke="#18181b"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {trail.map((p) => (
          <circle
            key={p.at}
            cx={px(p.lng)}
            cy={py(p.lat)}
            r={2.5}
            fill="#fff"
            stroke="#18181b"
            strokeWidth={1.25}
          />
        ))}
        <circle cx={px(first.lng)} cy={py(first.lat)} r={5} fill="#2e9d59" />
        <circle cx={px(last.lng)} cy={py(last.lat)} r={5} fill="#c8102e" />
      </svg>
      <figcaption className="mt-2 text-[12px] text-muted">
        <span className="text-[#1f7a43]">●</span> first stop{" "}
        {formatTime(first.at)} · <span className="text-[#b4101f]">●</span> last{" "}
        {formatTime(last.at)}
      </figcaption>
    </figure>
  );
}

export function AgentDayView({
  data,
  link = (href) => href,
}: {
  data: AgentDayResponse;
  link?: (href: string) => string;
}) {
  const s = data.summary;
  const facts: Array<[string, string]> = [
    ["Stops", `${formatCount(s.visited)} of ${formatCount(s.planned)} planned`],
    [
      "Productive",
      `${formatCount(s.productive)} (${formatPct(s.visited ? Math.round((s.productive / s.visited) * 1000) / 10 : null)})`,
    ],
    ["Sales", formatPhp(s.sales)],
    ["First call", formatTime(s.firstCallAt)],
    ["Last call", formatTime(s.lastCallAt)],
    ["Distance", s.distanceKm === null ? "—" : `${s.distanceKm} km`],
  ];
  return (
    <div className="grid gap-4">
      <section className="rounded-2xl border border-border bg-surface px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {data.person.name}
            </h2>
            <p className="text-[13px] text-muted">
              {data.person.position} · {data.person.territory}
            </p>
          </div>
          <Link href={link("/coverage-people")} className={buttonClass}>
            Back to everyone
          </Link>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-[12px] text-muted">{label}</dt>
              <dd className="text-[15px] font-semibold tabular-nums text-foreground">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <Panel
          title="The day, step by step"
          question="Every check-in, order, collection and gap."
          className="lg:col-span-2"
        >
          {data.timeline.length ? (
            <ol className="relative grid gap-0 border-l border-border pl-4">
              {data.timeline.map((event, i) => (
                <li
                  key={`${event.at}${i}`}
                  data-kind={event.kind}
                  className={`relative py-1.5 ${event.kind === "gap" ? "my-1 rounded-lg bg-[#d97706]/[0.07] px-2" : ""} ${event.kind === "check_in" && i ? "mt-2 border-t border-separator pt-2.5" : ""}`}
                >
                  <span
                    aria-hidden
                    className={`absolute -left-[21px] top-3 size-2.5 rounded-full border-2 border-surface ${
                      event.kind === "gap"
                        ? "bg-[#d97706]"
                        : event.kind === "order"
                          ? "bg-[#18181b]"
                          : event.kind === "collection"
                            ? "bg-[#2e9d59]"
                            : "bg-[#a1a1aa]"
                    }`}
                  />
                  <div className="flex flex-wrap items-baseline gap-x-3 text-[13px]">
                    <span className="w-16 shrink-0 tabular-nums text-muted">
                      {formatTime(event.at)}
                    </span>
                    <span
                      className={`w-24 shrink-0 font-medium ${event.kind === "gap" ? "text-[#a15c07]" : "text-foreground"}`}
                    >
                      {KIND_TEXT[event.kind]}
                    </span>
                    {event.storeLabel ? (
                      event.storeId ? (
                        <Link
                          href={link(
                            `/stores/store?storeId=${encodeURIComponent(event.storeId)}`,
                          )}
                          className="text-foreground hover:underline"
                        >
                          {event.storeLabel}
                        </Link>
                      ) : (
                        <span>{event.storeLabel}</span>
                      )
                    ) : null}
                    {event.amountCentavos !== null ? (
                      <span className="ml-auto font-semibold tabular-nums text-foreground">
                        {formatPhp(event.amountCentavos)}
                      </span>
                    ) : null}
                    {event.onPlan === false ? (
                      <span className="text-[12px] font-medium text-[#a15c07]">
                        Not on plan
                      </span>
                    ) : null}
                  </div>
                  {event.detail ? (
                    <p className="pl-[76px] text-[12.5px] text-muted">
                      {event.detail}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState variant="zero" title="Nothing recorded this day">
              No check-ins reached the server for {formatDate(data.period.from)}
              .
            </EmptyState>
          )}
        </Panel>
        <Panel title="Trail" question="Where the phone went.">
          <TrailMap trail={data.trail} />
        </Panel>
      </div>
    </div>
  );
}

export function AgentDayPage() {
  const { query, link } = usePageQuery(["profileId", "date"]);
  const result = useAnalytics("agent-day", query.profileId ? query : null);
  return (
    <CockpitPage
      title={
        result.data ? `${result.data.person.name}'s day` : "A person's day"
      }
      question="What did this person do that day?"
      header={result.data}
      bar={
        <PeriodScopeBar
          mode="day"
          showChannel={false}
          scopeLabel={result.data?.scope.label}
        />
      }
    >
      {query.profileId ? (
        <PageData result={result} label="this person's day">
          {(data) => <AgentDayView data={data} link={link} />}
        </PageData>
      ) : (
        <EmptyState
          variant="zero"
          title="Pick a person"
          action={{
            label: "Open Coverage & people",
            href: link("/coverage-people"),
          }}
        >
          Choose someone from the coverage table to see their day.
        </EmptyState>
      )}
    </CockpitPage>
  );
}
