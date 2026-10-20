"use client";

import { StatusPill, UnderlineTabs, type StatusTone } from "@sunpride/ui";
import { useState } from "react";
import { apiFetch, useApi } from "../../lib/api";
import { EmptyState } from "../cockpit/kit/empty-state";
import { Panel } from "../cockpit/kit/panel";

/** v2 spec PROGRAMME (F-025): Sunpride's Phase 1 features against what we run. Read-only. */

export type SpecStatus =
  | "built"
  | "partly_built"
  | "changing_to_spec"
  | "not_built"
  | "needs_sunpride"
  | "conditional";

export type ProgrammeFeature = {
  id: string;
  name: string;
  description: string;
  priority: string;
  status: SpecStatus;
  statusLabel: string;
  now: string;
  next: string;
  laneWhen: string;
  deferralPool: boolean;
};

export type ProgrammeWave = {
  code: string;
  name: string;
  months: string;
  goNoGoOwner: string;
  exitCriteria: string[];
  counts: Record<SpecStatus, number>;
  featureCount: number;
  mustCount: number;
  blocks: { id: string; name: string; features: ProgrammeFeature[] }[];
};

export type ProgrammeOverview = {
  loaded: boolean;
  featureCount: number;
  totals: Record<SpecStatus, number>;
  statusLabels: Record<SpecStatus, string>;
  waves: ProgrammeWave[];
};

const ORDER: SpecStatus[] = [
  "built",
  "partly_built",
  "changing_to_spec",
  "not_built",
  "needs_sunpride",
  "conditional",
];

const TONE: Record<SpecStatus, StatusTone> = {
  built: "success",
  partly_built: "neutral",
  changing_to_spec: "warning",
  not_built: "neutral",
  needs_sunpride: "danger",
  conditional: "neutral",
};

export function ProgrammeWorkspace() {
  const result = useApi<ProgrammeOverview>(
    ["programme", "overview"],
    ({ signal }) =>
      apiFetch<ProgrammeOverview>("/api/v1/programme/overview", { signal }),
  );
  if (result.error)
    return (
      <p className="text-[13px] text-muted">
        The programme could not load. {result.error.message}
      </p>
    );
  if (!result.data)
    return <p className="text-[13px] text-muted">Loading the programme…</p>;
  return <ProgrammeView data={result.data} />;
}

export function ProgrammeView({ data }: { data: ProgrammeOverview }) {
  const [active, setActive] = useState(data.waves[0]?.code ?? "W0");
  if (!data.loaded)
    return (
      <EmptyState variant="setup" title="The feature list is not loaded yet">
        An administrator loads Sunpride&apos;s Phase 1 feature list with the
        programme seed. Nothing here is counted until then.
      </EmptyState>
    );
  const wave = data.waves.find((w) => w.code === active) ?? data.waves[0]!;
  const waiting = data.totals.needs_sunpride;
  return (
    <div className="grid min-w-0 gap-4">
      <Panel
        title={`${data.featureCount} features in Sunpride's Phase 1 spec`}
        question="How much of the spec do we already run, and what is next?"
      >
        <div className="grid gap-3 px-4 pb-4 sm:px-5">
          <StatusCounts counts={data.totals} labels={data.statusLabels} />
          <p className="text-[13px] text-muted">
            {waiting > 0
              ? `Next action: ${waiting} ${waiting === 1 ? "feature waits" : "features wait"} on Sunpride's input or decision. They are marked “Needs Sunpride” below.`
              : "Nothing waits on Sunpride right now."}
          </p>
        </div>
      </Panel>
      <UnderlineTabs
        label="Waves"
        items={data.waves.map((w) => [w.code, w.code] as const)}
        activeId={wave.code}
        onChange={setActive}
      />
      <WaveView wave={wave} labels={data.statusLabels} />
    </div>
  );
}

function StatusCounts({
  counts,
  labels,
}: {
  counts: Record<SpecStatus, number>;
  labels: Record<SpecStatus, string>;
}) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Status counts">
      {ORDER.filter((s) => counts[s] > 0).map((s) => (
        <li key={s} className="flex items-center gap-2 text-[13px]">
          <span className="font-semibold tabular-nums text-foreground">
            {counts[s]}
          </span>
          <StatusPill tone={TONE[s]}>{labels[s]}</StatusPill>
        </li>
      ))}
    </ul>
  );
}

function WaveView({
  wave,
  labels,
}: {
  wave: ProgrammeWave;
  labels: Record<SpecStatus, string>;
}) {
  return (
    <div className="grid min-w-0 gap-4">
      <Panel
        title={`${wave.code} · ${wave.name}`}
        question={`${wave.months} · Go/no-go: ${wave.goNoGoOwner}`}
      >
        <div className="grid gap-4 px-4 pb-4 sm:px-5 md:grid-cols-2">
          <div>
            <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted">
              {wave.code === "TR-R" ? "Gate to start" : "Exit criteria"}
            </h3>
            <ol className="mt-2 grid list-decimal gap-1 pl-5 text-[13px] text-foreground">
              {wave.exitCriteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ol>
          </div>
          <div>
            <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted">
              {wave.featureCount} features · {wave.mustCount} Must
            </h3>
            <div className="mt-2">
              <StatusCounts counts={wave.counts} labels={labels} />
            </div>
          </div>
        </div>
      </Panel>
      {wave.blocks.map((block) => (
        <Panel key={block.id} title={block.name} flush>
          <ul className="divide-y divide-separator">
            {block.features.map((f) => (
              <FeatureRow key={f.id} feature={f} />
            ))}
          </ul>
        </Panel>
      ))}
    </div>
  );
}

function FeatureRow({ feature: f }: { feature: ProgrammeFeature }) {
  return (
    <li className="grid gap-1 px-4 py-3 sm:px-5" data-feature={f.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[12px] tabular-nums text-muted">{f.id}</span>
        <span className="text-[14px] font-medium text-foreground">
          {f.name}
        </span>
        <StatusPill tone={TONE[f.status]}>{f.statusLabel}</StatusPill>
        {f.priority !== f.statusLabel ? (
          <span className="text-[12px] text-muted">{f.priority}</span>
        ) : null}
        {f.deferralPool ? (
          <span className="text-[12px] text-muted">
            · may move past month 12
          </span>
        ) : null}
      </div>
      <p className="text-[13px] text-muted">
        <span className="font-medium text-foreground">Now: </span>
        {f.now}
      </p>
      <p className="text-[13px] text-muted">
        <span className="font-medium text-foreground">Next: </span>
        {f.next}
      </p>
      <p className="text-[12px] text-muted">{f.laneWhen}</p>
    </li>
  );
}
