import { ApiError, conflict, forbidden, invalid } from "../../core/errors.js";
import { OpRejected } from "../../core/sync.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import {
  person,
  roster,
  standard,
  today,
  date,
  uuid,
  requireCapability,
} from "./common.js";
import {
  session,
  sessionDetail,
  startSession,
  updateSession,
  completeSession,
} from "./coaching.js";
import { jointCallState, saveActions, reviewAction } from "./joint-calls.js";
const revision = (/** @type {any} */ d) =>
  sha256Hex(canonicalJson({ session: d.session, jointCall: d.jointCall }));
/** F-223: the existing Work-With model; no new coaching/cadence authority. @param {any} c */
export async function nativeJointCalls(c) {
  await requireCapability(c, "people.read");
  await requireCapability(c, "visit.record");
  const day = date(c.params.serviceDate);
  if (day !== today(c.now)) throw invalid("Refresh today's joint calls");
  const trainer = await person(c, c.actor.profileId, "visit.record");
  const st = await standard(c, trainer, day);
  const members = await roster(c);
  const trainees = [];
  for (const p of members.filter(
    (/** @type {any} */ p) => p.id !== trainer.id,
  )) {
    const state = await jointCallState(c, {
      id: "00000000-0000-0000-0000-000000000000",
      trainer_profile_id: trainer.id,
      trainee_profile_id: p.id,
      service_date: day,
    });
    trainees.push({ id: p.id, name: p.name, carried: state.carried });
  }
  const rows =
    await c.db`select id from work_with_sessions where trainer_profile_id=${trainer.id} and status='open' order by service_date desc,id limit 21`;
  if (rows.length > 20)
    throw conflict(
      "Close older open Work-With sessions in the office before downloading more",
    );
  const sessions = [];
  for (const row of rows) {
    const d = await sessionDetail(c, row.id);
    sessions.push({ ...d, revision: revision(d) });
  }
  return {
    profileId: trainer.id,
    serviceDate: day,
    canStart:
      st?.work_with_weekly_min != null || st?.work_with_monthly_min != null,
    trainees,
    sessions,
  };
}
/** Re-run before the CORE receipt lookup, including unchanged successful replays. @param {any} db @param {any} actor @param {any} op */
export async function guardJointCall(db, actor, op) {
  try {
    const c = { db, actor, now: Date.now() };
    await requireCapability(c, "people.read");
    await requireCapability(c, "visit.record");
    const traineeId = op.payload.sessionId
      ? (await session(c, op.payload.sessionId, true, false)).trainee_profile_id
      : op.payload.traineeProfileId;
    uuid(traineeId);
    await db`select id from profiles where id=${traineeId}::uuid for share`;
    await db`select id from employee_assignments where profile_id=${traineeId}::uuid and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now()) for share`;
    const p = await person(c, traineeId, "visit.record");
    if (p.status !== "active" || p.id === actor.profileId) throw forbidden();
  } catch (e) {
    if (e instanceof ApiError) throw new OpRejected("out_of_scope");
    throw e;
  }
}
/** @param {any} platform */
export function installNativeJointCalls(platform) {
  platform.registerProjection("field.jointcall", {
    params: (/** @type {any} */ p) => ({ serviceDate: date(p?.serviceDate) }),
    snapshot: async (/** @type {any} */ c) => ({
      data: await nativeJointCalls(c),
      next: null,
    }),
  });
  platform.registerOp(
    "jointcall.capture",
    async (/** @type {any} */ c) => {
      try {
        const a = c.payload;
        await guardJointCall(c.db, c.actor, c.op);
        let id = a.sessionId;
        if (id) {
          await session(c, id, true);
          let expected = a.expectedRevision;
          if (a.previousRequestId) {
            const [prior] =
              await c.db`select details from field_report_audit where actor_id=${c.actor.profileId} and command='jointcall.capture' and entity_id=${id} and details->>'requestId'=${a.previousRequestId} order by id desc limit 1`;
            const [receipt] =
              await c.db`select ack from op_receipts where subject=${c.actor.subject} and device_id=${c.device.id} and client_op_id=${a.previousRequestId} and op_type='jointcall.capture' and status='applied'`;
            if (
              !prior ||
              receipt?.ack?.entityId !== id ||
              !c.op.dependsOn.includes(a.previousRequestId)
            )
              throw invalid(
                "The preceding draft must be acknowledged on this phone",
              );
            expected = prior.details.resultRevision;
          }
          if (expected !== revision(await sessionDetail(c, id)))
            throw conflict(
              "The office changed this session; reconcile the retained form",
            );
        } else id = await startSession(c, a);
        const p = { ...a, sessionId: id };
        await updateSession(c, p);
        if (a.actions !== undefined) await saveActions(c, p);
        if (!Array.isArray(a.reviews) || a.reviews.length > 200)
          throw invalid("Review at most 200 carried actions");
        for (const r of a.reviews)
          await reviewAction(c, { ...r, sessionId: id });
        if (a.complete === true)
          await completeSession(c, p).catch((/** @type {any} */ e) => {
            // FLD-159: a finish refused for a missing part says so (the draft itself was saved before).
            if (e instanceof ApiError && e.status === 422)
              throw new OpRejected("work_with_incomplete");
            throw e;
          });
        else if (a.complete !== false)
          throw invalid("Choose draft or complete");
        await c.db`insert into field_report_audit(actor_id,command,entity_id,details) values(${c.actor.profileId},'jointcall.capture',${id},${{ requestId: c.op.clientOpId, deviceId: c.device.id, complete: a.complete, resultRevision: revision(await sessionDetail(c, id)) }})`;
        c.publish("supervision");
        return { entityId: id };
      } catch (e) {
        if (e instanceof ApiError)
          throw new OpRejected(
            e.status === 403
              ? "out_of_scope"
              : e.status === 409
                ? "idempotency_conflict"
                : "invalid_request",
          );
        throw e;
      }
    },
    guardJointCall,
  );
}
