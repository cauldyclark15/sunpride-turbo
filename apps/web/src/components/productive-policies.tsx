"use client";
import { formatPeriod } from "../lib/format";
import { useRef, useState } from "react";
import { useApi, useLive, useMutate } from "../lib/api";
import { currentManilaDate } from "../lib/coverage-calendar";

type Policy = {
  _id: string;
  label: string;
  version: number;
  status: string;
  orgUnitId: string;
  positionId?: string;
  channelKey?: string;
  unitName: string;
  positionLabel?: string;
  preparedByName: string;
  approvedByName?: string;
  sourceRef: string;
  effectiveFrom: number;
  effectiveTo?: number;
  contentHash: string;
  definition: { rule: string; matchMode: string; allowedCodes: string[] };
};
type Registry = {
  policies: Policy[];
  units: { id: string; name: string }[];
  positions: { id: string; label: string }[];
  codes: string[];
  canAuthor: boolean;
  canApprove: boolean;
};
const label = (c: string) => c.replaceAll("_", " ");
const futureDay = () =>
  new Date(Date.parse(currentManilaDate() + "T00:00:00Z") + 86400000)
    .toISOString()
    .slice(0, 10);
const action =
  "h-10 rounded-[10px] border border-border px-3 text-sm disabled:opacity-40";
