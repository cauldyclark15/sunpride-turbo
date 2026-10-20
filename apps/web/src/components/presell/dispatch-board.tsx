"use client";

import { useRef, useState } from "react";
import { apiFetch, mutate, useApi, useLive } from "../../lib/api";
import { usePermissions } from "../../lib/auth";

export type DeliveryRow = {
  id: string;
  order_number: string;
  order_status: string;
  outlet_id: string;
  outlet_name: string;
  requested_delivery_date: string;
  confirmed_delivery_date: string | null;
  handoff_id: string | null;
  handoff_status: string | null;
  source: string | null;
  drop_id: string | null;
  run_id: string | null;
  sequence: number | null;
  delivery_status: string | null;
  proof_id: string | null;
  within_sla: boolean | null;
  run_label: string | null;
  truck: string | null;
};
type Counts = {
  drops: number;
  proofs: number;
  withinSla: number;
  exceptions: number;
};
export type DispatchData = {
  date: string;
  targetPercent: number;
  current: Counts;
  prior: Counts;
  priorDate: string;
  trend: (Counts & { date: string })[];
  rows: DeliveryRow[];
  runs: { id: string; trip_id: string; label: string; status: string }[];
};
type Manifest = {
  label: string;
  tripNumber: string;
  status: string;
  serviceDate: string;
  rows: {
    sequence: number;
    store: string;
    address: string;
    order: string;
    deliveryDate: string;
    windowStart: string | null;
    windowEnd: string | null;
    bookingReference: string | null;
    lines: {
      product_code: string;
      description: string;
      ordered_quantity: string;
      uom: string;
      expected_base: string;
    }[];
  }[];
};
type DropDetail = {
  lines: {
    id: string;
    description: string;
    expected_base: string;
    ordered_quantity: string;
    uom: string;
  }[];
  proof: null | {
    receiver_name: string;
    driver_name: string;
    captured_at: string;
    signature: number[][];
    location: { latitude: number; longitude: number };
    lines: {
      lineId: string;
      acceptedBase: number;
      shortBase: number;
      rejectedBase: number;
      damagedBase: number;
      reason: string | null;
    }[];
  };
  variances: { id: string; reason: string; sap_status: string }[];
  slots: {
    id: string;
    label: string;
    starts_at: string;
    ends_at: string;
    capacity: number;
  }[];
  messages: { id: string; channel: string; status: string; attempts: number }[];
};
const field = "rounded-lg border border-border bg-surface px-3 py-2 text-sm";
const button =
  "rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40";
export const deliveryPercent = (c: Counts) =>
  c.drops ? Math.round((100 * c.proofs) / c.drops) : null;
