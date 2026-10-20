"use client";

import { useState, type FormEvent } from "react";
import { apiFetch, mutate, useApi, useLive } from "../lib/api";
import { useSession } from "../lib/auth/session";

type Step = {
  key: string;
  adapter: string;
  label: string;
  required: boolean;
  condition: string;
};
type Definition = {
  id: string;
  channelProfile: string;
  version: number;
  label: string;
  steps: Step[];
  effectiveFrom: number;
  effectiveTo: number | null;
  source: string;
};
type Policy = {
  id: string;
  channel_profile: string;
  outlet_class: string;
  version: number;
  radius_meters: number;
  max_accuracy_meters: number;
  max_fix_age_ms: number;
  min_dwell_ms: number;
  effective_from: string;
  source: string;
};
type Reason = {
  id: string;
  code: string;
  label: string;
  version: number;
  effective_from: string;
  source: string;
};
type Binding = {
  id: string;
  app: string;
  channel_code: string;
  outlet_class: string;
  channel_profile: string;
  version: number;
  effective_from: string;
};
type AdminData = {
  bindings: Binding[];
  definitions: Definition[];
  policies: Policy[];
  reasons: Reason[];
};
const panel = "rounded-xl border border-border bg-surface p-5 grid gap-4";
const input =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground";
const button =
  "rounded-md border border-border px-3 py-2 text-sm disabled:opacity-40";
const stamp = (at: number | string) =>
  new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(at));
const adapters = [
  "check_in",
  "stock_check",
  "order_build",
  "discount",
  "invoice",
  "payment",
  "return_pickup",
  "evidence",
  "note",
  "availability",
  "planogram",
  "posm",
  "price_check",
  "competitor",
  "issue_log",
  "check_out",
];

