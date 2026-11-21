"use client";

import { useState, type FormEvent } from "react";
import { apiFetch, useApi, useLive, useMutate } from "../lib/api";
import { countOf } from "../lib/format";
import type { SlotInput, StoreWork } from "./coverage-model";

type Activity = { activityId: string; name: string; active: boolean };
type Routine = {
  routineId: string;
  name: string;
  activityIds: string[];
  active: boolean;
};
export type StoreWorkCatalog = {
  canManage: boolean;
  activities: Activity[];
  routines: Routine[];
};
const button = "rounded-lg border border-border px-3 py-2 disabled:opacity-50";
export function useStoreWorkCatalog(enabled = true) {
  const query = useApi<StoreWorkCatalog>(
    enabled ? ["store-work"] : null,
    ({ signal }) => apiFetch("/api/v1/store-work/catalog", { signal }),
  );
  useLive(enabled ? ["coverage"] : null, [["store-work"]]);
  return query;
}

export function StoreWorkAdmin() {
  const { data, error } = useStoreWorkCatalog();
  const { mutate } = useMutate();
  const [editing, setEditing] = useState<{
    kind: "activity" | "routine";
    id?: string;
    name: string;
    active: boolean;
    activityIds: string[];
  } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setMessage("");
    try {
      await mutate(
        `/api/v1/store-work/${editing.kind}`,
        { ...editing, reason: String(form.get("reason") ?? "") },
        { invalidate: [["store-work"]] },
      );
      setEditing(null);
      setMessage(
        "Saved. Choose this routine or its activities when planning a customer stop.",
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="grid gap-4" aria-label="Activities and routines">
      <h2 className="text-lg font-semibold">Activities and routines</h2>
      <p>
        What should the salesman do at each stop? Keep the office activity list
        here, then group activities into reusable routines. Approved stops keep
        the names and activities that were agreed at the time.
      </p>
      <p>
        Start with the office&apos;s standard activity list. Collection, Countering and
        Count stock are examples, not a supplied master list. A tick records
        what the salesman says he did; it does not replace a collection receipt
        or a stock count.
      </p>
      {error && <p role="alert">{error.message}</p>}
      {!data && !error && <p>Loading activities…</p>}
      {data?.canManage && (
        <div className="flex flex-wrap gap-2">
          {(["activity", "routine"] as const).map((kind) => (
            <button
              key={kind}
              className={button}
              onClick={() =>
                setEditing({ kind, name: "", active: true, activityIds: [] })
              }
            >
              Add {kind}
            </button>
          ))}
        </div>
      )}
      {editing && data?.canManage && (
        <form
          onSubmit={save}
          className="grid gap-3 rounded border border-border p-3"
        >
          <h3>
            {editing.id ? "Edit" : "New"} {editing.kind}
          </h3>
          <label>
            Name
            <input
              aria-label="Activity or routine name"
              required
              maxLength={200}
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={editing.active}
              onChange={(e) =>
                setEditing({ ...editing, active: e.target.checked })
              }
            />
            Active
          </label>
          {editing.kind === "routine" && (
            <fieldset>
              <legend>Activities in this routine</legend>
              {data.activities.map((a) => (
                <label
                  key={a.activityId}
                  className="flex items-center gap-2 py-1"
                >
                  <input
                    type="checkbox"
                    checked={editing.activityIds.includes(a.activityId)}
                    disabled={
                      !a.active && !editing.activityIds.includes(a.activityId)
                    }
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        activityIds: e.target.checked
                          ? [...editing.activityIds, a.activityId]
                          : editing.activityIds.filter(
                              (id) => id !== a.activityId,
                            ),
                      })
                    }
                  />
                  {a.name}
                  {!a.active && " (inactive)"}
                </label>
              ))}
            </fieldset>
          )}
          <label>
            Reason for this change
            <input name="reason" required maxLength={500} />
          </label>
          <div className="flex gap-2">
            <button className={button} disabled={busy}>
              Save {editing.kind}
            </button>
            <button
              className={button}
              type="button"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section>
            <h3 className="font-semibold">Store activities</h3>
            {!data.activities.length && (
              <p>No activities yet. Add the office&apos;s first activity.</p>
            )}
            <ul>
              {data.activities.map((a) => (
                <li
                  key={a.activityId}
                  className="flex items-center justify-between gap-2 border-b border-border py-2"
                >
                  <span>
                    {a.name}
                    {!a.active && " · Inactive"}
                  </span>
                  {data.canManage && (
                    <button
                      className={button}
                      onClick={() =>
                        setEditing({
                          kind: "activity",
                          id: a.activityId,
                          name: a.name,
                          active: a.active,
                          activityIds: [],
                        })
                      }
                    >
                      Edit
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3 className="font-semibold">Reusable routines</h3>
            {!data.routines.length && (
              <p>No routines yet. Group activities you often plan together.</p>
            )}
            <ul>
              {data.routines.map((r) => (
                <li
                  key={r.routineId}
                  className="grid gap-2 border-b border-border py-2"
                >
                  <strong>
                    {r.name}
                    {!r.active && " · Inactive"}
                  </strong>
                  <p>
                    {r.activityIds
                      .map(
                        (id) =>
                          data.activities.find((a) => a.activityId === id)
                            ?.name ?? "Unavailable activity",
                      )
                      .join(", ")}
                  </p>
                  {data.canManage && (
                    <button
                      className={button}
                      onClick={() =>
                        setEditing({
                          kind: "routine",
                          id: r.routineId,
                          name: r.name,
                          active: r.active,
                          activityIds: r.activityIds,
                        })
                      }
                    >
                      Edit routine
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
      {data && !data.canManage && (
        <p>The national office maintains this shared list.</p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

export function changeStopWork(
  slot: SlotInput,
  catalog: StoreWorkCatalog,
  routineId: string | undefined,
  extras: string[],
): SlotInput {
  const routine = catalog.routines.find((r) => r.routineId === routineId);
  const ids = [...new Set([...(routine?.activityIds ?? []), ...extras])];
  return {
    ...slot,
    storeWork: {
      routineId,
      routineName: routine?.name,
      routineActivityIds: routine?.activityIds,
      activityIds: extras,
      activities: ids.map((activityId) => ({
        activityId,
        name:
          catalog.activities.find((a) => a.activityId === activityId)?.name ??
          "Unavailable activity",
      })),
    },
  };
}

export function StopWorkPlanner({
  slots,
  onChange,
  readOnly,
  nameFor,
}: {
  slots: SlotInput[];
  onChange: (slots: SlotInput[]) => void;
  readOnly: boolean;
  nameFor: (id: string) => string;
}) {
  const { data, error } = useStoreWorkCatalog(!readOnly);
  return (
    <section aria-label="Activities at each stop" className="grid gap-3">
      <h3 className="font-semibold">Activities at each stop</h3>
      <p>
        {readOnly
          ? "Store activities agreed for each dated visit. Changes need a new plan revision and approval."
          : "Choose a routine or individual activities for each dated visit. Save dated slots below, then submit the plan for approval."}
      </p>
      {error && <p role="alert">{error.message}</p>}
      {!readOnly && data && !data.activities.some((a) => a.active) && (
        <p>
          Add activities in Setup &gt; Field work &gt; Activities and routines
          first.
        </p>
      )}
      {slots
        .filter((s) => s.kind === "outlet_visit")
        .map((s) => {
          const work: StoreWork = s.storeWork ?? { activities: [] };
          const routine = data?.routines.find(
            (r) => r.routineId === work.routineId,
          );
          const extras = work.activityIds ?? [];
          const update = (
            routineId: string | undefined,
            activityIds: string[],
          ) =>
            data &&
            onChange(
              slots.map((row) =>
                row.slotKey === s.slotKey
                  ? changeStopWork(row, data, routineId, activityIds)
                  : row,
              ),
            );
          return (
            <details
              key={s.slotKey}
              className="rounded border border-border p-3"
            >
              <summary>
                {s.serviceDate} · {nameFor(s.outletId!)} ·{" "}
                {countOf(work.activities.length, "activity", "activities")}
              </summary>
              {!readOnly && data ? (
                <div className="grid gap-2 py-2">
                  <label>
                    Routine
                    <select
                      aria-label={`Routine ${s.slotKey}`}
                      value={work.routineId ?? ""}
                      onChange={(e) =>
                        update(e.target.value || undefined, extras)
                      }
                    >
                      <option value="">Individual activities only</option>
                      {work.routineId &&
                        !data.routines.some(
                          (r) => r.active && r.routineId === work.routineId,
                        ) && (
                          <option value={work.routineId}>
                            {work.routineName} (inactive)
                          </option>
                        )}
                      {data.routines
                        .filter((r) => r.active)
                        .map((r) => (
                          <option key={r.routineId} value={r.routineId}>
                            {r.routineId === work.routineId
                              ? work.routineName
                              : r.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <fieldset>
                    <legend>Activities for this visit</legend>
                    {data.activities
                      .filter(
                        (a) =>
                          a.active ||
                          work.activities.some(
                            (w) => w.activityId === a.activityId,
                          ),
                      )
                      .map((a) => {
                        const inRoutine =
                          (
                            work.routineActivityIds ?? routine?.activityIds
                          )?.includes(a.activityId) ?? false;
                        return (
                          <label
                            className="flex items-center gap-2 py-1"
                            key={a.activityId}
                          >
                            <input
                              type="checkbox"
                              checked={
                                inRoutine || extras.includes(a.activityId)
                              }
                              disabled={inRoutine}
                              onChange={(e) =>
                                update(
                                  work.routineId,
                                  e.target.checked
                                    ? [...extras, a.activityId]
                                    : extras.filter(
                                        (id) => id !== a.activityId,
                                      ),
                                )
                              }
                            />
                            {work.activities.find(
                              (task) => task.activityId === a.activityId,
                            )?.name ?? a.name}
                            {inRoutine && " · From routine"}
                            {!a.active && " · Inactive"}
                          </label>
                        );
                      })}
                  </fieldset>
                </div>
              ) : (
                <>
                  <p>{work.routineName}</p>
                  <ul>
                    {work.activities.map((a) => (
                      <li key={a.activityId}>{a.name}</li>
                    ))}
                  </ul>
                  {!work.activities.length && (
                    <p>No store activities planned.</p>
                  )}
                </>
              )}
            </details>
          );
        })}
    </section>
  );
}
