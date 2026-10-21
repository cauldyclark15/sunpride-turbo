"use client";

import { usePermissions, useSession } from "@/lib/auth/session";
import type { AnalyticsQuery } from "../api";
import { readCommon } from "../period";
import { useUrlState } from "../use-url-state";

/** Common period/scope params plus the listed page-specific ones, from the URL. */
export function usePageQuery(extra: readonly string[] = []) {
  const url = useUrlState();
  const query: AnalyticsQuery = { ...readCommon(url.params) };
  for (const name of extra) {
    const value = url.params.get(name);
    if (value) query[name] = value;
  }
  return { ...url, query };
}

/**
 * UI hints from the session. The API decides what each request may see or
 * change; these only hide controls a role cannot use.
 */
export function useCockpitAccess() {
  const { profile } = useSession();
  const { can } = usePermissions();
  const role = profile?.role ?? null;
  return {
    role,
    canSetTarget: can("target.manage"),
    readOnly: role === "analyst" || role === "viewer",
    isSales: role === "sales",
  };
}

export const linkClass =
  "font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground";

export const buttonClass =
  "inline-flex h-8 items-center rounded-lg border border-border bg-surface px-3 text-[13px] font-medium text-foreground hover:bg-default-soft";

export const primaryButtonClass =
  "inline-flex h-8 items-center rounded-lg border border-foreground bg-foreground px-3 text-[13px] font-medium text-background hover:opacity-90 disabled:opacity-50";

/** A two-state segmented control for in-page views. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex gap-0.5 rounded-lg border border-border bg-surface p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={`h-7 whitespace-nowrap rounded-md px-2.5 text-[12px] font-medium ${
            value === option.id
              ? "bg-foreground text-background"
              : "text-muted hover:text-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Small attainment bar used in tables. */
export function AttainmentBar({
  pct,
  status,
  scale = 100,
}: {
  pct: number | null;
  status: string;
  /** Percent at the full width; above 100 a tick marks the target. */
  scale?: number;
}) {
  const tone =
    status === "ok"
      ? "bg-[#2e9d59]"
      : status === "watch"
        ? "bg-[#d97706]"
        : status === "behind"
          ? "bg-[#c8102e]"
          : "bg-[#a1a1aa]";
  return (
    <span className="inline-flex w-full min-w-16 items-center gap-2">
      <span className="relative h-1.5 flex-1 rounded-full bg-default-soft">
        {pct !== null ? (
          <span
            className={`absolute inset-y-0 left-0 rounded-full ${tone}`}
            style={{
              width: `${(Math.min(scale, Math.max(0, pct)) / scale) * 100}%`,
            }}
          />
        ) : null}
        {scale > 100 ? (
          <span
            aria-hidden
            className="absolute -inset-y-1 w-px bg-foreground/45"
            style={{ left: `${(100 / scale) * 100}%` }}
          />
        ) : null}
      </span>
    </span>
  );
}
