"use client";

import { Button, Input } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Doc, Id } from "@sunpride/backend/data-model";
import {
  Card,
  DataTable,
  EmptyPanel,
  FormField,
  Pager,
  StatusPill,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useState, type FormEvent } from "react";
import { AdminSelectField } from "./org-admin";
import { formatManilaDate } from "../lib/manila-date";

type Person = Doc<"profiles">;
type Role =
  | "admin"
  | "operations"
  | "manager"
  | "approver"
  | "sales"
  | "analyst"
  | "viewer";
const roles: Role[] = [
  "admin",
  "operations",
  "manager",
  "approver",
  "sales",
  "analyst",
  "viewer",
];

export async function performPeopleAssignment(
  selected: Person,
  data: Pick<FormData, "get">,
  assign: (
    args: FunctionArgs<typeof api.people.mutations.assign>,
  ) => Promise<unknown>,
) {
  const reason = String(data.get("reason") ?? "").trim();
  if (!reason) throw new Error("Reason required");
  const positionId = String(data.get("positionId") ?? "");
  const supervisorId = String(data.get("supervisorId") ?? "");
  const employeeCode = String(data.get("employeeCode") ?? "").trim();
  return assign({
    profileId: selected._id,
    orgUnitId: String(data.get("orgUnitId")) as Id<"orgUnits">,
    role: String(data.get("role")) as Role,
    ...(positionId ? { positionId: positionId as Id<"positions"> } : {}),
    ...(supervisorId ? { supervisorId: supervisorId as Id<"profiles"> } : {}),
    ...(!selected.employeeCode && employeeCode ? { employeeCode } : {}),
    reason,
  });
}

