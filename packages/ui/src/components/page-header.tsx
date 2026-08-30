import type { ReactNode } from "react";
import { WorkspaceHeader } from "./workspace/workspace-header";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <WorkspaceHeader
      context={eyebrow}
      title={title}
      description={description}
      actions={actions}
    />
  );
}
