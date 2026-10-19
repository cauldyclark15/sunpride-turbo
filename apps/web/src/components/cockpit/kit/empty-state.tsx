import Link from "next/link";
import type { ReactNode } from "react";

export type EmptyVariant = "unknown" | "zero" | "setup";

const HEADINGS: Record<EmptyVariant, string> = {
  unknown: "Not measured yet",
  zero: "None in this period",
  setup: "Needs setup",
};

/**
 * Keeps three different situations apart: no data to measure (unknown),
 * a real zero, and something an owner must set up first.
 */
export function EmptyState({
  variant,
  title,
  children,
  action,
}: {
  variant: EmptyVariant;
  title?: string;
  children?: ReactNode;
  action?: { label: string; href: string };
}) {
  return (
    <div
      data-empty={variant}
      className={`rounded-xl px-4 py-5 text-center ${
        variant === "setup"
          ? "border border-dashed border-[#d97706]/50 bg-[#d97706]/[0.04]"
          : "border border-dashed border-border"
      }`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {HEADINGS[variant]}
      </p>
      {title ? (
        <p className="mt-1 text-sm font-medium text-foreground">{title}</p>
      ) : null}
      {children ? (
        <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">
          {children}
        </p>
      ) : null}
      {action ? (
        <Link
          href={action.href}
          className="mt-3 inline-flex h-8 items-center rounded-lg border border-border bg-surface px-3 text-[13px] font-medium text-foreground hover:bg-default-soft"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
