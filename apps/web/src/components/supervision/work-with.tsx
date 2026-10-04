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
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useState } from "react";
import type { SupervisionFilters } from "./supervision-model";
import {
  cadenceCell,
  MODE_LABELS,
  OBJECTIVE_LABELS,
  PRE_CALL_DOCUMENTS,
  RATING_LABELS,
  shortDate,
  STATUS_LABELS,
  statusTone,
  type PreCallDocument,
} from "./work-with-model";

type Cadence = FunctionReturnType<typeof api.supervision.work_with.cadence>;
type Trainer = Cadence["trainers"][number] & { id: string };
type SessionRow = Cadence["sessions"][number] & { id: string };
type Mine = FunctionReturnType<typeof api.supervision.work_with.mine>;
type Detail = FunctionReturnType<typeof api.supervision.work_with.detail>;
type UpdateArgs = FunctionArgs<typeof api.supervision.work_with.update>;
type StartArgs = FunctionArgs<typeof api.supervision.work_with.start>;
type Observation = NonNullable<UpdateArgs["observations"]>[number];

function errorText(error: unknown) {
  const data = (error as { data?: unknown })?.data;
  return typeof data === "string" ? data : "Not saved. Try again.";
}

function sessionColumns(
  onOpen?: (id: Id<"workWithSessions">) => void,
  showTrainer = true,
): DataColumn<SessionRow>[] {
  return [
    {
      key: "date",
      label: "Date",
      render: (row) => (
        <span className="font-mono text-[13px]">
          {shortDate(row.serviceDate)}
        </span>
      ),
    },
    ...(showTrainer
      ? [
          {
            key: "trainer",
            label: "Trainer",
            render: (row: SessionRow) => row.trainerName,
          },
        ]
      : []),
    { key: "trainee", label: "With", render: (row) => row.traineeName },
    {
      key: "objective",
      label: "Objective",
      render: (row) =>
        [
          OBJECTIVE_LABELS[row.objective],
          row.mode === "truck"
            ? `Truck ${row.truckReference ?? ""}`.trim()
            : MODE_LABELS[row.mode],
        ].join(" · "),
    },
    {
      key: "status",
      label: "Status",
      render: (row) => (
        <span className="flex items-center justify-end gap-2">
          <StatusPill tone={statusTone(row.status)}>
            {STATUS_LABELS[row.status] ?? row.status}
          </StatusPill>
          {onOpen && (
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              aria-label={`Open Work-With with ${row.traineeName} on ${row.serviceDate}`}
              onPress={() => onOpen(row.sessionId)}
            >
              Open
            </Button>
          )}
        </span>
      ),
      align: "right",
    },
  ];
}

