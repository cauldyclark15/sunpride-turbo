"use client";

import {
  Card,
  FormField,
  ListRow,
  Pager,
  StatusPill,
  WorkspaceIcon,
} from "@sunpride/ui";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { currentManilaDate } from "../lib/coverage-calendar";
import {
  capacityLabel,
  deadlineDate,
  deadlineStateLabel,
  needsSubmissionReminder,
} from "../lib/mcp-deadlines";

const secondaryAction =
  "h-10 rounded-[10px] border border-border bg-surface px-3 text-sm text-foreground";

/** Record, list and end away periods for one MCP approver. */
export function SupervisorAwayPanel({
  profileId,
  label,
}: {
  profileId: Id<"profiles">;
  label: string;
}) {
  const [asOf] = useState(() => Date.now());
  const periods = useQuery(api.coverage.away.list, { profileId, asOf });
  const record = useMutation(api.coverage.away.record);
  const end = useMutation(api.coverage.away.end);
  const [fromDate, setFromDate] = useState(currentManilaDate);
  const [toDate, setToDate] = useState(currentManilaDate);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      setReason("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label={label} className="grid gap-3">
      <h3 className="font-semibold">{label}</h3>
      <p className="text-[13px] text-muted">
        While an away period is in effect, the supervisor&apos;s manager
        approves Master Coverage Plans (MCPs) as backup.
      </p>
      <ul className="overflow-hidden rounded-xl border border-border">
        {periods && !periods.length && (
          <li className="px-4 py-3 text-[13px] text-muted">
            No current or upcoming away period.
          </li>
        )}
        {periods?.map((period) => (
          <li key={period._id}>
            <ListRow
              icon={<WorkspaceIcon name="field" />}
              title={`${deadlineDate(manilaDay(period.effectiveFrom))} – ${deadlineDate(manilaDay(period.effectiveTo - 86_400_000))}`}
              meta={period.reason}
              value={
                <button
                  className={secondaryAction}
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => end({ awayId: period._id }))}
                >
                  End
                </button>
              }
            />
          </li>
        ))}
      </ul>
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField label="Away from">
          <input
            aria-label="Away from"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </FormField>
        <FormField label="Away until">
          <input
            aria-label="Away until"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </FormField>
        <FormField label="Reason">
          <input
            aria-label="Away reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </FormField>
      </div>
      <button
        className={`${secondaryAction} w-fit`}
        type="button"
        disabled={busy || !reason.trim() || !fromDate || !toDate}
        onClick={() =>
          void run(() =>
            record({ profileId, fromDate, toDate, reason: reason.trim() }),
          )
        }
      >
        Record away period
      </button>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

function manilaDay(instant: number) {
  return new Date(instant + 8 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * MCP calendar for a month: the submission week, the approval deadline, who still has
 * no submitted MCP (the reminder list) and which approvals are late.
 */
export function CoverageDeadlines({
  localMonth,
  profileId,
  canApprove,
}: {
  localMonth: string;
  profileId: Id<"profiles">;
  canApprove: boolean;
}) {
  const [asOf] = useState(() => Date.now());
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const result = useQuery(
    api.coverage.calendar.status,
    /^\d{4}-(0[1-9]|1[0-2])$/.test(localMonth)
      ? { localMonth, asOf, paginationOpts: { numItems: 50, cursor } }
      : "skip",
  );
  if (!result)
    return (
      <span className="text-[13px] text-muted">Loading MCP deadlines…</span>
    );
  const { deadlines } = result;
  const reminders = result.page.filter((row) =>
    needsSubmissionReminder(row.state),
  );
  const awaiting = result.page.filter(
    (row) =>
      row.state === "awaiting_approval" || row.state === "approval_overdue",
  );
  const approved = result.page.filter(
    (row) => row.state === "approved" || row.state === "approved_late",
  );
  const pill = (state: (typeof result.page)[number]["state"]) => {
    const { label, tone } = deadlineStateLabel(state);
    return <StatusPill tone={tone}>{label}</StatusPill>;
  };
  return (
    <div className="grid gap-4">
      <Card
        label={`Master Coverage Plan (MCP) deadlines · ${localMonth}`}
        icon={<WorkspaceIcon name="field" />}
      >
        <ul className="grid gap-1 text-sm">
          <li>
            Submit between {deadlineDate(deadlines.submissionOpensDate)} and{" "}
            {deadlineDate(deadlines.submissionDueDate)} (last week of the
            previous month).
          </li>
          <li>
            Direct supervisor approves by{" "}
            {deadlineDate(deadlines.approvalDueDate)}; later approvals are shown
            as late.
          </li>
          <li>
            If the supervisor is away, the supervisor&apos;s manager approves as
            backup.
          </li>
        </ul>
      </Card>
      <Card label="No submitted MCP" icon={<WorkspaceIcon name="field" />}>
        {reminders.length ? (
          <ul
            aria-label="MCP reminders"
            className="overflow-hidden rounded-xl border border-border"
          >
            {reminders.map((row) => (
              <li key={row.profileId}>
                <ListRow
                  icon={<WorkspaceIcon name="field" />}
                  title={row.name}
                  meta={`${row.planStatus === "draft" ? `Draft v${row.version}` : "No MCP started"} · supervisor ${row.supervisorName ?? "not recorded"}`}
                  value={pill(row.state)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">
            Everyone on this page has submitted an MCP for {localMonth}.
          </p>
        )}
      </Card>
      <Card label="Awaiting approval" icon={<WorkspaceIcon name="field" />}>
        {awaiting.length ? (
          <ul className="overflow-hidden rounded-xl border border-border">
            {awaiting.map((row) => (
              <li key={row.profileId}>
                <ListRow
                  icon={<WorkspaceIcon name="field" />}
                  title={row.name}
                  meta={`v${row.version} · supervisor ${row.supervisorName ?? "not recorded"}${row.submittedLate ? " · submitted late" : ""}`}
                  value={pill(row.state)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">No MCP awaiting approval.</p>
        )}
      </Card>
      <Card label="Approved" icon={<WorkspaceIcon name="field" />}>
        {approved.length ? (
          <ul className="overflow-hidden rounded-xl border border-border">
            {approved.map((row) => (
              <li key={row.profileId}>
                <ListRow
                  icon={<WorkspaceIcon name="field" />}
                  title={row.name}
                  meta={`v${row.version}${row.approvalCapacity ? ` · ${capacityLabel(row.approvalCapacity)}` : ""}${row.submittedLate ? " · submitted late" : ""}`}
                  value={pill(row.state)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">No approved MCP yet.</p>
        )}
      </Card>
      {(cursor !== null || !result.isDone) && (
        <Pager
          label="MCP people pages"
          page={page}
          canPrevious={cursor !== null}
          canNext={!result.isDone}
          onPrevious={() => {
            setCursor(null);
            setPage(1);
          }}
          onNext={() => {
            setCursor(result.continueCursor);
            setPage((old) => old + 1);
          }}
        />
      )}
      {canApprove && (
        <Card label="Away periods" icon={<WorkspaceIcon name="field" />}>
          <SupervisorAwayPanel profileId={profileId} label="My away periods" />
        </Card>
      )}
    </div>
  );
}