export function deliveryNextAction(r: DeliveryRow) {
  if (r.handoff_status === "cancelled")
    return "Cancelled · source order retained";
  if (r.delivery_status === "variance")
    return "Review door quantities and SAP correction request";
  if (r.proof_id) return "Review signed proof";
  if (!r.confirmed_delivery_date)
    return r.order_status === "approved" || r.order_status === "posted"
      ? "Confirm the delivery day"
      : "Approve the source order first";
  if (r.handoff_status === "failed")
    return "Resolve source order, then retry the handoff";
  if (r.handoff_status === "pending")
    return "Waiting for the SAP handoff adapter";
  if (!r.run_id) return "Assign a truck";
  return "Await driver confirmation";
}
export function DispatchSummary({ data }: { data: DispatchData }) {
  const rate = deliveryPercent(data.current),
    prior = deliveryPercent(data.prior);
  return (
    <section className="grid gap-4" aria-label="Delivery performance">
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ["Planned drops", data.current.drops],
          ["Signed ePOD", rate === null ? "No drops" : `${rate}%`],
          [
            "Within confirmed day",
            `${data.current.withinSla} / ${data.current.drops}`,
          ],
          ["Door / handoff exceptions", data.current.exceptions],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-border p-4">
            <p className="text-xs text-muted">{label}</p>
            <strong className="text-2xl">{value}</strong>
          </div>
        ))}
      </div>
      <p className="text-sm text-muted">
        ePOD target {data.targetPercent}% · Same weekday last week (
        {data.priorDate}): {prior === null ? "No drops" : `${prior}%`} ·{" "}
        {data.prior.drops} drops.
      </p>
      <ol
        className="flex flex-wrap gap-3 text-xs"
        aria-label="Eight-day delivery trend"
      >
        {data.trend.map((d) => (
          <li key={d.date} className="border-l border-border pl-3">
            {d.date}
            <br />
            {d.proofs} / {d.drops} signed
          </li>
        ))}
      </ol>
    </section>
  );
}
export function DriverManifest({ data }: { data: Manifest }) {
  return (
    <section className="grid gap-4" data-driver-manifest>
      <h3 className="text-xl font-semibold">
        {data.label} · {data.serviceDate}
      </h3>
      <p>
        {data.tripNumber} ·{" "}
        {data.status === "planning"
          ? "Planning copy — not released"
          : "Released driver manifest"}
      </p>
      {data.rows.map((row) => (
        <article
          key={row.sequence}
          className="break-inside-avoid border-t border-border py-4"
        >
          <h4 className="font-semibold">
            {row.sequence}. {row.store} · {row.order}
          </h4>
          <p>{row.address}</p>
          <p>
            {row.windowStart
              ? `${new Date(row.windowStart).toLocaleString("en-PH", { timeZone: "Asia/Manila" })} – ${new Date(row.windowEnd!).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila" })}`
              : "No receiving appointment"}{" "}
            {row.bookingReference}
          </p>
          <ul>
            {row.lines.map((l) => (
              <li key={l.product_code}>
                {l.description} · {l.ordered_quantity} {l.uom} (
                {l.expected_base} base pieces)
              </li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}
export function DispatchBoard({ initialDate }: { initialDate?: string }) {
  const permissions = usePermissions(),
    canPlan = permissions.can("van.manage"),
    canConfirm = permissions.can("order.approve");
  const [date, setDate] = useState(
    initialDate ??
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
  );
  const [selected, setSelected] = useState<DeliveryRow | null>(null),
    [manifestRun, setManifestRun] = useState("");
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  // Failed transports retain the exact intent's retry key; a changed form gets a fresh key.
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  const board = useApi<DispatchData>(
    permissions.can("report.read") ? ["delivery", "board", date] : null,
    ({ signal }) =>
      apiFetch("/api/v1/presell/board", { query: { date }, signal }),
  );
  const trips = useApi<{
    rows: {
      tripId: string;
      tripNumber: string;
      truck: string;
      seller: string;
    }[];
  }>(canPlan ? ["van", "trips", date] : null, ({ signal }) =>
    apiFetch("/api/v1/van/trips", { query: { date }, signal }),
  );
  const detail = useApi<DropDetail>(
    selected?.drop_id ? ["delivery", "drop", selected.drop_id] : null,
    ({ signal }) =>
      apiFetch("/api/v1/presell/drop", {
        query: { dropId: selected?.drop_id },
        signal,
      }),
  );
  const manifest = useApi<Manifest>(
    manifestRun ? ["delivery", "manifest", manifestRun] : null,
    ({ signal }) =>
      apiFetch("/api/v1/presell/manifest", {
        query: { runId: manifestRun },
        signal,
      }),
  );
  useLive(["delivery", "orders"], [["delivery"]]);
  async function act(action: string, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const fingerprint = JSON.stringify({ action, body });
    const key =
      pending.current?.fingerprint === fingerprint
        ? pending.current.key
        : crypto.randomUUID();
    pending.current = { fingerprint, key };
    try {
      await mutate(
        `/api/v1/presell/${action}`,
        { ...body, idempotencyKey: key },
        { invalidate: [["delivery"]] },
      );
      pending.current = null;
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not save. Retry the same action.",
      );
    } finally {
      setBusy(false);
    }
  }
  function form(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    return Object.fromEntries(new FormData(event.currentTarget));
  }
  const rows = board.data?.rows ?? [],
    runs = board.data?.runs ?? [];
  return (
    <main className="grid gap-6" aria-label="Pre-sell dispatch planner">
      <header className="flex flex-wrap items-end justify-between gap-4 print:hidden">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted">
            Pre-sell → delivery
          </p>
          <h2 className="text-2xl font-semibold">
            Which deliveries need action?
          </h2>
        </div>
        <label className="text-sm">
          Manila delivery day
          <input
            aria-label="Delivery day"
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setSelected(null);
              setManifestRun("");
            }}
            className={field}
          />
        </label>
      </header>
      <p className="text-sm text-muted print:hidden">
        Confirmed orders become drops through a durable SAP handoff. Sample
        adapter only — no real SAP posting or customer messages.
      </p>
      {error && <p role="alert">{error}</p>}
      {board.error ? (
        <p role="alert">
          {board.error.message}
          <button onClick={() => void board.refetch()} className={button}>
            Try again
          </button>
        </p>
      ) : board.data ? (
        <DispatchSummary data={board.data} />
      ) : (
        <p>Loading delivery plan…</p>
      )}
      {canPlan && (
        <form
          onSubmit={(e) => {
            const p = form(e);
            void act("createRun", { tripId: p.tripId, label: p.label });
          }}
          className="flex flex-wrap items-end gap-3 print:hidden"
        >
          <label>
            Truck trip
            <select
              required
              name="tripId"
              className={field}
              aria-label="Truck trip"
            >
              <option value="">Choose truck and driver</option>
              {trips.data?.rows.map((t) => (
                <option key={t.tripId} value={t.tripId}>
                  {t.truck} · {t.seller} · {t.tripNumber}
                </option>
              ))}
            </select>
          </label>
          <label>
            Run name
            <input
              required
              name="label"
              className={field}
              maxLength={100}
              placeholder="Cebu morning deliveries"
            />
          </label>
          <button disabled={busy} className={button}>
            Create delivery run
          </button>
        </form>
      )}
      <section
        className="grid gap-3 print:hidden"
        aria-label="Delivery exceptions and orders"
      >
        <h3 className="font-semibold">
          Orders and next actions · seven days before and after this day
        </h3>
        {!rows.length && board.data && (
          <p>
            No pre-sell orders in this fortnight. Capture an order using the
            pre-sell channel, approve it, then confirm a delivery day.
          </p>
        )}
        {[...rows]
          .sort(
            (a, b) =>
              Number(
                b.delivery_status === "variance" ||
                  b.handoff_status === "failed",
              ) -
              Number(
                a.delivery_status === "variance" ||
                  a.handoff_status === "failed",
              ),
          )
          .map((r) => (
            <article key={r.id} className="rounded-xl border border-border p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <div>
                  <strong>{r.outlet_name}</strong>
                  <p className="text-sm">
                    {r.order_number} · Requested {r.requested_delivery_date} ·{" "}
                    {r.confirmed_delivery_date
                      ? `Confirmed ${r.confirmed_delivery_date}`
                      : "Not confirmed"}
                  </p>
                  <p className="text-sm text-muted">
                    {deliveryNextAction(r)}
                    {r.run_label
                      ? ` · ${r.run_label} · Stop ${r.sequence}`
                      : ""}
                  </p>
                </div>
                {r.drop_id && (
                  <button className={button} onClick={() => setSelected(r)}>
                    Open drop and proof
                  </button>
                )}
              </div>
              {!r.confirmed_delivery_date &&
                canConfirm &&
                ["approved", "posted"].includes(r.order_status) && (
                  <form
                    className="mt-3 flex flex-wrap gap-2"
                    onSubmit={(e) => {
                      const p = form(e);
                      void act("confirm", {
                        orderId: r.id,
                        confirmedDeliveryDate: p.day,
                        reason: p.reason,
                      });
                    }}
                  >
                    <input
                      required
                      aria-label={`Confirmed day for ${r.order_number}`}
                      type="date"
                      name="day"
                      defaultValue={r.requested_delivery_date}
                      className={field}
                    />
                    <input
                      required
                      name="reason"
                      placeholder="Buyer confirmation reference"
                      className={field}
                    />
                    <button disabled={busy} className={button}>
                      Confirm and release order
                    </button>
                  </form>
                )}
              {canPlan &&
                r.handoff_status === "acknowledged" &&
                !r.run_id &&
                r.drop_id && (
                  <form
                    className="mt-3 flex gap-2"
                    onSubmit={(e) => {
                      const p = form(e);
                      void act("schedule", {
                        dropId: r.drop_id,
                        runId: p.runId,
                      });
                    }}
                  >
                    <select
                      required
                      name="runId"
                      aria-label="Delivery run"
                      className={field}
                    >
                      <option value="">Assign truck run</option>
                      {runs
                        .filter((run) => run.status === "planning")
                        .map((run) => (
                          <option key={run.id} value={run.id}>
                            {run.label}
                          </option>
                        ))}
                    </select>
                    <button disabled={busy} className={button}>
                      Assign drop
                    </button>
                  </form>
                )}
              {canPlan && r.handoff_status === "failed" && (
                <button
                  disabled={busy}
                  className={button}
                  onClick={() =>
                    void act("retryHandoff", { handoffId: r.handoff_id })
                  }
                >
                  Retry handoff
                </button>
              )}
            </article>
          ))}
      </section>
      <section
        className="grid gap-4 print:hidden"
        aria-label="Truck sequencing"
      >
        {runs.map((run) => {
          const stops = rows
            .filter((r) => r.run_id === run.id)
            .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
          return (
            <article
              key={run.id}
              className="rounded-xl border border-border p-4"
            >
              <h3 className="font-semibold">
                {run.label} ·{" "}
                {run.status === "planning" ? "Planning" : "Released"}
              </h3>
              <ol>
                {stops.map((r, i) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-2 py-2"
                  >
                    {i + 1}. {r.outlet_name} · {r.order_number}
                    {canPlan && run.status === "planning" && i > 0 && (
                      <button
                        disabled={busy}
                        className={button}
                        onClick={() => {
                          const ids = stops.map((s) => s.drop_id);
                          [ids[i - 1], ids[i]] = [ids[i]!, ids[i - 1]!];
                          void act("sequence", { runId: run.id, dropIds: ids });
                        }}
                      >
                        Move earlier
                      </button>
                    )}
                  </li>
                ))}
              </ol>
              <div className="flex gap-2">
                {canPlan && run.status === "planning" && (
                  <button
                    disabled={busy || !stops.length}
                    className={button}
                    onClick={() => void act("releaseRun", { runId: run.id })}
                  >
                    Release to driver
                  </button>
                )}
                <button
                  className={button}
                  onClick={() => setManifestRun(run.id)}
                >
                  Open driver manifest
                </button>
              </div>
            </article>
          );
        })}
      </section>
      {manifest.error && <p role="alert">{manifest.error.message}</p>}
      {manifest.data && (
        <div>
          <div className="print:hidden flex gap-3">
            <a
              className={button}
              href={`/api/v1/presell/manifest?runId=${manifestRun}&format=html`}
              target="_blank"
              rel="noreferrer"
            >
              Print driver manifest
            </a>
            <button className={button} onClick={() => setManifestRun("")}>
              Close manifest
            </button>
          </div>
          <DriverManifest data={manifest.data} />
        </div>
      )}
      {selected && (
        <section
          className="grid gap-4 rounded-xl border border-border p-5 print:hidden"
          aria-label="Delivery detail"
        >
          <h3 className="text-xl font-semibold">
            {selected.outlet_name} · {selected.order_number}
          </h3>
          <button className={button} onClick={() => setSelected(null)}>
            Close drop
          </button>
          {detail.error && <p role="alert">{detail.error.message}</p>}
          {detail.data && (
            <>
              <ul>
                {detail.data.lines.map((l) => (
                  <li key={l.id}>
                    {l.description} · {l.ordered_quantity} {l.uom} (
                    {l.expected_base} base pieces)
                  </li>
                ))}
              </ul>
              {detail.data.proof ? (
                <>
                  <p>
                    Received by {detail.data.proof.receiver_name} · Delivered by{" "}
                    {detail.data.proof.driver_name} ·{" "}
                    {new Date(detail.data.proof.captured_at).toLocaleString(
                      "en-PH",
                      { timeZone: "Asia/Manila" },
                    )}
                  </p>
                  <svg
                    viewBox="0 0 300 120"
                    aria-label="Receiver signature"
                    className="max-w-sm border border-border"
                  >
                    <polyline
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      points={detail.data.proof.signature
                        .map(([x, y]) => `${x! * 300},${y! * 120}`)
                        .join(" ")}
                    />
                  </svg>
                  <a
                    className="underline"
                    href={`/api/v1/presell/photo?dropId=${selected.drop_id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open original watermarked delivery photo
                  </a>
                  <p>
                    Geo stamp {detail.data.proof.location.latitude.toFixed(5)},{" "}
                    {detail.data.proof.location.longitude.toFixed(5)}
                  </p>
                  {detail.data.proof.lines.map((l) => (
                    <p key={l.lineId}>
                      Accepted {l.acceptedBase} · Short {l.shortBase} · Rejected{" "}
                      {l.rejectedBase} · Damaged {l.damagedBase} pieces
                      {l.reason ? ` · ${l.reason.replaceAll("_", " ")}` : ""}
                    </p>
                  ))}
                  {detail.data.variances.map((v) => (
                    <p key={v.id}>
                      Correction request · {v.reason.replaceAll("_", " ")} ·{" "}
                      {v.sap_status === "mock_acknowledged"
                        ? "Mock SAP acknowledged — not posted"
                        : "Pending SAP"}
                    </p>
                  ))}
                </>
              ) : (
                <p>
                  No signed proof has reached the office. The phone may still be
                  offline.
                </p>
              )}
              {canPlan && (
                <>
                  <form
                    className="flex flex-wrap gap-2"
                    onSubmit={(e) => {
                      const p = form(e);
                      void act("slot", {
                        outletId: selected.outlet_id,
                        label: p.label,
                        startsAt: Date.parse(String(p.start) + "+08:00"),
                        endsAt: Date.parse(String(p.end) + "+08:00"),
                        capacity: Number(p.capacity),
                      });
                    }}
                  >
                    <input
                      required
                      name="label"
                      placeholder="Receiving slot name"
                      className={field}
                    />
                    <label>
                      Starts (Manila)
                      <input
                        required
                        name="start"
                        type="datetime-local"
                        className={field}
                      />
                    </label>
                    <label>
                      Ends (Manila)
                      <input
                        required
                        name="end"
                        type="datetime-local"
                        className={field}
                      />
                    </label>
                    <label>
                      Capacity
                      <input
                        required
                        name="capacity"
                        type="number"
                        min="1"
                        max="50"
                        defaultValue="1"
                        className={field}
                      />
                    </label>
                    <button disabled={busy} className={button}>
                      Add unloading slot
                    </button>
                  </form>
                  <form
                    className="flex flex-wrap gap-2"
                    onSubmit={(e) => {
                      const p = form(e);
                      void act("book", {
                        dropId: selected.drop_id,
                        slotId: p.slot,
                        bookingReference: p.reference,
                      });
                    }}
                  >
                    <select
                      required
                      name="slot"
                      aria-label="Receiving slot"
                      className={field}
                    >
                      <option value="">Choose receiving slot</option>
                      {detail.data.slots.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label} ·{" "}
                          {new Date(s.starts_at).toLocaleString("en-PH", {
                            timeZone: "Asia/Manila",
                          })}{" "}
                          · Capacity {s.capacity}
                        </option>
                      ))}
                    </select>
                    <input
                      required
                      name="reference"
                      placeholder="Appointment reference"
                      className={field}
                    />
                    <button disabled={busy} className={button}>
                      Book appointment
                    </button>
                  </form>
                  <form
                    className="flex flex-wrap gap-2"
                    onSubmit={(e) => {
                      const p = form(e);
                      void act("eta", {
                        dropId: selected.drop_id,
                        eta: Date.parse(String(p.eta) + "+08:00"),
                        channel: p.channel,
                        recipient: p.recipient,
                        consent: p.consent === "on",
                      });
                    }}
                  >
                    <label>
                      ETA (Manila)
                      <input
                        required
                        name="eta"
                        type="datetime-local"
                        className={field}
                      />
                    </label>
                    <select
                      name="channel"
                      aria-label="Message channel"
                      className={field}
                    >
                      <option value="sms">Mock SMS</option>
                      <option value="email">Mock email</option>
                    </select>
                    <input
                      required
                      name="recipient"
                      placeholder="Consenting recipient"
                      className={field}
                    />
                    <label>
                      <input type="checkbox" required name="consent" />
                      Recipient consent recorded
                    </label>
                    <button disabled={busy} className={button}>
                      Queue ETA message
                    </button>
                  </form>
                </>
              )}
              {detail.data.messages.map((m) => (
                <p key={m.id}>
                  ETA {m.channel.toUpperCase()} ·{" "}
                  {m.status === "sent"
                    ? "Delivered to dev sink only"
                    : m.status}{" "}
                  · {m.attempts} adapter attempts
                </p>
              ))}
            </>
          )}
        </section>
      )}
      {permissions.can("admin.manage") && (
        <DeliveryPolicyEditor busy={busy} act={act} />
      )}
    </main>
  );
}
function DeliveryPolicyEditor({
  busy,
  act,
}: {
  busy: boolean;
  act: (action: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const settings = useApi<{
    policies: {
      id: string;
      label: string;
      source: string;
      version: number;
      cutoff_minute: number;
      lead_days: number;
      horizon_days: number;
      sla_days: number;
      epod_target_percent: number;
    }[];
  }>(["delivery", "settings"], "/api/v1/presell/settings");
  return (
    <details className="rounded-xl border border-border p-4 print:hidden">
      <summary>Delivery cut-off, SLA and variance policy</summary>
      {settings.error && <p role="alert">{settings.error.message}</p>}
      {settings.data?.policies.map((p) => (
        <p key={p.id} className="text-sm">
          {p.label} · Version {p.version} ·{" "}
          {p.source === "sample" ? "Sample policy" : "Office publication"} ·
          Cut-off {String(Math.floor(p.cutoff_minute / 60)).padStart(2, "0")}:
          {String(p.cutoff_minute % 60).padStart(2, "0")} Manila · Lead{" "}
          {p.lead_days} days · SLA {p.sla_days} days · Target{" "}
          {p.epod_target_percent}%
        </p>
      ))}
      <form
        className="mt-4 grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          const p = Object.fromEntries(new FormData(e.currentTarget));
          const [hh, mm] = String(p.cutoff).split(":").map(Number);
          void act("publishPolicy", {
            label: p.label,
            effectiveFrom: Date.parse(String(p.from) + "+08:00"),
            cutoffMinute: hh! * 60 + mm!,
            leadDays: Number(p.lead),
            horizonDays: Number(p.horizon),
            slaDays: Number(p.sla),
            epodTargetPercent: Number(p.target),
            varianceReasons: String(p.reasons)
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const [code, ...label] = line.split("|");
                return { code, label: label.join("|") };
              }),
          });
        }}
      >
        <label>
          Policy label
          <input
            required
            name="label"
            defaultValue="Next-day delivery"
            className={field}
          />
        </label>
        <label>
          Effective from (Manila)
          <input required name="from" type="datetime-local" className={field} />
        </label>
        <label>
          Order cut-off
          <input
            required
            name="cutoff"
            type="time"
            defaultValue="14:00"
            className={field}
          />
        </label>
        <label>
          Minimum lead days
          <input
            required
            name="lead"
            type="number"
            min="0"
            max="30"
            defaultValue="1"
            className={field}
          />
        </label>
        <label>
          Latest requested day
          <input
            required
            name="horizon"
            type="number"
            min="1"
            max="90"
            defaultValue="30"
            className={field}
          />
        </label>
        <label>
          SLA days after request
          <input
            required
            name="sla"
            type="number"
            min="0"
            max="90"
            defaultValue="2"
            className={field}
          />
        </label>
        <label>
          Signed ePOD target %
          <input
            required
            name="target"
            type="number"
            min="1"
            max="100"
            defaultValue="98"
            className={field}
          />
        </label>
        <label>
          Door reasons · code|label per line
          <textarea
            required
            name="reasons"
            defaultValue={
              "not_loaded|Short loaded quantity\nbuyer_rejected|Buyer refused goods\ndamaged_at_door|Damage at delivery"
            }
            className={field}
          />
        </label>
        <button disabled={busy} className={button}>
          Publish future policy
        </button>
      </form>
    </details>
  );
}