/** Supervisor view: each trainer's sessions this week and month against the minimum. */
export function WorkWithCadenceView({
  data,
  onOpen,
}: {
  data: Cadence;
  onOpen?: (id: Id<"workWithSessions">) => void;
}) {
  const trainers: Trainer[] = data.trainers.map((row) => ({
    ...row,
    id: row.profileId,
  }));
  const sessions: SessionRow[] = data.sessions.map((row) => ({
    ...row,
    id: row.sessionId,
  }));
  const behind = trainers.filter(
    (row) => row.weekState === "behind" || row.monthState === "behind",
  ).length;
  const done = sessions.filter((row) => row.status === "completed").length;
  const columns: DataColumn<Trainer>[] = [
    {
      key: "trainer",
      label: "Trainer",
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
      key: "week",
      label: `Week of ${shortDate(data.week.start)}`,
      align: "right",
      render: (row) => {
        const cell = cadenceCell(row.weekCount, row.weeklyMin, row.weekState);
        return <StatusPill tone={cell.tone}>{cell.label}</StatusPill>;
      },
    },
    {
      key: "month",
      label: "Month",
      align: "right",
      render: (row) => {
        const cell = cadenceCell(
          row.monthCount,
          row.monthlyMin,
          row.monthState,
        );
        return <StatusPill tone={cell.tone}>{cell.label}</StatusPill>;
      },
    },
    {
      key: "open",
      label: "Open",
      align: "right",
      render: (row) => (row.openCount ? row.openCount : "—"),
    },
  ];
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard
          label="Trainers"
          value={String(trainers.length)}
          detail="with a Work-With minimum"
        />
        <MetricCard
          label="Behind"
          value={String(behind)}
          detail="week or month ended short"
        />
        <MetricCard
          label="Done this month"
          value={String(done)}
          detail={`of ${sessions.length} sessions`}
        />
      </div>
      {data.truncated && (
        <p className="text-[13px] text-muted">Partial list. Pick a unit.</p>
      )}
      <Card
        label="Work-With cadence"
        count={trainers.length}
        icon={<WorkspaceIcon name="user" />}
        flush
      >
        {trainers.length ? (
          <DataTable rows={trainers} columns={columns} bare empty={null} />
        ) : (
          <p className="p-4 text-[13px] text-muted">
            No trainers with a Work-With minimum here
          </p>
        )}
      </Card>
      <Card
        label="Sessions this month"
        count={sessions.length}
        icon={<WorkspaceIcon name="list" />}
        flush
      >
        {sessions.length ? (
          <DataTable
            rows={sessions}
            columns={sessionColumns(onOpen)}
            bare
            empty={null}
          />
        ) : (
          <p className="p-4 text-[13px] text-muted">No sessions yet</p>
        )}
      </Card>
    </div>
  );
}

