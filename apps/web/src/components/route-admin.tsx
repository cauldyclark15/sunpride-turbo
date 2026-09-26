"use client";
import { Button, Input } from "@heroui/react";
import {
  Card,
  FormField,
  Pager,
  ListRow,
  StatusPill,
  WorkspaceIcon,
} from "@sunpride/ui";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useState, type FormEvent } from "react";
import { formatManilaDate, futureManilaDateToUtcMs } from "../lib/manila-date";

type Action =
  "create" | "edit" | "move" | "duplicate" | "assign" | "end" | "deactivate";
type Mutations = {
  create: (
    args: FunctionArgs<typeof api.territories.routes.create>,
  ) => Promise<unknown>;
  edit: (
    args: FunctionArgs<typeof api.territories.routes.edit>,
  ) => Promise<unknown>;
  move: (
    args: FunctionArgs<typeof api.territories.routes.move>,
  ) => Promise<unknown>;
  duplicateTemplate: (
    args: FunctionArgs<typeof api.territories.routes.duplicateTemplate>,
  ) => Promise<unknown>;
  assignSalesperson: (
    args: FunctionArgs<typeof api.territories.routes.assignSalesperson>,
  ) => Promise<unknown>;
  endSalespersonAssignment: (
    args: FunctionArgs<typeof api.territories.routes.endSalespersonAssignment>,
  ) => Promise<unknown>;
  deactivate: (
    args: FunctionArgs<typeof api.territories.routes.deactivate>,
  ) => Promise<unknown>;
};
export async function performRouteAction(
  action: Action,
  data: Pick<FormData, "get" | "getAll">,
  mutations: Mutations,
  routeId?: Id<"routes">,
  territoryId?: Id<"territories">,
) {
  const get = (key: string) => String(data.get(key) ?? "").trim();
  const reason = get("reason");
  if (!reason) throw new Error("Reason required");
  const selectedTerritory = (get("territoryId") || territoryId) as
    Id<"territories"> | undefined;
  if (action === "edit") {
    if (!routeId) throw new Error("Select a route");
    return mutations.edit({
      routeId,
      name: get("name"),
      weekdayTemplate: data.getAll("weekday").map(Number),
      cycleDays: get("cycleDays") ? Number(get("cycleDays")) : undefined,
      reason,
    });
  }
  const date = futureManilaDateToUtcMs(get("effectiveDate"));
  if (action === "create") {
    if (!selectedTerritory) throw new Error("Select a territory");
    return mutations.create({
      territoryId: selectedTerritory,
      code: get("code"),
      name: get("name"),
      effectiveFrom: date,
      ...(get("endDate")
        ? { effectiveTo: futureManilaDateToUtcMs(get("endDate")) }
        : {}),
      weekdayTemplate: data.getAll("weekday").map(Number),
      cycleDays: get("cycleDays") ? Number(get("cycleDays")) : undefined,
      reason,
    });
  }
  if (!routeId) throw new Error("Select a route");
  if (action === "move" || action === "duplicate") {
    if (!selectedTerritory) throw new Error("Select a territory");
    return action === "move"
      ? mutations.move({
          routeId,
          territoryId: selectedTerritory,
          effectiveFrom: date,
          reason,
        })
      : mutations.duplicateTemplate({
          routeId,
          territoryId: selectedTerritory,
          code: get("code"),
          name: get("name"),
          effectiveFrom: date,
          reason,
        });
  }
  if (action === "assign")
    return mutations.assignSalesperson({
      routeId,
      profileId: get("profileId") as Id<"profiles">,
      primary: get("primary") === "on",
      effectiveFrom: date,
      reason,
    });
  if (action === "end")
    return mutations.endSalespersonAssignment({
      assignmentId: get("assignmentId") as Id<"routeSalespeople">,
      effectiveTo: date,
      reason,
    });
  return mutations.deactivate({ routeId, effectiveTo: date, reason });
}
export function RouteAdmin() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const canRead = permissions?.capabilities.includes("route.read") ?? false;
  const canManage = permissions?.capabilities.includes("route.manage") ?? false;
  const [territoryId, setTerritoryId] = useState<Id<"territories"> | null>(
    null,
  );
  const [selected, setSelected] = useState<Id<"routes"> | null>(null);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [action, setAction] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const territories = useQuery(
    api.territories.queries.list,
    canRead ? { paginationOpts: { numItems: 100, cursor: null } } : "skip",
  );
  const routes = useQuery(
    api.territories.routes.list,
    canRead && territoryId
      ? {
          territoryId,
          paginationOpts: { numItems: 25, cursor: cursors.at(-1) ?? null },
        }
      : "skip",
  );
  const detail = useQuery(
    api.territories.routes.detail,
    canRead && selected ? { routeId: selected } : "skip",
  );
  const history = useQuery(
    api.territories.routes.history,
    canRead && selected ? { routeId: selected } : "skip",
  );
  const people = useQuery(
    api.people.queries.list,
    canManage ? { paginationOpts: { numItems: 50, cursor: null } } : "skip",
  );
  const mutations = {
    create: useMutation(api.territories.routes.create),
    edit: useMutation(api.territories.routes.edit),
    move: useMutation(api.territories.routes.move),
    duplicateTemplate: useMutation(api.territories.routes.duplicateTemplate),
    assignSalesperson: useMutation(api.territories.routes.assignSalesperson),
    endSalespersonAssignment: useMutation(
      api.territories.routes.endSalespersonAssignment,
    ),
    deactivate: useMutation(api.territories.routes.deactivate),
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || !canManage || pending) return;
    setError("");
    setPending(true);
    try {
      await performRouteAction(
        action,
        new FormData(event.currentTarget),
        mutations,
        selected ?? undefined,
        territoryId ?? undefined,
      );
      setAction(null);
      setNotice("Route change saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Card
      label="Routes"
      icon={<WorkspaceIcon name="field" />}
      actions={
        <Button
          variant="outline"
          className="h-8"
          isDisabled={!canManage || !territoryId}
          onPress={() => setAction("create")}
        >
          Create route
        </Button>
      }
    >
      <div className="grid gap-4">
        {!canRead ? (
          <p>Route access required.</p>
        ) : (
          <>
            <FormField label="Territory">
              <select
                aria-label="Territory"
                value={territoryId ?? ""}
                onChange={(event) => {
                  setTerritoryId(
                    (event.target.value as Id<"territories">) || null,
                  );
                  setSelected(null);
                  setCursors([null]);
                }}
              >
                <option value="">Select territory</option>
                {territories?.page.map((t) => (
                  <option key={t._id} value={t._id}>
                    {t.code} · {t.name}
                  </option>
                ))}
              </select>
            </FormField>
            {territoryId && (
              <>
                <ul className="overflow-hidden rounded-xl border border-border">
                  {routes?.page.map((row) => (
                    <li key={row._id}>
                      <ListRow
                        icon={<WorkspaceIcon name="field" />}
                        title={`${row.code} · ${row.name}`}
                        meta={formatManilaDate(row.effectiveFrom)}
                        value={
                          <StatusPill
                            tone={
                              row.status === "active" ? "success" : "neutral"
                            }
                          >
                            {row.status}
                          </StatusPill>
                        }
                        action={
                          <Button
                            variant="outline"
                            className="h-8"
                            onPress={() => {
                              setSelected(row._id);
                              setAction(null);
                            }}
                          >
                            Open
                          </Button>
                        }
                      />
                    </li>
                  ))}
                </ul>
                {routes && !routes.page.length && <p>No routes here</p>}
                <Pager
                  page={cursors.length}
                  canPrevious={cursors.length > 1}
                  canNext={!!routes && !routes.isDone}
                  onPrevious={() => setCursors((old) => old.slice(0, -1))}
                  onNext={() =>
                    routes &&
                    setCursors((old) => [...old, routes.continueCursor])
                  }
                  label="Routes pages"
                />
              </>
            )}
            {detail && (
              <aside className="grid gap-2 rounded border p-3">
                <h3>
                  {detail.route.code} · {detail.route.name}
                </h3>
                <p>
                  Territory:{" "}
                  {territories?.page.find(
                    (t) => t._id === detail.territory?.territoryId,
                  )?.name ?? detail.territory?.territoryId}
                </p>
                <p>
                  Effective {formatManilaDate(detail.route.effectiveFrom)}
                  {detail.route.effectiveTo
                    ? ` – ${formatManilaDate(detail.route.effectiveTo)}`
                    : " onward"}
                </p>
                <p>
                  Weekdays: {detail.route.weekdayTemplate?.join(", ") || "none"}{" "}
                  · Cycle: {detail.route.cycleDays ?? "none"} days
                </p>
                <h4>Association history</h4>
                <ol>
                  {history?.territories.map((row) => (
                    <li key={row._id}>
                      {row.territoryId} · {formatManilaDate(row.effectiveFrom)}{" "}
                      · {row.reason}
                    </li>
                  ))}
                </ol>
                <h4>Salespeople</h4>
                <ul>
                  {detail.salespeople.map((row) => (
                    <li key={row._id}>
                      {people?.page.find((p) => p._id === row.profileId)
                        ?.name ?? row.profileId}{" "}
                      · {row.primary ? "primary" : "secondary"}{" "}
                      <Button
                        variant="outline"
                        className="h-10"
                        isDisabled={!canManage}
                        onPress={() => setAction("end")}
                      >
                        End assignment
                      </Button>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      "edit",
                      "move",
                      "duplicate",
                      "assign",
                      "deactivate",
                    ] as const
                  ).map((choice) => (
                    <Button
                      variant="outline"
                      className="h-10"
                      key={choice}
                      isDisabled={!canManage}
                      onPress={() => setAction(choice)}
                    >
                      {choice}
                    </Button>
                  ))}
                </div>
              </aside>
            )}
            {action && canManage && (
              <form
                onSubmit={submit}
                className="grid gap-3 rounded border p-4 sm:grid-cols-2 lg:grid-cols-3"
              >
                <h3>{action} route</h3>
                {(action === "create" || action === "duplicate") && (
                  <FormField label="Code">
                    <Input name="code" required />
                  </FormField>
                )}
                {(["create", "edit", "duplicate"] as Action[]).includes(
                  action,
                ) && (
                  <FormField label="Name">
                    <Input
                      name="name"
                      required
                      defaultValue={action === "edit" ? detail?.route.name : ""}
                    />
                  </FormField>
                )}
                {(action === "create" || action === "edit") && (
                  <>
                    <fieldset>
                      <legend>Weekday template (Monday=1)</legend>
                      {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                        <label key={day} className="mr-3">
                          <input
                            type="checkbox"
                            name="weekday"
                            value={day}
                            defaultChecked={
                              action === "edit" &&
                              detail?.route.weekdayTemplate?.includes(day)
                            }
                          />{" "}
                          {day}
                        </label>
                      ))}
                    </fieldset>
                    <FormField label="Cycle days (optional, 1–366)">
                      <input
                        name="cycleDays"
                        type="number"
                        min="1"
                        max="366"
                        defaultValue={
                          action === "edit"
                            ? detail?.route.cycleDays
                            : undefined
                        }
                      />
                    </FormField>
                  </>
                )}
                {(action === "move" || action === "duplicate") && (
                  <FormField label="Destination territory">
                    <select name="territoryId" className="min-w-40" required>
                      <option value="">Select territory</option>
                      {territories?.page.map((t) => (
                        <option key={t._id} value={t._id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </FormField>
                )}
                {action === "assign" && (
                  <>
                    <FormField label="Salesperson">
                      <select name="profileId" className="min-w-40" required>
                        <option value="">Select person</option>
                        {people?.page
                          .filter(
                            (p) =>
                              p.status === "active" &&
                              p.orgUnitId &&
                              permissions?.scopeUnitIds.includes(p.orgUnitId),
                          )
                          .map((p) => (
                            <option key={p._id} value={p._id}>
                              {p.name}
                            </option>
                          ))}
                      </select>
                    </FormField>
                    <label>
                      <input type="checkbox" name="primary" defaultChecked />{" "}
                      Primary owner
                    </label>
                  </>
                )}
                {action === "end" && (
                  <FormField label="Assignment">
                    <select name="assignmentId" className="min-w-40" required>
                      <option value="">Select assignment</option>
                      {detail?.salespeople.map((row) => (
                        <option key={row._id} value={row._id}>
                          {row.profileId}
                        </option>
                      ))}
                    </select>
                  </FormField>
                )}
                {action !== "edit" && (
                  <FormField label="Effective date">
                    <input type="date" name="effectiveDate" required />
                  </FormField>
                )}
                {action === "create" && (
                  <FormField label="End date">
                    <input type="date" name="endDate" />
                  </FormField>
                )}
                <FormField label="Reason (required)">
                  <textarea name="reason" required />
                </FormField>
                {error && (
                  <p role="alert" className="text-danger">
                    {error}
                  </p>
                )}
                <Button type="submit" isPending={pending}>
                  Save
                </Button>
                <Button
                  variant="outline"
                  className="h-10"
                  type="button"
                  onPress={() => setAction(null)}
                >
                  Cancel
                </Button>
              </form>
            )}
            {notice && <p role="status">{notice}</p>}
            {error && !action && <p role="alert">{error}</p>}
          </>
        )}
      </div>
    </Card>
  );
}
