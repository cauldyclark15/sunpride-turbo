"use client";

import { Button, Input } from "@heroui/react";
import { api } from "./master-data/api";
import type { Doc, Id } from "./master-data/model";
import { FormField, Pager, StatusPill } from "@sunpride/ui";
import { useMutation, useQuery } from "./master-data/api";
import type { FunctionArgs } from "./master-data/api";
import { useCallback, useState, type FormEvent } from "react";
import { AdminSelectField } from "./org-admin";
import { formatManilaDate } from "../lib/manila-date";
import { useSetupParam } from "./master-data/location";
import { ListPage, type ListColumn } from "./list-page/list-page";
import { Drawer } from "./cockpit/kit/drawer";

type Person = Doc<"profiles">;
export type AssignableRole =
  | "admin"
  | "operations"
  | "manager"
  | "approver"
  | "sales"
  | "analyst"
  | "viewer";
export const roleOptions: { value: AssignableRole; label: string }[] = [
  { value: "admin", label: "Administrator" },
  { value: "operations", label: "Operations" },
  { value: "manager", label: "Sales manager" },
  { value: "approver", label: "Approver" },
  { value: "sales", label: "Sales" },
  { value: "analyst", label: "Analyst" },
  { value: "viewer", label: "Viewer" },
];
export const roleLabel = (role: string) =>
  role === "super_admin"
    ? "Super admin"
    : (roleOptions.find((option) => option.value === role)?.label ??
      role
        .replaceAll("_", " ")
        .replace(/^./, (letter) => letter.toUpperCase()));

type Role = AssignableRole;
const roles: Role[] = roleOptions.map((option) => option.value);

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
  const phone = String(data.get("phone") ?? "").trim();
  return assign({
    profileId: selected._id,
    orgUnitId: String(data.get("orgUnitId")) as Id<"orgUnits">,
    role: String(data.get("role")) as Role,
    ...(positionId ? { positionId: positionId as Id<"positions"> } : {}),
    ...(supervisorId ? { supervisorId: supervisorId as Id<"profiles"> } : {}),
    ...(!selected.employeeCode && employeeCode ? { employeeCode } : {}),
    ...(phone !== (selected.phone ?? "") ? { phone: phone || null } : {}),
    reason,
  });
}

/** Sets or clears Setup URL params (q, filter) so reload and back keep the view. */
function setParams(values: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values))
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event("popstate"));
}

type Invitation = {
  _id: Id<"accessInvitations">;
  email: string;
  name?: string;
  role: string;
  status: string;
};

const readableError = (error: unknown) =>
  error instanceof Error ? error.message : "Could not save. Try again.";

/** Who may edit a person: unchanged from the old Assign button. */
export function canEditPerson(
  row: Pick<Person, "role">,
  canManage: boolean,
  actorRole: string | undefined,
) {
  return (
    canManage &&
    row.role !== "super_admin" &&
    !(row.role === "admin" && actorRole !== "super_admin")
  );
}

