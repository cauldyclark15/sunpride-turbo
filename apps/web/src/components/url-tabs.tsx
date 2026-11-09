"use client";

/** A row of tabs whose choice lives in the URL (`?tab=`); the caller owns the URL. */
export function UrlTabs<T extends string>({
  label,
  tabs,
  tab,
  onTab,
}: {
  label: string;
  tabs: { id: T; label: string }[];
  tab: T;
  onTab: (tab: T) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="-mx-4 flex gap-1 overflow-x-auto border-b border-separator px-4 sm:mx-0 sm:px-0"
    >
      {tabs.map((t) => {
        const on = t.id === tab;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onTab(t.id)}
            className={`-mb-px h-10 shrink-0 whitespace-nowrap border-b-2 px-3 text-sm font-medium ${on ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
