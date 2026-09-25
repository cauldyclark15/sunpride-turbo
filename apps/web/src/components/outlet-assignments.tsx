"use client";
import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useState, type FormEvent } from "react";
import {
  formatManilaDate,
  futureManilaDateToUtcMs,
  manilaDateToUtcMs,
} from "../lib/manila-date";

const field = "rounded border border-border bg-surface p-2 text-sm";
type Choice = Omit<
  FunctionArgs<typeof api.outlets.assignments.assign>,
  "effectiveFrom" | "reason"
>;
type Actions = {
  assign: (
    args: FunctionArgs<typeof api.outlets.assignments.assign>,
  ) => Promise<unknown>;
  batchAssign: (
    args: FunctionArgs<typeof api.outlets.assignments.batchAssign>,
  ) => Promise<unknown>;
  reorder: (
    args: FunctionArgs<typeof api.outlets.assignments.reorder>,
  ) => Promise<unknown>;
};
export async function performAssignmentAction(
  action: "assign" | "bulk" | "reorder",
  data: Pick<FormData, "get">,
  actions: Actions,
  selection: Id<"outlets">[],
  routeOrder: Id<"outlets">[],
) {
  const get = (key: string) => String(data.get(key) ?? "").trim();
  const reason = get("reason");
  if (!reason) throw new Error("Reason required");
  const effectiveFrom = futureManilaDateToUtcMs(get("effectiveDate"));
  if (action === "reorder") {
    if (!get("routeId") || !routeOrder.length)
      throw new Error("Select a route with stops");
    return actions.reorder({
      routeId: get("routeId") as Id<"routes">,
      outletIds: routeOrder,
      effectiveFrom,
      reason,
    });
  }
  if (!get("territoryId")) throw new Error("Select a territory");
  const routeId = get("routeId") as Id<"routes">;
  const sequence = get("sequence") ? Number(get("sequence")) : undefined;
  const target: Omit<Choice, "outletId"> = {
    territoryId: get("territoryId") as Id<"territories">,
    ...(routeId ? { routeId, sequence } : {}),
  };
  if (action === "bulk") {
    if (!selection.length)
      throw new Error("Select outlets for bulk reassignment");
    if (routeId && sequence === undefined)
      throw new Error("Starting sequence required");
    return actions.batchAssign({
      assignments: selection.map((outletId, i) => ({
        ...target,
        outletId,
        ...(routeId ? { sequence: sequence! + i } : {}),
      })),
      effectiveFrom,
      reason,
    });
  }
  if (!selection.length) throw new Error("Select an outlet");
  return actions.assign({
    ...target,
    outletId: selection[0]!,
    effectiveFrom,
    reason,
  });
}
export function OutletAssignments() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const canRead = permissions?.capabilities.includes("outlet.read") ?? false;
  const canRoute = permissions?.capabilities.includes("route.read") ?? false;
  const canAssign =
    permissions?.capabilities.includes("outlet.assign") ?? false;
  const [territoryId, setTerritoryId] = useState<Id<"territories"> | null>(
    null,
  );
  const [routeId, setRouteId] = useState<Id<"routes"> | null>(null);
  const [selected, setSelected] = useState<Id<"outlets">[]>([]);
  const [outletId, setOutletId] = useState<Id<"outlets"> | null>(null);
  const [order, setOrder] = useState<Id<"outlets">[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previewDate, setPreviewDate] = useState("");
  const asOf = previewDate ? manilaDateToUtcMs(previewDate) : undefined;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const territories = useQuery(
    api.territories.queries.list,
    canRead ? { paginationOpts: { numItems: 100, cursor: null } } : "skip",
  );
  const routes = useQuery(
    api.territories.routes.list,
    canRoute && territoryId
      ? { territoryId, paginationOpts: { numItems: 100, cursor: null } }
      : "skip",
  );
  const outlets = useQuery(
    api.outlets.queries.list,
    canRead ? { paginationOpts: { numItems: 100, cursor } } : "skip",
  );
  const unassigned = useQuery(
    api.outlets.assignments.unassigned,
    canRead ? { paginationOpts: { numItems: 100, cursor: null } } : "skip",
  );
  const stops = useQuery(
    api.outlets.assignments.routeStops,
    canRead && canRoute && routeId ? { routeId, asOf } : "skip",
  );
  const roster = useQuery(
    api.outlets.assignments.territoryRoster,
    canRead && territoryId ? { territoryId, asOf } : "skip",
  );
  const history = useQuery(
    api.outlets.assignments.history,
    canRead && outletId ? { outletId } : "skip",
  );
  const assign = useMutation(api.outlets.assignments.assign);
  const batchAssign = useMutation(api.outlets.assignments.batchAssign);
  const reorder = useMutation(api.outlets.assignments.reorder);
  const currentOrder = order ?? stops?.map((row) => row.outletId) ?? [];
  async function submit(
    event: FormEvent<HTMLFormElement>,
    action: "assign" | "bulk" | "reorder",
  ) {
    event.preventDefault();
    if (!canAssign || pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await performAssignmentAction(
        action,
        new FormData(event.currentTarget),
        { assign, batchAssign, reorder },
        action === "assign" ? (outletId ? [outletId] : []) : selected,
        currentOrder,
      );
      setOrder(null);
      setNotice("Assignment saved. History is retained.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="grid gap-4">
      <h2 className="text-lg font-semibold">
        Outlet assignments and ordered stops
      </h2>
      <p>Dates are Asia/Manila; changes are prospective and audited.</p>
      {!canRead ? (
        <p>Outlet read access required.</p>
      ) : (
        <>
          <label>
            Preview stops/roster as of Manila date{" "}
            <input
              className={field}
              type="date"
              value={previewDate}
              onChange={(event) => {
                setPreviewDate(event.target.value);
                setOrder(null);
              }}
            />
          </label>
          <label>
            Territory{" "}
            <select
              aria-label="Assignment territory"
              className={field}
              value={territoryId ?? ""}
              onChange={(e) => {
                setTerritoryId((e.target.value as Id<"territories">) || null);
                setRouteId(null);
                setOrder(null);
              }}
            >
              <option value="">Select territory</option>
              {territories?.page.map((t) => (
                <option key={t._id} value={t._id}>
                  {t.code} · {t.name}
                </option>
              ))}
            </select>
          </label>
          {canRoute && (
            <label>
              Route{" "}
              <select
                aria-label="Assignment route"
                className={field}
                value={routeId ?? ""}
                onChange={(e) => {
                  setRouteId((e.target.value as Id<"routes">) || null);
                  setOrder(null);
                }}
              >
                <option value="">Territory only</option>
                {routes?.page.map((r) => (
                  <option key={r._id} value={r._id}>
                    {r.code} · {r.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <h3>Scoped outlets (select for bulk reassignment)</h3>
          <ul>
            {outlets?.page.map((o) => (
              <li key={o._id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(o._id)}
                    onChange={(e) =>
                      setSelected((old) =>
                        e.target.checked
                          ? [...old, o._id]
                          : old.filter((id) => id !== o._id),
                      )
                    }
                  />{" "}
                  {o.code} · {o.name}
                </label>{" "}
                <Button variant="secondary" onPress={() => setOutletId(o._id)}>
                  History / assign
                </Button>
              </li>
            ))}
          </ul>
          <Button
            isDisabled={!outlets || outlets.isDone}
            onPress={() => outlets && setCursor(outlets.continueCursor)}
          >
            Next outlets
          </Button>
          <h3>Unassigned (current custodian scope)</h3>
          <ul>
            {unassigned?.page.map((o) => (
              <li key={o._id}>
                {o.code} · {o.name}
              </li>
            ))}
          </ul>
          {outletId && (
            <>
              <h3>Assignment history</h3>
              <ol>
                {history?.map((row) => (
                  <li key={row._id}>
                    {formatManilaDate(row.effectiveFrom)} –{" "}
                    {row.effectiveTo
                      ? formatManilaDate(row.effectiveTo)
                      : "current"}{" "}
                    · {row.territoryId} / {row.routeId ?? "no route"} ·{" "}
                    {row.sequence ?? "—"} · {row.actorSubject}: {row.reason}
                  </li>
                ))}
              </ol>
            </>
          )}
          {territoryId && (
            <>
              <h3>Territory roster</h3>
              <ul>
                {roster?.map((row) => (
                  <li key={row._id}>
                    {row.outletId} · {row.routeId ?? "no route"} ·{" "}
                    {row.sequence ?? "—"}
                  </li>
                ))}
              </ul>
            </>
          )}
          {routeId && (
            <>
              <h3>Route stops</h3>
              <ol>
                {currentOrder.map((id, i) => (
                  <li key={id}>
                    {i + 1}.{" "}
                    {outlets?.page.find((o) => o._id === id)?.name ?? id}{" "}
                    <Button
                      isDisabled={!canAssign || i === 0}
                      onPress={() =>
                        setOrder((old) => {
                          const next = [
                            ...(old ?? stops?.map((row) => row.outletId) ?? []),
                          ];
                          [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                          return next;
                        })
                      }
                    >
                      Up
                    </Button>{" "}
                    <Button
                      isDisabled={!canAssign || i === currentOrder.length - 1}
                      onPress={() =>
                        setOrder((old) => {
                          const next = [
                            ...(old ?? stops?.map((row) => row.outletId) ?? []),
                          ];
                          [next[i + 1], next[i]] = [next[i]!, next[i + 1]!];
                          return next;
                        })
                      }
                    >
                      Down
                    </Button>
                  </li>
                ))}
              </ol>
            </>
          )}
          {canAssign && (
            <form
              className="grid gap-3 rounded border p-4"
              onSubmit={(e) =>
                void submit(
                  e,
                  ((e.nativeEvent as SubmitEvent).submitter?.getAttribute(
                    "data-action",
                  ) as "assign" | "bulk" | "reorder") || "assign",
                )
              }
            >
              <input
                type="hidden"
                name="territoryId"
                value={territoryId ?? ""}
              />
              <input type="hidden" name="routeId" value={routeId ?? ""} />
              <label>
                Starting sequence{" "}
                <input
                  className={field}
                  name="sequence"
                  type="number"
                  min="1"
                />
              </label>
              <label>
                Effective date{" "}
                <input
                  className={field}
                  name="effectiveDate"
                  type="date"
                  required
                />
              </label>
              <label>
                Reason <input className={field} name="reason" required />
              </label>
              <div className="flex gap-2">
                <button
                  className={field}
                  data-action="assign"
                  disabled={!outletId || !territoryId || pending}
                >
                  Assign selected outlet
                </button>
                <button
                  className={field}
                  data-action="bulk"
                  disabled={!selected.length || !territoryId || pending}
                >
                  Bulk reassign selection
                </button>
                <button
                  className={field}
                  data-action="reorder"
                  disabled={!routeId || !currentOrder.length || pending}
                >
                  Save stop order
                </button>
              </div>
            </form>
          )}
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
        </>
      )}
    </section>
  );
}
