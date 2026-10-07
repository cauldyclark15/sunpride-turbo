"use client";
import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { Notice, WorkspaceIcon } from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useDeferredValue, useState } from "react";
import {
  errorMessage,
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
};
export function IssuesPage() {
  const { access, canRead, loading } = useIssueAccess();
  const router = useRouter();
  const [filters, setFilters] = useState(initialFilters);
  const [view, setView] = useState<"board" | "list">("board");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const search = useDeferredValue(filters.search.trim());
  const result = useQuery(
    api.issues.queries.board,
    canRead
      ? {
          archived: filters.archived,
          search: search || undefined,
          area: filters.area || undefined,
          status: (filters.status || undefined) as IssueStatus | undefined,
          priority: (filters.priority || undefined) as
            IssuePriority | undefined,
          assigneeId: (filters.assignee || undefined) as
            Id<"profiles"> | "unassigned" | undefined,
          milestone: filters.milestone || undefined,
        }
      : "skip",
  );
  const assignees = useQuery(
    api.issues.queries.assignees,
    canRead ? {} : "skip",
  );
  const move = useMutation(api.issues.mutations.move);
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
  if (!canRead) return <IssueAccessState loading={loading} />;
  const total = result?.issues.length;
  const done = result?.issues.filter(
    (issue) => issue.status === "completed",
  ).length;
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
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-[13px] text-muted">
          Saving move…
        </p>
      ) : null}
      {result === undefined ? (
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
