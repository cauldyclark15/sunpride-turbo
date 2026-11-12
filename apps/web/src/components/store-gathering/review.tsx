"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Card, Notice } from "@sunpride/ui";
import { apiFetch, mutate, useApi } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import type { Choice } from "../spec-masters/model";
import {
  addressLine,
  approveBlock,
  candidatePoints,
  capturedWhen,
  changeLine,
  isChange,
  formatDistance,
  mergeCandidates,
  metersBetween,
  reasonWords,
  sourceBadge,
  type Candidate,
  type Capture,
  type PinChoice,
  type Queue,
} from "./model";
import type { Page, Pin, Outlet } from "../master-data/model";

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
      {isChange(capture) && !capture.has_photo ? (
        <span className="h-12 w-12 shrink-0 rounded-md bg-default-soft" />
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element -- protected same-origin photo, no optimizer */
        <img
          src={`/api/v1/masters/census/${capture.id}/photo`}
          alt=""
          loading="lazy"
          className="h-12 w-12 shrink-0 rounded-md bg-default-soft object-cover"
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {capture.name}
        </span>
        <span className="block truncate text-xs text-muted">
          {capture.agent} · {capturedWhen(capture.captured_at, now)}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {isChange(capture) ? (
          <span
            data-testid="capture-change-badge"
            className="rounded-md bg-foreground px-1.5 py-0.5 text-[11px] font-medium text-background"
          >
            Change
          </span>
        ) : (
          <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px]">
            {sourceBadge(capture)}
          </span>
        )}
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
        No similar customers found nearby or with the same phone number.
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
                The agent said this is a different customer.
              </span>
            ) : null}
          </span>
          {onSame && c.kind === "outlet" ? (
            <button type="button" className={button} onClick={() => onSame(c)}>
              Same customer
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
  pinChoice = null,
  onPinChoice,
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
  pinChoice?: PinChoice | null;
  onPinChoice?: (c: PinChoice) => void;
  map?: React.ReactNode;
  onDecision: (d: Decision) => void;
  onSurvivor: (c: Candidate | null) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const outlets = candidates.filter((c) => c.kind === "outlet");
  const blocked =
    decision === "accept" ? approveBlock(capture, pinChoice) : null;
  const gap =
    capture.place_latitude != null &&
    capture.place_longitude != null &&
    capture.device_latitude != null &&
    capture.device_longitude != null
      ? metersBetween(
          capture.device_latitude,
          capture.device_longitude,
          capture.place_latitude,
          capture.place_longitude,
        )
      : null;
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
          <dt className="text-xs text-muted">Channel</dt>
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
          {capture.location_status === "pending" ? (
            <dd className="text-xs text-muted" role="status">
              Checking the address…
            </dd>
          ) : null}
        </div>
      </dl>
      {capture.location_status === "mismatch" ? (
        <div
          role="alert"
          className="grid gap-2 rounded-lg border border-warning bg-warning-soft p-3 text-sm"
        >
          <p className="font-medium text-warning">
            {capture.place_latitude == null
              ? "We could not find the searched address. Check the agent's pin before approving."
              : `The agent's pin is ${formatDistance(gap)} from the searched address. Choose which pin is right.`}
          </p>
          <div
            role="radiogroup"
            aria-label="Pin to keep"
            className="flex flex-wrap gap-2"
          >
            <button
              type="button"
              role="radio"
              aria-checked={pinChoice === "device"}
              className={pinChoice === "device" ? primary : button}
              onClick={() => onPinChoice?.("device")}
            >
              Keep the agent&apos;s pin
            </button>
            {capture.place_latitude != null ? (
              <button
                type="button"
                role="radio"
                aria-checked={pinChoice === "place"}
                className={pinChoice === "place" ? primary : button}
                onClick={() => onPinChoice?.("place")}
              >
                Use the searched address pin
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
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
              ["accept", "Approve as new customer"],
              ["duplicate", "Same as existing customer"],
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
            Customer Code (leave blank to number it automatically)
            <input className={field} name="code" autoComplete="off" />
          </label>
        ) : null}
        {decision === "duplicate" ? (
          <label className="grid gap-1 text-xs">
            Existing customer
            <select
              className={field}
              value={survivor?.id ?? ""}
              onChange={(e) =>
                onSurvivor(outlets.find((c) => c.id === e.target.value) ?? null)
              }
              required
            >
              <option value="">Choose the customer it matches…</option>
              {outlets.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {formatDistance(c.distanceMeters)}
                </option>
              ))}
            </select>
            {!outlets.length ? (
              <span className="text-muted">
                No existing customer matched. Approve or reject instead.
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
                  ? "Same customer as the existing one"
                  : ""
            }
            key={decision}
          />
        </label>
        <div>
          <button
            type="submit"
            className={primary}
            disabled={
              busy ||
              Boolean(blocked) ||
              (decision === "duplicate" && !survivor)
            }
          >
            {decision === "accept"
              ? "Approve as new customer"
              : decision === "duplicate"
                ? "Link to existing customer"
                : "Reject"}
          </button>
          {blocked ? (
            <span className="ml-2 text-xs text-muted">{blocked}</span>
          ) : null}
        </div>
      </fieldset>
    </form>
  );
}

/** Field Edit store: old -> new per field, then Approve (updates the existing store) or Reject. */
export function ChangeDetail({
  capture,
  decision,
  busy,
  pinChoice = null,
  onPinChoice,
  onDecision,
  onSubmit,
  onClose,
}: {
  capture: Capture;
  decision: Decision;
  busy?: boolean;
  pinChoice?: PinChoice | null;
  onPinChoice?: (c: PinChoice) => void;
  onDecision: (d: Decision) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const moved = (capture.changes ?? []).some((c) => c.field === "location");
  const blocked =
    decision === "accept" && moved ? approveBlock(capture, pinChoice) : null;
  const store = capture.target?.name ?? capture.name;
  return (
    <form
      key={capture.id}
      onSubmit={onSubmit}
      data-testid="change-detail"
      className="grid gap-4 rounded-xl border border-border p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">
            Change to {store}
            {capture.target?.code ? (
              <span className="ml-2 text-xs font-normal text-muted">
                {capture.target.code}
              </span>
            ) : null}
          </h3>
          <p className="text-xs text-muted">
            Sent by {capture.agent} · {capturedWhen(capture.captured_at)}
          </p>
        </div>
        <button type="button" className={button} onClick={onClose}>
          Close
        </button>
      </div>
      <table className="w-full text-sm" aria-label="Changes">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th className="py-1 pr-3 font-normal">What</th>
            <th className="py-1 pr-3 font-normal">Now</th>
            <th className="py-1 font-normal">New</th>
          </tr>
        </thead>
        <tbody>
          {(capture.changes ?? []).map((c) => (
            <tr
              key={c.field}
              className="border-t border-border align-top"
              data-testid={`change-${c.field}`}
              aria-label={`${c.label}: ${changeLine(c)}`}
            >
              <td className="py-2 pr-3 text-xs text-muted">{c.label}</td>
              <td className="py-2 pr-3 text-muted line-through">
                {c.old ?? "Not set"}
              </td>
              <td className="py-2 font-medium">{c.new ?? "Not set"}</td>
            </tr>
          ))}
          {!capture.changes?.length ? (
            <tr>
              <td colSpan={3} className="py-2 text-muted">
                The customer already matches this change.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {capture.has_photo ? (
        /* eslint-disable-next-line @next/next/no-img-element -- protected same-origin photo */
        <img
          src={`/api/v1/masters/census/${capture.id}/photo`}
          alt={`New storefront photo of ${store}`}
          className="max-h-60 w-full rounded-xl border border-border object-cover"
        />
      ) : null}
      {moved && capture.location_status === "pending" ? (
        <p className="text-xs text-muted" role="status">
          Checking the address…
        </p>
      ) : null}
      {moved && capture.location_status === "mismatch" ? (
        <div role="radiogroup" aria-label="Pin to keep" className="flex gap-2">
          <button
            type="button"
            role="radio"
            aria-checked={pinChoice === "device"}
            className={pinChoice === "device" ? primary : button}
            onClick={() => onPinChoice?.("device")}
          >
            Keep the agent&apos;s pin
          </button>
          {capture.place_latitude != null ? (
            <button
              type="button"
              role="radio"
              aria-checked={pinChoice === "place"}
              className={pinChoice === "place" ? primary : button}
              onClick={() => onPinChoice?.("place")}
            >
              Use the searched address pin
            </button>
          ) : null}
        </div>
      ) : null}
      <fieldset className="grid gap-3 border-t border-border pt-4">
        <legend className="sr-only">Decision</legend>
        <div role="radiogroup" className="flex flex-wrap gap-2">
          {(
            [
              ["accept", "Approve change"],
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
        <label className="grid gap-1 text-xs">
          {decision === "reject" ? "Why is it rejected?" : "Note"}
          <input
            className={field}
            name="reason"
            required
            defaultValue={decision === "accept" ? "Checked the changes" : ""}
            key={decision}
          />
        </label>
        <div>
          <button
            type="submit"
            className={primary}
            disabled={busy || Boolean(blocked)}
          >
            {decision === "accept" ? "Approve change" : "Reject change"}
          </button>
          {blocked ? (
            <span className="ml-2 text-xs text-muted">{blocked}</span>
          ) : null}
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
  const [pinChoice, setPinChoice] = useState<PinChoice | null>(null);
  const [live, setLive] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<"all" | "flagged" | "changes">("all");
  const rows = useMemo(
    () =>
      (queue.data?.rows ?? []).filter(
        (r) =>
          filter === "all" ||
          (filter === "changes" ? isChange(r) : r.duplicate_flag),
      ),
    [queue.data, filter],
  );
  const selected = queue.data?.rows.find((r) => r.id === selectedId) ?? null;
  useEffect(() => {
    if (!selected || isChange(selected)) return;
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
          ...(decision === "accept" && pinChoice ? { pinChoice } : {}),
          reason: f.get("reason"),
        },
        {
          idempotencyKey: crypto.randomUUID(),
          invalidate: [["masters"], ["stores"]],
        },
      );
      setMessage(
        isChange(selected)
          ? decision === "accept"
            ? `${selected.target?.name ?? selected.name}: change saved to the customer.`
            : `Change to ${selected.target?.name ?? selected.name} was rejected.`
          : decision === "accept"
            ? `${selected.name} is now a customer${result.code ? ` (code ${result.code})` : ""}.`
            : decision === "duplicate"
              ? `${selected.name} was linked to ${survivor?.name ?? "the existing customer"}.`
              : `${selected.name} was rejected.`,
      );
      setSelectedId(null);
      setSurvivor(null);
      setPinChoice(null);
      setDecision("accept");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Review failed.");
    } finally {
      setBusy(false);
    }
  }
  if (!allowed) return null;
  return (
    <Card label="Field customer review">
      {queue.error ? (
        <Notice title={queue.error.message} tone="danger" />
      ) : null}
      <p className="text-sm text-muted">
        New customers and changes to customers your agents sent from the field.
        Check them, then approve or reject. The person who sent one cannot
        review it.
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
            ["changes", "Changes"],
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
                  setPinChoice(null);
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
        {selected && isChange(selected) ? (
          <ChangeDetail
            capture={selected}
            decision={decision}
            busy={busy}
            pinChoice={pinChoice}
            onPinChoice={setPinChoice}
            onDecision={setDecision}
            onSubmit={submit}
            onClose={() => setSelectedId(null)}
          />
        ) : selected ? (
          <CaptureDetail
            capture={selected}
            candidates={candidates}
            decision={decision}
            survivor={survivor}
            busy={busy}
            pinChoice={pinChoice}
            onPinChoice={setPinChoice}
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
                others={[
                  ...candidatePoints(candidates),
                  ...(selected.location_status === "mismatch" &&
                  selected.place_latitude != null &&
                  selected.place_longitude != null
                    ? [
                        {
                          id: "searched-address",
                          latitude: selected.place_latitude,
                          longitude: selected.place_longitude,
                          label: "Searched address",
                        },
                      ]
                    : []),
                ]}
                label={`Where ${selected.name} is`}
                googleKey={GOOGLE_KEY}
              />
            }
          />
        ) : (
          <p className="hidden text-sm text-muted lg:block">
            Choose a customer on the left to review it.
          </p>
        )}
      </div>
      <PinsToConfirm onDone={setMessage} />
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

/** One proposed pin waiting for a second person (office Add store and other proposals). */
export function PinToConfirmRow({
  pin,
  busy,
  onDecide,
}: {
  pin: Pin & { outlet: Outlet };
  busy?: boolean;
  onDecide: (decision: "verified" | "rejected") => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2">
      <span className="min-w-0">
        <span className="block text-sm font-medium">
          {pin.outlet.name}{" "}
          <span className="text-xs font-normal text-muted">
            {pin.outlet.code}
          </span>
        </span>
        <span className="block text-xs text-muted">
          {pin.source === "office" ? "Added from the office" : pin.source} ·{" "}
          <a
            className="underline"
            target="_blank"
            rel="noreferrer"
            href={`https://www.google.com/maps/search/?api=1&query=${pin.latitude},${pin.longitude}`}
          >
            See the pin on a map
          </a>
        </span>
      </span>
      <span className="flex gap-2">
        <button
          type="button"
          className={primary}
          disabled={busy}
          onClick={() => onDecide("verified")}
        >
          Pin is right
        </button>
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => onDecide("rejected")}
        >
          Pin is wrong
        </button>
      </span>
    </li>
  );
}

/** SP-0162: proposed pins (office Add store) confirmed by a different person with outlet.verify. */
function PinsToConfirm({ onDone }: { onDone: (m: string) => void }) {
  const pins = useApi<Page<Pin & { outlet: Outlet }>>(
    ["masters", "pins"],
    "/api/v1/outlets/pins/queue?limit=50",
  );
  const [busy, setBusy] = useState(false);
  const rows = pins.data?.page ?? [];
  if (!rows.length) return null;
  async function decide(
    pin: Pin & { outlet: Outlet },
    decision: "verified" | "rejected",
  ) {
    setBusy(true);
    try {
      await mutate(
        "/api/v1/outlets/pins/decide",
        {
          pinId: pin._id,
          decision,
          reason:
            decision === "verified"
              ? "Pin checked on the map"
              : "Pin is not at the store",
        },
        {
          idempotencyKey: crypto.randomUUID(),
          invalidate: [["masters"], ["stores"]],
        },
      );
      onDone(
        decision === "verified"
          ? `${pin.outlet.name}: pin confirmed.`
          : `${pin.outlet.name}: pin sent back.`,
      );
    } catch (err) {
      onDone(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-4 grid gap-2 border-t border-border pt-4">
      <h4 className="text-sm font-semibold">Pin to confirm</h4>
      <p className="text-xs text-muted">
        Someone else set these map pins. Check each one; the person who set a
        pin cannot confirm it.
      </p>
      <ul className="grid gap-2">
        {rows.map((p) => (
          <PinToConfirmRow
            key={p._id}
            pin={p}
            busy={busy}
            onDecide={(d) => decide(p, d)}
          />
        ))}
      </ul>
    </section>
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
            Save round
          </button>
        </div>
      </form>
    </details>
  );
}
