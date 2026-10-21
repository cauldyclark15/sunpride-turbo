"use client";

import Link from "next/link";
import { formatAge, formatDayTime, formatTime } from "../format";
import type { ExceptionItem, ExceptionKind, Severity } from "../types";
import { safeHref } from "../url";
import { EmptyState } from "./empty-state";
import { StatusDot } from "./status";

export const KIND_LABEL: Record<ExceptionKind, string> = {
  behind_target: "Behind target",
  missed_stops: "Missed stops",
  not_started: "Not started",
  idle_agent: "Idle in the field",
  location_issue: "Location check",
  van_unclosed: "Trip not closed",
  cash_variance: "Cash short or over",
  stock_variance: "Stock difference",
  oos_hotspot: "Out of stock",
  credit_breach: "Over credit limit",
  order_approval: "Order approval",
  mcp_approval: "MCP approval",
  talk_sheet_overdue: "Talk Sheet overdue",
  per_diem_review: "Per diem review",
  new_store: "New store",
  dormant_key_store: "Key store gone quiet",
  dormant_store: "Dormant store",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  high: "Urgent",
  medium: "Soon",
  low: "When you can",
};

const sameManilaDay = (a: number, b: number) =>
  Math.floor((a + 8 * 3_600_000) / 86_400_000) ===
  Math.floor((b + 8 * 3_600_000) / 86_400_000);

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function sortExceptions(items: ExceptionItem[]) {
  return [...items].sort(
    (a, b) => ORDER[a.severity] - ORDER[b.severity] || a.openedAt - b.openedAt,
  );
}

/**
 * Exceptions, most severe first: what it is, who owns it, how old it is, and
 * the one action that resolves it.
 */
export function ExceptionList({
  items,
  now,
  link = (href: string) => href,
  onOpen,
  empty,
}: {
  items: ExceptionItem[];
  now: number;
  link?: (href: string) => string;
  onOpen?: (item: ExceptionItem) => void;
  empty?: string;
}) {
  if (!items.length)
    return (
      <EmptyState variant="zero" title={empty ?? "Nothing waiting"}>
        New items appear here as phones sync.
      </EmptyState>
    );
  return (
    <ul className="divide-y divide-separator">
      {sortExceptions(items).map((item) => {
        const href = safeHref(item.action.href);
        const overdue = item.dueAt !== null && item.dueAt < now;
        return (
          <li
            key={item.id}
            data-exception={item.kind}
            className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4"
          >
            <div className="min-w-0 flex-1">
              {onOpen ? (
                <button
                  type="button"
                  onClick={() => onOpen(item)}
                  className="text-left text-sm font-semibold text-foreground hover:underline"
                >
                  {item.title}
                </button>
              ) : (
                <p className="text-sm font-semibold text-foreground">
                  {item.title}
                </p>
              )}
              <p className="mt-0.5 text-[13px] text-muted">{item.detail}</p>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-muted">
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  <StatusDot status={item.severity} />
                  {SEVERITY_LABEL[item.severity]}
                  <span className="font-normal text-muted">
                    · {KIND_LABEL[item.kind] ?? item.kind}
                  </span>
                </span>
                <span>
                  {item.owner ? `Owner: ${item.owner.name}` : "No owner yet"}
                </span>
                <span>Open {formatAge(item.openedAt, now)}</span>
                {item.dueAt !== null ? (
                  <span className={overdue ? "font-medium text-[#b4101f]" : ""}>
                    {overdue ? "Overdue since " : "Due "}
                    {sameManilaDay(item.dueAt, now)
                      ? formatTime(item.dueAt)
                      : formatDayTime(item.dueAt)}
                  </span>
                ) : null}
              </p>
            </div>
            {href ? (
              <Link
                href={link(href)}
                className="ck-noprint inline-flex h-8 shrink-0 items-center self-start rounded-lg border border-foreground bg-foreground px-3 text-[13px] font-medium text-background hover:opacity-90 sm:self-center"
              >
                {item.action.label}
              </Link>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
