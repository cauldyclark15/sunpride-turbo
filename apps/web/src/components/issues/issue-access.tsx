"use client";
import { api } from "@sunpride/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex/react";
import { EmptyPanel, PageHeader, WorkspaceIcon } from "@sunpride/ui";
import type { ReactNode } from "react";
import Link from "next/link";
import { canAccessWebModule } from "../../lib/module-access";
export type IssueAccess = FunctionReturnType<typeof api.issues.queries.access>;
export type IssueCard = FunctionReturnType<
  typeof api.issues.queries.board
>["issues"][number];
export type IssueDetail = NonNullable<
  FunctionReturnType<typeof api.issues.queries.detail>
>;
export type IssueAssignee = FunctionReturnType<
  typeof api.issues.queries.assignees
>[number];
export function useIssueAccess() {
  const profile = useQuery(api.domains.profiles.current, {});
  const allowed =
    profile?.status === "active" && canAccessWebModule("issues", profile.role);
  const access = useQuery(api.issues.queries.access, allowed ? {} : "skip");
  return {
    access,
    canRead: Boolean(allowed && access?.canRead),
    loading: profile === undefined || (allowed && access === undefined),
  };
}
export function IssueAccessState({ loading }: { loading: boolean }) {
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
