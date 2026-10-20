// F-223: structured joint call follow-up on the existing Work-With session. The observation checklist,
// training log, pre-call review and post-call SWOT stay in coaching.js; this module adds the agreed actions
// and carries every unresolved one into the next joint call between the same trainer and trainee.
import { day, fail, oneOf, text, uuid } from "./common.js";
import { session } from "./coaching.js";

const MAX_ACTIONS = 10;

/** Actions agreed in this session, and earlier agreements this session must review.
 * @param {any} c @param {any} s */
export async function jointCallState(c, s) {
  const rows =
    await c.db`select a.*,w.service_date as agreed_on from joint_call_actions a join work_with_sessions w on w.id=a.session_id
      where a.trainer_profile_id=${s.trainer_profile_id} and a.trainee_profile_id=${s.trainee_profile_id} and w.status<>'cancelled'
      and (a.session_id=${s.id} or a.reviewed_in_session_id=${s.id} or (a.status='open' and w.service_date<=${day(s.service_date)}::date and a.session_id<>${s.id}))
      order by w.service_date,a.session_id,a.ordinal limit 200`;
  /** @param {any} r */
  const view = (r) => ({
    id: r.id,
    agreedOn: day(r.agreed_on),
    agreement: r.agreement,
    owner: r.owner,
    dueOn: day(r.due_on),
    status: r.status,
    reviewNote: r.review_note,
  });
  return {
    agreed: rows
      .filter((/** @type {any} */ r) => r.session_id === s.id)
      .map(view),
    carried: rows
      .filter((/** @type {any} */ r) => r.session_id !== s.id)
      .map(view),
  };
}

/** Completion is refused until every carried agreement is reviewed. @param {{carried:any[]}} state */
export function carryGaps(state) {
  return state.carried
    .filter((a) => a.status === "open")
    .map((a) => ({
      code: `carry_forward:${a.id}`,
      label: `Review the action agreed on ${a.agreedOn}: ${a.agreement}`,
    }));
}

/** Replace this open session's agreed actions (trainer only). @param {any} c @param {any} a */
export async function saveActions(c, a) {
  const s = await session(c, a.sessionId, true);
  if (!Array.isArray(a.actions) || a.actions.length > MAX_ACTIONS)
    fail(`Agree at most ${MAX_ACTIONS} actions`);
  const [reviewed] =
    await c.db`select 1 from joint_call_actions where session_id=${s.id} and status<>'open' limit 1`;
  if (reviewed)
    fail(
      "An action from this session was already reviewed; add new actions in the next joint call",
      409,
      "conflict",
    );
  const rows = a.actions.map((/** @type {any} */ x) => {
    const agreement = text(x.agreement, 500);
    if (!agreement) fail("Write every agreed action");
    oneOf(x.owner, ["trainee", "trainer"]);
    if (
      typeof x.dueOn !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(x.dueOn) ||
      x.dueOn < day(s.service_date)
    )
      fail("Each action needs a due day on or after the joint call");
    return { agreement, owner: x.owner, dueOn: x.dueOn };
  });
  await c.db`delete from joint_call_actions where session_id=${s.id}`;
  for (const [i, r] of rows.entries())
    await c.db`insert into joint_call_actions(session_id,trainer_profile_id,trainee_profile_id,org_unit_id,ordinal,agreement,owner,due_on)
      values(${s.id},${s.trainer_profile_id},${s.trainee_profile_id},${s.org_unit_id},${i},${r.agreement},${r.owner},${r.dueOn})`;
  return null;
}

/** Review one earlier agreement inside the current joint call (trainer only). @param {any} c @param {any} a */
export async function reviewAction(c, a) {
  const s = await session(c, a.sessionId, true);
  uuid(a.actionId);
  oneOf(a.outcome, ["done", "not_done"]);
  const note = text(a.note, 500);
  if (!note) fail("Say what you saw at this joint call");
  const [x] =
    await c.db`select a.*,w.service_date from joint_call_actions a join work_with_sessions w on w.id=a.session_id where a.id=${a.actionId} for update of a`;
  if (
    !x ||
    x.trainer_profile_id !== s.trainer_profile_id ||
    x.trainee_profile_id !== s.trainee_profile_id
  )
    fail("Action not found for this trainer and trainee", 404, "not_found");
  if (x.session_id === s.id)
    fail("Review an action at the next joint call, not the one that agreed it");
  if (day(x.service_date) > day(s.service_date))
    fail("This action was agreed after this joint call");
  if (x.status !== "open") {
    if (
      x.reviewed_in_session_id === s.id &&
      x.status === a.outcome &&
      x.review_note === note
    )
      return null;
    fail("This action was already reviewed", 409, "conflict");
  }
  await c.db`update joint_call_actions set status=${a.outcome},reviewed_in_session_id=${s.id},review_note=${note},reviewed_by=${c.actor.profileId},reviewed_at=${new Date(c.now)},updated_at=now() where id=${x.id}`;
  return null;
}
