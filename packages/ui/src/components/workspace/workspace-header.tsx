import type { ReactNode } from "react";

export function WorkspaceHeader({
  title,
  description,
  context,
  actions,
}: {
  title: string;
  description?: string;
  context?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="max-w-3xl">
        {context ? (
          <p className="mb-2 text-sm font-medium text-accent-soft-foreground">
            {context}
          </p>
        ) : null}
        <h1 className="text-[1.625rem] font-semibold leading-9 tracking-tight text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
