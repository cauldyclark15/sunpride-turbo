"use client";

import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  DataTable,
  FormField,
  Notice,
  StatusPill,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useState } from "react";
import { shortDate } from "../supervision/work-with-model";
import {
  FORM_KIND_ANNEX,
  FORM_KIND_LABELS,
  FORM_KINDS,
  FORM_STATUS_LABELS,
  formStatusTone,
  JOB_EVALUATION_SECTIONS,
  JOB_RATING_LABELS,
  objectiveLines,
  ratingList,
  ratingMap,
  type JobRating,
  type TrainerFormKind,
} from "./trainer-forms-model";

type Detail = FunctionReturnType<typeof api.supervision.trainer_forms.detail>;
type Program = FunctionReturnType<typeof api.supervision.trainer_forms.program>;
type Mine = FunctionReturnType<typeof api.supervision.trainer_forms.mine>;
type FormRow = Mine["written"][number] & { id: string };
type UpdateArgs = FunctionArgs<typeof api.supervision.trainer_forms.update>;
type FormId = Id<"trainerForms">;

function errorText(error: unknown) {
  const data = (error as { data?: unknown })?.data;
  return typeof data === "string" ? data : "Not saved. Try again.";
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

function TextInput({
  label,
  value,
  onChange,
  disabled,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  type?: "text" | "date";
}) {
  return (
    <FormField label={label}>
      <input
        aria-label={label}
        type={type}
        className="h-10"
        maxLength={120}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </FormField>
  );
}

export function formColumns(
  onOpen: (id: FormId) => void,
  person: "trainer" | "trainee",
): DataColumn<FormRow>[] {
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
    {
      key: "form",
      label: "Form",
      render: (row) =>
        `${FORM_KIND_LABELS[row.kind]} · ${FORM_KIND_ANNEX[row.kind]}`,
    },
    {
      key: "person",
      label: person === "trainer" ? "Trainer" : "Trainee",
      render: (row) =>
        person === "trainer" ? row.trainerName : row.traineeName,
    },
    {
      key: "status",
      label: "Status",
      align: "right",
      render: (row) => (
        <span className="flex items-center justify-end gap-2">
          <StatusPill tone={formStatusTone(row.status)}>
            {FORM_STATUS_LABELS[row.status] ?? row.status}
          </StatusPill>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            aria-label={`Open ${FORM_KIND_LABELS[row.kind]} of ${row.serviceDate}`}
            onPress={() => onOpen(row.formId)}
          >
            Open
          </Button>
        </span>
      ),
    },
  ];
}

/** Annex D: the trainee's signed training-program blocks and the latest job evaluation. */
export function ProgramSheetView({ data }: { data: Program }) {
  const latest = data.latestEvaluation;
  return (
    <section aria-label="Training program history" className="grid gap-3">
      <h3 className="text-[13px] font-medium text-foreground">
        {data.traineeName} · performance summary and training program
      </h3>
      {latest ? (
        <p className="text-[13px] text-muted">
          Latest job evaluation {shortDate(latest.serviceDate)} by{" "}
          {latest.trainerName}: overall{" "}
          {latest.evaluation.overall
            ? `${latest.evaluation.overall} · ${JOB_RATING_LABELS[latest.evaluation.overall]}`
            : "not rated"}
        </p>
      ) : (
        <p className="text-[13px] text-muted">No job evaluation yet</p>
      )}
      {data.blocks.length ? (
        data.blocks.map((block) => (
          <div
            key={block.formId}
            className="grid gap-1 border-t border-border pt-2 text-[13px]"
          >
            <span className="font-mono text-xs text-muted">
              {shortDate(block.serviceDate)} · {block.trainerName} ·{" "}
              {block.program.area}
            </span>
            <span>
              <strong>Objectives:</strong> {block.program.objectives.join("; ")}
            </span>
            <span>
              <strong>Strengths:</strong> {block.program.strengths}
            </span>
            <span>
              <strong>Needs improvement:</strong>{" "}
              {block.program.improvementAreas}
            </span>
            <span>
              <strong>Plans for next contact:</strong>{" "}
              {block.program.plansForNextContact}
            </span>
          </div>
        ))
      ) : (
        <p className="text-[13px] text-muted">No signed training blocks yet</p>
      )}
    </section>
  );
}

