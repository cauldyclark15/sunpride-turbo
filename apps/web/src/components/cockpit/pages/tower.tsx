"use client";

import { useState } from "react";
import { ModelWorkbench } from "./model-workbench";
import Link from "next/link";
import { apiFetch, buildApiUrl, mutate, useApi, useLive } from "@/lib/api";
import {
  KpiGrid,
  Panel,
  PageData,
  DrillTable,
  EmptyState,
  TrendChart,
} from "../kit";
import { formatCount, formatPct, formatPhp, formatMinutes } from "../format";
import type { Kpi, ResponseHeader } from "../types";
import type { AnalyticsQuery } from "../api";
import { buttonClass, useCockpitAccess } from "./shared";

type Scalar = string | number | boolean | null;
type TableRow = Record<string, Scalar>;
type Column = {
  key: string;
  label: string;
  format?: "php" | "pct" | "minutes";
};
export function TowerTable({
  label,
  rows,
  columns,
  href,
  rowHref,
}: {
  label: string;
  rows: TableRow[];
  columns: Column[];
  href?: string;
  rowHref?: (row: TableRow) => string;
}) {
  const [visible, setVisible] = useState(50);
  return (
    <DrillTable<TableRow>
      label={label}
      rows={rows.slice(0, visible)}
      footer={
        rows.length > visible ? (
          <button
            type="button"
            className={buttonClass}
            onClick={() => setVisible((n) => n + 50)}
          >
            Show more · {visible} of {rows.length}
          </button>
        ) : null
      }
      rowKey={(r) => String(r.key)}
      rowHref={rowHref}
      csvHref={href}
      columns={columns.map((c) => ({
        ...c,
        sort: (r) => {
          const v = r[c.key];
          return typeof v === "boolean" ? Number(v) : (v ?? null);
        },
        render: (r) => {
          const v = r[c.key];
          return v === null || v === undefined
            ? "Not measured"
            : c.format === "php"
              ? formatPhp(Number(v))
              : c.format === "pct"
                ? formatPct(Number(v))
                : c.format === "minutes"
                  ? formatMinutes(Number(v))
                  : typeof v === "number"
                    ? formatCount(v)
                    : typeof v === "boolean"
                      ? v
                        ? "Yes"
                        : "No"
                      : v;
        },
      }))}
      empty={
        <EmptyState variant="unknown" title="No source records">
          Connect the source or add clearly marked sample records. Missing data
          is not zero.
        </EmptyState>
      }
    />
  );
}
function useTower<T>(page: string, query: AnalyticsQuery) {
  const path = `/api/v1/analytics/${page}`;
  const result = useApi<T>(["analytics", page, query], ({ signal }) =>
    apiFetch<T>(path, { query, signal }),
  );
  useLive("analytics", [["analytics"]]);
  return result;
}
const excel = (page: string, query: AnalyticsQuery) =>
  buildApiUrl(`/api/v1/analytics/${page}`, { ...query, format: "xlsx" });
