import type { ReactNode } from "react";
import { WorkspaceHeader } from "./workspace/workspace-header";

export function PageHeader({
  title,
  meta,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return <WorkspaceHeader title={title} meta={meta} actions={actions} />;
}
