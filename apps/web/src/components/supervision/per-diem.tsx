"use client";

import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  DataTable,
  FormField,
  MetricCard,
  Notice,
  StatusPill,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import {
  claimRange,
  decisionError,
  HALF_LABELS,
  NOTE_LABELS,
  reasonText,
  shortDay,
  STATUS_LABELS,
  statusTone,
  type ClaimHalf,
} from "./per-diem-model";
import { formatTime, type SupervisionFilters } from "./supervision-model";

type Validation = FunctionReturnType<
  typeof api.supervision.per_diem.validation
>;
type Selected = NonNullable<Validation["selected"]>;
type PersonRow = Validation["people"][number] & { id: string };
type DayRow = Selected["days"][number] & { id: string };
type ItemRow = Selected["items"][number];
type DecisionRow = Selected["decisions"][number];
type Decide = (args: {
  decision: "validated" | "returned";
  note?: string;
  contentHash: string;
}) => Promise<unknown>;

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function Pill({ status }: { status: string }) {
  return (
    <StatusPill tone={statusTone(status)}>
      {STATUS_LABELS[status] ?? status}
    </StatusPill>
  );
}

function DecisionForm({
  selected,
  decide,
}: {
  selected: Selected;
  decide: Decide;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const held = selected.totals.heldCalls;
  async function submit(decision: "validated" | "returned") {
    setBusy(true);
    setError("");
    try {
      await decide({
        decision,
        contentHash: selected.contentHash,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setNote("");
    } catch (caught) {
      setError(decisionError(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-3">
      <FormField label="Note">
        <textarea
          aria-label="Decision note"
          className="min-h-20 w-full"
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </FormField>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="h-9"
          isDisabled={held > 0 || selected.truncated}
          isPending={busy}
          onPress={() => void submit("validated")}
        >
          Validate {plural(selected.totals.validCalls, "call")} ·{" "}
          {plural(selected.totals.validDays, "day")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-9"
          isDisabled={!note.trim()}
          isPending={busy}
          onPress={() => void submit("returned")}
        >
          Return
        </Button>
        {held > 0 && (
          <span className="text-[13px] text-muted">
            Decide the {held} held {held === 1 ? "call" : "calls"} first
          </span>
        )}
      </div>
      {error && <p className="text-[13px] text-danger">{error}</p>}
    </div>
  );
}

function SelectedView({
  selected,
  decide,
}: {
  selected: Selected;
  decide?: Decide;
}) {
  const t = selected.totals;
  const days: DayRow[] = selected.days.map((row) => ({
    ...row,
    id: row.serviceDate,
  }));
  const exceptions = selected.items.filter(
    (row) => row.status !== "valid" || row.notes.length > 0,
  );
  const dayColumns: DataColumn<DayRow>[] = [
    {
      key: "date",
      label: "Date",
      render: (row) => (
        <span className="font-mono text-[13px]">
          {shortDay(row.serviceDate)}
        </span>
      ),
    },
    {
      key: "planned",
      label: "Planned",
      align: "right",
      render: (row) => row.plannedStops,
    },
    {
      key: "valid",
      label: "Counts",
      align: "right",
      render: (row) => row.validCalls,
    },
    {
      key: "held",
      label: "Held",
      align: "right",
      render: (row) => row.heldCalls || "—",
    },
    {
      key: "invalid",
      label: "Does not count",
      align: "right",
      render: (row) => row.invalidCalls + row.notVisited || "—",
    },
    {
      key: "day",
      label: "Day",
      align: "right",
      render: (row) => <Pill status={row.dayStatus} />,
    },
  ];
  const itemColumns: DataColumn<ItemRow>[] = [
    {
      key: "date",
      label: "Date",
      render: (row) => (
        <span className="font-mono text-[13px]">
          {shortDay(row.serviceDate)}
          {row.checkedInAt ? ` · ${formatTime(row.checkedInAt)}` : ""}
        </span>
      ),
    },
    {
      key: "outlet",
      label: "Account",
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-sm text-foreground">{row.outletName}</span>
          <span className="font-mono text-xs text-muted">
            {row.outletCode}
            {row.sequence !== null ? ` · stop ${row.sequence}` : ""}
          </span>
        </span>
      ),
    },
    {
      key: "why",
      label: "Why",
      render: (row) => (
        <span className="text-[13px]">
          {[
            reasonText(row.reasons),
            ...row.notes.map((note) => NOTE_LABELS[note] ?? note),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      align: "right",
      render: (row) => <Pill status={row.status} />,
    },
  ];
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-4">
        <MetricCard
          label="Calls that count"
          value={String(t.validCalls)}
          detail={`of ${t.plannedStops} planned stops`}
        />
        <MetricCard
          label="Days that count"
          value={String(t.validDays)}
          detail={t.heldDays ? `${t.heldDays} held` : "days with a valid call"}
        />
        <MetricCard
          label="Held"
          value={String(t.heldCalls)}
          detail="waiting for a review"
        />
        <MetricCard
          label="Do not count"
          value={String(t.invalidCalls + t.notVisited)}
          detail={`${t.notVisited} planned stops not visited`}
        />
      </div>
      {selected.truncated && (
        <Notice
          title="Too many calls to check at once"
          meta="Pick 1–15 or 16–end."
        />
      )}
      <Card
        label={`${selected.name} · days`}
        count={days.length}
        icon={<WorkspaceIcon name="list" />}
        flush
      >
        <DataTable
          rows={days}
          columns={dayColumns}
          bare
          empty={
            <p className="p-4 text-[13px] text-muted">
              No approved plan or calls in this period
            </p>
          }
        />
      </Card>
      <Card
        label="Exceptions"
        count={exceptions.length}
        icon={<WorkspaceIcon name="queue" />}
        flush
      >
        <DataTable
          rows={exceptions}
          columns={itemColumns}
          bare
          empty={<p className="p-4 text-[13px] text-muted">No exceptions</p>}
        />
      </Card>
      <Card
        label="Supervisor decision"
        count={selected.decisions.length}
        icon={<WorkspaceIcon name="approvals" />}
      >
        <div className="grid gap-4">
          {selected.decisions.length > 0 && (
            <ol className="grid gap-1 text-[13px]">
              {selected.decisions.map((row: DecisionRow) => (
                <li key={row.id} className="flex flex-wrap items-center gap-2">
                  <Pill status={row.decision} />
                  <span className="tabular-nums">
                    {plural(row.validCalls, "call")} ·{" "}
                    {plural(row.validDays, "day")}
                  </span>
                  <span className="text-muted">
                    {row.deciderName} ·{" "}
                    {new Date(row.decidedAt).toLocaleDateString("en-PH", {
                      timeZone: "Asia/Manila",
                    })}
                  </span>
                  {row.note && <span>· {row.note}</span>}
                  {row.stale && (
                    <StatusPill tone="warning">Calls changed since</StatusPill>
                  )}
                </li>
              ))}
            </ol>
          )}
          {decide && selected.canDecide ? (
            <DecisionForm selected={selected} decide={decide} />
          ) : (
            <p className="text-[13px] text-muted">
              The person&apos;s supervisor or manager decides.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}

/** Presentational per-diem screen; the hooks live in `PerDiem`. */
export function PerDiemView({
  data,
  onPick,
  decide,
}: {
  data: Validation;
  onPick: (id: Id<"profiles"> | null) => void;
  decide?: Decide;
}) {
  const people: PersonRow[] = data.people.map((row) => ({
    ...row,
    id: row.profileId,
  }));
  const columns: DataColumn<PersonRow>[] = [
    {
      key: "name",
      label: "Person",
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-sm font-medium text-foreground">
            {row.name}
          </span>
          <span className="font-mono text-xs text-muted">
            {[row.employeeCode, row.positionLabel].filter(Boolean).join(" · ")}
          </span>
        </span>
      ),
    },
    {
      key: "decision",
      label: "Decision",
      align: "right",
      render: (row) => (
        <span className="flex items-center justify-end gap-2">
          {row.latest ? (
            <Pill status={row.latest.decision} />
          ) : (
            <StatusPill>Not decided</StatusPill>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            aria-label={`Check per diem for ${row.name}`}
            onPress={() => onPick(row.profileId)}
          >
            Check
          </Button>
        </span>
      ),
    },
  ];
  return (
    <div className="grid gap-4">
      <p className="text-[13px] text-muted">
        Only calls in the approved MCP, finished, located and reported count.
        The rate is set per position outside this system.
      </p>
      {data.selected ? (
        <>
          <div>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onPress={() => onPick(null)}
            >
              All people
            </Button>
          </div>
          <SelectedView selected={data.selected} decide={decide} />
        </>
      ) : (
        <>
          {data.truncated && (
            <p className="text-[13px] text-muted">Partial list. Pick a unit.</p>
          )}
          <Card
            label="Per diem claims"
            count={people.length}
            icon={<WorkspaceIcon name="user" />}
            flush
          >
            <DataTable
              rows={people}
              columns={columns}
              bare
              empty={
                <p className="p-4 text-[13px] text-muted">
                  No field people here
                </p>
              }
            />
          </Card>
        </>
      )}
    </div>
  );
}

export function PerDiem({ filters }: { filters: SupervisionFilters }) {
  const [month, setMonth] = useState(filters.serviceDate.slice(0, 7));
  const [half, setHalf] = useState<ClaimHalf>("month");
  const [profileId, setProfileId] = useState<Id<"profiles"> | null>(null);
  const range = claimRange(month, half);
  const data = useQuery(api.supervision.per_diem.validation, {
    ...(filters.orgUnitId ? { orgUnitId: filters.orgUnitId } : {}),
    ...(filters.channel ? { channel: filters.channel } : {}),
    ...(filters.directOnly ? { directOnly: filters.directOnly } : {}),
    ...range,
    ...(profileId ? { profileId } : {}),
  });
  const mutate = useMutation(api.supervision.per_diem.decide);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[180px] max-w-full">
          <FormField label="Month">
            <input
              type="month"
              aria-label="Claim month"
              className="h-10 w-full"
              value={month}
              onChange={(event) => {
                if (event.target.value) setMonth(event.target.value);
              }}
            />
          </FormField>
        </div>
        <div className="w-[160px] max-w-full">
          <FormField label="Period">
            <select
              aria-label="Claim period"
              className="h-10 w-full"
              value={half}
              onChange={(event) => setHalf(event.target.value as ClaimHalf)}
            >
              {HALF_LABELS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
        </div>
      </div>
      {data === undefined ? (
        <span className="text-[13px] text-muted">Checking per diem…</span>
      ) : (
        <PerDiemView
          data={data}
          onPick={setProfileId}
          decide={
            profileId
              ? (args) => mutate({ profileId, ...range, ...args })
              : undefined
          }
        />
      )}
    </div>
  );
}
