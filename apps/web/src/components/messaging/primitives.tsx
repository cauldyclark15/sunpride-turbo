"use client";

import { WorkspaceIcon, type WorkspaceIconName } from "@sunpride/ui";
import { useState, type ReactNode } from "react";
import { useEscape } from "../../lib/messaging/escape";
import { initials } from "../../lib/messaging/format";
import { REF_NOUNS } from "../../lib/messaging/tokens";
import type { RefType, UserLite } from "../../lib/messaging/types";

export function IconButton({
  label,
  icon,
  onClick,
  className = "",
  children,
  pressed,
}: {
  label: string;
  icon?: WorkspaceIconName;
  onClick: () => void;
  className?: string;
  children?: ReactNode;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-default-soft hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent ${className}`}
    >
      {icon ? <WorkspaceIcon name={icon} /> : children}
    </button>
  );
}

/**
 * Right-hand panel (thread, details, search). Closes with its close button
 * and with Escape. On a phone it covers the conversation.
 */
export function SidePanel({
  title,
  subtitle,
  onClose,
  children,
  testId,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  useEscape(onClose);
  return (
    <aside
      aria-label={title}
      data-panel={testId}
      className="flex h-full min-h-0 w-full flex-col border-border bg-surface lg:w-[380px] lg:shrink-0 lg:border-l"
    >
      <header className="flex min-h-14 items-center gap-2 border-b border-separator px-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          {subtitle ? (
            <p className="truncate text-xs text-muted">{subtitle}</p>
          ) : null}
        </div>
        <IconButton label={`Close ${title.toLowerCase()}`} icon="close" onClick={onClose} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

/** Centred dialog with a backdrop. Close button, backdrop click and Escape close it. */
export function ModalFrame({
  title,
  onClose,
  children,
  wide,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  testId?: string;
}) {
  useEscape(onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-panel={testId}
        className={`flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl ${wide ? "sm:max-w-4xl" : "sm:max-w-md"}`}
      >
        <header className="flex min-h-14 items-center gap-2 border-b border-separator px-4">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
          <IconButton label={`Close ${title.toLowerCase()}`} icon="close" onClick={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function Avatar({
  user,
  size = "md",
}: {
  user: Pick<UserLite, "display_name" | "avatar_url" | "is_agent">;
  size?: "sm" | "md";
}) {
  const box = size === "sm" ? "size-6 text-[10px]" : "size-9 text-xs";
  const [broken, setBroken] = useState(false);
  if (user.avatar_url && !broken)
    return (
      // eslint-disable-next-line @next/next/no-img-element -- authenticated media URLs, not static assets.
      <img
        src={user.avatar_url}
        alt=""
        onError={() => setBroken(true)}
        className={`${box} shrink-0 rounded-full object-cover`}
      />
    );
  return (
    <span
      aria-hidden
      className={`${box} inline-flex shrink-0 items-center justify-center rounded-full font-medium ${user.is_agent ? "border border-foreground/30 bg-default-soft text-foreground" : "bg-default-soft text-muted"}`}
    >
      {initials(user.display_name)}
    </span>
  );
}

export function AiBadge() {
  return (
    <span className="rounded border border-border px-1 text-[10px] font-medium uppercase tracking-wide text-muted">
      AI
    </span>
  );
}

export function CountBadge({
  count,
  mention,
  label,
}: {
  count: number;
  mention?: boolean;
  label: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={label}
      className={`min-w-5 rounded-full px-1.5 text-center text-[11px] font-semibold leading-5 ${mention ? "bg-foreground text-background" : "bg-default-soft text-foreground"}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

const REF_ICONS: Record<RefType, WorkspaceIconName> = {
  user: "user",
  outlet: "commercial",
  product: "inventory",
  customer: "commercial",
  issue: "issues",
  order: "order",
  visit: "field",
  territory: "board",
  route: "list",
  van_trip: "mobile",
};

export const REF_TYPE_LABELS: Record<RefType, string> = {
  user: "People",
  outlet: "Stores",
  product: "Items",
  customer: "Customers",
  issue: "Issues",
  order: "Orders",
  visit: "Visits",
  territory: "Territories",
  route: "Routes",
  van_trip: "Van trips",
};

export const REF_TYPE_SINGULAR = REF_NOUNS;

export function RefTypeIcon({
  type,
  className = "size-4",
}: {
  type: RefType;
  className?: string;
}) {
  return <WorkspaceIcon name={REF_ICONS[type]} className={className} />;
}

export function Spinner({ label }: { label: string }) {
  return (
    <p role="status" className="p-4 text-sm text-muted">
      {label}
    </p>
  );
}