type AvailabilityRow = {
  storeId: string;
  label: string;
  territory: string;
  required: number;
  checked: number;
  osa: number | null;
  completenessPct: number | null;
  frequencyAchieved: number;
  frequencyTarget: number;
  adherence: number | null;
  strikeRatePct: number | null;
  nextAction: string;
};
type Availability = ResponseHeader & {
  kpis: Kpi[];
  people: Array<{ id: string; label: string }>;
  trend: Array<{
    date: string;
    osa: number | null;
    completenessPct: number | null;
  }>;
  rows: AvailabilityRow[];
  universe: number;
  covered: number;
  billed: number;
  osa: number | null;
  completenessPct: number | null;
  setupRequired: boolean;
  definition: string;
  distribution: Array<{
    productId: string;
    label: string;
    universe: number;
    measured: number;
    unmeasured: number;
    stocking: number;
    numericDistributionPct: number | null;
    weightedDistributionPct: number | null;
  }>;
};
export function AvailabilityView({
  data,
  query,
}: {
  data: Availability;
  query: AnalyticsQuery;
}) {
  return (
    <Panel
      title="Coverage and shelf availability"
      question={`${data.covered} of ${data.universe} outlets covered · ${data.billed} billed. Buying is not stocking.`}
      csvHref={excel("coverage-availability", query)}
    >
      <KpiGrid kpis={data.kpis} />
      <TrendChart
        label="Weekly availability and measurement completeness"
        unit="pct"
        dates={data.trend.map((r) => r.date)}
        series={[
          {
            key: "osa",
            label: "On-shelf availability",
            kind: "line",
            values: data.trend.map((r) => r.osa),
          },
          {
            key: "measured",
            label: "Measured MSL lines",
            kind: "prior",
            values: data.trend.map((r) => r.completenessPct),
          },
        ]}
      />
      {data.setupRequired ? (
        <p className="text-sm text-muted">
          Set observation freshness before interpreting availability.
        </p>
      ) : null}
      <p className="mb-3 text-sm text-muted">
        MSL completeness {formatPct(data.completenessPct)} · OSA{" "}
        {formatPct(data.osa)}. {data.definition}
      </p>
      <TowerTable
        label="Outlet coverage and availability"
        rows={data.rows.map((r) => ({ key: r.storeId, ...r }))}
        rowHref={(r) => `/customers/customer?storeId=${r.storeId}`}
        columns={[
          { key: "label", label: "Outlet" },
          { key: "territory", label: "Territory" },
          { key: "frequencyAchieved", label: "Calls achieved" },
          { key: "frequencyTarget", label: "Calls needed" },
          { key: "adherence", label: "Adherence", format: "pct" },
          { key: "osa", label: "MSL on shelf", format: "pct" },
          { key: "completenessPct", label: "Measured", format: "pct" },
          { key: "nextAction", label: "Next action" },
        ]}
      />
      <TowerTable
        label="Stocking distribution"
        rows={data.distribution.map((r) => ({ key: r.productId, ...r }))}
        columns={[
          { key: "label", label: "Product" },
          { key: "stocking", label: "Stocking outlets" },
          { key: "universe", label: "Universe" },
          { key: "unmeasured", label: "Unmeasured" },
          {
            key: "numericDistributionPct",
            label: "Numeric distribution",
            format: "pct",
          },
          {
            key: "weightedDistributionPct",
            label: "Weighted distribution",
            format: "pct",
          },
        ]}
      />
    </Panel>
  );
}
export function AvailabilityPanel({ query }: { query: AnalyticsQuery }) {
  const [profile, setProfile] = useState("");
  const full = { ...query, ...(profile ? { profileId: profile } : {}) };
  const result = useTower<Availability>("coverage-availability", full);
  return (
    <div className="grid gap-2">
      <label className="text-sm">
        Shelf view by person{" "}
        <select value={profile} onChange={(e) => setProfile(e.target.value)}>
          <option value="">Everyone in selected scope</option>
          {result.data?.people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.label}
            </option>
          ))}
        </select>
      </label>
      <PageData result={result} label="coverage and availability">
        {(data) => <AvailabilityView data={data} query={full} />}
      </PageData>
    </div>
  );
}

type TradeRow = {
  key: string;
  distributor: string;
  product: string;
  channel: string;
  account: string;
  primaryCases: number | null;
  secondaryCases: number | null;
  stockCases: number | null;
  daysInventory: number | null;
  stockDate: string | null;
  secondaryContributionPct: number | null;
  priorSecondaryCentavos: number | null;
  primaryCentavos: number | null;
  secondaryCentavos: number | null;
  sample: boolean;
  nextAction: string;
};
type Trade = ResponseHeader & {
  kpis: Kpi[];
  rows: TradeRow[];
  trend: Array<{
    date: string;
    primary: number | null;
    secondary: number | null;
  }>;
  sourceMode: string;
  contributions: Array<{
    key: string;
    dimension: string;
    label: string;
    kind: string;
    valueCentavos: number | null;
    sourceLines: number;
  }>;
};
export function TradeView({
  data,
  query,
}: {
  data: Trade;
  query: AnalyticsQuery;
}) {
  return (
    <Panel
      title="Primary versus secondary"
      question="Are shipments reaching retailers, or building up in trade?"
      csvHref={excel("primary-secondary", query)}
    >
      <p className="mb-3 text-sm text-muted">
        {data.demo ? "Clearly marked sample distributor data. " : ""}
        {data.sourceMode}. Captured office orders are not primary shipments.
      </p>
      <KpiGrid kpis={data.kpis} />
      <TrendChart
        label="Shipments and retailer offtake"
        dates={data.trend.map((r) => r.date)}
        series={[
          {
            key: "primary",
            label: "Primary shipments",
            kind: "line",
            values: data.trend.map((r) => r.primary),
          },
          {
            key: "secondary",
            label: "Secondary offtake",
            kind: "prior",
            values: data.trend.map((r) => r.secondary),
          },
        ]}
      />
      <TowerTable
        label="Primary and secondary by distributor and product"
        rows={data.rows.map((r) => ({ ...r }))}
        columns={[
          { key: "distributor", label: "Distributor" },
          { key: "product", label: "Product" },
          { key: "channel", label: "Channel" },
          { key: "account", label: "Account" },
          { key: "primaryCases", label: "Shipped cases" },
          { key: "secondaryCases", label: "Offtake cases" },
          { key: "stockCases", label: "Trade stock cases" },
          { key: "daysInventory", label: "Days inventory" },
          { key: "stockDate", label: "Declared as of" },
          {
            key: "secondaryContributionPct",
            label: "Offtake contribution",
            format: "pct",
          },
          {
            key: "priorSecondaryCentavos",
            label: "Prior offtake",
            format: "php",
          },
          { key: "nextAction", label: "Next action" },
        ]}
      />
      <TowerTable
        label="Channel and account contribution"
        rows={data.contributions}
        columns={[
          { key: "dimension", label: "View" },
          { key: "label", label: "Channel or account" },
          { key: "kind", label: "Flow" },
          { key: "valueCentavos", label: "Contribution", format: "php" },
          { key: "sourceLines", label: "Source lines" },
        ]}
      />
    </Panel>
  );
}
export function TradePanel({ query }: { query: AnalyticsQuery }) {
  const result = useTower<Trade>("primary-secondary", query);
  return (
    <PageData result={result} label="primary and secondary sales">
      {(data) => <TradeView data={data} query={query} />}
    </PageData>
  );
}