/** One trainer form: editable by its trainer while a draft, acknowledged by its trainee. */
export function TrainerFormView({
  detail,
  save,
  sign,
  discard,
  acknowledge,
  onClose,
  history,
}: {
  detail: Detail;
  save: (args: UpdateArgs) => Promise<null>;
  sign: (args: { formId: FormId }) => Promise<null>;
  discard: (args: { formId: FormId }) => Promise<null>;
  acknowledge: (args: { formId: FormId; comment?: string }) => Promise<null>;
  onClose: () => void;
  history?: Program;
}) {
  const { form } = detail;
  const disabled = !detail.canEdit;
  const [program, setProgram] = useState(
    form.program ?? {
      area: "",
      objectives: [],
      strengths: "",
      improvementAreas: "",
      plansForNextContact: "",
    },
  );
  const [objectives, setObjectives] = useState(
    objectiveLines(form.program?.objectives ?? []),
  );
  const [sheet, setSheet] = useState(
    form.sheet ?? { objective: "", result: "", learnings: "", nextSteps: "" },
  );
  const [evaluation, setEvaluation] = useState(
    form.evaluation ?? {
      periodStart: form.serviceDate,
      periodEnd: form.serviceDate,
      district: "",
      area: "",
      ratings: [],
      remarks: "",
    },
  );
  const [ratings, setRatings] = useState(() =>
    ratingMap(form.evaluation?.ratings ?? []),
  );
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const payload = (): UpdateArgs => {
    if (form.kind === "training_program")
      return { formId: form._id, program: { ...program, objectives } };
    if (form.kind === "training_sheet") return { formId: form._id, sheet };
    return {
      formId: form._id,
      evaluation: { ...evaluation, ratings: ratingList(ratings) },
    };
  };
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
  const kind = form.kind as TrainerFormKind;

  return (
    <Card
      label={`${FORM_KIND_LABELS[kind]} · ${detail.traineeName} · ${shortDate(form.serviceDate)}`}
      icon={<WorkspaceIcon name="list" />}
      actions={
        <Button size="sm" variant="ghost" className="h-8" onPress={onClose}>
          Close
        </Button>
      }
    >
      <div className="grid gap-4">
        <p className="text-[13px] text-muted">
          {FORM_KIND_ANNEX[kind]} · Trainer {detail.trainerName} · Trainee{" "}
          {detail.traineeName}{" "}
          <StatusPill tone={formStatusTone(form.status)}>
            {FORM_STATUS_LABELS[form.status] ?? form.status}
          </StatusPill>
        </p>
        {detail.canEdit && detail.sessionStatus !== "completed" && (
          <Notice
            tone="neutral"
            title="Complete the Work-With first"
            meta="You can fill this form now and sign it once the session is done."
          />
        )}
        {detail.gaps.length > 0 && (
          <Notice
            title="Still needed to sign"
            meta={
              <ul className="list-disc pl-4">
                {detail.gaps.map((gap) => (
                  <li key={gap.code}>{gap.label}</li>
                ))}
              </ul>
            }
          />
        )}

        {kind === "training_sheet" && (
          <section aria-label="Training memo" className="grid gap-3">
            <TextArea
              label="Objective"
              value={sheet.objective}
              disabled={disabled}
              onChange={(objective) => setSheet({ ...sheet, objective })}
            />
            <TextArea
              label="Result"
              value={sheet.result}
              disabled={disabled}
              onChange={(result) => setSheet({ ...sheet, result })}
            />
            <TextArea
              label="Learnings"
              value={sheet.learnings}
              disabled={disabled}
              onChange={(learnings) => setSheet({ ...sheet, learnings })}
            />
            <TextArea
              label="Next steps"
              value={sheet.nextSteps}
              disabled={disabled}
              onChange={(nextSteps) => setSheet({ ...sheet, nextSteps })}
            />
          </section>
        )}

        {kind === "training_program" && (
          <section aria-label="Training block" className="grid gap-3">
            <div className="w-[260px] max-w-full">
              <TextInput
                label="Area"
                value={program.area}
                disabled={disabled}
                onChange={(area) => setProgram({ ...program, area })}
              />
            </div>
            {objectives.map((line, index) => (
              <TextInput
                key={index}
                label={`Training objective ${index + 1}`}
                value={line}
                disabled={disabled}
                onChange={(value) =>
                  setObjectives((rows) =>
                    rows.map((row, i) => (i === index ? value : row)),
                  )
                }
              />
            ))}
            <TextArea
              label="Strengths"
              value={program.strengths}
              disabled={disabled}
              onChange={(strengths) => setProgram({ ...program, strengths })}
            />
            <TextArea
              label="Areas needing improvement"
              value={program.improvementAreas}
              disabled={disabled}
              onChange={(improvementAreas) =>
                setProgram({ ...program, improvementAreas })
              }
            />
            <TextArea
              label="Training plans for next contact"
              value={program.plansForNextContact}
              disabled={disabled}
              onChange={(plansForNextContact) =>
                setProgram({ ...program, plansForNextContact })
              }
            />
            {history && <ProgramSheetView data={history} />}
          </section>
        )}

        {kind === "job_evaluation" && (
          <section aria-label="Job evaluation" className="grid gap-4">
            <div className="flex flex-wrap gap-3">
              <div className="w-[160px] max-w-full">
                <TextInput
                  label="Training period from"
                  type="date"
                  value={evaluation.periodStart}
                  disabled={disabled}
                  onChange={(periodStart) =>
                    setEvaluation({ ...evaluation, periodStart })
                  }
                />
              </div>
              <div className="w-[160px] max-w-full">
                <TextInput
                  label="Training period to"
                  type="date"
                  value={evaluation.periodEnd}
                  disabled={disabled}
                  onChange={(periodEnd) =>
                    setEvaluation({ ...evaluation, periodEnd })
                  }
                />
              </div>
              <div className="w-[180px] max-w-full">
                <TextInput
                  label="District"
                  value={evaluation.district}
                  disabled={disabled}
                  onChange={(district) =>
                    setEvaluation({ ...evaluation, district })
                  }
                />
              </div>
              <div className="w-[180px] max-w-full">
                <TextInput
                  label="Evaluation area"
                  value={evaluation.area}
                  disabled={disabled}
                  onChange={(area) => setEvaluation({ ...evaluation, area })}
                />
              </div>
            </div>
            <p className="text-[13px] text-muted">
              1 Excellent · 2 Good · 3 Satisfactory · 4 Unsatisfactory
            </p>
            {JOB_EVALUATION_SECTIONS.map((section) => (
              <fieldset key={section.code} className="grid gap-1">
                <legend className="text-[13px] font-medium text-foreground">
                  {section.label}
                </legend>
                {section.items.map(([item, label]) => {
                  const key = `${section.code}.${item}`;
                  return (
                    <label
                      key={key}
                      className="flex items-center justify-between gap-3 text-[13px]"
                    >
                      <span>{label}</span>
                      <select
                        aria-label={`${section.label}: ${label}`}
                        className="h-9 w-[170px]"
                        value={ratings.get(key) ?? ""}
                        disabled={disabled}
                        onChange={(event) =>
                          setRatings((old) => {
                            const next = new Map(old);
                            if (event.target.value)
                              next.set(
                                key,
                                Number(event.target.value) as JobRating,
                              );
                            else next.delete(key);
                            return next;
                          })
                        }
                      >
                        <option value="">Not rated</option>
                        {([1, 2, 3, 4] as const).map((rating) => (
                          <option key={rating} value={rating}>
                            {rating} · {JOB_RATING_LABELS[rating]}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </fieldset>
            ))}
            <label className="flex items-center justify-between gap-3 text-[13px] font-medium">
              <span>Overall job standard</span>
              <select
                aria-label="Overall job standard"
                className="h-9 w-[170px]"
                value={evaluation.overall ?? ""}
                disabled={disabled}
                onChange={(event) => {
                  const next = { ...evaluation };
                  if (event.target.value)
                    next.overall = Number(event.target.value) as JobRating;
                  else delete next.overall;
                  setEvaluation(next);
                }}
              >
                <option value="">Not rated</option>
                {([1, 2, 3, 4] as const).map((rating) => (
                  <option key={rating} value={rating}>
                    {rating} · {JOB_RATING_LABELS[rating]}
                  </option>
                ))}
              </select>
            </label>
            <TextArea
              label="Remarks"
              value={evaluation.remarks}
              disabled={disabled}
              onChange={(remarks) => setEvaluation({ ...evaluation, remarks })}
            />
            {form.evaluationSessions && (
              <p className="text-[13px] text-muted">
                Work-With dates:{" "}
                {form.evaluationSessions.length
                  ? form.evaluationSessions
                      .map((row) => shortDate(row.serviceDate))
                      .join(", ")
                  : "none"}
              </p>
            )}
          </section>
        )}

        {form.status !== "draft" && (
          <p className="text-[13px] text-muted">
            Signed by trainer {detail.trainerName}
            {form.signedAt
              ? ` on ${new Date(form.signedAt).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })}`
              : ""}
            .{" "}
            {form.status === "acknowledged"
              ? `Acknowledged by ${detail.traineeName}${form.traineeComment ? `: “${form.traineeComment}”` : "."}`
              : `Waiting for ${detail.traineeName} to acknowledge.`}
          </p>
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
                  await sign({ formId: form._id });
                }, "Signed")
              }
            >
              Save and sign
            </Button>
            <Button
              variant="ghost"
              className="h-10"
              isPending={busy}
              onPress={() =>
                void run(async () => {
                  await discard({ formId: form._id });
                  onClose();
                }, "Discarded")
              }
            >
              Discard draft
            </Button>
          </div>
        )}
        {detail.canAcknowledge && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[240px] flex-1">
              <TextInput
                label="Your comment (optional)"
                value={comment}
                disabled={false}
                onChange={setComment}
              />
            </div>
            <Button
              variant="primary"
              className="h-10"
              isPending={busy}
              onPress={() =>
                void run(
                  () =>
                    acknowledge({
                      formId: form._id,
                      ...(comment.trim() ? { comment } : {}),
                    }),
                  "Acknowledged",
                )
              }
            >
              Acknowledge
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

function TrainerFormEditor({
  formId,
  onClose,
}: {
  formId: FormId;
  onClose: () => void;
}) {
  const detail = useQuery(api.supervision.trainer_forms.detail, { formId });
  const history = useQuery(
    api.supervision.trainer_forms.program,
    detail?.form.kind === "training_program"
      ? { traineeProfileId: detail.form.traineeProfileId }
      : "skip",
  );
  const save = useMutation(api.supervision.trainer_forms.update);
  const sign = useMutation(api.supervision.trainer_forms.sign);
  const discard = useMutation(api.supervision.trainer_forms.discard);
  const acknowledge = useMutation(api.supervision.trainer_forms.acknowledge);
  if (detail === undefined)
    return <span className="text-[13px] text-muted">Loading form…</span>;
  return (
    <TrainerFormView
      // Re-seed the form when it is signed or acknowledged elsewhere.
      key={`${formId}-${detail.form.status}`}
      detail={detail}
      save={save}
      sign={sign}
      discard={discard}
      acknowledge={acknowledge}
      onClose={onClose}
      {...(history ? { history } : {})}
    />
  );
}

/** Trainer forms of one Work-With session, shown under the session editor. */
export function SessionFormsView({
  data,
  onOpen,
  onCreate,
}: {
  data: FunctionReturnType<typeof api.supervision.trainer_forms.forSession>;
  onOpen: (id: FormId) => void;
  onCreate: (kind: TrainerFormKind) => void;
}) {
  const rows: FormRow[] = data.forms.map((row) => ({ ...row, id: row.formId }));
  const missing = FORM_KINDS.filter(
    (kind) => !data.forms.some((row) => row.kind === kind),
  );
  return (
    <Card
      label="Trainer forms"
      count={rows.length}
      icon={<WorkspaceIcon name="list" />}
    >
      <div className="grid gap-3">
        {rows.length > 0 && (
          <DataTable
            rows={rows}
            columns={formColumns(onOpen, "trainee")}
            empty={null}
          />
        )}
        {!rows.length && (
          <p className="text-[13px] text-muted">No trainer forms yet</p>
        )}
        {data.canCreate && missing.length > 0 && (
          <span className="flex flex-wrap gap-2">
            {missing.map((kind) => (
              <Button
                key={kind}
                size="sm"
                variant="outline"
                className="h-8"
                onPress={() => onCreate(kind)}
              >
                Add {FORM_KIND_LABELS[kind].toLowerCase()}
              </Button>
            ))}
          </span>
        )}
      </div>
    </Card>
  );
}

export function SessionTrainerForms({
  sessionId,
}: {
  sessionId: Id<"workWithSessions">;
}) {
  const data = useQuery(api.supervision.trainer_forms.forSession, {
    sessionId,
  });
  const create = useMutation(api.supervision.trainer_forms.create);
  const [open, setOpen] = useState<FormId | null>(null);
  const [error, setError] = useState("");
  if (data === undefined)
    return <span className="text-[13px] text-muted">Loading forms…</span>;
  return (
    <div className="grid gap-4">
      <SessionFormsView
        data={data}
        onOpen={setOpen}
        onCreate={(kind) => {
          setError("");
          create({ sessionId, kind }).then(setOpen, (caught: unknown) =>
            setError(errorText(caught)),
          );
        }}
      />
      {error && (
        <span role="alert" className="text-[12px] text-danger">
          {error}
        </span>
      )}
      {open && (
        <TrainerFormEditor formId={open} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

/** The caller's own trainer forms: to acknowledge, received and written. */
export function TrainingFormsView({
  mine,
  program,
  onOpen,
}: {
  mine: Mine;
  program?: Program;
  onOpen: (id: FormId) => void;
}) {
  const rows = (list: Mine["written"]): FormRow[] =>
    list.map((row) => ({ ...row, id: row.formId }));
  return (
    <div className="grid gap-4">
      <Card
        label="Waiting for your acknowledgement"
        count={mine.toAcknowledge.length}
        icon={<WorkspaceIcon name="user" />}
        flush
      >
        {mine.toAcknowledge.length ? (
          <DataTable
            rows={rows(mine.toAcknowledge)}
            columns={formColumns(onOpen, "trainer")}
            bare
            empty={null}
          />
        ) : (
          <p className="p-4 text-[13px] text-muted">Nothing to acknowledge</p>
        )}
      </Card>
      {program && (
        <Card label="My training program" icon={<WorkspaceIcon name="field" />}>
          <ProgramSheetView data={program} />
        </Card>
      )}
      <Card
        label="Forms received"
        count={mine.received.length}
        icon={<WorkspaceIcon name="list" />}
        flush
      >
        {mine.received.length ? (
          <DataTable
            rows={rows(mine.received)}
            columns={formColumns(onOpen, "trainer")}
            bare
            empty={null}
          />
        ) : (
          <p className="p-4 text-[13px] text-muted">No forms yet</p>
        )}
      </Card>
      {mine.written.length > 0 && (
        <Card
          label="Forms I wrote"
          count={mine.written.length}
          icon={<WorkspaceIcon name="list" />}
          flush
        >
          <DataTable
            rows={rows(mine.written)}
            columns={formColumns(onOpen, "trainee")}
            bare
            empty={null}
          />
        </Card>
      )}
    </div>
  );
}

/** The Training module: every role reads and acknowledges its own trainer forms here. */
export function TrainingWorkspace() {
  const profile = useQuery(api.domains.profiles.current, {});
  const mine = useQuery(api.supervision.trainer_forms.mine, {});
  const program = useQuery(
    api.supervision.trainer_forms.program,
    profile ? { traineeProfileId: profile._id } : "skip",
  );
  const [open, setOpen] = useState<FormId | null>(null);
  if (mine === undefined)
    return <span className="text-[13px] text-muted">Loading your forms…</span>;
  return (
    <div className="grid gap-4">
      {open && (
        <TrainerFormEditor formId={open} onClose={() => setOpen(null)} />
      )}
      <TrainingFormsView
        mine={mine}
        {...(program ? { program } : {})}
        onOpen={setOpen}
      />
    </div>
  );
}
