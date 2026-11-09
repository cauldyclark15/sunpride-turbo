"use client";

import { useState, type FormEvent } from "react";
import { apiFetch, mutate, useApi, useLive } from "../../lib/api";
import { Panel, TrendChart } from "../cockpit/kit";
import { manilaToday } from "../cockpit/period";
import type { RetailSetup, RetailRelease } from "./types";
import { launchBuildTargets } from "./editor-rules";

const action =
  "rounded-lg border border-border px-3 py-2 text-sm font-medium disabled:opacity-40";
const field =
  "min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm";
type Preview = {
  releaseId: string;
  kind: RetailRelease["kind"];
  hash: string;
  rows: Array<{ outletId: string; name: string; label: string; lines: number }>;
};
type Launch = {
  label: string;
  sample: boolean;
  targets: number;
  scopeNarrowed: boolean;
  rows: Array<{
    outletId: string;
    name: string;
    firstOrderDate: string | null;
    repeatPurchase: boolean;
    orders: number;
  }>;
  curve: Array<{ date: string; plan: number; actual: number | null }>;
};

/** F-211/F-216/F-219 effective-dated Trade Marketing maintenance in existing Setup. */
export function AvailabilityEditor() {
  const result = useApi<RetailSetup>(
    ["availability", "setup"],
    "/api/v1/availability/releases",
  );
  useLive("availability", [["availability"]]);
  const [kind, setKind] = useState<RetailRelease["kind"]>("msl");
  const [selected, setSelected] = useState<string[]>([]);
  const [stores, setStores] = useState<string[]>([]);
  const [channel, setChannel] = useState("");
  const [subchannel, setSubchannel] = useState("");
  const [classification, setClassification] = useState("");
  const [territory, setTerritory] = useState("");
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [universeLabel, setUniverseLabel] = useState(
    "SAMPLE · validated outlet universe",
  );
  const [universeSource, setUniverseSource] = useState(
    "SAMPLE · Trade Marketing census approval",
  );
  const [universeDate, setUniverseDate] = useState(manilaToday());
  const [universeSample, setUniverseSample] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [launchId, setLaunchId] = useState("");
  const launch = useApi<Launch>(
    launchId ? ["availability", "launch", launchId] : null,
    ({ signal }) =>
      apiFetch("/api/v1/availability/launch", {
        query: { id: launchId },
        signal,
      }),
  );
  const data = result.data;
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(async () => {
      const effectiveFrom = new Date(String(f.get("from"))).getTime();
      const payload: Record<string, unknown> = {
        channel: channel || null,
        subchannel: subchannel || null,
        classification: classification || null,
        priority: Number(f.get("priority") || 0),
        outletIds: f.get("override") ? stores : [],
        territoryIds: territory ? [territory] : [],
      };
      if (kind === "rules")
        Object.assign(payload, {
          coverDays: Number(f.get("cover")),
          freshnessDays: Number(f.get("freshness")),
          universeFreshnessDays: Number(f.get("universeFreshness")),
        });
      else if (kind === "launch")
        Object.assign(payload, {
          productIds: selected,
          outletIds: stores,
          buildTargets: launchBuildTargets(
            String(f.get("buildDate")),
            Number(f.get("buildCount")),
            String(f.get("buildAdditional") ?? ""),
          ),
        });
      else
        payload.lines = selected.map((productId) => ({
          productId,
          minimumBase: Number(f.get(`qty-${productId}`) || 1),
          ...(kind === "focus"
            ? { objective: String(f.get("objective")) }
            : {}),
        }));
      const release = await mutate<RetailRelease>(
        "/api/v1/availability/releases/create",
        {
          kind,
          key: String(f.get("key")),
          label: String(f.get("label")),
          sourceRef: String(f.get("source")),
          sample: f.get("sample") === "on",
          effectiveFrom,
          payload,
        },
        { invalidate: [["availability"]] },
      );
      const checked = await mutate<Preview>(
        "/api/v1/availability/releases/preview",
        { releaseId: release.id, outletIds: stores },
      );
      setPreview(checked);
      setMessage("Draft saved. Review the affected stores, then publish.");
    });
  }
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((v) => v !== id) : [...list, id];
  if (result.error)
    return (
      <Panel title="Trade Marketing setup">
        <p role="alert">{result.error.message}</p>
        <button className={action} onClick={() => void result.refetch()}>
          Try again
        </button>
      </Panel>
    );
  if (!data) return <p>Loading Trade Marketing setup…</p>;
  const audience = (key: "channel" | "subchannel" | "classification") =>
    [
      ...new Set(
        data.outlets.map((o) => o[key]).filter((v): v is string => !!v),
      ),
    ].sort();
  return (
    <div className="grid gap-4">
      <Panel
        title="Must-stock lists and objectives"
        question="What each store must carry."
      >
        <p className="mb-4 text-sm text-muted">
          Saved lists start on the date you set. The most specific rule wins.
        </p>
        <form
          onSubmit={(e) => void submit(e)}
          onChange={() => setPreview(null)}
          className="grid gap-4"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <label>
              Policy
              <select
                className={field}
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as RetailRelease["kind"]);
                  setPreview(null);
                }}
              >
                <option value="msl">Must-stock set</option>
                <option value="focus">Focus SKUs and objectives</option>
                <option value="launch">New product launch</option>
                <option value="rules">Cover and freshness rules</option>
              </select>
            </label>
            <label>
              List group
              <input
                className={field}
                name="key"
                required
                placeholder="e.g. GT class A"
              />
            </label>
            <label>
              Name
              <input
                className={field}
                name="label"
                required
                placeholder="e.g. Sari-sari must-stock set"
              />
            </label>
            <label>
              Starts on
              <input
                className={field}
                type="datetime-local"
                name="from"
                required
              />
            </label>
            <label>
              Approved by
              <input
                className={field}
                name="source"
                required
                placeholder="Trade Marketing approval or SAMPLE"
              />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="sample" defaultChecked />
              Sample
            </label>
          </div>
          {kind === "rules" ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                ["cover", "Cover days", 8],
                ["freshness", "Shelf observation freshness, days", 7],
                ["universeFreshness", "Universe freshness, days", 7],
              ].map(([name, label, value]) => (
                <label key={name}>
                  {label}
                  <input
                    className={field}
                    name={String(name)}
                    type="number"
                    min="1"
                    max="90"
                    defaultValue={value}
                  />
                </label>
              ))}
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                {(
                  [
                    ["channel", "Channel", channel, setChannel],
                    ["subchannel", "Sub-channel", subchannel, setSubchannel],
                    [
                      "classification",
                      "Outlet class",
                      classification,
                      setClassification,
                    ],
                  ] as const
                ).map(([key, label, value, set]) => (
                  <label key={key}>
                    {label}
                    <select
                      className={field}
                      value={value}
                      onChange={(e) => set(e.target.value)}
                    >
                      <option value="">All</option>
                      {audience(key).map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                ))}
                <label>
                  Territory
                  <select
                    className={field}
                    value={territory}
                    onChange={(e) => setTerritory(e.target.value)}
                  >
                    <option value="">All territories</option>
                    {(data.territories ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.code} · {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Priority (0–99)
                  <input
                    className={field}
                    name="priority"
                    type="number"
                    min="0"
                    max="99"
                    defaultValue="0"
                  />
                </label>
              </div>
              {kind !== "launch" && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="override" />
                  Override only the selected stores
                </label>
              )}
              {kind === "focus" && (
                <label>
                  Per-call objective
                  <input
                    className={field}
                    name="objective"
                    required
                    placeholder="Secure first order and shelf position"
                  />
                </label>
              )}
              <fieldset>
                <legend className="mb-2 text-sm font-medium">
                  Products · minimum order proposal in integer base units
                </legend>
                <div className="max-h-72 overflow-auto rounded-lg border border-border p-3">
                  {data.products.map((p) => (
                    <div key={p.id} className="flex items-center gap-3 py-2">
                      <label className="flex flex-1 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selected.includes(p.id)}
                          onChange={() => setSelected(toggle(selected, p.id))}
                        />
                        {p.code} · {p.name}
                      </label>
                      {selected.includes(p.id) && kind !== "launch" && (
                        <input
                          aria-label={`Minimum base quantity for ${p.name}`}
                          className="w-24 rounded border border-border p-2"
                          name={`qty-${p.id}`}
                          type="number"
                          min="1"
                          max="1000000"
                          defaultValue="1"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </fieldset>
              {kind === "launch" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label>
                    Build target date
                    <input
                      className={field}
                      name="buildDate"
                      type="date"
                      required
                      defaultValue={manilaToday()}
                    />
                  </label>
                  <label>
                    Cumulative stores with a first order
                    <input
                      className={field}
                      name="buildCount"
                      type="number"
                      min="0"
                      max={stores.length}
                      required
                    />
                  </label>
                  <label className="sm:col-span-2">
                    Additional build milestones (date, cumulative stores)
                    <textarea
                      className={`${field} py-2`}
                      name="buildAdditional"
                      rows={3}
                      placeholder={"2026-11-08, 20\n2026-11-15, 30"}
                    />
                  </label>
                </div>
              )}
            </>
          )}
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Stores</legend>
            <button
              className={action}
              type="button"
              onClick={() =>
                setStores(
                  data.outlets
                    .filter(
                      (o) =>
                        (!territory || o.territoryId === territory) &&
                        (!channel || o.channel === channel) &&
                        (!subchannel || o.subchannel === subchannel) &&
                        (!classification ||
                          o.classification === classification),
                    )
                    .map((o) => o.id),
                )
              }
            >
              Pick matching stores
            </button>
            <span className="ml-3 text-sm">{stores.length} selected</span>
            <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-border p-3">
              {data.outlets.map((o) => (
                <label
                  key={o.id}
                  className="flex items-center gap-2 py-1 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={stores.includes(o.id)}
                    onChange={() => {
                      setStores(toggle(stores, o.id));
                      setPreview(null);
                    }}
                  />
                  {o.code} · {o.name} · {o.channel ?? "No channel"} /{" "}
                  {o.classification ?? "No class"}
                </label>
              ))}
            </div>
          </fieldset>
          <button className={`${action} justify-self-start`} disabled={busy}>
            Save and preview
          </button>
        </form>
        {message && (
          <p role="status" className="mt-3 text-sm">
            {message}
          </p>
        )}
        {preview && (
          <div className="mt-4 border-t border-border pt-4">
            <h3 className="font-medium">
              Preview · {preview.rows.length} stores
            </h3>
            <ul className="my-3 max-h-56 overflow-auto text-sm">
              {preview.rows.map((r) => (
                <li key={r.outletId} className="py-1">
                  {r.name} · {r.label} ·{" "}
                  {preview.kind === "msl"
                    ? `${r.lines} required lines`
                    : preview.kind === "rules"
                      ? "Measurement policy"
                      : `${r.lines} target products`}
                </li>
              ))}
            </ul>
            <button
              className={action}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await mutate(
                    "/api/v1/availability/releases/publish",
                    {
                      releaseId: preview.releaseId,
                      outletIds: stores,
                      previewHash: preview.hash,
                    },
                    { invalidate: [["availability"], ["analytics"]] },
                  );
                  await result.refetch();
                  setPreview(null);
                  setMessage("Published. Phones get it on their next sync.");
                })
              }
            >
              Publish
            </button>
          </div>
        )}
      </Panel>
      <Panel
        title="Store list for coverage"
        question="Coverage figures use this store list."
      >
        <p className="mb-3 text-sm text-muted">
          Only approved stores count. Leave a weight empty if unknown.
        </p>
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          <label>
            Name
            <input
              className={field}
              value={universeLabel}
              onChange={(e) => setUniverseLabel(e.target.value)}
            />
          </label>
          <label>
            Census approval reference
            <input
              className={field}
              value={universeSource}
              onChange={(e) => setUniverseSource(e.target.value)}
            />
          </label>
          <label>
            Universe effective date
            <input
              className={field}
              type="date"
              value={universeDate}
              onChange={(e) => setUniverseDate(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={universeSample}
              onChange={(e) => setUniverseSample(e.target.checked)}
            />
            Clearly marked sample universe
          </label>
        </div>
        <div className="mb-3 max-h-56 overflow-auto">
          {data.outlets
            .filter((o) => stores.includes(o.id))
            .map((o) => (
              <label
                key={o.id}
                className="flex items-center gap-3 py-1 text-sm"
              >
                <span className="flex-1">
                  {o.code} · {o.name}
                </span>
                <input
                  aria-label={`Turnover weight for ${o.name}`}
                  className="w-32 rounded border border-border p-2"
                  type="number"
                  min="1"
                  max="1000000000"
                  step="1"
                  placeholder="Unknown"
                  value={weights[o.id] ?? ""}
                  onChange={(e) =>
                    setWeights({ ...weights, [o.id]: e.target.value })
                  }
                />
              </label>
            ))}
        </div>
        <button
          className={action}
          disabled={
            busy ||
            !stores.length ||
            !universeLabel.trim() ||
            !universeSource.trim() ||
            !universeDate
          }
          onClick={() =>
            void run(async () => {
              await mutate(
                "/api/v1/availability/universe/publish",
                {
                  label: universeLabel,
                  serviceDate: universeDate,
                  sourceRef: universeSource,
                  sample: universeSample,
                  members: stores.map((outletId) => ({
                    outletId,
                    turnoverWeight: weights[outletId]?.trim()
                      ? Number(weights[outletId])
                      : null,
                    validationRef: universeSource,
                  })),
                },
                { invalidate: [["analytics"]] },
              );
              setMessage("Published.");
            })
          }
        >
          Publish
        </button>
      </Panel>
      <Panel
        title="Published lists"
        question="Launches show first and repeat orders."
      >
        <div className="grid gap-2">
          {data.rows.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap justify-between gap-2 border-b border-border py-2 text-sm"
            >
              <span>
                {r.label} · v{r.version} · {r.status}
                {r.sample ? " · Sample" : ""} ·{" "}
                {new Date(r.effective_from).toLocaleDateString("en-US", {
                  timeZone: "Asia/Manila",
                  month: "short",
                  day: "numeric",
                })}
              </span>
              <span>{r.source_ref}</span>
              {r.kind === "launch" && r.status === "published" && (
                <button className={action} onClick={() => setLaunchId(r.id)}>
                  View launch
                </button>
              )}
            </div>
          ))}
        </div>
        {launch.error && <p role="alert">{launch.error.message}</p>}
        {launch.data && (
          <div className="mt-4">
            <h3>
              {launch.data.label} · {launch.data.targets} scoped target stores
              {launch.data.scopeNarrowed
                ? " · company plan is broader than this scope"
                : ""}
            </h3>
            <TrendChart
              dates={launch.data.curve.map((r) => r.date)}
              unit="count"
              label="Launch build versus plan"
              series={[
                {
                  key: "plan",
                  label: "Plan",
                  kind: "target",
                  values: launch.data.curve.map((r) => r.plan),
                },
                {
                  key: "actual",
                  label: "First-order stores",
                  kind: "line",
                  values: launch.data.curve.map((r) => r.actual),
                },
              ]}
            />
            <ul className="mt-3 max-h-64 overflow-auto text-sm">
              {launch.data.rows.map((r) => (
                <li key={r.outletId}>
                  {r.name} · {r.firstOrderDate ?? "No first order"} ·{" "}
                  {r.repeatPurchase ? "Repeat purchase" : "No repeat yet"}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
    </div>
  );
}
