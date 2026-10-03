"use client";
import Link from "next/link";
import { useRef, useState, type DragEvent } from "react";
import type { Id } from "@sunpride/backend/data-model";
import { WorkspaceIcon } from "@sunpride/ui";
import {
  dropNeighbors,
  ISSUE_STATUSES,
  ISSUE_STATUS_DOTS,
  ISSUE_STATUS_LABELS,
  type IssueStatus,
} from "../../lib/issues";
import type { IssueCard } from "./issue-access";
import { IssuePriorityPill } from "./issue-pills";
import { IssueTimestamp } from "./issue-timestamp";
export type IssueMove = {
  issueId: Id<"issues">;
  status: IssueStatus;
  beforeId?: Id<"issues">;
  afterId?: Id<"issues">;
};
export function IssuesBoard({
  issues,
  counts,
  canWrite,
  onMove,
  busy = false,
}: {
  issues: IssueCard[];
  counts: Record<IssueStatus, number>;
  canWrite: boolean;
  onMove: (move: IssueMove) => Promise<void>;
  busy?: boolean;
}) {
  const dragged = useRef<Id<"issues"> | null>(null);
  const [target, setTarget] = useState("");
  async function drop(
    event: DragEvent,
    status: IssueStatus,
    cards: IssueCard[],
    targetId?: Id<"issues">,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const issueId = dragged.current;
    dragged.current = null;
    setTarget("");
    if (!canWrite || busy || !issueId || issueId === targetId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const neighbors = dropNeighbors(
      cards,
      issueId,
      targetId,
      Boolean(targetId && event.clientY > rect.top + rect.height / 2),
    );
    await onMove({
      issueId,
      status,
      beforeId: neighbors.beforeId as Id<"issues"> | undefined,
      afterId: neighbors.afterId as Id<"issues"> | undefined,
    });
  }
  return (
    <div
      className="overflow-x-auto pb-3"
      aria-label="Issue board"
      aria-busy={busy}
    >
      <div className="flex min-w-max items-stretch gap-3">
        {ISSUE_STATUSES.map((status) => {
          const cards = issues
            .filter((issue) => issue.status === status)
            .sort((a, b) => a.order - b.order || a.number - b.number);
          return (
            <section
              key={status}
              aria-label={`${ISSUE_STATUS_LABELS[status]} column`}
              className={`flex h-[calc(100svh-17rem)] min-h-[420px] w-64 shrink-0 flex-col rounded-2xl border p-2 ${target === status ? "border-accent" : "border-border"} bg-surface-secondary/50`}
              onDragOver={(event) => {
                if (canWrite && !busy && dragged.current) {
                  event.preventDefault();
                  setTarget(status);
                }
              }}
              onDrop={(event) => void drop(event, status, cards)}
            >
              <header className="flex min-h-12 items-center gap-2 px-1">
                <span
                  className={`size-2 shrink-0 rounded-full ${ISSUE_STATUS_DOTS[status]}`}
                  aria-hidden="true"
                />
                <h2 className="min-w-0 flex-1 text-[13px] font-semibold">
                  {ISSUE_STATUS_LABELS[status]}
                </h2>
                <span className="rounded-md bg-default-soft px-2 py-0.5 text-xs tabular-nums text-muted">
                  {counts[status]}
                </span>
              </header>
              <div className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto">
                {cards.length ? (
                  cards.map((issue) => (
                    <article
                      key={issue._id}
                      draggable={canWrite && !busy}
                      className={`rounded-xl border bg-surface p-3 ${target === issue._id ? "border-accent" : "border-border"}`}
                      onDragStart={(event) => {
                        if (!canWrite || busy) {
                          event.preventDefault();
                          return;
                        }
                        dragged.current = issue._id;
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", issue._id);
                      }}
                      onDragEnd={() => {
                        dragged.current = null;
                        setTarget("");
                      }}
                      onDragOver={(event) => {
                        if (canWrite && !busy && dragged.current) {
                          event.preventDefault();
                          event.stopPropagation();
                          setTarget(issue._id);
                        }
                      }}
                      onDrop={(event) =>
                        void drop(event, status, cards, issue._id)
                      }
                    >
                      <Link
                        href={`/issues/${issue.number}`}
                        draggable={false}
                        className="grid gap-2 text-inherit no-underline focus-visible:outline-2 focus-visible:outline-accent"
                        onClick={(event) => {
                          if (dragged.current) event.preventDefault();
                        }}
                      >
                        <div className="flex items-start gap-2">
                          {canWrite ? (
                            <WorkspaceIcon
                              name="grip"
                              className="mt-0.5 size-4 shrink-0 text-muted"
                            />
                          ) : null}
                          <div className="min-w-0">
                            <p className="font-mono text-xs text-muted">
                              {issue.key}
                              {issue.externalRef
                                ? ` · ${issue.externalRef}`
                                : ""}
                            </p>
                            <p className="mt-1 break-words text-sm font-medium">
                              {issue.title}
                            </p>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <span className="rounded-md bg-default-soft px-2 py-0.5 text-xs text-muted">
                            {issue.area}
                          </span>
                          <IssuePriorityPill priority={issue.priority} />
                        </div>
                        {issue.milestone ? (
                          <p className="break-words text-xs text-muted">
                            {issue.milestone}
                          </p>
                        ) : null}
                        <div className="grid gap-1 break-words text-xs text-muted">
                          <p>Reporter: {issue.reporterName}</p>
                          {issue.lastCommentAuthorName ? (
                            <p>Latest comment: {issue.lastCommentAuthorName}</p>
                          ) : null}
                          <IssueTimestamp
                            value={issue.lastCommentAt ?? issue.updatedAt}
                            label={
                              issue.lastCommentAt ? "Latest comment" : "Updated"
                            }
                          />
                        </div>
                        <div className="flex gap-3 text-xs text-muted">
                          <span
                            className="inline-flex items-center gap-1"
                            aria-label={`${issue.commentCount} comments`}
                          >
                            <WorkspaceIcon
                              name="comment"
                              className="size-3.5"
                            />
                            {issue.commentCount}
                          </span>
                          <span
                            className="inline-flex items-center gap-1"
                            aria-label={`${issue.attachmentCount} attachments`}
                          >
                            <WorkspaceIcon
                              name="attachment"
                              className="size-3.5"
                            />
                            {issue.attachmentCount}
                          </span>
                        </div>
                      </Link>
                    </article>
                  ))
                ) : (
                  <p className="rounded-xl border border-dashed border-border p-5 text-center text-xs text-muted">
                    No issues
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
