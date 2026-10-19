import {
  TRAINER_FORM_KINDS,
  JOB_EVALUATION_ITEMS,
  emptyContent,
  formGaps,
} from "./form-rules.js";
import {
  day,
  date,
  dto,
  fail,
  gate,
  ms,
  oneOf,
  person,
  roleHas,
  text,
  uuid,
} from "./common.js";
import { session } from "./coaching.js";

/** @param {any} c @param {string} id @param {boolean} [write] */
export async function form(c, id, write = false, requireDraft = true) {
  uuid(id);
  const [f] =
    await c.db`select f.*,tr.name trainer_name,te.name trainee_name,w.status session_status from trainer_forms f join profiles tr on tr.id=f.trainer_profile_id join profiles te on te.id=f.trainee_profile_id join work_with_sessions w on w.id=f.session_id where f.id=${id} ${write ? c.db.unsafe("for update of f") : c.db.unsafe("")}`;
  if (!f) fail("Training form not found", 404, "not_found");
  await gate(c, write ? "visit.record" : "report.read", f.org_unit_id);
  if (
    write &&
    (f.trainer_profile_id !== c.actor.profileId ||
      (requireDraft && f.status !== "draft"))
  )
    fail("Only the trainer can edit an unsigned form", 403, "forbidden");
  if (
    !write &&
    c.actor.role === "sales" &&
    ![f.trainer_profile_id, f.trainee_profile_id].includes(c.actor.profileId)
  )
    fail("This training form is private", 403, "forbidden");
  return f;
}
/** @param {any} c @param {string} id */
export async function formDetail(c, id) {
  const f = await form(c, id);
  const ss =
    await c.db`select session_id,service_date from trainer_form_evaluation_sessions where trainer_form_id=${id} order by ordinal`;
  return {
    form: {
      ...dto(f),
      evaluationSessions: ss.map((/** @type {any} */ s) => ({
        sessionId: s.session_id,
        serviceDate: day(s.service_date),
      })),
    },
    trainerName: f.trainer_name,
    traineeName: f.trainee_name,
    sessionStatus: f.session_status,
    gaps: formGaps(f.kind, f, day(f.service_date)),
    canEdit:
      f.trainer_profile_id === c.actor.profileId &&
      f.status === "draft" &&
      roleHas(c.actor.role, "visit.record"),
    canAcknowledge:
      f.trainee_profile_id === c.actor.profileId &&
      f.status === "signed" &&
      roleHas(c.actor.role, "visit.record"),
  };
}
/** @param {any} f */
export function formSummary(f) {
  return {
    formId: f.id,
    sessionId: f.session_id,
    serviceDate: day(f.service_date),
    status: f.status,
    kind: f.kind,
    trainerName: f.trainer_name,
    traineeName: f.trainee_name,
  };
}
/** @param {any} c @param {any} a */
export async function createForm(c, a) {
  const s = await session(c, a.sessionId);
  await gate(c, "visit.record", s.org_unit_id);
  if (s.trainer_profile_id !== c.actor.profileId || s.status === "cancelled")
    fail("Only the session trainer may create its forms", 403);
  oneOf(a.kind, TRAINER_FORM_KINDS);
  const empty = emptyContent(a.kind, day(s.service_date));
  const [f] =
    await c.db`insert into trainer_forms(organization_id,kind,session_id,trainer_profile_id,trainee_profile_id,org_unit_id,service_date,status,program,sheet,evaluation,created_by,updated_by) values(${s.organization_id},${a.kind},${s.id},${s.trainer_profile_id},${s.trainee_profile_id},${s.org_unit_id},${day(s.service_date)},'draft',${empty.program ?? null},${empty.sheet ?? null},${empty.evaluation ?? null},${c.actor.userId},${c.actor.userId}) on conflict (session_id,kind) do nothing returning id`;
  return (
    f?.id ??
    (
      await c.db`select id from trainer_forms where session_id=${s.id} and kind=${a.kind}`
    )[0].id
  );
}
/** @param {any} c @param {any} a */
export async function updateForm(c, a) {
  const f = await form(c, a.formId, true);
  const key =
    f.kind === "training_program"
      ? "program"
      : f.kind === "training_sheet"
        ? "sheet"
        : "evaluation";
  const value = a[key];
  if (!value || typeof value !== "object")
    fail("Supply the matching form content");
  if (JSON.stringify(value).length > 20000) fail("Form is too long");
  for (const v of Object.values(value)) if (typeof v === "string") text(v);
  if (
    value.objectives &&
    (!Array.isArray(value.objectives) || value.objectives.length > 3)
  )
    fail("Use at most three objectives");
  if (key === "evaluation") {
    date(value.periodStart);
    date(value.periodEnd);
  }
  if (
    value.objectives &&
    value.objectives.some(
      (/** @type {any} */ value) =>
        typeof value !== "string" || value.length > 2000,
    )
  )
    fail("Write text training objectives", 400);
  if (value.ratings) {
    if (!Array.isArray(value.ratings) || value.ratings.length > 60)
      fail("Too many ratings");
    const seen = new Set();
    for (const r of value.ratings) {
      if (
        ![1, 2, 3, 4].includes(r.rating) ||
        !JOB_EVALUATION_ITEMS.has(r.item) ||
        seen.has(r.item)
      )
        fail("Choose unique listed job ratings");
      seen.add(r.item);
    }
  }
  await c.db`update trainer_forms set program=${key === "program" ? value : f.program},sheet=${key === "sheet" ? value : f.sheet},evaluation=${key === "evaluation" ? value : f.evaluation},updated_by=${c.actor.userId} where id=${f.id}`;
  return null;
}
/** @param {any} c @param {any} a */
export async function signForm(c, a) {
  const f = await form(c, a.formId, true);
  if (f.session_status !== "completed")
    fail("Complete the Work-With session before signing");
  const gaps = formGaps(f.kind, f, day(f.service_date));
  if (gaps.length) fail(gaps.map((g) => g.label).join("; "));
  if (f.kind === "job_evaluation") {
    const rows =
      await c.db`select id,service_date from work_with_sessions where trainer_profile_id=${f.trainer_profile_id} and trainee_profile_id=${f.trainee_profile_id} and status='completed' and service_date between ${f.evaluation.periodStart}::date and ${f.evaluation.periodEnd}::date order by service_date,id`;
    for (const [i, s] of rows.entries())
      await c.db`insert into trainer_form_evaluation_sessions(trainer_form_id,ordinal,session_id,service_date) values(${f.id},${i},${s.id},${day(s.service_date)})`;
  }
  await c.db`update trainer_forms set status='signed',signed_at=${new Date(c.now)},signed_by=${c.actor.userId},updated_by=${c.actor.userId} where id=${f.id}`;
  return null;
}
/** @param {any} c @param {any} a */
export async function acknowledgeForm(c, a) {
  const f = await form(c, a.formId);
  await gate(c, "visit.record", f.org_unit_id);
  if (f.trainee_profile_id !== c.actor.profileId || f.status !== "signed")
    fail("Only the trainee may acknowledge a signed form", 403);
  await c.db`update trainer_forms set status='acknowledged',acknowledged_at=${new Date(c.now)},acknowledged_by=${c.actor.userId},trainee_comment=${a.comment ? text(a.comment) : null},updated_by=${c.actor.userId} where id=${f.id} and status='signed'`;
  return null;
}
/** @param {any} c @param {any} a */
export async function program(c, a) {
  const p = await person(c, a.traineeProfileId);
  const rows =
    await c.db`select f.*,tr.name trainer_name from trainer_forms f join profiles tr on tr.id=f.trainer_profile_id where f.trainee_profile_id=${p.id} and f.status in ('signed','acknowledged') order by f.service_date desc,f.id desc`;
  for (const f of rows) await gate(c, "report.read", f.org_unit_id);
  const latest = rows.find(
    (/** @type {any} */ r) => r.kind === "job_evaluation",
  );
  return {
    traineeName: p.name,
    blocks: rows
      .filter((/** @type {any} */ r) => r.kind === "training_program")
      .map((/** @type {any} */ f) => ({
        formId: f.id,
        serviceDate: day(f.service_date),
        trainerName: f.trainer_name,
        status: f.status,
        program: f.program,
      })),
    latestEvaluation: latest
      ? {
          formId: latest.id,
          serviceDate: day(latest.service_date),
          trainerName: latest.trainer_name,
          evaluation: latest.evaluation,
        }
      : null,
  };
}
