"use client";

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { percent } from "./model";

const BASE =
  "inline-flex min-h-12 items-center justify-center rounded-xl px-5 text-base font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-40";

/** The one main action on a screen (Itemcount: solid orange, right-hand side of the footer). */
export function PrimaryButton({
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`${BASE} bg-accent text-accent-foreground ${className}`.trim()}
      {...props}
    />
  );
}

/** Outlined, for everything that is not the main action. */
export function SecondaryButton({
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`${BASE} border border-border bg-surface text-foreground ${className}`.trim()}
      {...props}
    />
  );
}

const TONES = {
  good: "bg-success-soft text-success-soft-foreground",
  warn: "bg-warning-soft text-warning-soft-foreground",
  bad: "bg-danger-soft text-danger-soft-foreground",
  neutral: "bg-default-soft text-default-soft-foreground",
  info: "bg-accent-soft text-accent",
} as const;

/** A small rounded label ("Blind count", "3 to recount"). */
export function Chip({
  tone = "neutral",
  children,
}: {
  tone?: keyof typeof TONES;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** "120 of 300 counted" as a bar. Always labelled in words, never a bare colour. */
export function ProgressBar({
  done,
  total,
  label,
}: {
  done: number;
  total: number;
  label: string;
}) {
  const pct = percent(done, total);
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted">{pct}%</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-default-soft"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label={label}
      >
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** A plain-words error under a form. Shows the server's message as it is. */
export function ErrorLine({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm font-medium text-danger">
      {message}
    </p>
  );
}

/** White card on the grey page, 1 px border, 16 px radius (R3 pattern 16). */
export function Panel({
  children,
  className = "",
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLElement>, "children" | "className">) {
  return (
    <section
      className={`rounded-2xl border border-border bg-surface p-4 ${className}`.trim()}
      {...rest}
    >
      {children}
    </section>
  );
}

/** Small grey uppercase label. */
export function MicroLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs font-medium uppercase tracking-wide text-muted">
      {children}
    </span>
  );
}
