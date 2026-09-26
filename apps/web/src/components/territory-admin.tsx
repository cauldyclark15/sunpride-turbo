"use client";
import { Card, ListRow, StatusPill, WorkspaceIcon } from "@sunpride/ui";
import { Button, Input } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Doc, Id } from "@sunpride/backend/data-model";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useState, type FormEvent } from "react";
import { formatManilaDate, futureManilaDateToUtcMs } from "../lib/manila-date";

type Action = "create" | "edit" | "transfer" | "assign" | "end" | "deactivate";
type Mutations = {
  create: (
    args: FunctionArgs<typeof api.territories.mutations.create>,
  ) => Promise<unknown>;
  edit: (
    args: FunctionArgs<typeof api.territories.mutations.edit>,
  ) => Promise<unknown>;
  transferOwner: (
    args: FunctionArgs<typeof api.territories.mutations.transferOwner>,
  ) => Promise<unknown>;
  assignSalesperson: (
    args: FunctionArgs<typeof api.territories.mutations.assignSalesperson>,
  ) => Promise<unknown>;
  endSalespersonAssignment: (
    args: FunctionArgs<
      typeof api.territories.mutations.endSalespersonAssignment
    >,
  ) => Promise<unknown>;
  deactivate: (
    args: FunctionArgs<typeof api.territories.mutations.deactivate>,
  ) => Promise<unknown>;
};
const field =
  "h-10 rounded-[10px] border border-border bg-surface px-3 text-sm text-foreground";
export async function performTerritoryAction(
  action: Action,
  data: Pick<FormData, "get">,
  mutations: Mutations,
  territoryId?: Id<"territories">,
) {
  const get = (key: string) => String(data.get(key) ?? "").trim();
  const reason = get("reason");
  if (!reason) throw new Error("Reason required");
  if (action === "edit") {
    if (!territoryId) throw new Error("Select a territory");
    return mutations.edit({
      territoryId,
      name: get("name"),
      channel: get("channel") || undefined,
      boundaryGeoJson: get("boundaryGeoJson") || undefined,
      reason,
    });
  }
  const date = futureManilaDateToUtcMs(get("effectiveDate"));
  if (action === "create")
    return mutations.create({
      code: get("code"),
      name: get("name"),
      orgUnitId: get("orgUnitId") as Id<"orgUnits">,
      channel: get("channel") || undefined,
      boundaryGeoJson: get("boundaryGeoJson") || undefined,
      effectiveFrom: date,
      ...(get("endDate")
        ? { effectiveTo: futureManilaDateToUtcMs(get("endDate")) }
        : {}),
      reason,
    });
  if (!territoryId) throw new Error("Select a territory");
  if (action === "transfer")
    return mutations.transferOwner({
      territoryId,
      orgUnitId: get("orgUnitId") as Id<"orgUnits">,
      effectiveFrom: date,
      reason,
    });
  if (action === "assign")
    return mutations.assignSalesperson({
      territoryId,
      profileId: get("profileId") as Id<"profiles">,
      kind: "primary",
      effectiveFrom: date,
      reason,
    });
  if (action === "end")
    return mutations.endSalespersonAssignment({
      assignmentId: get("assignmentId") as Id<"territorySalespeople">,
      effectiveTo: date,
      reason,
    });
  return mutations.deactivate({ territoryId, effectiveTo: date, reason });
}
function TerritoryListRow({
  row,
  noSalesperson,
  onSelect,
  asOf,
}: {
  row: Doc<"territories">;
  noSalesperson: boolean;
  onSelect: () => void;
  asOf: number;
}) {
  const assigned = useQuery(
    api.territories.queries.salespeopleAt,
    noSalesperson ? { territoryId: row._id, asOf } : "skip",
  );
  if (noSalesperson && (!assigned || assigned.length > 0)) return null;
  return (
    <li>
      <ListRow
        icon={<WorkspaceIcon name="field" />}
        title={row.name}
        meta={`${row.code} · ${formatManilaDate(row.effectiveFrom)}`}
        value={
          <StatusPill tone={row.status === "active" ? "success" : "neutral"}>
            {row.status}
          </StatusPill>
        }
        action={
          <Button variant="outline" className="h-8" onPress={onSelect}>
            Open
          </Button>
        }
      />
    </li>
  );
}

