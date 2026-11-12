"use client";
import { useUrlTab } from "../../lib/use-url-tab";
import { formatDate } from "../../lib/format";
import { Button } from "@heroui/react";
import { useIssueQuery, useIssueCommand } from "./data";
import { useLive } from "../../lib/api";
import type { IssueBoard, IssueAssignee } from "./model";
import { Notice, WorkspaceIcon } from "@sunpride/ui";

import { useRouter } from "next/navigation";
import { useDeferredValue, useState } from "react";
import {
  errorMessage,
  issuesCsv,
  ISSUE_AREAS,
  ISSUE_BOARD_LIMIT,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  type IssuePriority,
  type IssueStatus,
} from "../../lib/issues";
import { IssueAccessState, IssuesHeader, useIssueAccess } from "./issue-access";
import { IssuesBoard, type IssueMove } from "./issues-board";
import { IssuesList } from "./issues-list";
const initialFilters = {
  search: "",
  area: "",
  status: "",
  priority: "",
  assignee: "",
  milestone: "",
  archived: false,
  attention: "",
};
const ISSUE_VIEWS = ["board", "list"] as const;

export function IssuesPage() {
  const { access, canRead, loading, error: accessError } = useIssueAccess();
  const router = useRouter();
  const [filters, setFilters] = useState(initialFilters);
  const [view, setView] = useUrlTab(ISSUE_VIEWS, "board", "view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const search = useDeferredValue(filters.search.trim());
  const query = useIssueQuery<IssueBoard>(
    "board",
    canRead
      ? {
          archived: filters.archived,
          attention: filters.attention || undefined,
          search: search || undefined,
          area: filters.area || undefined,
          status: (filters.status || undefined) as IssueStatus | undefined,
          priority: (filters.priority || undefined) as
            IssuePriority | undefined,
          assigneeId: (filters.assignee || undefined) as
            string | "unassigned" | undefined,
          milestone: filters.milestone || undefined,
        }
      : null,
  );
  const result = query.data;
  const { data: assignees } = useIssueQuery<IssueAssignee[]>(
    "assignees",
    canRead ? {} : null,
  );
  useLive(canRead ? ["issues"] : [], [["issues"]]);
  const move = useIssueCommand("move");
  async function moveIssue(input: IssueMove) {
    if (!access?.canTriage || busy || filters.archived) return;
    setBusy(true);
    setError("");
    try {
      await move(input);
    } catch (caught) {
      setError(errorMessage(caught, "Move failed. Try again."));
    } finally {
      setBusy(false);
    }
  }
  if (!canRead)
    return <IssueAccessState loading={loading} error={accessError} />;
  const total = result?.total ?? result?.issues.length;
  const done = result
    ? filters.status
      ? filters.status === "completed"
        ? total
        : 0
      : result.counts.completed
    : undefined;
  function filter(key: keyof typeof initialFilters, value: string | boolean) {
    setFilters((current) => ({ ...current, [key]: value }));
  }
  return (
    <div className="grid min-w-0 gap-4">
      <IssuesHeader
        title="Issues"
        actions={
          access?.canWrite ? (
            <Button
              variant="primary"
              onPress={() => router.push("/issues/new")}
            >
              <WorkspaceIcon name="plus" className="size-4" />
              New issue
            </Button>
          ) : undefined
        }
      />
      {result?.summary && !filters.archived ? (
        <section
          aria-label="What needs attention"
          className="grid gap-3 rounded-2xl border border-border p-4"
        >
          <div>
            <h2 className="text-sm font-medium">
              What is blocking the rollout?
            </h2>
            <p className="text-xs text-muted">
              Goal: no urgent blockers. Select a queue, then open an issue to
              assign, fix or retest it.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {(
              [
                ["urgent", "High-priority blockers", result.summary.urgent],
                [
                  "unassigned",
                  "Open without an owner",
                  result.summary.unassigned,
                ],
                ["retest", "Ready to test", result.summary.readyForRetest],
              ] as const
            ).map(([attention, label, count]) => (
              <Button
                key={attention}
                aria-label={label}
                variant="outline"
                className="h-auto justify-between p-4"
                onPress={() => setFilters({ ...initialFilters, attention })}
              >
                <span>{label}</span>
                <span className="text-xl tabular-nums">{count}</span>
              </Button>
            ))}
          </div>
          <p className="text-[13px] text-muted">
            Moves to Done recorded: {result.summary.completedThisWeek} in the
            last 7 days
            {result.summary.completedPriorWeek === null
              ? " · Prior week unavailable"
              : ` · ${result.summary.completedPriorWeek} in the preceding 7`}
            . Reopened issues can count again.
          </p>
          {result.trend?.length ? (
            <div className="grid gap-2">
              <svg
                viewBox="0 0 280 48"
                role="img"
                aria-label="Moves to Done over 14 Manila days"
                className="h-12 w-full"
              >
                {result.trend.map((day, index) => (
                  <rect
                    key={day.date}
                    x={index * 20 + 2}
                    y={
                      46 -
                      (40 * day.completed) /
                        Math.max(1, ...result.trend.map((d) => d.completed))
                    }
                    width="14"
                    height={
                      day.known === false
                        ? 0
                        : Math.max(
                            1,
                            (40 * day.completed) /
                              Math.max(
                                1,
                                ...result.trend.map((d) => d.completed),
                              ),
                          )
                    }
                    fill="currentColor"
                  >
                    <title>
                      {formatDate(day.date)}:{" "}
                      {day.known === false
                        ? "No historical activity available"
                        : `${day.completed} moves to Done`}
                    </title>
                  </rect>
                ))}
              </svg>
              <p className="text-xs text-muted">{result.historyNote}</p>
            </div>
          ) : null}
          {filters.attention ? (
            <p className="text-xs text-muted">
              Showing the selected attention queue. Reset filters to see all
              issues.
            </p>
          ) : null}
        </section>
      ) : null}
      <section
        aria-label="Issue filters"
        className="grid gap-3 rounded-2xl border border-border bg-surface p-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7"
      >
        <div className="relative">
          <WorkspaceIcon
            name="search"
            className="pointer-events-none absolute left-3 top-3 size-4 text-muted"
          />
          <input
            type="search"
            aria-label="Search issues"
            placeholder="Search number or text"
            value={filters.search}
            className="w-full pl-9"
            onChange={(event) => filter("search", event.target.value)}
          />
        </div>
        <select
          aria-label="Filter area"
          value={filters.area}
          onChange={(event) => filter("area", event.target.value)}
        >
          <option value="">All areas</option>
          {ISSUE_AREAS.map((area) => (
            <option key={area}>{area}</option>
          ))}
        </select>
        <select
          aria-label="Filter status"
          value={filters.status}
          onChange={(event) => filter("status", event.target.value)}
        >
          <option value="">All statuses</option>
          {ISSUE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {ISSUE_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter priority"
          value={filters.priority}
          onChange={(event) => filter("priority", event.target.value)}
        >
          <option value="">All priorities</option>
          {ISSUE_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {priority.charAt(0).toUpperCase() + priority.slice(1)}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter assignee"
          value={filters.assignee}
          onChange={(event) => filter("assignee", event.target.value)}
        >
          <option value="">All assignees</option>
          <option value="unassigned">Unassigned</option>
          {assignees?.map((person) => (
            <option key={person._id} value={person._id}>
              {person.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter milestone"
          value={filters.milestone}
          onChange={(event) => filter("milestone", event.target.value)}
        >
          <option value="">All milestones</option>
          {[
            ...new Set([
              ...(result?.milestones ?? []),
              ...(filters.milestone ? [filters.milestone] : []),
            ]),
          ].map((milestone) => (
            <option key={milestone}>{milestone}</option>
          ))}
        </select>
        <select
          aria-label="Issue scope"
          value={filters.archived ? "archived" : "active"}
          onChange={(event) => {
            const archived = event.target.value === "archived";
            filter("archived", archived);
            if (archived) setView("list");
          }}
        >
          <option value="active">Active issues</option>
          <option value="archived">Archived issues</option>
        </select>
      </section>
      <div className="flex items-center justify-between gap-3 text-[13px] text-muted">
        <p aria-live="polite">
          {total === undefined || done === undefined
            ? "Loading issues…"
            : `${total} issues · ${done} done · ${total - done} open`}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onPress={() => setFilters(initialFilters)}
        >
          Reset filters
        </Button>
      </div>
      <div
        role="group"
        aria-label="Issue view"
        className="flex w-fit gap-1 rounded-xl bg-surface-secondary p-1"
      >
        <Button
          variant="ghost"
          size="sm"
          isDisabled={!result || result.truncated}
          onPress={() => {
            if (!result || result.truncated) return;
            const url = URL.createObjectURL(
              new Blob([issuesCsv(result.issues)], {
                type: "text/csv;charset=utf-8",
              }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = "sunpride-issues.csv";
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          Export CSV
        </Button>
        <Button variant="ghost" size="sm" onPress={() => window.print()}>
          Print
        </Button>
        {(["board", "list"] as const).map((option) => (
          <Button
            key={option}
            variant="ghost"
            aria-pressed={view === option}
            isDisabled={option === "board" && filters.archived}
            className={`h-10 min-h-10 rounded-[10px] ${view === option ? "bg-surface text-foreground" : "text-muted"}`}
            onPress={() => setView(option)}
          >
            <WorkspaceIcon name={option} className="size-4" />
            {option === "board" ? "Board" : "List"}
          </Button>
        ))}
      </div>
      {result?.truncated ? (
        <Notice
          title={`Showing up to ${ISSUE_BOARD_LIMIT} issues`}
          meta="Narrow the search or filters"
        />
      ) : null}
      {error || query.error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error || query.error?.message}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-[13px] text-muted">
          Saving move…
        </p>
      ) : null}
      {query.error ? null : result === undefined ? (
        <p role="status" className="py-10 text-center text-[13px] text-muted">
          Loading issues…
        </p>
      ) : view === "board" && !filters.archived ? (
        <IssuesBoard
          issues={result.issues}
          counts={result.counts}
          canWrite={Boolean(access?.canTriage)}
          onMove={moveIssue}
          busy={busy}
        />
      ) : (
        <IssuesList
          key={JSON.stringify({ ...filters, search })}
          issues={result.issues}
        />
      )}
    </div>
  );
}