export function PeopleAdmin() {
  const q = useSetupParam("q");
  const filterParam = useSetupParam("filter");
  const legacyUnassigned = useSetupParam("unassigned") === "true";
  const unassigned = filterParam === "unassigned" || legacyUnassigned;
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const canManage = permissions?.capabilities.includes("admin.manage") ?? false;
  const current = useQuery(api.domains.profiles.current, {});
  // Adding a person (an invitation) keeps its old gate: national admins only.
  const canAdd =
    (current?.role === "super_admin" || current?.role === "admin") &&
    permissions?.national !== false;
  const invited = filterParam === "invited" && canAdd;
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const result = useQuery(
    api.people.queries.list,
    invited
      ? "skip"
      : {
          ...(unassigned ? { unassigned: "true" } : {}),
          ...(q ? { q } : {}),
          paginationOpts: { numItems: 25, cursor },
        },
  );
  const invitationPage = useQuery(
    api.domains.profiles.listInvitations,
    invited
      ? {
          ...(q ? { q } : {}),
          paginationOpts: { numItems: 25, cursor },
        }
      : "skip",
  );
  const [asOf] = useState(() => Date.now());
  const units = useQuery(api.org.queries.tree, { asOf });
  const positions = useQuery(
    api.sfa.positions.list,
    canManage || canAdd ? {} : "skip",
  );
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
  const invite = useMutation(api.domains.profiles.invite);
  const revoke = useMutation(api.domains.profiles.revoke);
  const [historyId, setHistoryId] = useState<Id<"profiles"> | null>(null);
  const shownHistory = selectedId ?? historyId;
  const history = useQuery(
    api.people.queries.history,
    shownHistory ? { profileId: shownHistory } : "skip",
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [adding, setAdding] = useState<string | false>(false);
  const [role, setRole] = useState<AssignableRole>("viewer");
  const [positionId, setPositionId] = useState("");
  const [orgUnitId, setOrgUnitId] = useState("");
  const people = result?.page ?? [];
  const selected = people.find((person) => person._id === selectedId);
  const nameOf = (id?: Id<"profiles">) =>
    (supervisorOptions?.page ?? people).find((person) => person._id === id)
      ?.name ?? (id ? "Person unavailable" : "—");
  const unitOf = (id?: Id<"orgUnits">) =>
    units?.find((unit) => unit._id === id)?.name ??
    (id ? "Outside current tree" : "—");
  const positionOf = (id?: Id<"positions">) =>
    positions?.find((position) => position._id === id)?.label ??
    (id ? "Position unavailable" : "—");
  const supervisorOf = (subject?: string) =>
    (supervisorOptions?.page ?? people).find(
      (person) => person.authSubject === subject,
    )?.name ?? (subject ? "Supervisor unavailable" : "—");

  const onSearch = useCallback((text: string) => {
    setCursors([null]);
    setParams({ q: text || null });
  }, []);
  const closeEdit = useCallback(() => setSelectedId(null), []);
  const closeHistory = useCallback(() => setHistoryId(null), []);
  const closeAdd = useCallback(() => setAdding(false), []);

  function openEdit(row: Person) {
    setSelectedId(row._id);
    setSupervisorUnitId(row.orgUnitId ?? null);
    setSupervisorSearch("");
    setChosenSupervisorId("");
    setSupervisorCursors([null]);
    setError("");
    setNotice("");
  }

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
      setNotice("Saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  async function submitAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAdd || pending) return;
    setPending(true);
    setError("");
    setNotice("");
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const name = String(data.get("name") ?? "").trim();
    try {
      await invite({
        email,
        role,
        ...(name ? { name } : {}),
        ...(positionId ? { positionId: positionId as Id<"positions"> } : {}),
        ...(orgUnitId ? { orgUnitId } : {}),
      });
      setAdding(false);
      setRole("viewer");
      setPositionId("");
      setOrgUnitId("");
      setNotice(`${name || email} added.`);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setPending(false);
    }
  }

  async function removeInvitation(invitationId: Id<"accessInvitations">) {
    setError("");
    setNotice("");
    try {
      await revoke({ invitationId });
      setNotice("Removed.");
    } catch (cause) {
      setError(readableError(cause));
    }
  }

  const filters = [
    { id: "unassigned", label: "No unit" },
    ...(canAdd ? [{ id: "invited", label: "Invited" }] : []),
  ];
  const filter = invited ? "invited" : unassigned ? "unassigned" : null;
  const onFilter = (id: string | null) => {
    setCursors([null]);
    setParams({ filter: id, unassigned: null });
  };
  const pager = (
    page: { isDone: boolean; continueCursor: string } | undefined,
  ) => (
    <Pager
      label="People pages"
      page={cursors.length}
      canPrevious={cursors.length > 1}
      canNext={!!page && !page.isDone}
      onPrevious={() => setCursors((old) => old.slice(0, -1))}
      onNext={() => {
        if (page && !page.isDone)
          setCursors((old) => [...old, page.continueCursor]);
      }}
    />
  );
  const shared = {
    noun: { one: "person", many: "people" },
    total: null,
    page: cursors.length,
    onPage: () => {},
    q,
    onSearch,
    searchPlaceholder: "Search by name, email or code",
    onAdd: canAdd ? (name: string) => setAdding(name) : undefined,
    filters,
    filter,
    onFilter,
    exportName: "people",
  };

  const columns: ListColumn<Person>[] = [
    {
      key: "name",
      label: "Person",
      primary: true,
      text: (row) => row.name?.trim() || row.email,
      render: (row) => (
        <span className="block min-w-0">
          <span className="block truncate">
            {row.name?.trim() || row.email}
          </span>
          {row.name?.trim() || row.employeeCode ? (
            <span className="block truncate text-[13px] font-normal text-muted">
              {row.name?.trim() ? row.email : null}
              {row.name?.trim() && row.employeeCode ? " · " : null}
              {row.employeeCode ?? null}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "role",
      label: "Role",
      text: (row) => roleLabel(row.role),
      render: (row) =>
        `${roleLabel(row.role)}${row.positionId ? ` · ${positionOf(row.positionId)}` : ""}`,
    },
    {
      key: "unit",
      label: "Unit",
      text: (row) => unitOf(row.orgUnitId),
      render: (row) =>
        `${unitOf(row.orgUnitId)}${row.supervisorSubject ? ` · ${supervisorOf(row.supervisorSubject)}` : ""}`,
    },
    {
      key: "status",
      label: "Status",
      text: (row) => row.status,
      render: (row) => (
        <StatusPill tone={row.status === "active" ? "success" : "neutral"}>
          {row.status}
        </StatusPill>
      ),
    },
    {
      key: "edit",
      label: "",
      align: "right",
      render: (row) =>
        canEditPerson(row, canManage, permissions?.role) ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 whitespace-nowrap"
            onPress={() => openEdit(row)}
          >
            Edit
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-8 whitespace-nowrap"
            onPress={() => setHistoryId(row._id)}
          >
            History
          </Button>
        ),
    },
  ];
  const invitationColumns: ListColumn<Invitation>[] = [
    {
      key: "name",
      label: "Person",
      primary: true,
      text: (row) => row.name?.trim() || row.email,
      render: (row) => (
        <span className="block min-w-0">
          <span className="block truncate">
            {row.name?.trim() || row.email}
          </span>
          {row.name?.trim() ? (
            <span className="block truncate text-[13px] font-normal text-muted">
              {row.email}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "role",
      label: "Role",
      text: (row) => roleLabel(row.role),
      render: (row) => roleLabel(row.role),
    },
    {
      key: "status",
      label: "Status",
      text: (row) => row.status,
      render: (row) => (
        <StatusPill
          tone={
            row.status === "accepted"
              ? "success"
              : row.status === "revoked"
                ? "danger"
                : "warning"
          }
        >
          {row.status}
        </StatusPill>
      ),
    },
    {
      key: "remove",
      label: "",
      align: "right",
      render: (row) =>
        row.role === "super_admin" || row.status === "revoked" ? null : (
          <Button
            size="sm"
            variant="outline"
            className="h-8 whitespace-nowrap"
            onPress={() => void removeInvitation(row._id)}
          >
            Remove
          </Button>
        ),
    },
  ];

  const historyList = (
    <section aria-label="Assignment history" className="grid gap-2">
      <h3 className="text-[13px] font-semibold text-foreground">History</h3>
      {history === undefined ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : history.length === 0 ? (
        <p className="text-sm text-muted">No changes yet.</p>
      ) : (
        <ol className="grid gap-2">
          {[...history]
            .sort((a, b) => b.effectiveFrom - a.effectiveFrom)
            .map((entry) => (
              <li
                key={entry._id}
                className="rounded-lg border border-border p-3 text-sm"
              >
                <strong>{roleLabel(entry.role)}</strong> ·{" "}
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
    </section>
  );

  return (
    <div className="grid gap-4">
      <h2 className="text-[20px] font-semibold text-foreground">People</h2>
      {notice ? (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      ) : null}
      {error && !selected && adding === false ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {invited ? (
        <ListPage<Invitation>
          {...shared}
          rows={(invitationPage?.page as Invitation[] | undefined) ?? null}
          loading={invitationPage === undefined}
          columns={invitationColumns}
          rowKey={(row) => row._id}
        />
      ) : (
        <ListPage<Person>
          {...shared}
          rows={result ? people : null}
          loading={result === undefined}
          columns={columns}
          rowKey={(row) => row._id}
        />
      )}
      {pager(invited ? invitationPage : result)}

      <Drawer
        open={!!selected}
        title={
          selected
            ? `Edit ${selected.name?.trim() || selected.email}`
            : "Edit person"
        }
        onClose={closeEdit}
        wide
      >
        {selected ? (
          <div className="grid gap-6">
            <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
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
                    label: roleLabel(role),
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
              <div className="sm:col-span-2">
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
              <FormField label="Phone number">
                <Input
                  name="phone"
                  type="tel"
                  defaultValue={selected.phone ?? ""}
                  placeholder="e.g. 0917 123 4567"
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
                <p role="alert" className="text-sm text-danger sm:col-span-2">
                  {error}
                </p>
              ) : null}
              <div className="flex gap-2 sm:col-span-2">
                <Button
                  type="submit"
                  variant="primary"
                  isDisabled={!canManage}
                  isPending={pending}
                >
                  Save
                </Button>
                <Button type="button" variant="outline" onPress={closeEdit}>
                  Cancel
                </Button>
              </div>
            </form>
            {historyList}
          </div>
        ) : null}
      </Drawer>

      <Drawer
        open={!!historyId && !selected}
        title={`History · ${nameOf(historyId ?? undefined)}`}
        onClose={closeHistory}
      >
        {historyList}
      </Drawer>

      <Drawer open={adding !== false} title="Add person" onClose={closeAdd}>
        {adding !== false && current ? (
          <form onSubmit={submitAdd} className="grid gap-4">
            <FormField label="Full name">
              <Input
                name="name"
                defaultValue={adding && !adding.includes("@") ? adding : ""}
                placeholder="Juan Dela Cruz"
              />
            </FormField>
            <FormField label="Email">
              <Input
                name="email"
                type="email"
                required
                defaultValue={adding && adding.includes("@") ? adding : ""}
                placeholder="name@sunpride.com.ph"
              />
            </FormField>
            <AdminSelectField
              label="Role"
              value={role}
              onChange={(value) => setRole(value as AssignableRole)}
              options={roleOptions
                .filter(
                  (option) =>
                    option.value !== "admin" || current.role === "super_admin",
                )
                .map((option) => ({ id: option.value, label: option.label }))}
            />
            <AdminSelectField
              label="Position"
              value={positionId}
              onChange={setPositionId}
              options={[
                { id: "", label: "No position" },
                ...(positions ?? []).map((position) => ({
                  id: position._id,
                  label: position.label,
                })),
              ]}
            />
            <AdminSelectField
              label="Unit"
              value={orgUnitId}
              onChange={setOrgUnitId}
              options={[
                { id: "", label: "Pick later" },
                ...(units ?? [])
                  .filter((u) => u.status === "active")
                  .map((u) => ({ id: u._id, label: `${u.code} · ${u.name}` })),
              ]}
            />
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button type="submit" variant="primary" isPending={pending}>
                Save
              </Button>
              <Button type="button" variant="outline" onPress={closeAdd}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </Drawer>
    </div>
  );
}
