import type { ReactNode } from "react";

export function BrandMark({
  logo,
  compact = false,
}: {
  logo: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-[7px] bg-accent">
        {logo}
      </div>
      {!compact && (
        <div className="min-w-0">
          <p className="truncate text-base font-semibold tracking-tight text-foreground">
            sunpride
          </p>
          <p className="truncate text-xs text-muted">Operations</p>
        </div>
      )}
    </div>
  );
}
