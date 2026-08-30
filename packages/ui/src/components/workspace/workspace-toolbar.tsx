import type { ReactNode } from "react";

export function WorkspaceToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-2 overflow-x-auto rounded-md bg-surface-secondary px-3 py-2">
      {children}
    </div>
  );
}
