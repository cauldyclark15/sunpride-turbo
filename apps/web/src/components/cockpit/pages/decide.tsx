"use client";

import { CallFlowReviews, CallFlowReport } from "../../callflow-admin";

import { IntegrityReview } from "../../integrity/review";
import Link from "next/link";
import { FiscalWorkspace } from "../../fiscal/fiscal-workspace";
import { RetailExceptionReview } from "../../storepos/retail-workspace";
import { StoreShiftReview } from "../../storepos/storepos-admin";
import { FraudPanel, AlertsPanel } from "./tower";
import { useCallback, useState } from "react";
import { useAnalytics } from "../api";
import { formatAge, formatCount, formatDayTime, formatPhp } from "../format";
import {
  CockpitPage,
  Drawer,
  ExceptionList,
  KIND_LABEL,
  PageData,
  Panel,
  PeriodScopeBar,
  StatusChip,
} from "../kit";
import {
  EXCEPTION_KINDS,
  type ExceptionItem,
  type ExceptionKind,
  type ExceptionsResponse,
  type Severity,
} from "../types";
import { safeHref } from "../url";
import { primaryButtonClass, usePageQuery } from "./shared";

const SEVERITIES: Array<{ id: Severity; label: string }> = [
  { id: "high", label: "Urgent" },
  { id: "medium", label: "Soon" },
  { id: "low", label: "When you can" },
];

const MONEY_KEY = /centavos|expected|remitted|amount|balance|limit/i;

