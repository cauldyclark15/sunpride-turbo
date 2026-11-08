"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Card, Notice } from "@sunpride/ui";
import { apiFetch, mutate, useApi } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import type { Choice } from "../spec-masters/model";
import {
  addressLine,
  candidatePoints,
  capturedWhen,
  formatDistance,
  mergeCandidates,
  reasonWords,
  sourceBadge,
  type Candidate,
  type Capture,
  type Queue,
} from "./model";

const PinMap = dynamic(() => import("./pin-map").then((m) => m.PinMap), {
  ssr: false,
  loading: () => (
    <div className="h-72 rounded-xl border border-border bg-default-soft" />
  ),
});
const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";
const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm";
const button =
  "inline-flex h-9 items-center justify-center rounded-lg border border-border bg-surface px-3 text-[13px] font-medium text-foreground hover:bg-default-soft disabled:opacity-50";
const primary =
  "inline-flex h-9 items-center justify-center rounded-lg border border-foreground bg-foreground px-3 text-[13px] font-medium text-background hover:opacity-90 disabled:opacity-50";

export type Decision = "accept" | "duplicate" | "reject";

/** One row of the gathering list: photo, store, agent, time, location badge, duplicate flag. */
export function CaptureRow({
  capture,
  selected,
  now,
  onOpen,
}: {
  capture: Capture;
  selected: boolean;
  now?: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      className={`flex w-full items-center gap-3 rounded-lg border p-2 text-left ${selected ? "border-foreground" : "border-border hover:bg-default-soft"}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- protected same-origin photo, no optimizer */}
      <img
        src={`/api/v1/masters/census/${capture.id}/photo`}
        alt=""
        loading="lazy"
        className="h-12 w-12 shrink-0 rounded-md bg-default-soft object-cover"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {capture.name}
        </span>
        <span className="block truncate text-xs text-muted">
          {capture.agent} · {capturedWhen(capture.captured_at, now)}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px]">
          {sourceBadge(capture)}
        </span>
        {capture.duplicate_flag ? (
          <span className="rounded-md bg-warning-soft px-1.5 py-0.5 text-[11px] font-medium text-warning">
            Maybe already listed
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** Candidate list beside the map: name, address, distance and the reason in plain words. */
export function CandidateList({
  candidates,
  acknowledged = [],
  onSame,
}: {
  candidates: Candidate[];
  acknowledged?: string[];
  onSame?: (c: Candidate) => void;
}) {
  if (!candidates.length)
    return (
      <p className="text-sm text-muted">
        No similar stores found nearby or with the same phone number.
      </p>
    );
  return (
    <ul className="grid gap-2" aria-label="Possible matches">
      {candidates.map((c) => (
        <li
          key={c.id}
          className="flex items-start justify-between gap-3 rounded-lg border border-border p-2"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium">
              {c.name}
              {c.kind === "capture" ? (
                <span className="ml-1 text-xs font-normal text-muted">
                  (also waiting for review)
                </span>
              ) : null}
            </span>
            <span className="block text-xs text-muted">
              {c.address || "No address"} · {formatDistance(c.distanceMeters)}
            </span>
            <span className="block text-xs">{reasonWords(c.reasons)}</span>
            {acknowledged.includes(c.id) ? (
              <span className="block text-xs text-muted">
                The agent said this is a different store.
              </span>
            ) : null}
          </span>
          {onSame && c.kind === "outlet" ? (
            <button type="button" className={button} onClick={() => onSame(c)}>
              Same store
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Detail of one capture with the review form. Pure view; the container sends the decision. */
export function CaptureDetail({
  capture,
  candidates,
  decision,
  survivor,
  busy,
  map,
  onDecision,
  onSurvivor,
  onSubmit,
  onClose,
}: {
  capture: Capture;
  candidates: Candidate[];
  decision: Decision;
  survivor: Candidate | null;
  busy?: boolean;
  map?: React.ReactNode;
  onDecision: (d: Decision) => void;
  onSurvivor: (c: Candidate | null) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const outlets = candidates.filter((c) => c.kind === "outlet");
  const parts = addressLine(capture.address_components);
  return (
    <form
      key={capture.id}
      onSubmit={onSubmit}
      className="grid gap-4 rounded-xl border border-border p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{capture.name}</h3>
          <p className="text-xs text-muted">
            Gathered by {capture.agent} · {capturedWhen(capture.captured_at)} ·{" "}
            {sourceBadge(capture)}
          </p>
        </div>
        <button type="button" className={button} onClick={onClose}>
          Close
        </button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- protected same-origin photo */}
        <img
          src={`/api/v1/masters/census/${capture.id}/photo`}
          alt={`Storefront of ${capture.name}`}
          className="max-h-72 w-full rounded-xl border border-border object-cover"
        />
        {map}
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted">Address</dt>
          <dd>{capture.address}</dd>
          {parts && parts !== capture.address ? (
            <dd className="text-xs text-muted">{parts}</dd>
          ) : null}
          {capture.landmark ? (
            <dd className="text-xs">Landmark: {capture.landmark}</dd>
          ) : null}
        </div>
        <div>
          <dt className="text-xs text-muted">Owner</dt>
          <dd>
            {capture.owner_name} ·{" "}
            <a className="underline" href={`tel:${capture.owner_phone}`}>
              {capture.owner_phone}
            </a>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Type of store</dt>
          <dd>
            {[capture.channel, capture.subchannel]
              .filter(Boolean)
              .join(" · ") || "Not set"}{" "}
            · class {capture.estimated_class}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Location</dt>
          <dd>
            {capture.location_source === "places"
              ? "Pin from the address the agent searched"
              : `Phone location, accurate to about ${Math.round(capture.accuracy_meters ?? 0)} m`}
          </dd>
        </div>
      </dl>
      <section className="grid gap-2">
        <h4 className="text-sm font-semibold">
          {candidates.length
            ? "This might already be in the list"
            : "Possible matches"}
        </h4>
        <CandidateList
          candidates={candidates}
          acknowledged={capture.acknowledged_duplicate_ids}
          onSame={(c) => {
            onDecision("duplicate");
            onSurvivor(c);
          }}
        />
      </section>
      <fieldset className="grid gap-3 border-t border-border pt-4">
        <legend className="sr-only">Decision</legend>
        <div role="radiogroup" className="flex flex-wrap gap-2">
          {(
            [
              ["accept", "Approve as new store"],
              ["duplicate", "Same as existing store"],
              ["reject", "Reject"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={decision === value}
              className={decision === value ? primary : button}
              onClick={() => onDecision(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {decision === "accept" ? (
          <label className="grid gap-1 text-xs">
            Store code (leave blank to number it automatically)
            <input className={field} name="code" autoComplete="off" />
          </label>
        ) : null}
        {decision === "duplicate" ? (
          <label className="grid gap-1 text-xs">
            Existing store
            <select
              className={field}
              value={survivor?.id ?? ""}
              onChange={(e) =>
                onSurvivor(outlets.find((c) => c.id === e.target.value) ?? null)
              }
              required
            >
              <option value="">Choose the store it matches…</option>
              {outlets.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {formatDistance(c.distanceMeters)}
                </option>
              ))}
            </select>
            {!outlets.length ? (
              <span className="text-muted">
                No existing store matched. Approve or reject instead.
              </span>
            ) : null}
          </label>
        ) : null}
        <label className="grid gap-1 text-xs">
          {decision === "reject" ? "Why is it rejected?" : "Note"}
          <input
            className={field}
            name="reason"
            required
            defaultValue={
              decision === "accept"
                ? "Checked photo, owner and location"
                : decision === "duplicate"
                  ? "Same store as the existing one"
                  : ""
            }
            key={decision}
          />
        </label>
        <div>
          <button
            type="submit"
            className={primary}
            disabled={busy || (decision === "duplicate" && !survivor)}
          >
            {decision === "accept"
              ? "Approve as new store"
              : decision === "duplicate"
                ? "Link to existing store"
                : "Reject"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

/** SP-0162 rebuilt store gathering review (was the F-011 census queue). */
export function StoreGatheringReview({ units = [] }: { units?: Choice[] }) {
  const { can } = usePermissions();
  const allowed = can("outlet.verify");
  const queue = useApi<Queue>(
    allowed ? ["masters", "census"] : null,
    "/api/v1/masters/census-queue",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision>("accept");
  const [survivor, setSurvivor] = useState<Candidate | null>(null);
  const [live, setLive] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<"all" | "flagged">("all");
  const rows = useMemo(
    () =>
      (queue.data?.rows ?? []).filter(
        (r) => filter === "all" || r.duplicate_flag,
      ),
    [queue.data, filter],
  );
  const selected = queue.data?.rows.find((r) => r.id === selectedId) ?? null;
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    apiFetch<{ candidates: Candidate[] }>(
      "/api/v1/masters/census/duplicate-check",
      {
        body: {
          name: selected.name,
          phone: selected.owner_phone,
          latitude: selected.latitude,
          longitude: selected.longitude,
          excludeCaptureId: selected.id,
        },
        signal: controller.signal,
      },
    )
      .then((r) => setLive(r.candidates))
      .catch(() => setLive([]));
    return () => controller.abort();
  }, [selected]);
  const candidates = selected
    ? mergeCandidates(selected.duplicate_candidates ?? [], live)
    : [];
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const result = await mutate<{ code: string | null }>(
        "/api/v1/masters/census/review",
        {
          captureId: selected.id,
          decision,
          code: decision === "accept" ? String(f.get("code") ?? "") : null,
          outletId: decision === "duplicate" ? (survivor?.id ?? null) : null,
          reason: f.get("reason"),
        },
        { idempotencyKey: crypto.randomUUID(), invalidate: [["masters"]] },
      );
      setMessage(
        decision === "accept"
          ? `${selected.name} is now a store${result.code ? ` (code ${result.code})` : ""}.`
          : decision === "duplicate"
            ? `${selected.name} was linked to ${survivor?.name ?? "the existing store"}.`
            : `${selected.name} was rejected.`,
      );
      setSelectedId(null);
      setSurvivor(null);
      setDecision("accept");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Review failed.");
    } finally {
      setBusy(false);
    }
  }
  if (!allowed) return null;
  return (
    <Card label="Store gathering review">
      {queue.error ? (
        <Notice title={queue.error.message} tone="danger" />
      ) : null}
      <p className="text-sm text-muted">
        Stores your agents gathered in the field. Check the photo, the owner and
        the pin, then approve, link to an existing store, or reject. The person
        who gathered a store cannot review it.
      </p>
      {queue.data?.batches.length ? (
        <div className="my-3 flex flex-wrap gap-2 text-xs">
          {queue.data.batches.map((b) => (
            <span
              key={b.id}
              className="rounded-lg border border-border px-2 py-1"
            >
              {b.name}: {b.accepted} approved · {b.pending} waiting
            </span>
          ))}
        </div>
      ) : null}
      <div className="mb-2 flex gap-2" role="tablist" aria-label="Show">
        {(
          [
            ["all", "All waiting"],
            ["flagged", "Maybe already listed"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={filter === id}
            className={filter === id ? primary : button}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_1fr]">
        <div className="grid content-start gap-2">
          {rows.length ? (
            rows.map((c) => (
              <CaptureRow
                key={c.id}
                capture={c}
                selected={c.id === selectedId}
                onOpen={() => {
                  setSelectedId(c.id);
                  setDecision("accept");
                  setSurvivor(null);
                  setLive([]);
                }}
              />
            ))
          ) : queue.data ? (
            <p className="text-sm text-muted">Nothing waiting for review.</p>
          ) : (
            <p className="text-sm text-muted">Loading…</p>
          )}
          {queue.data?.truncated ? (
            <Notice
              title="Showing the first 100. Review these to see more."
              tone="warning"
            />
          ) : null}
        </div>
        {selected ? (
          <CaptureDetail
            capture={selected}
            candidates={candidates}
            decision={decision}
            survivor={survivor}
            busy={busy}
            onDecision={setDecision}
            onSurvivor={setSurvivor}
            onSubmit={submit}
            onClose={() => setSelectedId(null)}
            map={
              <PinMap
                pin={{
                  latitude: selected.latitude,
                  longitude: selected.longitude,
                }}
                others={candidatePoints(candidates)}
                label={`Where ${selected.name} is`}
                googleKey={GOOGLE_KEY}
              />
            }
          />
        ) : (
          <p className="hidden text-sm text-muted lg:block">
            Choose a store on the left to review it.
          </p>
        )}
      </div>
      {can("outlet.manage") && units.length ? (
        <BatchForm units={units} onDone={setMessage} />
      ) : null}
      {message ? (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      ) : null}
    </Card>
  );
}

function BatchForm({
  units,
  onDone,
}: {
  units: Choice[];
  onDone: (m: string) => void;
}) {
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
      onDone("Gathering round created. Agents see it after their next sync.");
    } catch (err) {
      onDone(
        err instanceof Error ? err.message : "Round could not be created.",
      );
    }
  }
  return (
    <details className="mt-4 border-t border-border pt-4">
      <summary className="cursor-pointer text-sm font-semibold">
        Start a separate gathering round (optional)
      </summary>
      <p className="mt-1 text-xs text-muted">
        Agents gather into their area&apos;s ongoing round by default. Start a
        separate round only for a planned area sweep with a target count.
      </p>
      <form onSubmit={create} className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="grid gap-1 text-xs">
          Short name
          <input name="code" className={field} required />
        </label>
        <label className="grid gap-1 text-xs">
          Round name
          <input name="name" className={field} required />
        </label>
        <label className="grid gap-1 text-xs">
          Area
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
          Stores expected in the area
          <input
            name="expected"
            type="number"
            min={1}
            className={field}
            required
          />
        </label>
        <div>
          <button type="submit" className={button}>
            Create round
          </button>
        </div>
      </form>
    </details>
  );
}
