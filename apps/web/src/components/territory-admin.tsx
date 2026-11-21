"use client";
import { formatStatus } from "../lib/format";
import {
  Card,
  FormField,
  Pager,
  ListRow,
  StatusPill,
  WorkspaceIcon,
} from "@sunpride/ui";
import { Button, Input } from "@heroui/react";
import { api } from "./master-data/api";
import type { Doc, Id } from "./master-data/model";
import { useMutation, useQuery } from "./master-data/api";
import type { FunctionArgs } from "./master-data/api";
import { useState, type FormEvent } from "react";
import {
  formatManilaDate,
  futureManilaDateToUtcMs,
  manilaDateToUtcMs,
  todayOrFutureManilaDateToUtcMs,
} from "../lib/manila-date";
import { SetupSearch } from "./master-data/setup-health";
import { Drawer } from "./cockpit/kit/drawer";
import {
  TerritoryCoverageFields,
  TerritoryStores,
  readCoverageForm,
} from "./territory-coverage-fields";

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
export async function performTerritoryAction(
  action: Action,
  data: Pick<FormData, "get">,
  mutations: Mutations,
  territoryId?: Id<"territories">,
) {
  const get = (key: string) => String(data.get(key) ?? "").trim();
  const reason = get("reason");
  if (action === "edit") {
    if (!territoryId) throw new Error("Select a territory");
    return mutations.edit({
      territoryId,
      ...readCoverageForm(data),
      name: get("name"),
      channel: get("channel") || undefined,
      boundaryGeoJson: get("boundaryGeoJson") || undefined,
      reason,
    });
  }
  const date =
    action === "create"
      ? todayOrFutureManilaDateToUtcMs(get("effectiveDate"))
      : futureManilaDateToUtcMs(get("effectiveDate"));
  if (action === "create")
    return mutations.create({
      code: get("code"),
      ...readCoverageForm(data),
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
  salespersonNames,
}: {
  row: Doc<"territories">;
  noSalesperson: boolean;
  onSelect: () => void;
  asOf: number;
  salespersonNames: Map<string, string>;
}) {
  const assigned = useQuery(api.territories.queries.salespeopleAt, {
    territoryId: row._id,
    asOf,
  });
  if (noSalesperson && (!assigned || assigned.length > 0)) return null;
  const salesperson = assigned?.length
    ? assigned
        .map(
          (person) =>
            salespersonNames.get(person.profileId) ?? "Salesperson assigned",
        )
        .join(", ")
    : assigned
      ? "No salesperson"
      : "Salesperson loading…";
  return (
    <li>
      <ListRow
        icon={<WorkspaceIcon name="field" />}
        title={row.name}
        meta={`${row.code} · ${row.territoryType === "customer_group" ? "Customer group" : "Location"} · ${formatManilaDate(row.effectiveFrom)} · ${salesperson}`}
        value={
          <StatusPill tone={row.status === "active" ? "success" : "neutral"}>
            {formatStatus(row.status)}
          </StatusPill>
        }
        action={
          <Button variant="outline" className="h-8" onPress={onSelect}>
            Edit
          </Button>
        }
      />
    </li>
  );
}

function TerritorySalespersonField({ territoryId }: { territoryId: string }) {
  const [search, setSearch] = useState<string | undefined>(undefined);
  const [effectiveDate, setEffectiveDate] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  let asOf: number | undefined;
  try {
    asOf = effectiveDate ? manilaDateToUtcMs(effectiveDate) : undefined;
  } catch {
    // Partial date input is not a valid filter or a submittable date yet.
  }
  const people = useQuery(api.people.queries.list, {
    territoryId,
    ...(asOf === undefined ? {} : { asOf }),
    ...(search ? { q: search } : {}),
    paginationOpts: { numItems: 50, cursor: cursors.at(-1) ?? null },
  });
  return (
    <div className="grid gap-2 sm:col-span-2">
      <FormField label="Effective date">
        <input
          type="date"
          name="effectiveDate"
          required
          value={effectiveDate}
          onChange={(event) => {
            setEffectiveDate(event.target.value);
            setCursors([null]);
          }}
        />
      </FormField>
      <SetupSearch
        label="Search salespeople"
        value={search ?? ""}
        onChange={(value) => {
          setSearch(value);
          setCursors([null]);
        }}
      />
      <FormField label="Salesperson">
        <select
          key={`${effectiveDate}:${search ?? ""}:${cursors.at(-1) ?? ""}`}
          name="profileId"
          required
          aria-busy={!people}
          defaultValue=""
        >
          <option value="">Select person</option>
          {people?.page.map((person) => (
            <option key={person._id} value={person._id}>
              {person.name}
            </option>
          ))}
        </select>
      </FormField>
      {!people ? (
        <p>Loading salespeople…</p>
      ) : !people.page.length ? (
        <p>No active people found in this territory’s owning branch.</p>
      ) : null}
      <Pager
        page={cursors.length}
        canPrevious={cursors.length > 1}
        canNext={!!people && !people.isDone}
        onPrevious={() => setCursors((old) => old.slice(0, -1))}
        onNext={() =>
          people && setCursors((old) => [...old, people.continueCursor])
        }
        label="Salespeople pages"
      />
    </div>
  );
}

const territoryActionLabel: Record<Action, string> = {
  create: "Add territory",
  edit: "Edit territory",
  transfer: "Move to another branch",
  assign: "Add salesperson",
  end: "Remove salesperson",
  deactivate: "Remove territory",
};
export function TerritoryAdmin() {
  const [search, setSearch] = useState<string | undefined>(undefined);
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
      ? {
          ...(search ? { q: search } : {}),
          paginationOpts: { numItems: 25, cursor: cursors.at(-1) ?? null },
        }
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
      setNotice("Saved.");
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
        canManage ? (
          <Button
            variant="primary"
            className="h-9"
            onPress={() => setAction("create")}
          >
            Add territory
          </Button>
        ) : null
      }
    >
      <div className="grid min-w-0 grid-cols-1 gap-4">
        {!canRead ? (
          <p>Territory access required.</p>
        ) : (
          <>
            <SetupSearch
              label="Search territories"
              value={search ?? ""}
              onChange={(value) => {
                setSearch(value);
                setCursors([null]);
              }}
            />
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
                  salespersonNames={
                    new Map(
                      people?.page.map((person) => [person._id, person.name]),
                    )
                  }
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
            <Pager
              page={cursors.length}
              canPrevious={cursors.length > 1}
              canNext={!!territories && !territories.isDone}
              onPrevious={() => setCursors((old) => old.slice(0, -1))}
              onNext={() =>
                territories &&
                setCursors((old) => [...old, territories.continueCursor])
              }
              label="Territories pages"
            />
            {detail ? (
              <aside className="grid min-w-0 grid-cols-1 gap-2 break-words rounded border p-3">
                <h3>
                  {detail.territory.name} · {detail.territory.code}
                </h3>
                <p>
                  Owner:{" "}
                  {units?.find((unit) => unit._id === detail.owner?.orgUnitId)
                    ?.name ?? "Pending"}
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
                <p>
                  Territory type:{" "}
                  {detail.territory.territoryType === "customer_group"
                    ? "Customer group"
                    : "Location"}
                </p>
                <h4>Covered places or groups</h4>
                {detail.coverage?.length ? (
                  <ul>
                    {detail.coverage.map((row) => (
                      <li key={row._id}>
                        {[row.name, row.municipalityName, row.provinceName]
                          .filter(Boolean)
                          .join(" · ")}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    No places or groups selected. Existing manual assignments
                    still apply.
                  </p>
                )}
                {selected && <TerritoryStores territoryId={selected} />}
                <h4>Ownership history</h4>
                <ol>
                  {history?.map((row) => (
                    <li key={row._id}>
                      {row.orgUnitName ?? "Branch unavailable"} ·{" "}
                      {formatManilaDate(row.effectiveFrom)} · {row.reason}
                    </li>
                  ))}
                </ol>
                <h4>Current salespeople</h4>
                <ul>
                  {salespeople?.map((row) => (
                    <li key={row._id}>
                      {people?.page.find((p) => p._id === row.profileId)
                        ?.name ??
                        row.personName ??
                        "Salesperson unavailable"}{" "}
                      · {row.kind === "secondary" ? "Secondary" : "Primary"}{" "}
                      <Button
                        variant="outline"
                        className="h-10"
                        isDisabled={!canManage}
                        onPress={() => setAction("end")}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  {(["edit", "transfer", "assign", "deactivate"] as const).map(
                    (choice) => (
                      <Button
                        variant="outline"
                        className="h-10"
                        key={choice}
                        isDisabled={!canManage}
                        onPress={() => setAction(choice)}
                      >
                        {territoryActionLabel[choice]}
                      </Button>
                    ),
                  )}
                </div>
              </aside>
            ) : null}
            <Drawer
              open={!!action && canManage}
              title={action ? territoryActionLabel[action] : "Territory"}
              onClose={() => setAction(null)}
              wide
            >
              {action && canManage ? (
                <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
                  <h3 className="sr-only">{territoryActionLabel[action]}</h3>
                  {(action === "create" || action === "edit") && (
                    <>
                      {action === "create" && (
                        <FormField label="Code">
                          <Input
                            name="code"
                            required
                            className="border border-border"
                          />
                        </FormField>
                      )}
                      <FormField label="Name">
                        <Input
                          name="name"
                          required
                          className="border border-border"
                          defaultValue={
                            action === "edit" ? detail?.territory.name : ""
                          }
                        />
                      </FormField>
                      {canManage && (
                        <TerritoryCoverageFields
                          key={`${action}:${selected ?? "new"}`}
                          initial={action === "edit" ? detail : undefined}
                        />
                      )}
                      <FormField label="Channel">
                        <Input
                          name="channel"
                          className="border border-border"
                          defaultValue={
                            action === "edit" ? detail?.territory.channel : ""
                          }
                        />
                      </FormField>
                      <FormField label="Advisory boundary (GeoJSON Polygon)">
                        <textarea
                          name="boundaryGeoJson"
                          defaultValue={
                            action === "edit"
                              ? detail?.territory.boundaryGeoJson
                              : ""
                          }
                        />
                      </FormField>
                    </>
                  )}
                  {(action === "create" || action === "transfer") && (
                    <FormField label="Owning branch">
                      <select name="orgUnitId" required>
                        <option value="">Select branch</option>
                        {units
                          ?.filter(
                            (unit) =>
                              unit.status === "active" &&
                              permissions?.scopeUnitIds.includes(unit._id),
                          )
                          .map((unit) => (
                            <option value={unit._id} key={unit._id}>
                              {unit.name} · {unit.code}
                            </option>
                          ))}
                      </select>
                    </FormField>
                  )}
                  {action === "assign" && selected && (
                    <TerritorySalespersonField
                      key={selected}
                      territoryId={selected}
                    />
                  )}
                  {action === "end" && (
                    <FormField label="Assignment">
                      <select name="assignmentId" required>
                        <option value="">Select assignment</option>
                        {salespeople?.map((row) => (
                          <option key={row._id} value={row._id}>
                            {people?.page.find((p) => p._id === row.profileId)
                              ?.name ??
                              row.personName ??
                              "Salesperson unavailable"}
                          </option>
                        ))}
                      </select>
                    </FormField>
                  )}
                  {action !== "edit" && action !== "assign" && (
                    <FormField label="Effective date">
                      <input type="date" name="effectiveDate" required />
                    </FormField>
                  )}
                  {action === "create" && (
                    <FormField label="End date">
                      <input type="date" name="endDate" />
                    </FormField>
                  )}
                  <FormField label="Reason (optional)">
                    <textarea name="reason" />
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
              ) : null}
            </Drawer>
            {notice && <p role="status">{notice}</p>}
            {error && !action && <p role="alert">{error}</p>}
          </>
        )}
      </div>
    </Card>
  );
}
