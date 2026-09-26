"use client";

import { Button, Input } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  DataTable,
  ListRow,
  StatusPill,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useState, type FormEvent } from "react";
import { AdminSelectField } from "./org-admin";
import { formatManilaDate, futureManilaDateToUtcMs } from "../lib/manila-date";

const fieldClass =
  "h-10 rounded-[10px] border border-border bg-surface px-3 text-sm text-foreground shadow-none";
const fieldLabel = "grid gap-1.5 text-[13px] font-medium text-foreground";
type TeamAction = "create" | "add" | "remove" | "deactivate";
type TeamMutations = {
  create: (
    args: FunctionArgs<typeof api.teams.mutations.create>,
  ) => Promise<unknown>;
  addMember: (
    args: FunctionArgs<typeof api.teams.mutations.addMember>,
  ) => Promise<unknown>;
  removeMember: (
    args: FunctionArgs<typeof api.teams.mutations.removeMember>,
  ) => Promise<unknown>;
  deactivate: (
    args: FunctionArgs<typeof api.teams.mutations.deactivate>,
  ) => Promise<unknown>;
};

export async function performTeamAction(
  action: TeamAction,
  data: Pick<FormData, "get">,
  mutations: TeamMutations,
  teamId?: Id<"teams">,
) {
  const reason = String(data.get("reason") ?? "").trim();
  if (!reason) throw new Error("Reason required");
  const date = futureManilaDateToUtcMs(String(data.get("effectiveDate") ?? ""));
  if (action === "create")
    return mutations.create({
      code: String(data.get("code") ?? "").trim(),
      name: String(data.get("name") ?? "").trim(),
      orgUnitId: String(data.get("orgUnitId") ?? "") as Id<"orgUnits">,
      effectiveFrom: date,
      reason,
    });
  if (!teamId) throw new Error("Select a team");
  if (action === "deactivate")
    return mutations.deactivate({ teamId, effectiveTo: date, reason });
  const profileId = String(data.get("profileId") ?? "") as Id<"profiles">;
  if (!profileId) throw new Error("Select a person");
  if (action === "add")
    return mutations.addMember({
      teamId,
      profileId,
      effectiveFrom: date,
      reason,
    });
  return mutations.removeMember({
    teamId,
    profileId,
    effectiveTo: date,
    reason,
  });
}

