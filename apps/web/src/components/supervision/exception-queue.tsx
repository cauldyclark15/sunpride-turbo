"use client";

import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  IconTile,
  ListRow,
  StatusPill,
  WorkspaceIcon,
  type StatusTone,
} from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import {
  DECISION_REASONS,
  EXCEPTION_LABELS,
  eventLabel,
  exceptionMeta,
  formatTime,
  reasonLabel,
  splitQueue,
  type SupervisionFilters,
} from "./supervision-model";

type Queue = FunctionReturnType<typeof api.supervision.exceptions.queue>;
type Item = Queue["items"][number];
type Decide = (args: {
  evidenceId: Id<"visitLocationEvidence">;
  decision: "approve" | "reject";
  reason: string;
}) => Promise<unknown>;

const KIND_TONES: Record<Item["kind"], StatusTone> = {
  location: "danger",
  out_of_sequence: "warning",
  unplanned: "neutral",
  nonproductive: "warning",
  rescheduled: "neutral",
  cancelled: "neutral",
  not_visited: "warning",
};

function History({ item }: { item: Item }) {
  if (!item.history.length) return null;
  return (
    <details className="px-4 pb-3 text-[13px] text-muted">
      <summary className="cursor-pointer">
        History · {item.history.length}
      </summary>
      <ol className="mt-2 grid gap-1">
        {item.history.map((row, index) => (
          <li key={`${row.kind}-${row.at}-${index}`} className="tabular-nums">
            <span className="font-mono">{formatTime(row.at)}</span> ·{" "}
            {eventLabel(row.kind)}
            {row.after ? ` · ${row.after.replaceAll("_", " ")}` : ""}
            {row.reasonCode ? ` · ${reasonLabel(row.reasonCode)}` : ""} ·{" "}
            {row.actorName}
          </li>
        ))}
      </ol>
    </details>
  );
}

function DecisionControls({ item, decide }: { item: Item; decide: Decide }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const decision = DECISION_REASONS.reject.some(([code]) => code === reason)
    ? "reject"
    : "approve";
  async function submit(kind: "approve" | "reject") {
    if (!item.evidenceId || !reason) return;
    setBusy(true);
    setError("");
    try {
      await decide({ evidenceId: item.evidenceId, decision: kind, reason });
    } catch {
      setError("Not saved. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="flex flex-wrap items-center justify-end gap-2">
      <select
        aria-label={`Reason for ${item.personName} at ${item.outletName}`}
        className="h-8 text-[13px]"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      >
        <option value="">Reason</option>
        <optgroup label="Approve">
          {DECISION_REASONS.approve.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Reject">
          {DECISION_REASONS.reject.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </optgroup>
      </select>
      <Button
        size="sm"
        variant="outline"
        className="h-8"
        isDisabled={!reason || decision !== "reject"}
        isPending={busy}
        onPress={() => void submit("reject")}
      >
        Reject
      </Button>
      <Button
        size="sm"
        variant="primary"
        className="h-8"
        isDisabled={!reason || decision !== "approve"}
        isPending={busy}
        onPress={() => void submit("approve")}
      >
        Approve
      </Button>
      {error && (
        <span role="alert" className="text-[12px] text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

function Row({ item, decide }: { item: Item; decide: Decide }) {
  const tone = KIND_TONES[item.kind];
  return (
    <div>
      <ListRow
        icon={
          <IconTile
            tone={tone}
            icon={
              <WorkspaceIcon
                name={item.kind === "location" ? "field" : "queue"}
              />
            }
          />
        }
        title={`${item.personName} · ${item.outletName}`}
        meta={exceptionMeta(item)}
        value={
          item.decision ? (
            <span className="text-[13px] text-muted">
              {item.decision.status === "approved_exception"
                ? "Approved"
                : "Rejected"}{" "}
              · {reasonLabel(item.decision.reasonCode)} ·{" "}
              {item.decision.actorName} · {formatTime(item.decision.at)}
            </span>
          ) : (
            <StatusPill tone={tone}>{EXCEPTION_LABELS[item.kind]}</StatusPill>
          )
        }
        action={
          item.canDecide ? (
            <DecisionControls item={item} decide={decide} />
          ) : undefined
        }
      />
      <History item={item} />
    </div>
  );
}

export function ExceptionQueueView({
  data,
  now,
  decide,
}: {
  data: Queue;
  now: number;
  decide: Decide;
}) {
  const { open, other } = splitQueue(data.items, data.dayCloseAt, now);
  return (
    <div className="grid gap-4">
      {data.truncated && (
        <p className="text-[13px] text-muted">
          Partial list. Pick a unit or channel.
        </p>
      )}
      <Card
        label="Needs decision"
        count={open.length}
        icon={<WorkspaceIcon name="approvals" />}
        flush
      >
        {open.length ? (
          <div className="divide-y divide-separator">
            {open.map((item) => (
              <Row key={item.id} item={item} decide={decide} />
            ))}
          </div>
        ) : (
          <p className="p-4 text-[13px] text-muted">Nothing to decide</p>
        )}
      </Card>
      <Card
        label="Other exceptions"
        count={other.length}
        icon={<WorkspaceIcon name="queue" />}
        flush
      >
        {other.length ? (
          <div className="divide-y divide-separator">
            {other.map((item) => (
              <Row key={item.id} item={item} decide={decide} />
            ))}
          </div>
        ) : (
          <p className="p-4 text-[13px] text-muted">No exceptions</p>
        )}
      </Card>
    </div>
  );
}

export function ExceptionQueue({
  filters,
  now,
}: {
  filters: SupervisionFilters;
  now: number;
}) {
  const data = useQuery(api.supervision.exceptions.queue, filters);
  const decide = useMutation(api.visits.location.decideLocationException);
  if (data === undefined)
    return <span className="text-[13px] text-muted">Loading exceptions…</span>;
  return <ExceptionQueueView data={data} now={now} decide={decide} />;
}