export function PeopleAdmin() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const canManage = permissions?.capabilities.includes("admin.manage") ?? false;
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const result = useQuery(api.people.queries.list, {
    paginationOpts: { numItems: 25, cursor },
  });
  const [asOf] = useState(() => Date.now());
  const units = useQuery(api.org.queries.tree, { asOf });
  const positions = useQuery(api.sfa.positions.list, canManage ? {} : "skip");
  const [selectedId, setSelectedId] = useState<Id<"profiles"> | null>(null);
  const [supervisorUnitId, setSupervisorUnitId] =
    useState<Id<"orgUnits"> | null>(null);
  const [supervisorSearch, setSupervisorSearch] = useState("");
  const [chosenSupervisorId, setChosenSupervisorId] = useState("");
  const [supervisorCursors, setSupervisorCursors] = useState<(string | null)[]>(
    [null],
  );
  const supervisorOptions = useQuery(
    api.people.queries.supervisorOptions,
    canManage && selectedId && supervisorUnitId
      ? {
          orgUnitId: supervisorUnitId,
          search: supervisorSearch || undefined,
          paginationOpts: {
            numItems: 50,
            cursor: supervisorCursors[supervisorCursors.length - 1] ?? null,
          },
        }
      : "skip",
  );
  const assign = useMutation(api.people.mutations.assign);
  const [historyId, setHistoryId] = useState<Id<"profiles"> | null>(null);
  const history = useQuery(
    api.people.queries.history,
    historyId ? { profileId: historyId } : "skip",
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const people = result?.page ?? [];
  const selected = people.find((person) => person._id === selectedId);
  const nameOf = (id?: Id<"profiles">) =>
    (supervisorOptions?.page ?? people).find((person) => person._id === id)
      ?.name ??
    id ??
    "—";
  const unitOf = (id?: Id<"orgUnits">) =>
    units?.find((unit) => unit._id === id)?.name ??
    (id ? "Outside current tree" : "—");
  const positionOf = (id?: Id<"positions">) =>
    positions?.find((position) => position._id === id)?.label ??
    (id ? "Position unavailable" : "—");
  const supervisorOf = (subject?: string) =>
    (supervisorOptions?.page ?? people).find(
      (person) => person.authSubject === subject,
    )?.name ??
    subject ??
    "—";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !canManage || pending) return;
    setError("");
    setNotice("");
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    try {
      await performPeopleAssignment(selected, data, assign);
      setSelectedId(null);
      setNotice("Assignment saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  const rows = people.map((person) => ({ ...person, id: person._id }));
  const columns: DataColumn<Person & { id: string }>[] = [
    {
      key: "name",
      label: "Person",
      render: (row) => (
        <span className="block">
          <span className="block text-sm font-medium">{row.name}</span>
          <span className="block font-mono text-xs text-muted">
            {row.email}
          </span>
        </span>
      ),
    },
    {
      key: "role",
      label: "Role",
      render: (row) => (
        <StatusPill tone="neutral">{row.role.replaceAll("_", " ")}</StatusPill>
      ),
    },
    {
      key: "position",
      label: "Position",
      render: (row) => positionOf(row.positionId),
    },
    { key: "unit", label: "Unit", render: (row) => unitOf(row.orgUnitId) },
    {
      key: "supervisor",
      label: "Supervisor",
      render: (row) => supervisorOf(row.supervisorSubject),
    },
    {
      key: "code",
      label: "Employee code",
      render: (row) => row.employeeCode ?? "—",
    },
    {
      key: "status",
      label: "Status",
      render: (row) => (
        <StatusPill tone={row.status === "active" ? "success" : "neutral"}>
          {row.status}
        </StatusPill>
      ),
    },
    {
      key: "actions",
      label: "Actions",
      render: (row) => (
        <span className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            isDisabled={
              !canManage ||
              row.role === "super_admin" ||
              (row.role === "admin" && permissions?.role !== "super_admin")
            }
            onPress={() => {
              setSelectedId(row._id);
              setSupervisorUnitId(row.orgUnitId ?? null);
              setSupervisorSearch("");
              setChosenSupervisorId("");
              setSupervisorCursors([null]);
              setError("");
              setNotice("");
            }}
          >
            Assign
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onPress={() => setHistoryId(row._id)}
          >
            History
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="grid gap-4">
      <Card
        label="People"
        icon={<WorkspaceIcon name="user" />}
        count={people.length}
        flush
      >
        {result === undefined ? (
          <p className="p-4 text-sm text-muted">Loading people…</p>
        ) : (
          <DataTable
            bare
            rows={rows}
            columns={columns}
            empty={<EmptyPanel title="No people on this page" />}
          />
        )}
        <Pager
          label="People pages"
          page={cursors.length}
          canPrevious={cursors.length > 1}
          canNext={!!result && !result.isDone}
          onPrevious={() => setCursors((old) => old.slice(0, -1))}
          onNext={() => {
            if (result && !result.isDone)
              setCursors((old) => [...old, result.continueCursor]);
          }}
        />
      </Card>
      {selected ? (
        <Card label={`Assign · ${selected.name}`}>
          <form
            onSubmit={submit}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            <AdminSelectField
              key={`${selected._id}-unit`}
              name="orgUnitId"
              label="Unit"
              defaultValue={selected.orgUnitId ?? ""}
              required
              onChange={(value) => {
                setSupervisorUnitId(value as Id<"orgUnits">);
                setSupervisorSearch("");
                setChosenSupervisorId("");
                setSupervisorCursors([null]);
              }}
              options={[
                { id: "", label: "Select a unit" },
                ...(units ?? [])
                  .filter(
                    (unit) =>
                      unit.status === "active" &&
                      (permissions?.scopeUnitIds.includes(unit._id) ?? false),
                  )
                  .map((unit) => ({
                    id: unit._id,
                    label: `${unit.code} · ${unit.name}`,
                  })),
              ]}
            />
            <AdminSelectField
              key={`${selected._id}-role`}
              name="role"
              label="Role"
              defaultValue={selected.role}
              required
              options={roles
                .filter(
                  (role) =>
                    role !== "admin" || permissions?.role === "super_admin",
                )
                .map((role) => ({
                  id: role,
                  label: role.replaceAll("_", " "),
                }))}
            />
            <AdminSelectField
              key={`${selected._id}-position`}
              name="positionId"
              label="Position"
              defaultValue={selected.positionId ?? ""}
              options={[
                { id: "", label: "Keep current position" },
                ...(positions ?? []).map((position) => ({
                  id: position._id,
                  label: position.label,
                })),
              ]}
            />
            <FormField label="Search supervisors">
              <Input
                value={supervisorSearch}
                onChange={(event) => {
                  setSupervisorSearch(event.target.value);
                  setSupervisorCursors([null]);
                }}
                placeholder="Name, email or code"
              />
            </FormField>
            <AdminSelectField
              name="supervisorId"
              label="Supervisor"
              value={chosenSupervisorId}
              onChange={setChosenSupervisorId}
              options={[
                { id: "", label: "Keep current supervisor" },
                ...(chosenSupervisorId &&
                !supervisorOptions?.page.some(
                  (person) => person._id === chosenSupervisorId,
                )
                  ? [{ id: chosenSupervisorId, label: "Selected supervisor" }]
                  : []),
                ...(supervisorOptions?.page ?? [])
                  .filter((person) => person._id !== selected._id)
                  .map((person) => ({
                    id: person._id,
                    label: `${person.name} · ${person.email}`,
                  })),
              ]}
            />
            <div className="sm:col-span-2 lg:col-span-3">
              <Pager
                label="Supervisors pages"
                page={supervisorCursors.length}
                canPrevious={supervisorCursors.length > 1}
                canNext={!!supervisorOptions && !supervisorOptions.isDone}
                onPrevious={() =>
                  setSupervisorCursors((old) => old.slice(0, -1))
                }
                onNext={() => {
                  if (supervisorOptions && !supervisorOptions.isDone)
                    setSupervisorCursors((old) => [
                      ...old,
                      supervisorOptions.continueCursor,
                    ]);
                }}
              />
            </div>
            <FormField label="Employee code">
              <Input
                name="employeeCode"
                defaultValue={selected.employeeCode ?? ""}
                disabled={!!selected.employeeCode}
                placeholder="e.g. EMP-001"
              />
            </FormField>
            <FormField label="Reason">
              <textarea
                className="min-h-20 rounded-[10px] border border-border bg-surface p-3 text-sm"
                name="reason"
                required
                rows={2}
              />
            </FormField>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="primary"
                isDisabled={!canManage}
                isPending={pending}
              >
                Save assignment
              </Button>
              <Button
                type="button"
                variant="secondary"
                onPress={() => setSelectedId(null)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
      {notice ? (
        <Card label="Status">
          <p role="status" className="text-sm text-success">
            {notice}
          </p>
        </Card>
      ) : null}
      {historyId ? (
        <Card
          label={`History · ${nameOf(historyId)}`}
          actions={
            <Button
              size="sm"
              variant="secondary"
              onPress={() => setHistoryId(null)}
            >
              Close
            </Button>
          }
        >
          <aside aria-label="Assignment history">
            {history === undefined ? (
              <p>Loading history…</p>
            ) : history.length === 0 ? (
              <p className="text-sm text-muted">No assignment history.</p>
            ) : (
              <ol className="mt-3 grid gap-3">
                {[...history]
                  .sort((a, b) => b.effectiveFrom - a.effectiveFrom)
                  .map((entry) => (
                    <li
                      key={entry._id}
                      className="rounded-md border border-border p-3 text-sm"
                    >
                      <strong>{entry.role.replaceAll("_", " ")}</strong> ·{" "}
                      {unitOf(entry.orgUnitId)} · {positionOf(entry.positionId)}{" "}
                      · Supervisor: {nameOf(entry.supervisorId)}
                      <p className="text-xs text-muted">
                        {formatManilaDate(entry.effectiveFrom)}
                        {entry.effectiveTo
                          ? ` – ${formatManilaDate(entry.effectiveTo)}`
                          : " onward"}{" "}
                        · {entry.reason}
                      </p>
                    </li>
                  ))}
              </ol>
            )}
          </aside>
        </Card>
      ) : null}
    </div>
  );
}