function StartForm({
  mine,
  serviceDate,
  start,
  onStarted,
}: {
  mine: Mine;
  serviceDate: string;
  start: (args: StartArgs) => Promise<Id<"workWithSessions">>;
  onStarted: (id: Id<"workWithSessions">) => void;
}) {
  const [trainee, setTrainee] = useState("");
  const [date, setDate] = useState(serviceDate);
  const [objective, setObjective] =
    useState<StartArgs["objective"]>("training");
  const [mode, setMode] = useState<StartArgs["mode"]>("booking");
  const [truck, setTruck] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    try {
      onStarted(
        await start({
          traineeProfileId: trainee as Id<"profiles">,
          serviceDate: date,
          objective,
          mode,
          ...(mode === "truck" ? { truckReference: truck } : {}),
        }),
      );
      setTrainee("");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-[220px] max-w-full">
        <FormField label="With">
          <select
            aria-label="Trainee"
            className="h-10"
            value={trainee}
            onChange={(event) => setTrainee(event.target.value)}
          >
            <option value="">Pick a person</option>
            {mine.trainees.map((row) => (
              <option key={row.profileId} value={row.profileId}>
                {row.employeeCode
                  ? `${row.name} · ${row.employeeCode}`
                  : row.name}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <div className="w-[160px] max-w-full">
        <FormField label="Date">
          <input
            type="date"
            aria-label="Work-With date"
            className="h-10"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </FormField>
      </div>
      <div className="w-[200px] max-w-full">
        <FormField label="Objective">
          <select
            aria-label="Objective"
            className="h-10"
            value={objective}
            onChange={(event) =>
              setObjective(event.target.value as StartArgs["objective"])
            }
          >
            {Object.entries(OBJECTIVE_LABELS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <div className="w-[140px] max-w-full">
        <FormField label="Work with">
          <select
            aria-label="Mode"
            className="h-10"
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as StartArgs["mode"])
            }
          >
            {Object.entries(MODE_LABELS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      {mode === "truck" && (
        <div className="w-[160px] max-w-full">
          <FormField label="Truck">
            <input
              aria-label="Truck"
              className="h-10"
              value={truck}
              maxLength={120}
              onChange={(event) => setTruck(event.target.value)}
            />
          </FormField>
        </div>
      )}
      <Button
        variant="primary"
        className="h-10"
        isDisabled={!trainee || !date || (mode === "truck" && !truck.trim())}
        isPending={busy}
        onPress={() => void submit()}
      >
        Start
      </Button>
      {error && (
        <span role="alert" className="text-[12px] text-danger">
          {error}
        </span>
      )}
    </div>
  );
}

function TextArea({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <FormField label={label}>
      <textarea
        aria-label={label}
        rows={2}
        maxLength={2000}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </FormField>
  );
}

/** The trainer's form for one session; read-only for everybody else. */
export function WorkWithEditorView({
  detail,
  save,
  complete,
  cancel,
  onClose,
}: {
  detail: Detail;
  save: (args: UpdateArgs) => Promise<null>;
  complete: (args: { sessionId: Id<"workWithSessions"> }) => Promise<null>;
  cancel: (args: {
    sessionId: Id<"workWithSessions">;
    reason: string;
  }) => Promise<null>;
  onClose: () => void;
}) {
  const { session } = detail;
  const disabled = !detail.canEdit;
  const [observations, setObservations] = useState<Observation[]>(
    session.observations,
  );
  const [log, setLog] = useState(
    session.trainingLog ?? {
      topics: "",
      tradeDevelopment: "",
      discussedWithTrainee: false,
    },
  );
  const [documents, setDocuments] = useState<PreCallDocument[]>(
    session.preCall?.documents ?? [],
  );
  const [remarks, setRemarks] = useState(session.preCall?.remarks ?? "");
  const [swot, setSwot] = useState(
    session.postCall ?? {
      strengths: "",
      weaknesses: "",
      opportunities: "",
      threats: "",
    },
  );
  const [rode, setRode] = useState(session.rodeWithTruck ?? false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const training = session.objective === "training";

  const payload = (): UpdateArgs => ({
    sessionId: session._id,
    observations: observations.filter((row) => row.item.trim()),
    ...(training
      ? { trainingLog: log }
      : {
          preCall: { documents, remarks },
          postCall: swot,
          ...(session.mode === "truck" ? { rodeWithTruck: rode } : {}),
        }),
  });
  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      setMessage(done);
    } catch (caught) {
      setMessage(errorText(caught));
    } finally {
      setBusy(false);
    }
  }
  const setObservation = (index: number, patch: Partial<Observation>) =>
    setObservations((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );

  return (
    <Card
      label={`Work-With · ${detail.traineeName} · ${shortDate(session.serviceDate)}`}
      icon={<WorkspaceIcon name="field" />}
      actions={
        <Button size="sm" variant="ghost" className="h-8" onPress={onClose}>
          Close
        </Button>
      }
    >
      <div className="grid gap-4">
        <p className="text-[13px] text-muted">
          {[
            detail.trainerName,
            OBJECTIVE_LABELS[session.objective],
            session.mode === "truck"
              ? `Truck ${session.truckReference ?? ""}`.trim()
              : MODE_LABELS[session.mode],
            `MCP ${detail.mcp.done}/${detail.mcp.planned}`,
          ].join(" · ")}{" "}
          <StatusPill tone={statusTone(session.status)}>
            {STATUS_LABELS[session.status] ?? session.status}
          </StatusPill>
        </p>
        {detail.gaps.length > 0 && (
          <Notice
            title="Still needed to complete"
            meta={
              <ul className="list-disc pl-4">
                {detail.gaps.map((gap) => (
                  <li key={gap.code}>{gap.label}</li>
                ))}
              </ul>
            }
          />
        )}
        {session.cancelReason && (
          <Notice
            tone="neutral"
            title="Cancelled"
            meta={session.cancelReason}
          />
        )}

        <section aria-label="BCP and PSF observations" className="grid gap-2">
          <h3 className="text-[13px] font-medium text-foreground">
            BCP and PSF observations
          </h3>
          {observations.map((row, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <select
                aria-label={`Observation ${index + 1} area`}
                className="h-9 w-[90px]"
                value={row.area}
                disabled={disabled}
                onChange={(event) =>
                  setObservation(index, {
                    area: event.target.value as Observation["area"],
                  })
                }
              >
                <option value="bcp">BCP</option>
                <option value="psf">PSF</option>
              </select>
              <input
                aria-label={`Observation ${index + 1} step`}
                className="h-9 min-w-[180px] flex-1"
                placeholder="Step observed"
                maxLength={120}
                value={row.item}
                disabled={disabled}
                onChange={(event) =>
                  setObservation(index, { item: event.target.value })
                }
              />
              <select
                aria-label={`Observation ${index + 1} rating`}
                className="h-9 w-[110px]"
                value={row.rating}
                disabled={disabled}
                onChange={(event) =>
                  setObservation(index, {
                    rating: event.target.value as Observation["rating"],
                  })
                }
              >
                {Object.entries(RATING_LABELS).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                aria-label={`Observation ${index + 1} remark`}
                className="h-9 min-w-[180px] flex-1"
                placeholder="Remark"
                maxLength={2000}
                value={row.remark ?? ""}
                disabled={disabled}
                onChange={(event) =>
                  setObservation(index, { remark: event.target.value })
                }
              />
            </div>
          ))}
          {!disabled && (
            <span className="flex gap-2">
              {(["bcp", "psf"] as const).map((area) => (
                <Button
                  key={area}
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onPress={() =>
                    setObservations((rows) => [
                      ...rows,
                      { area, item: "", rating: "met" },
                    ])
                  }
                >
                  Add {area.toUpperCase()}
                </Button>
              ))}
            </span>
          )}
        </section>

        {training ? (
          <section aria-label="Training log" className="grid gap-3">
            <TextArea
              label="Training log"
              value={log.topics}
              disabled={disabled}
              onChange={(topics) => setLog({ ...log, topics })}
            />
            <TextArea
              label="Trade development"
              value={log.tradeDevelopment}
              disabled={disabled}
              onChange={(tradeDevelopment) =>
                setLog({ ...log, tradeDevelopment })
              }
            />
            <label className="flex items-center gap-2 text-[13px] text-foreground">
              <input
                type="checkbox"
                checked={log.discussedWithTrainee}
                disabled={disabled}
                onChange={(event) =>
                  setLog({ ...log, discussedWithTrainee: event.target.checked })
                }
              />
              Reviewed and discussed with the trainee
            </label>
          </section>
        ) : (
          <>
            <section aria-label="Before the call" className="grid gap-3">
              <h3 className="text-[13px] font-medium text-foreground">
                Before the call
              </h3>
              <div className="flex flex-wrap gap-4">
                {PRE_CALL_DOCUMENTS.map(([code, label]) => (
                  <label
                    key={code}
                    className="flex items-center gap-2 text-[13px] text-foreground"
                  >
                    <input
                      type="checkbox"
                      checked={documents.includes(code)}
                      disabled={disabled}
                      onChange={(event) =>
                        setDocuments((rows) =>
                          event.target.checked
                            ? [...rows, code]
                            : rows.filter((row) => row !== code),
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
              <TextArea
                label="Pre-call remarks"
                value={remarks}
                disabled={disabled}
                onChange={setRemarks}
              />
            </section>
            <section
              aria-label="After the call"
              className="grid gap-3 sm:grid-cols-2"
            >
              <TextArea
                label="Strengths"
                value={swot.strengths}
                disabled={disabled}
                onChange={(strengths) => setSwot({ ...swot, strengths })}
              />
              <TextArea
                label="Weaknesses"
                value={swot.weaknesses}
                disabled={disabled}
                onChange={(weaknesses) => setSwot({ ...swot, weaknesses })}
              />
              <TextArea
                label="Opportunities"
                value={swot.opportunities}
                disabled={disabled}
                onChange={(opportunities) =>
                  setSwot({ ...swot, opportunities })
                }
              />
              <TextArea
                label="Threats"
                value={swot.threats}
                disabled={disabled}
                onChange={(threats) => setSwot({ ...swot, threats })}
              />
            </section>
            {session.mode === "truck" && (
              <label className="flex items-center gap-2 text-[13px] text-foreground">
                <input
                  type="checkbox"
                  checked={rode}
                  disabled={disabled}
                  onChange={(event) => setRode(event.target.checked)}
                />
                Rode with truck {session.truckReference}
              </label>
            )}
          </>
        )}

        {detail.canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="h-10"
              isPending={busy}
              onPress={() => void run(() => save(payload()), "Saved")}
            >
              Save
            </Button>
            <Button
              variant="primary"
              className="h-10"
              isPending={busy}
              onPress={() =>
                void run(async () => {
                  await save(payload());
                  await complete({ sessionId: session._id });
                }, "Completed")
              }
            >
              Save and complete
            </Button>
            <input
              aria-label="Cancel reason"
              className="h-10 w-[200px]"
              placeholder="Reason to cancel"
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <Button
              variant="ghost"
              className="h-10"
              isDisabled={!reason.trim()}
              isPending={busy}
              onPress={() =>
                void run(
                  () => cancel({ sessionId: session._id, reason }),
                  "Cancelled",
                )
              }
            >
              Cancel session
            </Button>
          </div>
        )}
        {message && (
          <span role="status" className="text-[13px] text-muted">
            {message}
          </span>
        )}
      </div>
    </Card>
  );
}

function SessionEditor({
  sessionId,
  onClose,
}: {
  sessionId: Id<"workWithSessions">;
  onClose: () => void;
}) {
  const detail = useQuery(api.supervision.work_with.detail, { sessionId });
  const save = useMutation(api.supervision.work_with.update);
  const complete = useMutation(api.supervision.work_with.complete);
  const cancel = useMutation(api.supervision.work_with.cancel);
  if (detail === undefined)
    return <span className="text-[13px] text-muted">Loading session…</span>;
  return (
    <WorkWithEditorView
      // Re-seed the form when the session closes elsewhere.
      key={`${sessionId}-${detail.session.status}`}
      detail={detail}
      save={save}
      complete={complete}
      cancel={cancel}
      onClose={onClose}
    />
  );
}

function MyWorkWith({
  serviceDate,
  onOpen,
}: {
  serviceDate: string;
  onOpen: (id: Id<"workWithSessions">) => void;
}) {
  const mine = useQuery(api.supervision.work_with.mine, { serviceDate });
  const start = useMutation(api.supervision.work_with.start);
  if (mine === undefined)
    return (
      <span className="text-[13px] text-muted">Loading your sessions…</span>
    );
  const rows: SessionRow[] = mine.sessions.map((row) => ({
    ...row,
    id: row.sessionId,
  }));
  return (
    <Card
      label="My Work-With"
      count={rows.length}
      icon={<WorkspaceIcon name="plus" />}
    >
      <div className="grid gap-4">
        <StartForm
          mine={mine}
          serviceDate={serviceDate}
          start={start}
          onStarted={onOpen}
        />
        {rows.length > 0 && (
          <DataTable
            rows={rows}
            columns={sessionColumns(onOpen, false)}
            empty={null}
          />
        )}
      </div>
    </Card>
  );
}

export function WorkWith({ filters }: { filters: SupervisionFilters }) {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const data = useQuery(api.supervision.work_with.cadence, filters);
  const [open, setOpen] = useState<Id<"workWithSessions"> | null>(null);
  const canRecord = !!permissions?.capabilities.includes("visit.record");
  return (
    <div className="grid gap-4">
      {open && <SessionEditor sessionId={open} onClose={() => setOpen(null)} />}
      {canRecord && (
        <MyWorkWith serviceDate={filters.serviceDate} onOpen={setOpen} />
      )}
      {data === undefined ? (
        <span className="text-[13px] text-muted">Loading Work-With…</span>
      ) : (
        <WorkWithCadenceView data={data} onOpen={setOpen} />
      )}
    </div>
  );
}
