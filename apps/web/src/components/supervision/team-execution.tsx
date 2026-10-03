"use client";

import { api } from "@sunpride/backend/api";
import {
  Card,
  DataTable,
  MetricCard,
  StatusPill,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  formatTime,
  type SupervisionFilters,
  groupBy,
  percent,
  personStatus,
} from "./supervision-model";

type TeamDay = FunctionReturnType<typeof api.supervision.team.day>;
type Person = TeamDay["people"][number] & { id: string };

function flags(person: Person) {
  return [
    person.openExceptions
      ? {
          key: "exceptions",
          label: `${person.openExceptions} to review`,
          tone: "danger" as const,
        }
      : null,
    person.outOfSequence
      ? {
          key: "order",
          label: `${person.outOfSequence} out of order`,
          tone: "warning" as const,
        }
      : null,
    person.lateSync
      ? {
          key: "sync",
          label: `${person.lateSync} late sync`,
          tone: "warning" as const,
        }
      : null,
    person.unplanned
      ? {
          key: "unplanned",
          label: `${person.unplanned} unplanned`,
          tone: "neutral" as const,
        }
      : null,
  ].filter((flag) => flag !== null);
}

export function TeamExecutionView({
  data,
  now,
}: {
  data: TeamDay;
  now: number;
}) {
  const people: Person[] = data.people.map((person) => ({
    ...person,
    id: person.profileId,
  }));
  const totals = people.reduce(
    (sum, person) => ({
      planned: sum.planned + person.planned,
      done: sum.done + person.done,
      productive: sum.productive + person.productive,
      open: sum.open + person.openExceptions,
    }),
    { planned: 0, done: 0, productive: 0, open: 0 },
  );
  const statuses = new Map(
    people.map((person) => [
      person.id,
      personStatus(person, data.serviceDate, data.dayCloseAt, now),
    ]),
  );
  const notStarted = people.filter((person) =>
    ["Not started", "No calls"].includes(statuses.get(person.id)!.label),
  ).length;
  const columns: DataColumn<Person>[] = [
    {
      key: "person",
      label: "Person",
      render: (person) => (
        <span className="flex flex-col">
          <span className="text-sm font-medium text-foreground">
            {person.name}
          </span>
          <span className="font-mono text-xs text-muted">
            {[person.employeeCode, person.positionLabel]
              .filter(Boolean)
              .join(" · ") || "—"}
          </span>
        </span>
      ),
    },
    {
      key: "calls",
      label: "Calls",
      align: "right",
      render: (person) =>
        person.planned ? `${person.done}/${person.planned}` : `${person.done}`,
    },
    {
      key: "productive",
      label: "Productive",
      align: "right",
      render: (person) =>
        `${person.productive} · ${percent(person.productive, person.done)}`,
    },
    {
      key: "first",
      label: "First in",
      align: "right",
      render: (person) => (
        <span className="font-mono text-[13px]">
          {formatTime(person.firstCheckInAt)}
        </span>
      ),
    },
    {
      key: "last",
      label: "Last out",
      align: "right",
      render: (person) => (
        <span className="font-mono text-[13px]">
          {formatTime(person.lastCheckOutAt)}
        </span>
      ),
    },
    {
      key: "sync",
      label: "Last sync",
      align: "right",
      render: (person) => (
        <span className="font-mono text-[13px]">
          {formatTime(person.lastActivityAt)}
        </span>
      ),
    },
    {
      key: "flags",
      label: "Flags",
      render: (person) => {
        const list = flags(person);
        return list.length ? (
          <span className="flex flex-wrap gap-1">
            {list.map((flag) => (
              <StatusPill key={flag.key} tone={flag.tone}>
                {flag.label}
              </StatusPill>
            ))}
          </span>
        ) : (
          <span className="text-muted">—</span>
        );
      },
    },
    {
      key: "status",
      label: "Status",
      render: (person) => {
        const status = statuses.get(person.id)!;
        return <StatusPill tone={status.tone}>{status.label}</StatusPill>;
      },
    },
  ];
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Calls"
          value={`${totals.done}/${totals.planned}`}
          detail={percent(totals.done, totals.planned)}
        />
        <MetricCard
          label="Productive"
          value={String(totals.productive)}
          detail={percent(totals.productive, totals.done)}
        />
        <MetricCard
          label="Not started"
          value={String(notStarted)}
          detail={`of ${people.length}`}
        />
        <MetricCard
          label="To review"
          value={String(totals.open)}
          detail="exceptions"
        />
      </div>
      {data.truncated && (
        <p className="text-[13px] text-muted">
          First {people.length} shown. Pick a unit.
        </p>
      )}
      {people.length === 0 ? (
        <Card label="Team" icon={<WorkspaceIcon name="user" />}>
          <p className="text-[13px] text-muted">No field people here</p>
        </Card>
      ) : (
        groupBy(people, (person) => person.channel).map(([channel, rows]) => {
          const done = rows.reduce((n, row) => n + row.done, 0);
          const planned = rows.reduce((n, row) => n + row.planned, 0);
          const productive = rows.reduce((n, row) => n + row.productive, 0);
          return (
            <Card
              key={channel}
              label={channel}
              count={rows.length}
              icon={<WorkspaceIcon name="user" />}
              actions={
                <span className="text-[13px] tabular-nums text-muted">
                  {done}/{planned} calls · {percent(productive, done)}{" "}
                  productive
                </span>
              }
              flush
            >
              <DataTable rows={rows} columns={columns} bare empty={null} />
            </Card>
          );
        })
      )}
    </div>
  );
}

export function TeamExecution({
  filters,
  now,
}: {
  filters: SupervisionFilters;
  now: number;
}) {
  const data = useQuery(api.supervision.team.day, filters);
  if (data === undefined)
    return <span className="text-[13px] text-muted">Loading team…</span>;
  return <TeamExecutionView data={data} now={now} />;
}
