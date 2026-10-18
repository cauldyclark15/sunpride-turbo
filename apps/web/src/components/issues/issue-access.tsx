"use client";
import { useSession } from "../../lib/auth";
import { useIssueQuery } from "./data";
import type { IssueAccess } from "./model";
export type {
  IssueAccess,
  IssueCard,
  IssueDetail,
  IssueAssignee,
} from "./model";
import { EmptyPanel, PageHeader, WorkspaceIcon } from "@sunpride/ui";
import type { ReactNode } from "react";
import Link from "next/link";
import { canAccessWebModule } from "../../lib/module-access";

export function useIssueAccess() {
  const { profile, status } = useSession();
  const allowed = Boolean(
    profile?.active && canAccessWebModule("issues", profile.role),
  );
  const query = useIssueQuery<IssueAccess>("access", allowed ? {} : null);
  const access = query.data;
  return {
    access,
    canRead: Boolean(allowed && access?.canRead && !query.error),
    loading:
      status === "loading" || (allowed && access === undefined && !query.error),
    error: query.error,
  };
}
export function IssueAccessState({
  loading,
  error,
}: {
  loading: boolean;
  error?: Error | null;
}) {
  if (error)
    return (
      <p role="alert" className="text-[13px] text-danger">
        {error.message}
      </p>
    );
  return loading ? (
    <p role="status" className="text-[13px] text-muted">
      Checking access…
    </p>
  ) : (
    <EmptyPanel title="No access" />
  );
}
export function IssuesHeader({
  title,
  actions,
  meta,
}: {
  title: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <WorkspaceIcon
        name="bug"
        className="mt-1.5 size-6 shrink-0 text-danger"
      />
      <div className="min-w-0 flex-1">
        <PageHeader title={title} actions={actions} meta={meta} />
      </div>
    </div>
  );
}
export function IssuesBackLink() {
  return (
    <Link
      href="/issues"
      className="inline-flex w-fit items-center gap-1.5 text-[13px] text-accent"
    >
      <WorkspaceIcon name="back" className="size-4" />
      Issues
    </Link>
  );
}
