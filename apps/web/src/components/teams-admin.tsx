"use client";

import { Button, Input } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useState, type FormEvent } from "react";
import { formatManilaDate, futureManilaDateToUtcMs } from "../lib/manila-date";

const fieldClass =
  "h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground";
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
      setNotice(
        "Team change saved. Future changes take effect on their selected date.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="grid gap-5">
      <div>
        <h2 className="text-lg font-semibold">Teams</h2>
        <p className="text-sm text-muted">
          Scoped teams and effective-dated memberships · Asia/Manila dates
        </p>
      </div>
      {canManage ? (
        <Button
          variant="primary"
          onPress={() => {
            setAction("create");
            setError("");
          }}
        >
          Create team
        </Button>
      ) : null}
      {teams === undefined ? (
        <p>Loading teams…</p>
      ) : teams.page.length === 0 ? (
        <p className="text-sm text-muted">No teams on this page.</p>
      ) : (
        <ul className="grid gap-2">
          {teams.page.map((team) => (
            <li
              key={team._id}
              className="rounded-md border border-border bg-surface p-3"
            >
              <Button
                variant="secondary"
                onPress={() => {
                  setSelectedId(team._id);
                  setHistoryProfileId(null);
                  setAction(null);
                }}
              >
                {team.code} · {team.name}
              </Button>
              <span className="ml-2 text-sm text-muted">
                {team.status} ·{" "}
                {units?.find((u) => u._id === team.orgUnitId)?.name ??
                  team.orgUnitId}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 text-sm">
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
      {selectedId &&
        (detail === undefined ? (
          <p>Loading team detail…</p>
        ) : (
          <aside
            aria-label="Team detail"
            className="grid gap-3 rounded-lg border border-border bg-surface p-5"
          >
            <h3 className="font-semibold">
              {detail.team.name} · {detail.team.code}
            </h3>
            <p className="text-sm text-muted">
              Effective {formatManilaDate(detail.team.effectiveFrom)}
              {detail.team.effectiveTo
                ? ` – ${formatManilaDate(detail.team.effectiveTo)}`
                : " onward"}
            </p>
            <h4 className="font-medium">Current members</h4>
            {detail.members.length === 0 ? (
              <p className="text-sm text-muted">No current members.</p>
            ) : (
              <ul className="grid gap-2">
                {detail.members.map(({ membership, profile }) => (
                  <li
                    key={membership._id}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span>
                      {profile.name} · {profile.email} · from{" "}
                      {formatManilaDate(membership.effectiveFrom)}
                    </span>
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
                          variant="secondary"
                          onPress={() => {
                            setHistoryProfileId(profile._id);
                            setAction("remove");
                            setError("");
                          }}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
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
                  variant="secondary"
                  onPress={() => {
                    setAction("deactivate");
                    setError("");
                  }}
                >
                  Deactivate team
                </Button>
              </div>
            ) : null}
            <label className="grid gap-1 text-sm">
              Membership history for person
              <select
                className={fieldClass}
                value={historyProfileId ?? ""}
                onChange={(event) =>
                  setHistoryProfileId(
                    event.target.value
                      ? (event.target.value as Id<"profiles">)
                      : null,
                  )
                }
              >
                <option value="">Select a person</option>
                {historyProfileId &&
                !people?.page.some((p) => p._id === historyProfileId) ? (
                  <option value={historyProfileId}>Selected person</option>
                ) : null}
                {(people?.page ?? []).map((person) => (
                  <option key={person._id} value={person._id}>
                    {person.name} · {person.email}
                  </option>
                ))}
              </select>
            </label>
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
                    setPeopleCursors((old) => [...old, people.continueCursor]);
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
        ))}
      {action && canManage ? (
        <form
          onSubmit={submit}
          className="grid gap-3 rounded-lg border border-border bg-surface p-5"
        >
          <h3 className="font-semibold">
            {action === "create"
              ? "Create team"
              : action === "add"
                ? "Add member"
                : action === "remove"
                  ? "Remove member"
                  : "Deactivate team"}
          </h3>
          {action === "create" ? (
            <>
              <label className="grid gap-1 text-sm">
                Code <Input name="code" required />
              </label>
              <label className="grid gap-1 text-sm">
                Name <Input name="name" required />
              </label>
              <label className="grid gap-1 text-sm">
                Unit
                <select
                  className={fieldClass}
                  name="orgUnitId"
                  required
                  defaultValue=""
                >
                  <option value="" disabled>
                    Select a unit
                  </option>
                  {(units ?? [])
                    .filter(
                      (unit) =>
                        unit.status === "active" &&
                        permissions?.scopeUnitIds.includes(unit._id),
                    )
                    .map((unit) => (
                      <option key={unit._id} value={unit._id}>
                        {unit.code} · {unit.name}
                      </option>
                    ))}
                </select>
              </label>
            </>
          ) : null}
          {action === "add" ? (
            <label className="grid gap-1 text-sm">
              Person
              <select
                className={fieldClass}
                name="profileId"
                required
                defaultValue=""
              >
                <option value="" disabled>
                  Select a person
                </option>
                {(people?.page ?? [])
                  .filter(
                    (person) =>
                      person.status === "active" &&
                      person.orgUnitId &&
                      permissions?.scopeUnitIds.includes(person.orgUnitId) &&
                      !detail?.members.some(
                        (m) => m.profile._id === person._id,
                      ),
                  )
                  .map((person) => (
                    <option key={person._id} value={person._id}>
                      {person.name} · {person.email}
                    </option>
                  ))}
              </select>
            </label>
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
                {detail?.members.find((m) => m.profile._id === historyProfileId)
                  ?.profile.name ?? historyProfileId}
              </p>
            </>
          ) : null}
          <label className="grid gap-1 text-sm">
            Effective date (Asia/Manila)
            <input
              type="date"
              name="effectiveDate"
              className={fieldClass}
              required
            />
          </label>
          <label className="grid gap-1 text-sm">
            Reason (required)
            <textarea
              name="reason"
              required
              rows={2}
              className="rounded-md border border-border bg-surface p-2"
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
              Save team change
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
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