export function TerritoryAdmin() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const canRead = permissions?.capabilities.includes("territory.read") ?? false;
  const canManage =
    permissions?.capabilities.includes("territory.manage") ?? false;
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<Id<"territories"> | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [noSalesperson, setNoSalesperson] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [asOf] = useState(() => Date.now());
  const territories = useQuery(
    api.territories.queries.list,
    canRead
      ? { paginationOpts: { numItems: 25, cursor: cursors.at(-1) ?? null } }
      : "skip",
  );
  const detail = useQuery(
    api.territories.queries.detail,
    canRead && selected ? { territoryId: selected } : "skip",
  );
  const salespeople = useQuery(
    api.territories.queries.salespeopleAt,
    canRead && selected ? { territoryId: selected, asOf } : "skip",
  );
  const history = useQuery(
    api.territories.queries.ownershipHistory,
    canRead && selected ? { territoryId: selected } : "skip",
  );
  const units = useQuery(api.org.queries.tree, canRead ? { asOf } : "skip");
  const people = useQuery(
    api.people.queries.list,
    canManage ? { paginationOpts: { numItems: 50, cursor: null } } : "skip",
  );
  const mutations = {
    create: useMutation(api.territories.mutations.create),
    edit: useMutation(api.territories.mutations.edit),
    transferOwner: useMutation(api.territories.mutations.transferOwner),
    assignSalesperson: useMutation(api.territories.mutations.assignSalesperson),
    endSalespersonAssignment: useMutation(
      api.territories.mutations.endSalespersonAssignment,
    ),
    deactivate: useMutation(api.territories.mutations.deactivate),
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || !action || pending) return;
    setError("");
    setPending(true);
    try {
      await performTerritoryAction(
        action,
        new FormData(event.currentTarget),
        mutations,
        selected ?? undefined,
      );
      setNotice("Territory change saved.");
      setAction(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Card
      label="Territories"
      count={territories?.page.length}
      icon={<WorkspaceIcon name="field" />}
      actions={
        <Button
          variant="outline"
          className="h-8"
          isDisabled={!canManage}
          onPress={() => setAction("create")}
        >
          Create territory
        </Button>
      }
    >
      <div className="grid gap-4">
        {!canRead ? (
          <p>Territory access required.</p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={noSalesperson}
                onChange={(event) => setNoSalesperson(event.target.checked)}
              />{" "}
              No salesperson assigned
            </label>
            <ul className="overflow-hidden rounded-xl border border-border">
              {(territories?.page ?? []).map((row) => (
                <TerritoryListRow
                  key={row._id}
                  row={row}
                  noSalesperson={noSalesperson}
                  asOf={asOf}
                  onSelect={() => {
                    setSelected(row._id);
                    setAction(null);
                  }}
                />
              ))}
            </ul>
            {territories && !territories.page.length ? (
              <p>No territories here</p>
            ) : null}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="h-10"
                isDisabled={cursors.length === 1}
                onPress={() => setCursors((old) => old.slice(0, -1))}
              >
                Previous
              </Button>
              <span>Page {cursors.length}</span>
              <Button
                variant="outline"
                className="h-10"
                isDisabled={!territories || territories.isDone}
                onPress={() =>
                  territories &&
                  setCursors((old) => [...old, territories.continueCursor])
                }
              >
                Next
              </Button>
            </div>
            {detail ? (
              <aside className="grid gap-2 rounded border p-3">
                <h3>
                  {detail.territory.name} · {detail.territory.code}
                </h3>
                <p>
                  Owner:{" "}
                  {units?.find((unit) => unit._id === detail.owner?.orgUnitId)
                    ?.name ??
                    detail.owner?.orgUnitId ??
                    "Pending"}
                </p>
                <p>
                  Effective {formatManilaDate(detail.territory.effectiveFrom)}
                  {detail.territory.effectiveTo
                    ? ` – ${formatManilaDate(detail.territory.effectiveTo)}`
                    : " onward"}
                </p>
                <p>
                  Channel: {detail.territory.channel || "—"} · Boundary:{" "}
                  {detail.territory.boundaryGeoJson
                    ? "Advisory polygon"
                    : "None"}
                </p>
                <h4>Ownership history</h4>
                <ol>
                  {history?.map((row) => (
                    <li key={row._id}>
                      {row.orgUnitId} · {formatManilaDate(row.effectiveFrom)} ·{" "}
                      {row.reason}
                    </li>
                  ))}
                </ol>
                <h4>Current salespeople</h4>
                <ul>
                  {salespeople?.map((row) => (
                    <li key={row._id}>
                      {people?.page.find((p) => p._id === row.profileId)
                        ?.name ?? row.profileId}{" "}
                      · {row.kind ?? "primary"}{" "}
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
                <div className="flex gap-2">
                  {(["edit", "transfer", "assign", "deactivate"] as const).map(
                    (choice) => (
                      <Button
                        variant="outline"
                        className="h-10"
                        key={choice}
                        isDisabled={!canManage}
                        onPress={() => setAction(choice)}
                      >
                        {choice}
                      </Button>
                    ),
                  )}
                </div>
              </aside>
            ) : null}
            {action && canManage ? (
              <form onSubmit={submit} className="grid gap-3 rounded border p-4">
                <h3>{action} territory</h3>
                {(action === "create" || action === "edit") && (
                  <>
                    <label>
                      Code{" "}
                      {action === "create" && <Input name="code" required />}
                    </label>
                    <label>
                      Name{" "}
                      <Input
                        name="name"
                        required
                        defaultValue={
                          action === "edit" ? detail?.territory.name : ""
                        }
                      />
                    </label>
                    <label>
                      Channel{" "}
                      <Input
                        name="channel"
                        defaultValue={
                          action === "edit" ? detail?.territory.channel : ""
                        }
                      />
                    </label>
                    <label>
                      Advisory boundary (GeoJSON Polygon){" "}
                      <textarea
                        name="boundaryGeoJson"
                        className={field}
                        defaultValue={
                          action === "edit"
                            ? detail?.territory.boundaryGeoJson
                            : ""
                        }
                      />
                    </label>
                  </>
                )}
                {(action === "create" || action === "transfer") && (
                  <label>
                    Owning unit{" "}
                    <select name="orgUnitId" className={field} required>
                      <option value="">Select unit</option>
                      {units
                        ?.filter(
                          (unit) =>
                            unit.status === "active" &&
                            permissions?.scopeUnitIds.includes(unit._id),
                        )
                        .map((unit) => (
                          <option value={unit._id} key={unit._id}>
                            {unit.code} · {unit.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {action === "assign" && (
                  <label>
                    Salesperson{" "}
                    <select name="profileId" className={field} required>
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
                  </label>
                )}
                {action === "end" && (
                  <label>
                    Assignment{" "}
                    <select name="assignmentId" className={field} required>
                      <option value="">Select assignment</option>
                      {salespeople?.map((row) => (
                        <option key={row._id} value={row._id}>
                          {people?.page.find((p) => p._id === row.profileId)
                            ?.name ?? row.profileId}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {action !== "edit" && (
                  <label>
                    Effective date{" "}
                    <input
                      type="date"
                      name="effectiveDate"
                      className={field}
                      required
                    />
                  </label>
                )}
                {action === "create" && (
                  <label>
                    End date{" "}
                    <input type="date" name="endDate" className={field} />
                  </label>
                )}
                <label>
                  Reason (required){" "}
                  <textarea name="reason" required className={field} />
                </label>
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
            ) : null}
            {notice && <p role="status">{notice}</p>}
            {error && !action && <p role="alert">{error}</p>}
          </>
        )}
      </div>
    </Card>
  );
}