/** F-006 F-107: one publication surface for all channel configurations. */
export function CallFlowAdmin() {
  const { profile } = useSession();
  const allowed =
    profile?.active && ["super_admin", "admin"].includes(profile.role);
  const result = useApi<AdminData>(
    allowed ? ["callflow", "admin"] : null,
    "/api/v1/callflow/admin",
  );
  useLive(["callflow"], [["callflow"]]);
  const [selected, setSelected] = useState<Definition | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function publish(event: FormEvent<HTMLFormElement>, kind: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload: Record<string, unknown> = Object.fromEntries(data.entries());
    payload.effectiveFrom = new Date(
      String(data.get("effectiveFrom")),
    ).getTime();
    if (kind === "definition") payload.steps = steps;
    if (kind === "policy")
      for (const key of [
        "radiusMeters",
        "maxAccuracyMeters",
        "maxFixAgeMs",
        "minDwellMs",
      ])
        payload[key] = Number(data.get(key));
    setBusy(true);
    setMessage("");
    try {
      const saved = await mutate<{ id: string; version: number }>(
        `/api/v1/callflow/${kind}/publish`,
        payload,
        { invalidate: [["callflow"]] },
      );
      // Read the exact saved target back before claiming publication succeeded.
      const fresh = await apiFetch<AdminData>("/api/v1/callflow/admin");
      if (
        ![
          ...fresh.definitions,
          ...fresh.policies,
          ...fresh.reasons,
          ...fresh.bindings,
        ].some((row) => row.id === saved.id)
      )
        throw new Error(
          "Could not confirm publication. Refresh before retrying.",
        );
      setMessage(
        `Version ${saved.version} published for the chosen effective date. Open calls keep their original rules.`,
      );
      await result.refetch();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not publish. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!allowed)
    return (
      <section className={panel}>
        Administrator access is required to publish call flows.
      </section>
    );
  return (
    <div className="grid gap-5">
      <section className={panel}>
        <h2 className="text-lg font-semibold">Call flows</h2>
        <p className="text-sm text-muted">
          Which rules will each seller follow? Review the steps, radius, dwell
          time and no-order reasons, then publish a future version. Both Android
          apps use the same engine offline.
        </p>
        {message && <p role="status">{message}</p>}
        {result.error && <p role="alert">{result.error.message}</p>}
        {!result.data ? (
          <p>Loading call flow setup…</p>
        ) : result.data.definitions.length === 0 ? (
          <p>
            No flow is published. Publish a definition and its radius policy
            before enabling it.
          </p>
        ) : (
          result.data.definitions.map((d) => (
            <button
              key={d.id}
              className={`${button} text-left`}
              onClick={() => {
                setSelected(d);
                setSteps(d.steps.map((s) => ({ ...s })));
              }}
            >
              <span className="font-medium">
                {d.label} · Version {d.version}
              </span>
              <span className="block text-muted">
                {stamp(d.effectiveFrom)}
                {d.effectiveTo
                  ? ` — ${stamp(d.effectiveTo)}`
                  : " onwards"} ·{" "}
                {d.source === "sample"
                  ? "Sample rules — needs Sunpride approval"
                  : "Office published"}
              </span>
            </button>
          ))
        )}
      </section>
      <form
        key={selected?.id ?? "new"}
        className={panel}
        onSubmit={(event) => void publish(event, "definition")}
      >
        <h3 className="font-semibold">
          {selected ? "Publish a revised flow" : "Publish a call flow"}
        </h3>
        <label>
          Channel profile
          <input
            name="channelProfile"
            defaultValue={selected?.channelProfile ?? "field_selling"}
            className={input}
            required
            pattern="[a-z][a-z0-9_]*"
          />
        </label>
        <label>
          Name
          <input
            name="label"
            defaultValue={selected?.label ?? ""}
            className={input}
            required
            maxLength={100}
          />
        </label>
        <label>
          Effective from (local time)
          <input
            type="datetime-local"
            name="effectiveFrom"
            className={input}
            required
          />
        </label>
        <p className="text-sm text-muted">
          Start with Check in, finish with Check out. Required steps block later
          steps; conditions use the call’s saved order facts. New channel
          adapters need a working capture form before they can be required.
        </p>
        {steps.map((step, index) => (
          <div
            key={`${index}-${step.key}`}
            className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-2"
          >
            <label>
              Step name
              <input
                className={input}
                value={step.label}
                onChange={(e) =>
                  setSteps(
                    steps.map((s, i) =>
                      i === index ? { ...s, label: e.target.value } : s,
                    ),
                  )
                }
                required
              />
            </label>
            <label>
              Action
              <select
                className={input}
                value={step.adapter}
                onChange={(e) =>
                  setSteps(
                    steps.map((s, i) =>
                      i === index ? { ...s, adapter: e.target.value } : s,
                    ),
                  )
                }
              >
                {adapters.map((a) => (
                  <option key={a} value={a}>
                    {a.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={step.required}
                onChange={(e) =>
                  setSteps(
                    steps.map((s, i) =>
                      i === index ? { ...s, required: e.target.checked } : s,
                    ),
                  )
                }
              />{" "}
              Required
            </label>
            <label>
              When
              <select
                className={input}
                value={step.condition}
                onChange={(e) =>
                  setSteps(
                    steps.map((s, i) =>
                      i === index ? { ...s, condition: e.target.value } : s,
                    ),
                  )
                }
              >
                <option value="always">Every call</option>
                <option value="has_order">With an order</option>
                <option value="no_order">Without an order</option>
              </select>
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                className={button}
                disabled={index === 0}
                onClick={() => {
                  const next = [...steps];
                  [next[index - 1], next[index]] = [
                    next[index]!,
                    next[index - 1]!,
                  ];
                  setSteps(next);
                }}
              >
                Move up
              </button>
              <button
                type="button"
                className={button}
                onClick={() => setSteps(steps.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          className={button}
          onClick={() =>
            setSteps([
              ...steps,
              {
                key: `step_${crypto.randomUUID().slice(0, 8)}`,
                adapter: steps.length === 0 ? "check_in" : "check_out",
                label: steps.length === 0 ? "Check in" : "Check out",
                required: true,
                condition: "always",
              },
            ])
          }
        >
          Add step
        </button>
        <button className={button} disabled={busy || steps.length < 2}>
          Publish definition
        </button>
      </form>
      <section className={panel}>
        <h3 className="font-semibold">
          Choose a flow by channel and store class
        </h3>
        <p className="text-sm text-muted">
          Pre-sell, merchandising and distributor reps use these profiles in the
          existing apps. A channel match takes priority over a class-only match;
          * means all. A published binding never changes an open call.
        </p>
        {result.data?.bindings.map((b) => (
          <p key={b.id}>
            {b.app === "van-android" ? "Van app" : "Field app"} ·{" "}
            {b.channel_code === "*" ? "All channels" : b.channel_code} ·{" "}
            {b.outlet_class === "*"
              ? "All store classes"
              : `Class ${b.outlet_class}`}{" "}
            → {b.channel_profile.replaceAll("_", " ")} · Version {b.version} ·{" "}
            {stamp(b.effective_from)}
          </p>
        ))}
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => void publish(e, "binding")}
        >
          <label>
            App
            <select name="app" className={input}>
              <option value="field-android">Field app</option>
              <option value="van-android">Van app</option>
            </select>
          </label>
          <label>
            Channel code (* means all)
            <input
              name="channelCode"
              defaultValue="*"
              className={input}
              required
            />
          </label>
          <label>
            Outlet class (* means all)
            <input
              name="outletClass"
              defaultValue="*"
              className={input}
              required
            />
          </label>
          <label>
            Published channel profile
            <input
              name="channelProfile"
              defaultValue="field_selling"
              className={input}
              required
            />
          </label>
          <label>
            Effective from
            <input
              name="effectiveFrom"
              type="datetime-local"
              className={input}
              required
            />
          </label>
          <button className={button} disabled={busy}>
            Publish channel binding
          </button>
        </form>
        <h3 className="font-semibold">Radius and time in store</h3>
        {result.data?.policies.map((p) => (
          <p key={p.id} className="text-sm">
            {p.channel_profile.replaceAll("_", " ")} ·{" "}
            {p.outlet_class === "*"
              ? "All store classes"
              : `Class ${p.outlet_class}`}{" "}
            · Version {p.version}: {p.radius_meters} m radius, accuracy within{" "}
            {p.max_accuracy_meters} m, fix within {p.max_fix_age_ms / 1000}{" "}
            seconds, minimum {p.min_dwell_ms / 60000} minutes. From{" "}
            {stamp(p.effective_from)}
            {p.source === "sample" ? " · Sample" : ""}
          </p>
        ))}
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => void publish(e, "policy")}
        >
          <label>
            Channel profile
            <input
              className={input}
              name="channelProfile"
              defaultValue="field_selling"
              required
            />
          </label>
          <label>
            Outlet class (* means all)
            <input
              className={input}
              name="outletClass"
              defaultValue="*"
              required
            />
          </label>
          {[
            ["radiusMeters", "Radius (metres)", 100, 1, 500],
            ["maxAccuracyMeters", "Maximum fix accuracy (metres)", 50, 1, 100],
            [
              "maxFixAgeMs",
              "Maximum fix age (milliseconds)",
              60000,
              1000,
              300000,
            ],
            ["minDwellMs", "Minimum time (milliseconds)", 180000, 0, 14400000],
          ].map(([key, label, value, min, max]) => (
            <label key={String(key)}>
              {label}
              <input
                className={input}
                name={String(key)}
                type="number"
                defaultValue={value}
                min={min}
                max={max}
                required
              />
            </label>
          ))}
          <label>
            Effective from
            <input
              className={input}
              name="effectiveFrom"
              type="datetime-local"
              required
            />
          </label>
          <button className={button} disabled={busy}>
            Publish policy
          </button>
        </form>
      </section>
      <section className={panel}>
        <h3 className="font-semibold">No-order reasons</h3>
        <p className="text-sm text-muted">
          A saved draft is not an order. Calls with no saved order require one
          of these reasons; photos remain optional unless the flow requires
          evidence.
        </p>
        {result.data?.reasons.map((reason) => (
          <p key={reason.id}>
            {reason.label} · Version {reason.version} ·{" "}
            {stamp(reason.effective_from)}
            {reason.source === "sample" ? " · Sample" : ""}
          </p>
        ))}
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => void publish(e, "reason")}
        >
          <label>
            Stable code
            <input
              name="code"
              className={input}
              required
              pattern="[a-z][a-z0-9_]*"
            />
          </label>
          <label>
            Reason shown on phones
            <input name="label" className={input} required maxLength={100} />
          </label>
          <label>
            Effective from
            <input
              name="effectiveFrom"
              className={input}
              type="datetime-local"
              required
            />
          </label>
          <button className={button} disabled={busy}>
            Publish reason
          </button>
        </form>
      </section>
    </div>
  );
}

type CallReport = {
  from: string;
  to: string;
  counts: Record<"planned" | "deviated" | "unplanned", number>;
  items: {
    callId: string;
    person: string;
    outlet: string;
    serviceDate: string;
    source: string;
    state: string;
    reason: string | null;
    zeroSaleReason: string | null;
    durationMs: number | null;
    shortCallReason: string | null;
  }[];
};
export function CallFlowReport() {
  const result = useApi<CallReport>(
    ["callflow", "report"],
    "/api/v1/callflow/report",
  );
  return (
    <section className={panel}>
      <h2 className="text-lg font-semibold">Configured calls by plan status</h2>
      <p className="text-sm text-muted">
        Calls recorded by this engine over the last seven days. Earlier visits
        remain in Coverage. Unplanned calls stay separate and never inflate
        planned-stop adherence.
      </p>
      {result.error && <p role="alert">{result.error.message}</p>}
      {result.data ? (
        (["deviated", "unplanned", "planned"] as const).map((source) => (
          <details key={source}>
            <summary className="cursor-pointer font-medium">
              {source === "deviated"
                ? "Planned, out of sequence"
                : source === "unplanned"
                  ? "Unplanned stores"
                  : "In planned sequence"}{" "}
              · {result.data!.counts[source]}
            </summary>
            <div className="grid gap-3 py-3">
              {result
                .data!.items.filter((c) => c.source === source)
                .map((call) => (
                  <article
                    key={call.callId}
                    className="rounded-md border border-border p-3"
                  >
                    <p>
                      {call.person} · {call.outlet} · {call.serviceDate}
                    </p>
                    <p className="text-sm text-muted">
                      {call.state === "open"
                        ? "In progress"
                        : call.state === "interrupted"
                          ? "Missing checkout — reconcile"
                          : "Closed"}
                      {call.reason ? ` · ${call.reason}` : ""}
                      {call.zeroSaleReason
                        ? ` · No order: ${call.zeroSaleReason}`
                        : ""}
                      {call.durationMs !== null
                        ? ` · ${Math.floor(call.durationMs / 60000)} min`
                        : ""}
                      {call.shortCallReason
                        ? ` · Short call: ${call.shortCallReason}`
                        : ""}
                    </p>
                  </article>
                ))}
            </div>
          </details>
        ))
      ) : (
        <p>Loading call breakdown…</p>
      )}
    </section>
  );
}

type Review = {
  id: string;
  kind: string;
  person: string;
  outlet: string;
  reason: string;
  durationMs: number | null;
  source: string;
  canDecide: boolean;
};
/** F-106 F-204 F-205 F-207: part of the existing Decide queue, not a second approval app. */
export function CallFlowReviews() {
  const result = useApi<{ items: Review[] }>(
    ["callflow", "reviews"],
    "/api/v1/callflow/reviews",
  );
  useLive(["callflow"], [["callflow"]]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function decide(row: Review, decision: string) {
    setBusy(true);
    setMessage("");
    try {
      await mutate(
        "/api/v1/callflow/reviews/decide",
        { reviewId: row.id, decision, reason: reasons[row.id] },
        { invalidate: [["callflow"]] },
      );
      await result.refetch();
      setMessage("Decision saved. The original call evidence is unchanged.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not save decision.",
      );
    } finally {
      setBusy(false);
    }
  }
  const labels: Record<string, string> = {
    geofence_start: "Outside-radius start",
    geofence_end: "Outside-radius end",
    short_call: "Short call",
    sequence: "Out-of-sequence call",
    unplanned: "Unplanned call",
  };
  return (
    <section className={panel}>
      <h2 className="text-lg font-semibold">Call exceptions</h2>
      <p className="text-sm text-muted">
        Review short calls, deviations and requests to start outside a store
        radius. Approval never changes the planned-stop denominator or the
        original evidence.
      </p>
      {(message || result.error) && (
        <p role="status">{message || result.error?.message}</p>
      )}
      {!result.data ? (
        <p>Loading call exceptions…</p>
      ) : result.data.items.length === 0 ? (
        <p>No pending call exceptions in your current scope.</p>
      ) : (
        result.data.items.map((row) => (
          <article
            key={row.id}
            className="grid gap-3 rounded-lg border border-border p-4"
          >
            <h3 className="font-medium">
              {labels[row.kind] ?? "Call review"} · {row.outlet}
            </h3>
            <p>
              {row.person} · {row.reason}
            </p>
            {row.durationMs !== null && (
              <p>{Math.floor(row.durationMs / 60000)} minutes in store</p>
            )}
            {row.canDecide && (
              <>
                <label>
                  Decision reason
                  <input
                    className={input}
                    value={reasons[row.id] ?? ""}
                    onChange={(e) =>
                      setReasons({ ...reasons, [row.id]: e.target.value })
                    }
                    maxLength={500}
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    className={button}
                    disabled={busy || !reasons[row.id]?.trim()}
                    onClick={() => void decide(row, "approve")}
                  >
                    Approve exception
                  </button>
                  <button
                    className={button}
                    disabled={busy || !reasons[row.id]?.trim()}
                    onClick={() => void decide(row, "reject")}
                  >
                    Reject exception
                  </button>
                </div>
              </>
            )}
          </article>
        ))
      )}
    </section>
  );
}
