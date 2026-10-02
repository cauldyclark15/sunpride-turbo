"use client";
import Link from "next/link";
import { useState } from "react";
import { Pager } from "@sunpride/ui";
import type { IssueCard } from "./issue-access";
import { IssuePriorityPill, IssueStatusPill } from "./issue-pills";
import { IssueTimestamp } from "./issue-timestamp";
export function IssuesList({ issues }: { issues: IssueCard[] }) {
  const [page, setPage] = useState(1);
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(issues.length / 25)),
  );
  const rows = issues.slice((currentPage - 1) * 25, currentPage * 25);
  return (
    <section
      aria-label="Issue list"
      className="overflow-hidden rounded-2xl border border-border bg-surface"
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="h-12 border-b border-separator text-[11px] uppercase tracking-wide text-muted">
              {[
                "Issue",
                "Area",
                "Status",
                "Priority",
                "Assignee",
                "Updated",
              ].map((label) => (
                <th key={label} className="px-4 font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((issue) => (
                <tr
                  key={issue._id}
                  className="h-[52px] border-b border-separator last:border-b-0 hover:bg-surface-hover"
                >
                  <td className="min-w-60 px-4 py-2">
                    <Link
                      href={`/issues/${issue.number}`}
                      className="block focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <span className="block text-sm font-medium">
                        {issue.title}
                      </span>
                      <span className="font-mono text-xs text-muted">
                        {issue.key}
                      </span>
                    </Link>
                  </td>
                  <td className="px-4">{issue.area}</td>
                  <td className="whitespace-nowrap px-4">
                    <IssueStatusPill status={issue.status} />
                  </td>
                  <td className="px-4">
                    <IssuePriorityPill priority={issue.priority} />
                  </td>
                  <td className="px-4">{issue.assigneeName ?? "Unassigned"}</td>
                  <td className="min-w-56 px-4 text-xs text-muted">
                    <IssueTimestamp value={issue.updatedAt} />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="h-32 text-center text-muted">
                  No issues match these filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager
        label="Issue pages"
        page={currentPage}
        canPrevious={currentPage > 1}
        canNext={currentPage * 25 < issues.length}
        onPrevious={() => setPage(currentPage - 1)}
        onNext={() => setPage(currentPage + 1)}
      />
    </section>
  );
}