/** Evidence values in plain words: money as ₱, metres as m, the rest as numbers or text. */
export function evidenceRows(evidence: Record<string, unknown>) {
  return Object.entries(evidence).flatMap(([key, value]) => {
    if (value === null || value === undefined || typeof value === "object")
      return [];
    const label = key
      .replace(/Centavos$/, "")
      .replace(/M$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replaceAll("_", " ")
      .toLowerCase();
    const text =
      typeof value === "number"
        ? MONEY_KEY.test(key)
          ? formatPhp(value, { cents: true })
          : /M$/.test(key)
            ? `${formatCount(value)} m`
            : formatCount(value)
        : String(value);
    return [{ label: label.charAt(0).toUpperCase() + label.slice(1), text }];
  });
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium ${
        on
          ? "bg-foreground text-background"
          : "border border-foreground/20 text-foreground hover:bg-default-soft"
      }`}
    >
      {children}
    </button>
  );
}

export function ExceptionDetail({
  item,
  now,
  link,
}: {
  item: ExceptionItem;
  now: number;
  link: (href: string) => string;
}) {
  const href = safeHref(item.action.href);
  const facts: Array<[string, string]> = [
    ["About", item.subject.label],
    ["Owner", item.owner?.name ?? "No owner yet"],
    ["Open for", formatAge(item.openedAt, now)],
    ["Due", item.dueAt === null ? "No deadline" : formatDayTime(item.dueAt)],
  ];
  return (
    <div className="grid gap-4">
      <div>
        <StatusChip
          status={item.severity}
          label={`${SEVERITIES.find((s) => s.id === item.severity)?.label} · ${KIND_LABEL[item.kind]}`}
        />
        <p className="mt-2 text-[15px] font-semibold text-foreground">
          {item.title}
        </p>
        <p className="mt-1 text-[13px] text-muted">{item.detail}</p>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-[13px]">
        {[
          ...facts,
          ...evidenceRows(item.evidence).map(
            (r) => [r.label, r.text] as [string, string],
          ),
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-[12px] text-muted">{label}</dt>
            <dd className="font-medium tabular-nums text-foreground">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {href ? (
        <Link
          href={link(href)}
          className={`${primaryButtonClass} justify-self-start`}
        >
          {item.action.label}
        </Link>
      ) : null}
    </div>
  );
}

export function DecideView({
  data,
  kind,
  severity,
  now: nowProp,
  link = (href) => href,
  onFilter,
  onMore,
  onFirst,
}: {
  data: ExceptionsResponse;
  kind: ExceptionKind | null;
  severity: Severity | null;
  now?: number;
  link?: (href: string) => string;
  onMore?: () => void;
  onFirst?: () => void;
  onFilter?: (patch: {
    kind?: ExceptionKind | null;
    severity?: Severity | null;
  }) => void;
}) {
  const now = nowProp ?? data.freshness.asOf;
  const [open, setOpen] = useState<ExceptionItem | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const total = Object.values(data.counts).reduce((s, n) => s + (n ?? 0), 0);
  const kinds = EXCEPTION_KINDS.filter((k) => (data.counts[k] ?? 0) > 0);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <Panel
        title="What is waiting"
        question={`${formatCount(total)} ${total === 1 ? "item" : "items"} across ${kinds.length} kinds.`}
      >
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
          <div
            role="group"
            aria-label="Kind"
            className="ck-scroll-x -mx-4 flex items-center gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0"
          >
            <span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted">
              Kind
            </span>
            <Chip on={kind === null} onClick={() => onFilter?.({ kind: null })}>
              Everything{" "}
              <span className="tabular-nums opacity-70">
                {formatCount(total)}
              </span>
            </Chip>
            {kinds.map((k) => (
              <Chip
                key={k}
                on={kind === k}
                onClick={() => onFilter?.({ kind: kind === k ? null : k })}
              >
                {KIND_LABEL[k]}{" "}
                <span className="tabular-nums opacity-70">
                  {formatCount(data.counts[k] ?? 0)}
                </span>
              </Chip>
            ))}
          </div>
          <div
            role="group"
            aria-label="Urgency"
            className="ck-scroll-x -mx-4 flex items-center gap-2 overflow-x-auto border-t border-separator px-4 pt-3 sm:mx-0 sm:flex-wrap sm:px-0"
          >
            <span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted">
              Urgency
            </span>
            {SEVERITIES.map((s) => (
              <Chip
                key={s.id}
                on={severity === s.id}
                onClick={() =>
                  onFilter?.({ severity: severity === s.id ? null : s.id })
                }
              >
                {s.label}
              </Chip>
            ))}
          </div>
        </div>
      </Panel>
      <Panel
        title={kind ? KIND_LABEL[kind] : "Decide"}
        question="Most urgent first. Open an item for its evidence and the action that resolves it."
      >
        <ExceptionList
          items={data.items}
          now={now}
          link={link}
          onOpen={setOpen}
          empty={
            kind || severity
              ? "Nothing matches these filters"
              : "Nothing waiting"
          }
        />
        {data.next || onFirst ? (
          <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-[13px]">
            <span>
              Showing {formatCount(data.items.length)} items
              {data.next ? " · more waiting" : ""}
            </span>
            <div className="flex gap-3">
              {onFirst ? (
                <button type="button" onClick={onFirst}>
                  Back to first
                </button>
              ) : null}
              {data.next ? (
                <button type="button" onClick={onMore}>
                  Next items
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Panel>
      <Drawer
        open={open !== null}
        title={open ? KIND_LABEL[open.kind] : ""}
        onClose={close}
      >
        {open ? <ExceptionDetail item={open} now={now} link={link} /> : null}
      </Drawer>
    </div>
  );
}

export function DecidePage() {
  const { query, params, link, set } = usePageQuery([
    "kind",
    "severity",
    "ownerProfileId",
    "cursor",
  ]);
  const kind = (EXCEPTION_KINDS as readonly string[]).includes(
    params.get("kind") ?? "",
  )
    ? (params.get("kind") as ExceptionKind)
    : null;
  const severity = SEVERITIES.some((s) => s.id === params.get("severity"))
    ? (params.get("severity") as Severity)
    : null;
  const result = useAnalytics("exceptions", query);
  return (
    <CockpitPage
      title="Decide"
      question="What do I need to decide?"
      header={result.data}
      bar={
        <PeriodScopeBar
          showCompare={false}
          scopeLabel={result.data?.scope.label}
        />
      }
    >
      <PageData result={result} label="the decision inbox">
        {(data) => (
          <DecideView
            data={data}
            kind={kind}
            severity={severity}
            link={link}
            onFilter={(patch) => set({ ...patch, cursor: null })}
            onMore={() => set({ cursor: data.next })}
            onFirst={
              params.has("cursor") ? () => set({ cursor: null }) : undefined
            }
          />
        )}
      </PageData>
      <StoreShiftReview />
      <RetailExceptionReview />
      <CallFlowReviews />
      <CallFlowReport />
      <FiscalWorkspace decisionsOnly />
      <IntegrityReview />
      <FraudPanel query={query} />
      <AlertsPanel unitId={result.data?.scope.unitId ?? null} />
    </CockpitPage>
  );
}
