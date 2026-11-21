"use client";

import { useState } from "react";
import { Card, FormField, Notice } from "@sunpride/ui";
import { mutate, useApi, useLive } from "../../lib/api";
import { formatDateTime, formatPeriod, manilaDay } from "../../lib/format";
import {
  STATUS_LABELS,
  addDays,
  mondayOf,
  shiftWeek,
  varianceText,
  weekSaveBody,
  type DraftLine,
  type TruckWeek,
  type TruckWeekList,
} from "./weekly-truck-stock-model";

const button =
  "rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50";
const control =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm";

/** SP-0227 office screen: request vs served per salesman-week, then the Saturday reconciliation. */
export function WeeklyTruckStock() {
  const [week, setWeek] = useState(() =>
    mondayOf(manilaDay(Date.now()) ?? "2026-01-05"),
  );
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<TruckWeek | "new" | null>(null);
  const list = useApi<TruckWeekList>(
    ["truck-weeks", week],
    `/api/v1/truck-weeks?weekStart=${week}`,
  );
  useLive(["van"], [["truck-weeks"]]);
  return (
    <Card label="Weekly truck stock">
      <div className="grid gap-4" aria-label="Weekly truck stock">
        <p>
          Record what each salesman asked for and what the warehouse actually
          loaded. On Saturday the salesman counts what is left in the Field app.
          The cashier counts him for what was actually loaded: loaded − sold −
          counted = difference, each with a reason.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className={button}
            onClick={() => setWeek(shiftWeek(week, -1))}
          >
            Previous week
          </button>
          <strong>{formatPeriod(week, addDays(week, 5))}</strong>
          <button
            className={button}
            onClick={() => setWeek(shiftWeek(week, 1))}
          >
            Next week
          </button>
          <a
            className={button}
            href={`/api/v1/truck-weeks?weekStart=${week}&format=csv`}
          >
            Download CSV
          </a>
          {list.data?.canManage && (
            <button
              className={button}
              onClick={() => {
                setEditing("new");
                setOpen(null);
              }}
            >
              Add salesman stock
            </button>
          )}
        </div>
        {list.error ? (
          <Notice title={list.error.message} tone="danger" />
        ) : !list.data ? (
          <p>Loading truck stock…</p>
        ) : (
          <>
            {!list.data.rows.length && (
              <p>No truck stock recorded for this week yet.</p>
            )}
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th>Salesman</th>
                  <th>Status</th>
                  <th className="text-right">Requested</th>
                  <th className="text-right">Loaded</th>
                  <th className="text-right">Short</th>
                  <th className="text-right">Sold</th>
                  <th className="text-right">Counted</th>
                  <th className="text-right">Difference</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.rows.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td>{r.seller}</td>
                    <td>
                      {STATUS_LABELS[r.status]}
                      {r.totals.missingReasons > 0 &&
                        ` · ${r.totals.missingReasons} without reason`}
                    </td>
                    <td className="text-right">{r.totals.requestedBase}</td>
                    <td className="text-right">{r.totals.servedBase}</td>
                    <td className="text-right">{r.totals.shortfallBase}</td>
                    <td className="text-right">{r.totals.soldBase}</td>
                    <td className="text-right">
                      {r.totals.countedBase ?? "—"}
                    </td>
                    <td className="text-right">
                      {varianceText(r.totals.varianceBase)}
                    </td>
                    <td>
                      <button
                        className={button}
                        onClick={() => {
                          setOpen(r.id);
                          setEditing(null);
                        }}
                      >
                        Open {r.seller}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {editing && (
              <WeekForm
                key={editing === "new" ? "new" : editing.updatedAt}
                week={week}
                list={list.data}
                current={editing === "new" ? undefined : editing}
                onDone={(id) => {
                  setEditing(null);
                  if (id) setOpen(id);
                }}
              />
            )}
            {open && !editing && (
              <WeekDetail
                id={open}
                canManage={list.data.canManage}
                onEdit={(w) => setEditing(w)}
              />
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function WeekDetail({
  id,
  canManage,
  onEdit,
}: {
  id: string;
  canManage: boolean;
  onEdit: (w: TruckWeek) => void;
}) {
  const detail = useApi<TruckWeek>(
    ["truck-weeks", "detail", id],
    `/api/v1/truck-weeks?id=${id}`,
  );
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  if (detail.error)
    return <Notice title={detail.error.message} tone="danger" />;
  if (!detail.data) return <p>Loading salesman stock…</p>;
  const w = detail.data;
  async function review() {
    setBusy(true);
    setMessage("");
    try {
      await mutate(
        "/api/v1/truck-weeks/review",
        { id: w.id, baseUpdatedAt: w.updatedAt, note },
        { idempotencyKey: key, invalidate: [["truck-weeks"]] },
      );
      setMessage("Week checked and closed.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="grid gap-3 border-t border-border pt-4">
      <h3 className="font-semibold">
        {w.seller} · {STATUS_LABELS[w.status]}
      </h3>
      {w.countedAt !== null && <p>Counted {formatDateTime(w.countedAt)}</p>}
      {w.reviewedAt !== null && (
        <p>
          Checked {formatDateTime(w.reviewedAt)}
          {w.reviewNote ? ` · ${w.reviewNote}` : ""}
        </p>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted">
            <th>Product</th>
            <th className="text-right">Requested</th>
            <th className="text-right">Loaded</th>
            <th className="text-right">Short</th>
            <th className="text-right">Sold</th>
            <th className="text-right">Should be left</th>
            <th className="text-right">Counted</th>
            <th className="text-right">Difference</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {w.lines.map((l) => (
            <tr key={l.productId} className="border-t border-border">
              <td>
                {l.name}
                <span className="block text-xs text-muted">
                  {l.code} · {l.uom}
                </span>
              </td>
              <td className="text-right">{l.requestedBase}</td>
              <td className="text-right">{l.servedBase}</td>
              <td className="text-right">{l.shortfallBase}</td>
              <td className="text-right">{l.soldBase}</td>
              <td className="text-right">{l.expectedLeftBase}</td>
              <td className="text-right">{l.countedBase ?? "—"}</td>
              <td className="text-right">{varianceText(l.varianceBase)}</td>
              <td>
                {l.reasonName ?? (l.needsReason ? "No reason given" : "—")}
                {l.note && (
                  <span className="block text-xs text-muted">{l.note}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Total difference: {varianceText(w.totals.varianceBase)}. Positive
        differences are stock not accounted for.
      </p>
      <div className="flex flex-wrap gap-2">
        <a
          className={button}
          href={`/api/v1/truck-weeks?id=${w.id}&format=csv`}
        >
          Download CSV
        </a>
        {canManage && w.status !== "reviewed" && (
          <button className={button} onClick={() => onEdit(w)}>
            Edit requested and loaded
          </button>
        )}
      </div>
      {canManage && w.status === "counted" && (
        <div className="grid gap-2">
          <FormField label="Office note (needed if a difference has no reason)">
            <input
              className={control}
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
          </FormField>
          <button className={button} disabled={busy} onClick={review}>
            Mark checked and close week
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

function WeekForm({
  week,
  list,
  current,
  onDone,
}: {
  week: string;
  list: TruckWeekList;
  current?: TruckWeek;
  onDone: (id?: string) => void;
}) {
  const [seller, setSeller] = useState(current?.salespersonProfileId ?? "");
  const [lines, setLines] = useState<DraftLine[]>(
    current
      ? current.lines
          .filter((l) => l.servedBase > 0 || l.requestedBase > 0)
          .map((l) => ({
            productId: l.productId,
            requested: String(l.requestedBase),
            served: String(l.servedBase),
          }))
      : [{ productId: "", requested: "", served: "" }],
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string>();
  const taken = new Set(list.rows.map((r) => r.salespersonProfileId));
  const set = (i: number, patch: Partial<DraftLine>) => {
    setKey(undefined);
    setLines((all) => all.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  };
  async function save() {
    const built = weekSaveBody(seller, week, lines, current?.updatedAt);
    if (!built.ok) return setError(built.error);
    const k = key ?? crypto.randomUUID();
    setKey(k);
    setBusy(true);
    setError("");
    try {
      const result = await mutate<{ id: string }>(
        "/api/v1/truck-weeks/save",
        built.body,
        { idempotencyKey: k, invalidate: [["truck-weeks"]] },
      );
      onDone(result.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="grid gap-3 border-t border-border pt-4">
      <h3 className="font-semibold">
        {current ? `Edit ${current.seller}` : "Add salesman stock"}
      </h3>
      <FormField label="Salesman">
        <select
          className={control}
          value={seller}
          disabled={!!current}
          onChange={(e) => {
            setSeller(e.target.value);
            setKey(undefined);
          }}
        >
          <option value="">Choose…</option>
          {list.sellers
            .filter((s) => s.id === seller || !taken.has(s.id))
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      </FormField>
      {lines.map((l, i) => (
        <div key={i} className="grid gap-2 md:grid-cols-[2fr_1fr_1fr_auto]">
          <FormField label="Product">
            <select
              className={control}
              value={l.productId}
              onChange={(e) => set(i, { productId: e.target.value })}
            >
              <option value="">Choose…</option>
              {list.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.code}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Requested">
            <input
              className={control}
              inputMode="numeric"
              value={l.requested}
              onChange={(e) => set(i, { requested: e.target.value })}
            />
          </FormField>
          <FormField label="Actually loaded">
            <input
              className={control}
              inputMode="numeric"
              value={l.served}
              onChange={(e) => set(i, { served: e.target.value })}
            />
          </FormField>
          <button
            className={button}
            onClick={() => {
              setKey(undefined);
              setLines((all) => all.filter((_, n) => n !== i));
            }}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button
          className={button}
          onClick={() =>
            setLines((all) => [
              ...all,
              { productId: "", requested: "", served: "" },
            ])
          }
        >
          Add product
        </button>
        <button className={button} disabled={busy} onClick={save}>
          Save
        </button>
        <button className={button} onClick={() => onDone()}>
          Cancel
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
