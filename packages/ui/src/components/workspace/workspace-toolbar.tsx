import type { ReactNode } from "react";

export function WorkspaceToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-2 overflow-x-auto">
      {children}
    </div>
  );
}
