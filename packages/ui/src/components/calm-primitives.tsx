"use client";

import { Button } from "@heroui/react/button";
import type { ReactNode } from "react";
import type { StatusTone } from "./status-pill";

const softTones: Record<StatusTone, string> = {
  success: "bg-success-soft text-success-soft-foreground",
  warning: "bg-warning-soft text-warning-soft-foreground",
  danger: "bg-danger-soft text-danger-soft-foreground",
  neutral: "bg-default-soft text-default-soft-foreground",
};

export function Card({
  label,
  icon,
  count,
  actions,
  flush = false,
  children,
  className = "",
}: {
  label: string;
  icon?: ReactNode;
  count?: number;
  actions?: ReactNode;
  flush?: boolean;
  children: ReactNode;
  className?: string;
}) {
  // Plain elements: HeroUI Card's own header/content layout stacks and centers
  // children, which breaks the single left-aligned header row this pattern needs.
  return (
    <section
      aria-label={label}
      className={`flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface ${className}`}
    >
      <header className="flex min-h-12 flex-row items-center gap-2 border-b border-separator px-4 py-1.5 text-muted">
        {icon ? (
          <span className="grid size-3.5 shrink-0 place-items-center [&_svg]:size-3.5">
            {icon}
          </span>
        ) : null}
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted">
          {label}
          {count !== undefined ? ` · ${count}` : ""}
        </h2>
        {actions ? (
          <div className="ml-auto flex items-center gap-2 text-foreground">
            {actions}
          </div>
        ) : null}
      </header>
      <div className={`min-w-0 ${flush ? "p-0" : "p-4"}`}>{children}</div>
    </section>
  );
}

export function IconTile({
  icon,
  tone = "neutral",
}: {
  icon: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <span
      className={`grid size-9 shrink-0 place-items-center rounded-[10px] [&_svg]:size-[18px] ${softTones[tone]}`}
    >
      {icon}
    </span>
  );
}

export function ListRow({
  icon,
  title,
  meta,
  value,
  action,
  dotTone,
  tone = "neutral",
}: {
  icon: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  value?: ReactNode;
  action?: ReactNode;
  dotTone?: StatusTone;
  tone?: StatusTone;
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 border-b border-separator px-4 last:border-b-0">
      <IconTile icon={icon} tone={tone} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {title}
        </div>
        {meta ? (
          <div className="truncate text-[13px] text-muted">{meta}</div>
        ) : null}
      </div>
      {value ? (
        <span className="shrink-0 text-right text-[13px] tabular-nums text-muted">
          {value}
        </span>
      ) : null}
      {action ? <span className="shrink-0">{action}</span> : null}
      {dotTone ? (
        <span
          aria-label={dotTone}
          className={`size-1.5 shrink-0 rounded-full ${dotTone === "success" ? "bg-success" : dotTone === "warning" ? "bg-warning" : dotTone === "danger" ? "bg-danger" : "bg-muted"}`}
        />
      ) : null}
    </div>
  );
}

export function Notice({
  title,
  meta,
  tone = "warning",
}: {
  title: string;
  meta?: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <div role="status" className={`rounded-xl p-3 ${softTones[tone]}`}>
      <p className="text-sm font-medium">{title}</p>
      {meta ? <p className="mt-1 text-[13px]">{meta}</p> : null}
    </div>
  );
}

export function UnderlineTabs<T extends string>({
  items,
  activeId,
  onChange,
  label = "Sections",
}: {
  items: readonly (readonly [T, string])[];
  activeId: T;
  onChange: (id: T) => void;
  label?: string;
}) {
  return (
    <nav
      aria-label={label}
      className="flex overflow-x-auto border-b border-separator"
    >
      {items.map(([id, text]) => (
        <Button
          key={id}
          variant="ghost"
          aria-current={id === activeId ? "page" : undefined}
          onPress={() => onChange(id)}
          className={`h-10 min-h-10 shrink-0 rounded-none border-b-2 px-3 text-sm ${id === activeId ? "border-accent bg-transparent font-semibold text-foreground" : "border-transparent bg-transparent text-muted hover:text-foreground"}`}
        >
          {text}
        </Button>
      ))}
    </nav>
  );
}
