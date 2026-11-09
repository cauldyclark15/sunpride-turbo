"use client";

import Link from "next/link";

/** Tabs kept in `?tab=` so reload, back and shared links land on the same view. */
export function PageTabs({
  label,
  tabs,
  current,
  href,
}: {
  label: string;
  tabs: readonly { id: string; label: string }[];
  current: string;
  href: (id: string) => string;
}) {
  return (
    <nav
      aria-label={label}
      className="flex gap-1 overflow-x-auto border-b border-separator"
    >
      {tabs.map((t) => {
        const on = t.id === current;
        return (
          <Link
            key={t.id}
            href={href(t.id)}
            scroll={false}
            aria-current={on ? "page" : undefined}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[14px] font-medium ${on ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** "Nov 9" in Manila time; the year only when it is not this year. */
export function shortDate(ms: number, now = Date.now()) {
  const year = (n: number) =>
    new Date(n).toLocaleDateString("en-PH", {
      timeZone: "Asia/Manila",
      year: "numeric",
    });
  return new Date(ms).toLocaleDateString("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    ...(year(ms) === year(now) ? {} : { year: "numeric" }),
  });
}

export const rowButton =
  "inline-flex h-8 items-center rounded-lg border border-border bg-surface px-3 text-[13px] font-medium text-foreground hover:bg-default-soft";
