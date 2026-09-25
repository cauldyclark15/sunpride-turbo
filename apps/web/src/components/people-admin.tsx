"use client";

import { Button, Input } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Doc, Id } from "@sunpride/backend/data-model";
import {
  DataTable,
  EmptyPanel,
  StatusPill,
  type DataColumn,
} from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useState, type FormEvent } from "react";
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
const selectClass =
  "h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground";

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
        <span>
          {row.name}
          <span className="block text-xs text-muted">{row.email}</span>
        </span>
      ),
    },
    {
      key: "role",
      label: "Role",
      render: (row) => row.role.replaceAll("_", " "),
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
    <section className="grid gap-5">
      <div>
        <h2 className="text-lg font-semibold">People assignments</h2>
        <p className="text-sm text-muted">
          Role, position and organizational unit are separate assignment axes.
        </p>
      </div>
      {result === undefined ? (
        <p>Loading people…</p>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          empty={
            <EmptyPanel
              title="No people on this page"
              description="Invite a user or turn the page."
            />
          }
        />
      )}
      <div className="flex items-center gap-3 text-sm">
        <Button
          variant="secondary"
          size="sm"
          isDisabled={cursors.length === 1}
          onPress={() => setCursors((old) => old.slice(0, -1))}
        >
          Previous
        </Button>
        <span>Page {cursors.length}</span>
        <Button
          variant="secondary"
          size="sm"
          isDisabled={!result || result.isDone}
          onPress={() => {
            if (result && !result.isDone)
              setCursors((old) => [...old, result.continueCursor]);
          }}
        >
          Next
        </Button>
      </div>
      {selected ? (
        <form
          onSubmit={submit}
          className="grid gap-3 rounded-lg border border-border bg-surface p-5"
        >
          <h3 className="font-semibold">Assign {selected.name}</h3>
          <label className="grid gap-1 text-sm">
            Unit
            <select
              className={selectClass}
              name="orgUnitId"
              defaultValue={selected.orgUnitId ?? ""}
              onChange={(event) => {
                setSupervisorUnitId(event.target.value as Id<"orgUnits">);
                setSupervisorSearch("");
                setChosenSupervisorId("");
                setSupervisorCursors([null]);
              }}
              required
            >
              <option value="" disabled>
                Select a unit
              </option>
              {(units ?? [])
                .filter(
                  (unit) =>
                    unit.status === "active" &&
                    (permissions?.scopeUnitIds.includes(unit._id) ?? false),
                )
                .map((unit) => (
                  <option key={unit._id} value={unit._id}>
                    {unit.code} · {unit.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Role
            <select
              className={selectClass}
              name="role"
              defaultValue={selected.role}
              required
            >
              {roles
                .filter(
                  (role) =>
                    role !== "admin" || permissions?.role === "super_admin",
                )
                .map((role) => (
                  <option key={role} value={role}>
                    {role.replaceAll("_", " ")}
                  </option>
                ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Position (optional)
            <select
              className={selectClass}
              name="positionId"
              defaultValue={selected.positionId ?? ""}
            >
              <option value="">Keep current position</option>
              {(positions ?? []).map((position) => (
                <option key={position._id} value={position._id}>
                  {position.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Search supervisors (name, email or employee code)
            <Input
              value={supervisorSearch}
              onChange={(event) => {
                setSupervisorSearch(event.target.value);
                setSupervisorCursors([null]);
              }}
              placeholder="Search by prefix"
            />
          </label>
          <label className="grid gap-1 text-sm">
            Supervisor (optional)
            <select
              className={selectClass}
              name="supervisorId"
              value={chosenSupervisorId}
              onChange={(event) => setChosenSupervisorId(event.target.value)}
            >
              <option value="">Keep current supervisor</option>
              {chosenSupervisorId &&
              !supervisorOptions?.page.some(
                (person) => person._id === chosenSupervisorId,
              ) ? (
                <option value={chosenSupervisorId}>Selected supervisor</option>
              ) : null}
              {(supervisorOptions?.page ?? [])
                .filter((person) => person._id !== selected._id)
                .map((person) => (
                  <option key={person._id} value={person._id}>
                    {person.name} · {person.email}
                  </option>
                ))}
            </select>
          </label>
          <div className="flex items-center gap-2 text-sm">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              isDisabled={supervisorCursors.length === 1}
              onPress={() => setSupervisorCursors((old) => old.slice(0, -1))}
            >
              Previous supervisors
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              isDisabled={!supervisorOptions || supervisorOptions.isDone}
              onPress={() => {
                if (supervisorOptions && !supervisorOptions.isDone)
                  setSupervisorCursors((old) => [
                    ...old,
                    supervisorOptions.continueCursor,
                  ]);
              }}
            >
              Next supervisors
            </Button>
          </div>
          <label className="grid gap-1 text-sm">
            Employee code (set once)
            <Input
              name="employeeCode"
              defaultValue={selected.employeeCode ?? ""}
              disabled={!!selected.employeeCode}
              placeholder="e.g. EMP-001"
            />
          </label>
          <label className="grid gap-1 text-sm">
            Reason (required)
            <textarea
              className="rounded-md border border-border bg-surface p-2"
              name="reason"
              required
              rows={2}
            />
          </label>
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
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      ) : null}
      {historyId ? (
        <aside
          aria-label="Assignment history"
          className="rounded-lg border border-border bg-surface p-5"
        >
          <div className="flex justify-between">
            <h3 className="font-semibold">
              Assignment history · {nameOf(historyId)}
            </h3>
            <Button
              size="sm"
              variant="secondary"
              onPress={() => setHistoryId(null)}
            >
              Close
            </Button>
          </div>
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
                    {unitOf(entry.orgUnitId)} · {positionOf(entry.positionId)} ·
                    Supervisor: {nameOf(entry.supervisorId)}
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
      ) : null}
    </section>
  );
}