export function ProductivePolicyList({
  policies,
  canApprove = false,
  busy = false,
  publish,
}: {
  policies: Policy[];
  canApprove?: boolean;
  busy?: boolean;
  publish?: (id: string) => void;
}) {
  return (
    <section aria-label="Productive definition versions" className="grid gap-3">
      {policies.length ? (
        policies.map((p) => (
          <article
            key={p._id}
            className="rounded-xl border border-border p-4 text-sm"
          >
            <h3 className="font-medium">
              {p.label} · version {p.version} · {p.status}
            </h3>
            <p>
              Unit: {p.unitName} · Position:{" "}
              {p.positionLabel ?? "All positions"} ·{" "}
              {p.channelKey ?? "All channels"}
            </p>
            <p>
              {formatPeriod(p.effectiveFrom, p.effectiveTo ?? null)} ·{" "}
              {p.definition.matchMode === "all" ? "Every" : "Any"} qualifying
              activity: {p.definition.allowedCodes.map(label).join(", ")}.
            </p>
            <p>
              {p.definition.rule === "truck_seller" &&
              p.definition.allowedCodes.includes("merchandising")
                ? "Truck-seller merchandising requires the no-sales-due-to-inventory marker. "
                : ""}
              Completed approved-plan calls only. Notes and checkout alone do
              not qualify.
            </p>
            <p>
              Prepared by {p.preparedByName};{" "}
              {p.approvedByName
                ? `approved by ${p.approvedByName}`
                : "waiting for a different approver"}
              . Source: {p.sourceRef}
            </p>
            <p className="text-muted">
              Definition hash {p.contentHash.slice(0, 12)}. Earlier visits keep
              their captured version.
            </p>
            {p.status === "draft" && canApprove ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => publish?.(p._id)}
                className={action}
              >
                Publish {p.label} version {p.version}
              </button>
            ) : null}
          </article>
        ))
      ) : (
        <p>
          No published definition yet. Calls retain a clearly provisional beta
          definition until an office agreement is published.
        </p>
      )}
    </section>
  );
}
/** F-208: a registry inside the existing Coverage workspace, not another call engine. */
export function ProductivePolicies() {
  const registry = useApi<Registry>(
    ["coverage", "productive-policies"],
    "/api/v1/coverage/productive-policies",
  );
  useLive(["coverage"], [["coverage"]]);
  const { mutate } = useMutate();
  const [unit, setUnit] = useState(""),
    [position, setPosition] = useState(""),
    [name, setName] = useState(""),
    [source, setSource] = useState("SAMPLE — awaiting Sunpride agreement"),
    [from, setFrom] = useState(futureDay),
    [to, setTo] = useState(""),
    [rule, setRule] = useState("any_listed_activity"),
    [mode, setMode] = useState("any"),
    [codes, setCodes] = useState<string[]>([]),
    [replace, setReplace] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const keys = useRef(new Map<string, string>());
  async function send(action: string, body: object) {
    const intent = JSON.stringify({ action, body });
    let key = keys.current.get(intent);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(intent, key);
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await mutate(
        `/api/v1/coverage/productive-policies/${action}`,
        { ...body, idempotencyKey: key },
        { invalidate: [["coverage"]] },
      );
      keys.current.delete(intent);
      setNotice(
        action === "draft"
          ? "Draft saved. A different approver must publish it."
          : "Definition published. Earlier visits retain their frozen definition.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save definition");
    } finally {
      setBusy(false);
    }
  }
  if (registry.error) return <p role="alert">{registry.error.message}</p>;
  if (!registry.data) return <p>Loading productive-call definitions…</p>;
  const data = registry.data;
  return (
    <div className="grid gap-5">
      <header>
        <h2 className="text-lg font-medium">
          What earns productive-call credit?
        </h2>
        <p className="text-sm text-muted">
          Publish Sales and Trade Marketing’s agreed definition before it
          applies. Productive calls follow this definition; strike rate counts
          calls with a recorded, authorized order. They are not interchangeable.
        </p>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {data.canAuthor ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send("draft", {
              orgUnitId: unit || data.units[0]?.id,
              positionId: position || null,
              channelKey: null,
              label: name,
              sourceRef: source,
              fromDate: from,
              toDate: to || null,
              replacesPolicyId: replace || null,
              definition: {
                rule,
                matchMode: mode,
                requiresPlanned: true,
                allowedCodes: codes,
              },
            });
          }}
          className="grid gap-3 rounded-xl border border-border p-4 md:grid-cols-2"
          aria-label="Draft productive definition"
        >
          <label className="grid gap-1 text-sm">
            Replace a published version (optional)
            <select
              value={replace}
              onChange={(e) => {
                setReplace(e.target.value);
                const p = data.policies.find((p) => p._id === e.target.value);
                if (p) {
                  setUnit(p.orgUnitId);
                  setPosition(p.positionId ?? "");
                  setName(p.label);
                  setRule(p.definition.rule);
                  setMode(p.definition.matchMode);
                  setCodes(p.definition.allowedCodes);
                }
              }}
            >
              <option value="">New definition</option>
              {data.policies
                .filter((p) => p.status === "published")
                .map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.label} · {p.unitName} ·{" "}
                    {p.positionLabel ?? "All positions"} · version {p.version}
                  </option>
                ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Definition label
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Applies within this unit
            <select
              aria-label="Definition unit"
              value={unit || data.units[0]?.id || ""}
              onChange={(e) => setUnit(e.target.value)}
            >
              {data.units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Position
            <select
              value={position}
              onChange={(e) => setPosition(e.target.value)}
            >
              <option value="">All positions in this unit</option>
              {data.positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Rule
            <select value={rule} onChange={(e) => setRule(e.target.value)}>
              <option value="any_listed_activity">
                Agreed qualifying activities
              </option>
              <option value="truck_seller">
                Truck seller — inventory condition
              </option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Effective from
            <input
              required
              type="date"
              min={futureDay()}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Effective until (exclusive, optional)
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Qualification
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="any">Any selected activity</option>
              <option value="all">Every selected activity</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Agreement/source reference
            <input
              required
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
          <fieldset className="grid gap-2 md:col-span-2">
            <legend className="mb-2 text-sm">Activities that qualify</legend>
            <div className="flex flex-wrap gap-4">
              {data.codes.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={codes.includes(c)}
                    onChange={() =>
                      setCodes((v) =>
                        v.includes(c) ? v.filter((x) => x !== c) : [...v, c],
                      )
                    }
                  />
                  {label(c)}
                </label>
              ))}
            </div>
          </fieldset>
          <p className="text-sm text-muted md:col-span-2">
            Units are exact applicability, not implicit inheritance. Overlapping
            definitions are refused. A replacement must retain its applicability
            and start after its predecessor.
          </p>
          <button
            className={action}
            disabled={busy || !codes.length}
            type="submit"
          >
            Save definition draft
          </button>
        </form>
      ) : null}
      <ProductivePolicyList
        policies={data.policies}
        canApprove={data.canApprove}
        busy={busy}
        publish={(id) => void send("publish", { policyId: id })}
      />
    </div>
  );
}