export function TeamsAdmin() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const canManage = permissions?.capabilities.includes("admin.manage") ?? false;
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const teams = useQuery(api.teams.queries.list, {
    paginationOpts: {
      numItems: 25,
      cursor: cursors[cursors.length - 1] ?? null,
    },
  });
  const [selectedId, setSelectedId] = useState<Id<"teams"> | null>(null);
  const detail = useQuery(
    api.teams.queries.detail,
    selectedId ? { teamId: selectedId } : "skip",
  );
  const [asOf] = useState(() => Date.now());
  const units = useQuery(api.org.queries.tree, { asOf });
  const [peopleCursors, setPeopleCursors] = useState<(string | null)[]>([null]);
  const people = useQuery(api.people.queries.list, {
    paginationOpts: {
      numItems: 50,
      cursor: peopleCursors[peopleCursors.length - 1] ?? null,
    },
  });
  const [historyProfileId, setHistoryProfileId] =
    useState<Id<"profiles"> | null>(null);
  const history = useQuery(
    api.teams.queries.memberHistory,
    selectedId && historyProfileId
      ? { teamId: selectedId, profileId: historyProfileId }
      : "skip",
  );
  const create = useMutation(api.teams.mutations.create);
  const addMember = useMutation(api.teams.mutations.addMember);
  const removeMember = useMutation(api.teams.mutations.removeMember);
  const deactivate = useMutation(api.teams.mutations.deactivate);
  const [action, setAction] = useState<TeamAction | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const activeTeam =
    detail?.team.status === "active" &&
    (detail.team.effectiveTo === undefined || detail.team.effectiveTo > asOf);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || !action || pending) return;
    setError("");
    setNotice("");
    setPending(true);
    try {
      await performTeamAction(
        action,
        new FormData(event.currentTarget),
        { create, addMember, removeMember, deactivate },
        selectedId ?? undefined,
      );
      setAction(null);
      setNotice("Team saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  const teamRows = (teams?.page ?? []).map((team) => ({
    ...team,
    id: team._id,
  }));
  const columns: DataColumn<(typeof teamRows)[number]>[] = [
    {
      key: "name",
      label: "Team",
      render: (row) => (
        <span className="block">
          <span className="block text-sm font-medium">{row.name}</span>
          <span className="block font-mono text-xs text-muted">{row.code}</span>
        </span>
      ),
    },
    {
      key: "unit",
      label: "Unit",
      render: (row) =>
        units?.find((unit) => unit._id === row.orgUnitId)?.name ??
        row.orgUnitId,
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
        <Button
          size="sm"
          variant="secondary"
          onPress={() => {
            setSelectedId(row._id);
            setHistoryProfileId(null);
            setAction(null);
          }}
        >
          View team
        </Button>
      ),
    },
  ];

  return (
    <div className="grid gap-4">
      <Card
        label="Teams"
        icon={<WorkspaceIcon name="user" />}
        count={teams?.page.length}
        actions={
          canManage ? (
            <Button
              variant="primary"
              className="h-10 rounded-[10px]"
              onPress={() => {
                setAction("create");
                setError("");
              }}
            >
              New team
            </Button>
          ) : undefined
        }
        flush
      >
        {teams === undefined ? (
          <p className="p-4 text-sm text-muted">Loading teams…</p>
        ) : (
          <DataTable
            bare
            rows={teamRows}
            columns={columns}
            empty={
              <p className="p-4 text-sm text-muted">No teams on this page</p>
            }
          />
        )}
        <div className="flex items-center gap-2 border-t border-separator p-4 text-sm">
          <Button
            size="sm"
            variant="secondary"
            isDisabled={cursors.length === 1}
            onPress={() => setCursors((old) => old.slice(0, -1))}
          >
            Previous teams
          </Button>
          <span>Page {cursors.length}</span>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!teams || teams.isDone}
            onPress={() => {
              if (teams && !teams.isDone)
                setCursors((old) => [...old, teams.continueCursor]);
            }}
          >
            Next teams
          </Button>
        </div>
      </Card>
      {selectedId &&
        (detail === undefined ? (
          <Card label="Team detail">Loading team…</Card>
        ) : (
          <Card label={`${detail.team.name} · ${detail.team.code}`}>
            <aside aria-label="Team detail" className="grid gap-4">
              <p className="text-[13px] text-muted">
                Effective {formatManilaDate(detail.team.effectiveFrom)}
                {detail.team.effectiveTo
                  ? ` – ${formatManilaDate(detail.team.effectiveTo)}`
                  : " onward"}
              </p>
              <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted">
                Current members
              </h4>
              {detail.members.length === 0 ? (
                <p className="text-sm text-muted">No current members</p>
              ) : (
                <div className="-mx-4 border-y border-separator">
                  {detail.members.map(({ membership, profile }) => (
                    <ListRow
                      key={membership._id}
                      icon={<WorkspaceIcon name="user" />}
                      title={profile.name}
                      meta={`${profile.email} · ${formatManilaDate(membership.effectiveFrom)}`}
                      action={
                        <span className="flex gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            onPress={() => setHistoryProfileId(profile._id)}
                          >
                            History
                          </Button>
                          {canManage && activeTeam ? (
                            <Button
                              size="sm"
                              variant="danger-soft"
                              onPress={() => {
                                setHistoryProfileId(profile._id);
                                setAction("remove");
                                setError("");
                              }}
                            >
                              Remove member
                            </Button>
                          ) : null}
                        </span>
                      }
                    />
                  ))}
                </div>
              )}
              {canManage && activeTeam ? (
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setAction("add");
                      setError("");
                    }}
                  >
                    Add member
                  </Button>
                  <Button
                    variant="danger-soft"
                    onPress={() => {
                      setAction("deactivate");
                      setError("");
                    }}
                  >
                    Deactivate team
                  </Button>
                </div>
              ) : null}
              <AdminSelectField
                label="Membership history"
                value={historyProfileId ?? ""}
                onChange={(value) =>
                  setHistoryProfileId(value ? (value as Id<"profiles">) : null)
                }
                options={[
                  { id: "", label: "Select a person" },
                  ...(historyProfileId &&
                  !people?.page.some(
                    (person) => person._id === historyProfileId,
                  )
                    ? [{ id: historyProfileId, label: "Selected person" }]
                    : []),
                  ...(people?.page ?? []).map((person) => ({
                    id: person._id,
                    label: `${person.name} · ${person.email}`,
                  })),
                ]}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={peopleCursors.length === 1}
                  onPress={() => setPeopleCursors((old) => old.slice(0, -1))}
                >
                  Previous people
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={!people || people.isDone}
                  onPress={() => {
                    if (people && !people.isDone)
                      setPeopleCursors((old) => [
                        ...old,
                        people.continueCursor,
                      ]);
                  }}
                >
                  Next people
                </Button>
              </div>
              {historyProfileId &&
                (history === undefined ? (
                  <p>Loading member history…</p>
                ) : history.length ? (
                  <ol className="grid gap-1 text-sm">
                    {history.map((entry) => (
                      <li key={entry._id}>
                        {formatManilaDate(entry.effectiveFrom)}
                        {entry.effectiveTo
                          ? ` – ${formatManilaDate(entry.effectiveTo)}`
                          : " onward"}{" "}
                        · {entry.reason}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-muted">
                    No membership history for this person.
                  </p>
                ))}
            </aside>
          </Card>
        ))}
      {action && canManage ? (
        <Card
          label={
            action === "create"
              ? "New team"
              : action === "add"
                ? "Add member"
                : action === "remove"
                  ? "Remove member"
                  : "Deactivate team"
          }
        >
          <form onSubmit={submit} className="grid max-w-xl gap-4">
            {action === "create" ? (
              <>
                <label className={fieldLabel}>
                  Code <Input className={fieldClass} name="code" required />
                </label>
                <label className={fieldLabel}>
                  Name <Input className={fieldClass} name="name" required />
                </label>
                <AdminSelectField
                  key="new-team-unit"
                  name="orgUnitId"
                  label="Unit"
                  required
                  options={[
                    { id: "", label: "Select a unit" },
                    ...(units ?? [])
                      .filter(
                        (unit) =>
                          unit.status === "active" &&
                          permissions?.scopeUnitIds.includes(unit._id),
                      )
                      .map((unit) => ({
                        id: unit._id,
                        label: `${unit.code} · ${unit.name}`,
                      })),
                  ]}
                />
              </>
            ) : null}
            {action === "add" ? (
              <AdminSelectField
                name="profileId"
                label="Person"
                required
                options={[
                  { id: "", label: "Select a person" },
                  ...(people?.page ?? [])
                    .filter(
                      (person) =>
                        person.status === "active" &&
                        person.orgUnitId &&
                        permissions?.scopeUnitIds.includes(person.orgUnitId) &&
                        !detail?.members.some(
                          (member) => member.profile._id === person._id,
                        ),
                    )
                    .map((person) => ({
                      id: person._id,
                      label: `${person.name} · ${person.email}`,
                    })),
                ]}
              />
            ) : null}
            {action === "remove" ? (
              <>
                <input
                  type="hidden"
                  name="profileId"
                  value={historyProfileId ?? ""}
                />
                <p className="text-sm">
                  Removing{" "}
                  {detail?.members.find(
                    (m) => m.profile._id === historyProfileId,
                  )?.profile.name ?? historyProfileId}
                </p>
              </>
            ) : null}
            <label className={fieldLabel}>
              Effective date
              <input
                type="date"
                name="effectiveDate"
                className={fieldClass}
                required
              />
            </label>
            <label className={fieldLabel}>
              Reason
              <textarea
                name="reason"
                required
                rows={2}
                className="min-h-20 rounded-[10px] border border-border bg-surface p-3 text-sm"
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
                isPending={pending}
                isDisabled={!canManage}
              >
                Save change
              </Button>
              <Button
                type="button"
                variant="secondary"
                onPress={() => setAction(null)}
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
    </div>
  );
}