type Demand = ResponseHeader & {
  rows: Array<
    TradeRow & {
      numericDistributionPct: number | null;
      completeness: string;
      promotionPlans: unknown[];
    }
  >;
  notice: string;
  completeness: Record<string, boolean>;
};
export function DemandPanel({ query }: { query: AnalyticsQuery }) {
  const result = useTower<Demand>("demand-signals", query);
  const access = useCockpitAccess();
  const [id, setId] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [destination, setDestination] = useState(
      "Sample Supply Chain review inbox",
    ),
    [reference, setReference] = useState("");
  const cuts = useApi<{ rows: Array<{ id: string; label: string }> }>(
    access.canSetTarget ? ["analytics", "planning-cuts"] : null,
    ({ signal }) => apiFetch("/api/v1/planning/demand-signals", { signal }),
  );
  async function prepare() {
    setBusy(true);
    try {
      const r = await mutate<{ id: string }>(
        "/api/v1/planning/demand-signals/prepare",
        { ...query, requestKey: crypto.randomUUID() },
      );
      setId(r.id);
      await cuts.refetch();
      setMessage("Planning cut prepared with frozen source lineage.");
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Could not prepare planning cut.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function transition(action: string) {
    setBusy(true);
    try {
      await mutate("/api/v1/planning/demand-signals/transition", {
        id,
        action,
        destination,
        reference,
      });
      setMessage(
        action === "publish"
          ? "Published for a different planning owner to acknowledge."
          : "Planning acknowledgement saved.",
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Could not update planning cut.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title="Demand signal to S&OP"
      question="Give Supply Chain the evidence, not an unexplained forecast."
      csvHref={excel("demand-signals", query)}
    >
      <PageData result={result} label="demand signal">
        {(data) => (
          <>
            <p className="mb-3 text-sm text-muted">{data.notice}</p>
            <p className="mb-3 text-sm">
              {Object.entries(data.completeness)
                .map(
                  ([k, v]) =>
                    `${k.replace(/([A-Z])/g, " $1")}: ${v ? "available" : "incomplete"}`,
                )
                .join(" · ")}
            </p>
            <TowerTable
              label="Demand signal inputs"
              rows={data.rows.map((r) => ({
                key: r.key,
                product: r.product,
                distributor: r.distributor,
                secondaryCases: r.secondaryCases,
                stockCases: r.stockCases,
                numericDistributionPct: r.numericDistributionPct,
                promotions: r.promotionPlans.length,
                completeness: r.completeness,
              }))}
              columns={[
                { key: "product", label: "Product" },
                { key: "distributor", label: "Distributor" },
                { key: "secondaryCases", label: "Offtake cases" },
                { key: "stockCases", label: "Trade stock cases" },
                {
                  key: "numericDistributionPct",
                  label: "Distribution",
                  format: "pct",
                },
                { key: "promotions", label: "Promotion plans" },
                { key: "completeness", label: "Readiness" },
              ]}
            />
          </>
        )}
      </PageData>
      {access.canSetTarget ? (
        <div className="mt-3 grid gap-3">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="grid min-w-0 gap-1 text-sm">
              Planning cut
              <select
                className="min-w-0 w-full"
                value={id}
                onChange={(e) => setId(e.target.value)}
              >
                <option value="">Choose a prepared cut</option>
                {cuts.data?.rows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-1 text-sm">
              Destination
              <input
                className="min-w-0 w-full"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              />
            </label>
            <label className="grid min-w-0 gap-1 text-sm">
              Acknowledgement reference
              <input
                className="min-w-0 w-full"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Supply Chain reference"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => void prepare()}
            >
              Prepare planning cut
            </button>
            {["publish", "accept", "reject"].map((a) => (
              <button
                key={a}
                type="button"
                className={buttonClass}
                disabled={busy || !id}
                onClick={() => void transition(a)}
              >
                {a === "publish"
                  ? "Publish cut"
                  : a === "accept"
                    ? "Accept cut"
                    : "Reject cut"}
              </button>
            ))}
          </div>
          {id ? (
            <a
              className="text-sm underline"
              href={`/api/v1/planning/demand-signals/snapshot?id=${encodeURIComponent(id)}`}
              target="_blank"
              rel="noreferrer"
            >
              Inspect frozen cut and source lineage
            </a>
          ) : null}
          <p role="status" className="text-sm">
            {message}
          </p>
        </div>
      ) : null}
      <ModelWorkbench />
    </Panel>
  );
}

type Finding = {
  id: string;
  title: string;
  detail: string;
  store: string;
  person: string;
  severity: string;
  status: string;
  rule: string;
  version: string;
  sample: boolean;
  reviewHref: string;
};
export function FraudPanel({ query }: { query: AnalyticsQuery }) {
  const result = useTower<ResponseHeader & { rows: Finding[]; notice: string }>(
    "fraud",
    query,
  );
  return (
    <Panel
      title="Exception and integrity signals"
      question="What needs an independent review? A signal is not proof of fraud."
      csvHref={excel("fraud", query)}
    >
      <PageData result={result} label="integrity signals">
        {(data) => (
          <>
            <p className="mb-3 text-sm text-muted">{data.notice}</p>
            <TowerTable
              label="Integrity findings for review"
              rows={data.rows.map((r) => ({ key: r.id, ...r }))}
              rowHref={(r) => String(r.reviewHref)}
              columns={[
                { key: "title", label: "Signal" },
                { key: "store", label: "Outlet" },
                { key: "person", label: "Person" },
                { key: "severity", label: "Priority" },
                { key: "status", label: "Review status" },
                { key: "sample", label: "Sample case" },
                { key: "detail", label: "Evidence summary" },
              ]}
            />
          </>
        )}
      </PageData>
    </Panel>
  );
}

type ContextItem = {
  kind: string;
  label?: string;
  value?: number;
  components?: Record<string, number | null>;
  service?: string;
  history?: string;
  condition?: string;
  serial?: string;
  status?: string;
  nextAction?: string;
  source?: { sample?: boolean };
};
export type OutletContext = {
  coverage?: { planned: number; visited: number; missed: number };
  classification: ContextItem & { potential?: string | number };
  executionScore: ContextItem & { reason?: string };
  assets: ContextItem[];
  issues: ContextItem[];
  competitors: Array<{
    id: string;
    brand: string;
    kind: string;
    observed_price_minor: number | null;
    note: string | null;
  }>;
  arScope: string;
  availability: AvailabilityRow | null;
  demo: boolean;
};
export function OutletContextView({ data }: { data: OutletContext }) {
  return (
    <Panel
      title="Outlet 360 · execution and context"
      question="What should the next visit fix?"
    >
      <p className="mb-3 text-sm">
        {data.classification.label} ·{" "}
        {data.classification.potential ?? "Potential not assessed"} · Execution
        score {data.executionScore.value ?? "Not measured"}.{" "}
        {data.demo ? "Context includes clearly marked samples." : ""}
      </p>
      <p className="mb-3 text-sm text-muted">
        Receivables: {data.arScope}. Coverage achieved{" "}
        {data.availability?.frequencyAchieved ?? "Not measured"}; OSA{" "}
        {formatPct(data.availability?.osa ?? null)}.
      </p>
      {data.executionScore.components ? (
        <details className="mb-3 text-sm">
          <summary>Execution score components</summary>
          <dl className="mt-2 grid gap-1">
            {Object.entries(data.executionScore.components).map(
              ([name, value]) => (
                <div key={name} className="flex gap-3">
                  <dt>{name.replace(/([A-Z])/g, " $1")}</dt>
                  <dd>{value ?? "Not measured"}</dd>
                </div>
              ),
            )}
          </dl>
        </details>
      ) : null}
      <TowerTable
        label="Assets at the outlet"
        rows={data.assets.map((r, i) => ({
          key: String(i),
          label: r.label ?? "Asset",
          condition: r.condition ?? null,
          serial: r.serial ?? null,
          service: r.service ?? null,
          history: r.history ?? null,
        }))}
        columns={[
          { key: "label", label: "Asset" },
          { key: "serial", label: "Serial" },
          { key: "condition", label: "Condition" },
          { key: "service", label: "Service" },
          { key: "history", label: "History" },
        ]}
      />
      <TowerTable
        label="Outlet incidents"
        rows={data.issues.map((r, i) => ({
          key: String(i),
          label: r.label ?? "Issue",
          status: r.status ?? null,
          nextAction: r.nextAction ?? null,
        }))}
        columns={[
          { key: "label", label: "Issue" },
          { key: "status", label: "Status" },
          { key: "nextAction", label: "Next action" },
        ]}
      />
      <TowerTable
        label="Competitor position"
        rows={data.competitors.map((r) => ({
          key: r.id,
          brand: r.brand,
          kind: r.kind,
          price: r.observed_price_minor,
          note: r.note,
        }))}
        columns={[
          { key: "brand", label: "Competitor" },
          { key: "kind", label: "Observation" },
          { key: "price", label: "Observed price", format: "php" },
          { key: "note", label: "Notes" },
        ]}
      />
    </Panel>
  );
}

export function AlertsPanel({ unitId }: { unitId: string | null }) {
  const result = useApi<{
    rows: Array<{ id: string; title: string; read: boolean }>;
    mailMode: string;
  }>(["analytics", "alerts"], ({ signal }) =>
    apiFetch("/api/v1/alerts", { signal }),
  );
  const [metric, setMetric] = useState("integrity_open"),
    [threshold, setThreshold] = useState("0"),
    [cooldown, setCooldown] = useState("60"),
    [email, setEmail] = useState(true),
    [message, setMessage] = useState("");
  async function subscribe(enabled: boolean) {
    try {
      await mutate(
        "/api/v1/alerts/subscribe",
        {
          unitId,
          metric,
          threshold: Number(threshold),
          cooldownMinutes: Number(cooldown),
          inApp: true,
          email,
          enabled,
        },
        { invalidate: [["analytics"]] },
      );
      await mutate(
        "/api/v1/alerts/evaluate",
        {},
        { invalidate: [["analytics"]] },
      );
      setMessage(
        enabled
          ? "Subscription saved. Email uses the development sink; no external mail sent."
          : "Subscription paused.",
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Could not save subscription.",
      );
    }
  }
  return (
    <Panel
      title="Your alerts"
      question="Choose what deserves an interruption. Repeated breaches respect your cooldown."
    >
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm">
          Metric
          <select value={metric} onChange={(e) => setMetric(e.target.value)}>
            <option value="integrity_open">Open integrity signals above</option>
            <option value="missed_stops">Missed calls above</option>
            <option value="availability_below">Availability below</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Threshold
          <input
            type="number"
            min="0"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm">
          Cooldown minutes
          <input
            type="number"
            min="1"
            max="10080"
            value={cooldown}
            onChange={(e) => setCooldown(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <input
            type="checkbox"
            checked={email}
            onChange={(e) => setEmail(e.target.checked)}
          />{" "}
          Email to development sink
        </label>
        <button
          type="button"
          className={buttonClass}
          disabled={!unitId}
          onClick={() => void subscribe(true)}
        >
          Subscribe
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!unitId}
          onClick={() => void subscribe(false)}
        >
          Pause
        </button>
      </div>
      <p role="status" className="text-sm">
        {message}
      </p>
      <PageData result={result} label="your alerts">
        {(data) => (
          <div className="grid gap-2">
            <p className="text-sm text-muted">{data.mailMode}</p>
            {data.rows.map((r) => (
              <div
                key={r.id}
                className="flex justify-between border-b border-border py-2"
              >
                <span>{r.title}</span>
                <button
                  type="button"
                  disabled={r.read}
                  className={buttonClass}
                  onClick={() =>
                    void mutate(
                      "/api/v1/alerts/read",
                      { id: r.id },
                      { invalidate: [["analytics"]] },
                    ).then(() => result.refetch())
                  }
                >
                  {r.read ? "Read" : "Mark read"}
                </button>
              </div>
            ))}
          </div>
        )}
      </PageData>
    </Panel>
  );
}

export function PolicyPanel({ unitId }: { unitId: string | null }) {
  const access = useCockpitAccess();
  const [freshness, setFreshness] = useState("7"),
    [turnover, setTurnover] = useState(""),
    [store, setStore] = useState(""),
    [search, setSearch] = useState(""),
    [team, setTeam] = useState(""),
    [message, setMessage] = useState("");
  const policies = useApi<{
    rows: Array<{ org_unit_id: string; unit: string }>;
  }>(access.canSetTarget ? ["analytics", "policies"] : null, ({ signal }) =>
    apiFetch("/api/v1/analytics/policies", { signal }),
  );
  const outlets = useApi<{ rows: Array<{ storeId: string; name: string }> }>(
    access.canSetTarget
      ? ["analytics", "turnover-outlets", search, unitId]
      : null,
    ({ signal }) =>
      apiFetch("/api/v1/analytics/stores", {
        query: { q: search, limit: "200", ...(unitId ? { unitId } : {}) },
        signal,
      }),
  );
  if (!access.canSetTarget) return null;
  const teams = [
    ...new Map(
      (policies.data?.rows ?? []).map((r) => [r.org_unit_id, r]),
    ).values(),
  ];
  const selectedTeam = team || unitId;
  async function save(kind: "policy" | "turnover") {
    try {
      const effectiveFrom = new Date(Date.now() + 60000).toISOString();
      await mutate(
        kind === "policy"
          ? "/api/v1/analytics/policies/set"
          : "/api/v1/analytics/turnover/set",
        kind === "policy"
          ? {
              unitId: selectedTeam,
              freshnessDays: Number(freshness),
              effectiveFrom,
            }
          : {
              storeId: store,
              turnoverCentavos: Math.round(Number(turnover) * 100),
              effectiveFrom,
            },
        { invalidate: [["analytics"]] },
      );
      setMessage("Saved prospectively, effective in one minute.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save policy.");
    }
  }
  return (
    <Panel
      title="Measurement policy"
      question="Govern freshness and total-outlet turnover weights. Weights are not Sunpride purchase values."
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm">
          Team
          <select
            value={selectedTeam ?? ""}
            onChange={(e) => setTeam(e.target.value)}
          >
            {unitId && !teams.some((r) => r.org_unit_id === unitId) ? (
              <option value={unitId}>Selected scope root</option>
            ) : null}
            {teams.map((r) => (
              <option key={r.org_unit_id} value={r.org_unit_id}>
                {r.unit}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Freshness days
          <input
            type="number"
            min="1"
            max="90"
            value={freshness}
            onChange={(e) => setFreshness(e.target.value)}
          />
        </label>
        <button
          type="button"
          className={buttonClass}
          disabled={!selectedTeam}
          onClick={() => void save("policy")}
        >
          Set team policy
        </button>
        <label className="grid gap-1 text-sm">
          Find outlet
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by outlet name"
          />
        </label>
        <label className="grid gap-1 text-sm">
          Outlet
          <select value={store} onChange={(e) => setStore(e.target.value)}>
            <option value="">Choose outlet</option>
            {outlets.data?.rows.map((r) => (
              <option key={r.storeId} value={r.storeId}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Total outlet turnover (₱)
          <input
            type="number"
            min="0"
            value={turnover}
            onChange={(e) => setTurnover(e.target.value)}
          />
        </label>
        <button
          type="button"
          className={buttonClass}
          disabled={!store || !turnover}
          onClick={() => void save("turnover")}
        >
          Set turnover weight
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">
        Freshness applies to the exact selected team; choose each territory team
        as needed.
      </p>
      <p role="status" className="text-sm">
        {message}
      </p>
      <Link href="/customers" className="text-sm underline">
        Open outlet universe
      </Link>
    </Panel>
  );
}
