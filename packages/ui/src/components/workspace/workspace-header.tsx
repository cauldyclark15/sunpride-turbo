import type { ReactNode } from "react";

export function WorkspaceHeader({
  title,
  meta,
  actions,
}: {
  title: string;
  /** Kept for older callers; page copy belongs in the content, not the header. */
  description?: string;
  context?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-[26px] font-semibold leading-9 tracking-tight text-foreground">
          {title}
        </h1>
        {meta ? <p className="mt-1 text-[13px] text-muted">{meta}</p> : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
