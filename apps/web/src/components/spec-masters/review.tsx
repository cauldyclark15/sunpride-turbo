"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import { Card, Notice } from "@sunpride/ui";
import { apiFetch, mutate, useApi } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import type { Choice } from "./model";
const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm";
type Capture = {
  id: string;
  name: string;
  address: string;
  accuracy_meters: number;
  owner_name: string;
  owner_phone: string;
  estimated_class: string;
  agent: string;
  batch: string;
};
type Queue = {
  batches: {
    id: string;
    name: string;
    expected_outlets: number;
    accepted: number;
    pending: number;
    coveragePct: number;
    targetPct: number;
  }[];
  rows: Capture[];
  truncated: boolean;
};
/** F-011 pending surveys first; physical universe denominator is explicit and editable. */
export function CensusReview({ units = [] }: { units?: Choice[] }) {
  const { can } = usePermissions(),
    [message, setMessage] = useState("");
  const queue = useApi<Queue>(
    can("outlet.verify") ? ["masters", "census"] : null,
    "/api/v1/masters/census-queue",
  );
  const [selected, setSelected] = useState<Capture | null>(null);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await mutate(
        "/api/v1/masters/census/batches",
        {
          code: f.get("code"),
          name: f.get("name"),
          orgUnitId: f.get("unit"),
          expectedOutlets: Number(f.get("expected")),
        },
        { idempotencyKey: crypto.randomUUID(), invalidate: [["masters"]] },
      );
      setMessage(
        "Census batch created. Reopen census online once on the assigned phones.",
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Batch could not be created.",
      );
    }
  }
  async function review(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected) return;
    const f = new FormData(e.currentTarget);
    try {
      await mutate(
        "/api/v1/masters/census/review",
        {
          captureId: selected.id,
          decision: f.get("decision"),
          code: f.get("code"),
          outletId: String(f.get("outletId") ?? "") || null,
          reason: f.get("reason"),
        },
        { idempotencyKey: crypto.randomUUID(), invalidate: [["masters"]] },
      );
      setSelected(null);
      setMessage("Census reviewed. Original evidence stays unchanged.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Review failed.");
    }
  }
  if (!can("outlet.verify")) return null;
  return (
    <Card label="Census batches and review">
      {queue.error ? (
        <Notice title={queue.error.message} tone="danger" />
      ) : null}
      <p className="text-sm text-muted">
        Accept a survey only after checking its photo, owner contact and GPS.
        All accepted captures have measured accuracy under 50 m. Sample batches
        are not a completed real-world census.
      </p>
      <div className="my-3 grid gap-2 md:grid-cols-2">
        {queue.data?.batches.map((b) => (
          <div key={b.id} className="rounded-lg border border-border p-3">
            <p className="text-sm font-medium">{b.name}</p>
            <p className="text-xs text-muted">
              {b.accepted} accepted / {b.expected_outlets} expected ·{" "}
              {b.pending} to review
            </p>
            <p className="text-sm">
              {b.coveragePct.toFixed(1)}% accepted · target {b.targetPct}%
            </p>
          </div>
        ))}
      </div>
      {queue.data?.rows.length ? (
        <div className="grid gap-2">
          {queue.data.rows.map((c) => (
            <button
              key={c.id}
              className="rounded-lg border border-border p-3 text-left"
              onClick={() => setSelected(c)}
            >
              <span className="text-sm font-medium">{c.name}</span>
              <span className="block text-xs text-muted">
                {c.batch} · ±{Math.round(c.accuracy_meters)} m · captured by{" "}
                {c.agent}
              </span>
            </button>
          ))}
        </div>
      ) : queue.data ? (
        <p className="text-sm text-muted">No captures waiting for review.</p>
      ) : (
        <p>Loading census…</p>
      )}
      {queue.data?.truncated ? (
        <Notice
          title="Showing the first 100 items. Review these before continuing."
          tone="warning"
        />
      ) : null}
      {selected ? (
        <form
          key={selected.id}
          onSubmit={review}
          className="mt-4 grid gap-3 rounded-lg border border-border p-4"
        >
          <h3 className="font-semibold">{selected.name}</h3>
          <p className="text-sm">
            {selected.address} · {selected.owner_name} · {selected.owner_phone}{" "}
            · estimated class {selected.estimated_class}
          </p>
          <a
            href={`/api/v1/masters/census/${selected.id}/photo`}
            target="_blank"
            rel="noreferrer"
            className="text-sm underline"
          >
            Open protected storefront photo
          </a>
          <label className="grid gap-1 text-xs">
            Decision
            <select name="decision" className={field}>
              <option value="accept">Accept as new store</option>
              <option value="reject">Reject survey</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            New store code (when accepting)
            <input className={field} name="code" />
          </label>
          <label className="grid gap-1 text-xs">
            Review reason
            <input className={field} name="reason" required />
          </label>
          <p className="text-xs text-muted">
            Check duplicate-store review before accepting. The API also supports
            linking a duplicate capture to an existing survivor.
          </p>
          <Button type="submit" variant="outline">
            Save independent review
          </Button>
          <Button variant="ghost" onPress={() => setSelected(null)}>
            Cancel
          </Button>
        </form>
      ) : null}
      {can("outlet.manage") && units.length ? (
        <form
          onSubmit={create}
          className="mt-4 grid gap-3 border-t border-border pt-4"
        >
          <h3 className="text-sm font-semibold">Start a census batch</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-xs">
              Batch code
              <input name="code" className={field} required />
            </label>
            <label className="grid gap-1 text-xs">
              Batch name
              <input name="name" className={field} required />
            </label>
            <label className="grid gap-1 text-xs">
              Assigned area
              <select name="unit" className={field} required>
                <option value="">Choose…</option>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs">
              Expected physical outlets
              <input
                name="expected"
                type="number"
                min={1}
                className={field}
                required
              />
            </label>
          </div>
          <Button type="submit" variant="outline">
            Create batch
          </Button>
        </form>
      ) : null}
      {message ? (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      ) : null}
    </Card>
  );
}
type Preview = {
  potentialCentavos: number;
  derivedClass: string;
  policyVersionId: string;
};
type Inputs = {
  transactionsPerDay: number;
  averageBasketCentavos: number;
  tradingDaysPerMonth: number;
  captureRatePct: number;
};
/** F-014 scoring preview and immutable per-store decision history. */
export function OutletClassification({ outlets }: { outlets: Choice[] }) {
  const { can } = usePermissions(),
    [outlet, setOutlet] = useState(""),
    [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null),
    [inputs, setInputs] = useState<Inputs | null>(null);
  const history = useApi<{
    decisions: {
      id: string;
      assignedClass: string;
      derivedClass: string;
      reason: string;
      actorName: string;
      potentialCentavos: number;
    }[];
  }>(
    outlet ? ["masters", "class-history", outlet] : null,
    `/api/v1/masters/outlets/${outlet}/history`,
  );
  async function score(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const input = {
      transactionsPerDay: Number(f.get("transactions")),
      averageBasketCentavos: Math.round(Number(f.get("basket")) * 100),
      tradingDaysPerMonth: Number(f.get("days")),
      captureRatePct: Number(f.get("capture")),
    };
    try {
      setPreview(
        await apiFetch<Preview>("/api/v1/masters/class-preview", {
          method: "POST",
          body: { inputs: input },
        }),
      );
      setInputs(input);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Preview failed.");
    }
  }
  async function assign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!preview || !inputs) return;
    const f = new FormData(e.currentTarget);
    try {
      await mutate(
        "/api/v1/masters/outlets/classify",
        {
          outletId: outlet,
          policyVersionId: preview.policyVersionId,
          inputs,
          overrideClass: String(f.get("class")) || null,
          reason: f.get("reason"),
        },
        { idempotencyKey: crypto.randomUUID(), invalidate: [["masters"]] },
      );
      setPreview(null);
      setMessage(
        "Potential class recorded with its inputs and policy version.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Classification failed.");
    }
  }
  if (!can("outlet.verify")) return null;
  return (
    <Card label="Classify a store by revenue potential">
      <label className="grid gap-1 text-xs">
        Store
        <select
          className={field}
          value={outlet}
          onChange={(e) => {
            setOutlet(e.target.value);
            setPreview(null);
          }}
        >
          <option value="">Choose…</option>
          {outlets.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      <form
        onSubmit={score}
        onChange={() => setPreview(null)}
        className="mt-3 grid gap-3"
      >
        <p className="text-sm text-muted">
          Estimate what the store could sell, not its recorded sales.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {[
            ["transactions", "Potential transactions per day", "100"],
            ["basket", "Average basket (₱)", "100"],
            ["days", "Trading days per month", "30"],
            ["capture", "Expected share captured (%)", "50"],
          ].map(([name, label, value]) => (
            <label key={name} className="grid gap-1 text-xs">
              {label}
              <input
                type="number"
                className={field}
                name={name}
                defaultValue={value}
                min="0"
                step={name === "basket" ? "0.01" : "1"}
                required
              />
            </label>
          ))}
        </div>
        <Button type="submit" variant="outline" isDisabled={!outlet}>
          Preview potential class
        </Button>
      </form>
      {preview ? (
        <form
          onSubmit={assign}
          className="mt-3 grid gap-3 rounded-lg border border-border p-3"
        >
          <p>
            Estimated monthly potential:{" "}
            {new Intl.NumberFormat("en-PH", {
              style: "currency",
              currency: "PHP",
            }).format(preview.potentialCentavos / 100)}{" "}
            · derived class {preview.derivedClass}
          </p>
          <label className="grid gap-1 text-xs">
            Assigned class (override requires a reason)
            <select
              className={field}
              name="class"
              defaultValue={preview.derivedClass}
            >
              {["A", "B", "C", "D"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            Decision reason
            <input className={field} name="reason" required />
          </label>
          <Button type="submit" variant="outline">
            Record class decision
          </Button>
        </form>
      ) : null}
      {history.error ? (
        <Notice title={history.error.message} tone="danger" />
      ) : null}
      {history.data?.decisions.map((d) => (
        <p key={d.id} className="mt-2 text-sm">
          Class {d.assignedClass}
          {d.assignedClass !== d.derivedClass
            ? ` (derived ${d.derivedClass})`
            : ""}{" "}
          · {d.actorName} · {d.reason}
        </p>
      ))}
      {message ? (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      ) : null}
    </Card>
  );
}
