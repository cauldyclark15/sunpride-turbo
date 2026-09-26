"use client";

import { Button, Input } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  DataTable,
  ListRow,
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
import { formatManilaDate, futureManilaDateToUtcMs } from "../lib/manila-date";

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
        <span className="whitespace-nowrap">
          <StatusPill tone={row.status === "active" ? "success" : "neutral"}>
            {row.status}
          </StatusPill>
        </span>
      ),
    },
    {
      key: "actions",
      label: "Actions",
      align: "right",
      render: (row) => (
        <Button
          size="sm"
          variant="outline"
          className="h-8 whitespace-nowrap"
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
            empty={<p className="p-4 text-sm text-muted">No teams yet</p>}
          />
        )}
        <Pager
          label="Teams pages"
          page={cursors.length}
          canPrevious={cursors.length > 1}
          canNext={!!teams && !teams.isDone}
          onPrevious={() => setCursors((old) => old.slice(0, -1))}
          onNext={() => {
            if (teams && !teams.isDone)
              setCursors((old) => [...old, teams.continueCursor]);
          }}
        />
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
                        <span className="flex flex-nowrap justify-end gap-2 whitespace-nowrap">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 whitespace-nowrap"
                            onPress={() => setHistoryProfileId(profile._id)}
                          >
                            History
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 whitespace-nowrap"
                            isDisabled={!canManage || !activeTeam}
                            onPress={() => {
                              setHistoryProfileId(profile._id);
                              setAction("remove");
                              setError("");
                            }}
                          >
                            Remove member
                          </Button>
                        </span>
                      }
                    />
                  ))}
                </div>
              )}
              {canManage && activeTeam ? (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onPress={() => {
                      setAction("add");
                      setError("");
                    }}
                  >
                    Add member
                  </Button>
                  <Button
                    variant="outline"
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
              <Pager
                label="People pages"
                page={peopleCursors.length}
                canPrevious={peopleCursors.length > 1}
                canNext={!!people && !people.isDone}
                onPrevious={() => setPeopleCursors((old) => old.slice(0, -1))}
                onNext={() => {
                  if (people && !people.isDone)
                    setPeopleCursors((old) => [...old, people.continueCursor]);
                }}
              />
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
          <form
            onSubmit={submit}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {action === "create" ? (
              <>
                <FormField label="Code">
                  <Input name="code" required />
                </FormField>
                <FormField label="Name">
                  <Input name="name" required />
                </FormField>
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
            <FormField label="Effective date">
              <input type="date" name="effectiveDate" required />
            </FormField>
            <FormField label="Reason">
              <textarea
                name="reason"
                required
                rows={2}
                className="min-h-20 rounded-[10px] border border-border bg-surface p-3 text-sm"
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
                isPending={pending}
                isDisabled={!canManage}
              >
                Save change
              </Button>
              <Button
                type="button"
                variant="outline"
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
