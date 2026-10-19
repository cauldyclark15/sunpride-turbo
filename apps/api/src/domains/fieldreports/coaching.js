import {
  date,
  day,
  dto,
  fail,
  gate,
  ms,
  oneOf,
  person,
  requireCapability,
  roleHas,
  roster,
  standard,
  text,
  today,
  uuid,
} from "./common.js";
import {
  cadenceState,
  carriesOver,
  completionGaps,
  countIn,
  effectiveStatus,
  finalizeGaps,
  monthOf,
  oneMonthAfter,
  rootCauseDue,
  TOPIC_LABELS,
  weekOf,
} from "./rules.js";
import { execution } from "./reads.js";
import { scopeFilterForActor } from "../org/scope.js";

/** @param {any} c @param {string} id @param {boolean} [write] */
export async function session(c, id, write = false, requireOpen = true) {
  uuid(id);
  const [s] =
    await c.db`select w.*,tr.name trainer_name,te.name trainee_name from work_with_sessions w join profiles tr on tr.id=w.trainer_profile_id join profiles te on te.id=w.trainee_profile_id where w.id=${id} ${write ? c.db.unsafe("for update of w") : c.db.unsafe("")}`;
  if (!s) fail("Work-With not found", 404, "not_found");
  await gate(c, write ? "visit.record" : "report.read", s.org_unit_id);
  if (
    write &&
    (s.trainer_profile_id !== c.actor.profileId ||
      (requireOpen && s.status !== "open"))
  )
    fail("Only the trainer can edit an open session", 403, "forbidden");
  if (
    !write &&
    c.actor.role === "sales" &&
    ![s.trainer_profile_id, s.trainee_profile_id].includes(c.actor.profileId)
  )
    fail("This session is private", 403, "forbidden");
  return s;
}
/** @param {any} c @param {string} id */
export async function sessionDetail(c, id) {
  const s = await session(c, id);
  const p = await person(c, s.trainee_profile_id);
  const x = await execution(c, p, day(s.service_date));
  const observations =
    await c.db`select * from work_with_session_observations where work_with_session_id=${id} order by ordinal`;
  const row = {
    ...dto(s),
    observations: observations.map((/** @type {any} */ o) => ({
      area: o.area,
      item: o.item,
      rating: o.rating,
      ...(o.remark ? { remark: o.remark } : {}),
    })),
    trainingLog:
      s.training_log_topics !== null
        ? {
            topics: s.training_log_topics,
            tradeDevelopment: s.training_log_trade_development,
            discussedWithTrainee: s.training_log_discussed_with_trainee,
          }
        : undefined,
    preCall:
      s.pre_call_remarks !== null
        ? { documents: s.pre_call_documents, remarks: s.pre_call_remarks }
        : undefined,
    postCall:
      s.post_call_strengths !== null
        ? {
            strengths: s.post_call_strengths,
            weaknesses: s.post_call_weaknesses,
            opportunities: s.post_call_opportunities,
            threats: s.post_call_threats,
          }
        : undefined,
  };
  const mcp = { planned: x.summary.planned, done: x.summary.plannedDone };
  return {
    session: row,
    trainerName: s.trainer_name,
    traineeName: s.trainee_name,
    mcp,
    gaps: completionGaps(row, mcp),
    canEdit:
      s.trainer_profile_id === c.actor.profileId &&
      s.status === "open" &&
      roleHas(c.actor.role, "visit.record"),
  };
}
/** @param {any} c @param {any} f */
export async function cadence(c, f) {
  const d = date(f.serviceDate);
  const week = weekOf(d);
  const month = monthOf(d);
  const people = await roster(c, f, true);
  const { unitIds } = await scopeFilterForActor(c.db, c.actor);
  const trainers = [];
  const sessions = [];
  for (const p of people) {
    const st = await standard(c, p, d);
    if (st?.work_with_weekly_min == null && st?.work_with_monthly_min == null)
      continue;
    const ss =
      await c.db`select w.*,tr.name trainer_name,te.name trainee_name from work_with_sessions w join profiles tr on tr.id=w.trainer_profile_id join profiles te on te.id=w.trainee_profile_id where w.trainer_profile_id=${p.id} and (${unitIds === null} or w.org_unit_id in ${c.db(unitIds?.length ? unitIds : [null])}) and w.service_date between ${week.start < month.start ? week.start : month.start}::date and ${week.end > month.end ? week.end : month.end}::date order by w.service_date,w.id`;
    const visible = [];
    for (const s of ss) {
      await gate(c, "report.read", s.org_unit_id);
      visible.push(s);
    }
    const weekCount = countIn(visible, week.start, week.end);
    const monthCount = countIn(visible, month.start, month.end);
    trainers.push({
      profileId: p.id,
      name: p.name,
      employeeCode: p.employee_code,
      positionLabel: p.position_label ?? "Position not set",
      orgUnitId: p.org_unit_id,
      direct: p.direct,
      weeklyMin: st.work_with_weekly_min,
      monthlyMin: st.work_with_monthly_min,
      weekCount,
      monthCount,
      openCount: visible.filter((s) => s.status === "open").length,
      weekState: cadenceState(
        weekCount,
        st.work_with_weekly_min,
        week.end,
        today(c.now),
      ),
      monthState: cadenceState(
        monthCount,
        st.work_with_monthly_min,
        month.end,
        today(c.now),
      ),
      sourceRef: st.source_ref,
    });
    sessions.push(...visible.map(sessionSummary));
  }
  return { week, month, truncated: false, trainers, sessions };
}
/** @param {any} s */
export function sessionSummary(s) {
  return {
    sessionId: s.id,
    serviceDate: day(s.service_date),
    trainerProfileId: s.trainer_profile_id,
    trainerName: s.trainer_name,
    traineeProfileId: s.trainee_profile_id,
    traineeName: s.trainee_name,
    objective: s.objective,
    mode: s.mode,
    truckReference: s.truck_reference,
    status: s.status,
  };
}
/** @param {any} c @param {any} a */
export async function startSession(c, a) {
  date(a.serviceDate);
  if (
    Math.abs(Date.parse(a.serviceDate) - Date.parse(today(c.now))) >
    7 * 86400000
  )
    fail("Work-With must be within 7 days of today");
  const trainer = await person(c, c.actor.profileId, "visit.record");
  const trainee = await person(c, a.traineeProfileId, "visit.record");
  if (trainer.id === trainee.id) fail("Choose a different trainee");
  const st = await standard(c, trainer, a.serviceDate);
  if (st?.work_with_weekly_min == null && st?.work_with_monthly_min == null)
    fail("This position has no Work-With standard");
  oneOf(a.objective, ["training", "sales_validation"]);
  oneOf(a.mode, ["truck", "booking"]);
  const truck = a.truckReference ? text(a.truckReference, 120) : null;
  if (a.mode === "truck" && !truck) fail("Name the truck");
  const [r] =
    await c.db`insert into work_with_sessions(organization_id,trainer_profile_id,trainer_position_id,trainee_profile_id,org_unit_id,service_date,objective,mode,truck_reference,status,created_by,updated_by) values(${trainer.organization_id},${trainer.id},${trainer.position_id},${trainee.id},${trainee.org_unit_id},${a.serviceDate},${a.objective},${a.mode},${truck},'open',${c.actor.userId},${c.actor.userId}) returning id`;
  return r.id;
}
/** @param {any} c @param {any} a */
export async function updateSession(c, a) {
  const s = await session(c, a.sessionId, true);
  if (a.observations) {
    if (!Array.isArray(a.observations) || a.observations.length > 40)
      fail("Use at most 40 observations");
    await c.db`delete from work_with_session_observations where work_with_session_id=${s.id}`;
    for (const [i, o] of a.observations.entries()) {
      oneOf(o.area, ["bcp", "psf"]);
      oneOf(o.rating, ["met", "partial", "not_met"]);
      const item = text(o.item, 120);
      if (!item) fail("Name every observation");
      await c.db`insert into work_with_session_observations(work_with_session_id,ordinal,area,item,rating,remark) values(${s.id},${i},${o.area},${item},${o.rating},${o.remark ? text(o.remark) : null})`;
    }
  }
  if (a.trainingLog) {
    text(a.trainingLog.topics);
    text(a.trainingLog.tradeDevelopment);
    if (typeof a.trainingLog.discussedWithTrainee !== "boolean")
      fail("Confirm the training discussion");
  }
  if (a.preCall) {
    if (!Array.isArray(a.preCall.documents)) fail("Choose reviewed reports");
    for (const k of a.preCall.documents)
      oneOf(k, [
        "distribution",
        "productivity",
        "daily_productive_sales_report",
        "call_sheet",
      ]);
    text(a.preCall.remarks);
  }
  if (a.postCall)
    for (const k of ["strengths", "weaknesses", "opportunities", "threats"])
      text(a.postCall[k]);
  await c.db`update work_with_sessions set truck_reference=${a.truckReference === undefined ? s.truck_reference : text(a.truckReference, 120)},rode_with_truck=${a.rodeWithTruck ?? s.rode_with_truck},training_log_topics=${a.trainingLog?.topics ?? s.training_log_topics},training_log_trade_development=${a.trainingLog?.tradeDevelopment ?? s.training_log_trade_development},training_log_discussed_with_trainee=${a.trainingLog?.discussedWithTrainee ?? s.training_log_discussed_with_trainee},pre_call_documents=${c.db.array(a.preCall?.documents ?? s.pre_call_documents, "TEXT")},pre_call_remarks=${a.preCall?.remarks ?? s.pre_call_remarks},post_call_strengths=${a.postCall?.strengths ?? s.post_call_strengths},post_call_weaknesses=${a.postCall?.weaknesses ?? s.post_call_weaknesses},post_call_opportunities=${a.postCall?.opportunities ?? s.post_call_opportunities},post_call_threats=${a.postCall?.threats ?? s.post_call_threats},updated_by=${c.actor.userId} where id=${s.id}`;
  return null;
}
/** @param {any} c @param {any} a */
export async function completeSession(c, a) {
  await session(c, a.sessionId, true);
  const d = await sessionDetail(c, a.sessionId);
  if (d.gaps.length) fail(d.gaps.map((g) => g.label).join("; "));
  await c.db`update work_with_sessions set status='completed',completed_at=${new Date(c.now)},mcp_planned=${d.mcp.planned},mcp_done=${d.mcp.done},updated_by=${c.actor.userId} where id=${a.sessionId}`;
  return null;
}
/** @param {any} c @param {string} id @param {boolean} [write] */
export async function sheet(c, id, write = false, requireDraft = true) {
  uuid(id);
  const [s] =
    await c.db`select t.*,p.name owner_name,u.name unit_name from talk_sheets t join profiles p on p.id=t.owner_profile_id join org_units u on u.id=t.org_unit_id where t.id=${id} ${write ? c.db.unsafe("for update of t") : c.db.unsafe("")}`;
  if (!s) fail("Talk Sheet not found", 404, "not_found");
  await gate(c, write ? "visit.record" : "report.read", s.org_unit_id);
  if (
    write &&
    (s.owner_profile_id !== c.actor.profileId ||
      (requireDraft && s.status !== "draft"))
  )
    fail("Only the author can edit a draft Talk Sheet", 403, "forbidden");
  if (
    !write &&
    c.actor.role === "sales" &&
    s.owner_profile_id !== c.actor.profileId
  )
    fail("This Talk Sheet is private", 403, "forbidden");
  return s;
}
/** @param {any} c @param {string} id */
export async function sheetDetail(c, id) {
  const s = await sheet(c, id);
  const rows =
    await c.db`select * from talk_sheet_items where sheet_id=${id} order by position`;
  const items = rows.map((/** @type {any} */ r) => {
    const i = dto(r);
    return {
      item: i,
      effectiveStatus: effectiveStatus(i, today(c.now)),
      carried: !!r.carried_from_item_id,
      daysOpen: Math.max(
        0,
        Math.round(
          (Date.parse(today(c.now)) - Date.parse(i.openedOn)) / 86400000,
        ),
      ),
      rootCauseDue: rootCauseDue(i, today(c.now)),
    };
  });
  const previous = s.previous_sheet_id
    ? (
        await c.db`select meeting_date from talk_sheets where id=${s.previous_sheet_id}`
      )[0]
    : null;
  return {
    sheet: dto(s),
    ownerName: s.owner_name,
    previousMeetingDate: previous ? day(previous.meeting_date) : null,
    items,
    gaps: finalizeGaps({
      ...dto(s),
      items: items.map((/** @type {any} */ i) => i.item),
    }),
    canEdit:
      s.status === "draft" &&
      s.owner_profile_id === c.actor.profileId &&
      roleHas(c.actor.role, "visit.record"),
  };
}
/** @param {any} c @param {any} a */
export async function createSheet(c, a) {
  const p = await person(c, c.actor.profileId, "visit.record");
  date(a.meetingDate);
  if (
    Math.abs(Date.parse(a.meetingDate) - Date.parse(today(c.now))) >
    31 * 86400000
  )
    fail("Date the meeting within 31 days of today");
  const partner = text(a.partnerName, 120).replace(/\s+/g, " ");
  if (!partner) fail("Name the partner");
  const key = partner.toLowerCase();
  await c.db`select pg_advisory_xact_lock(hashtextextended(${p.org_unit_id + key},0))`;
  const [prev] =
    await c.db`select * from talk_sheets where org_unit_id=${p.org_unit_id} and partner_key=${key} order by meeting_date desc,id desc limit 1`;
  if (
    prev &&
    (prev.status === "draft" || a.meetingDate <= day(prev.meeting_date))
  )
    fail(
      "Sign off the previous sheet and date the next meeting after it",
      409,
      "sheet_chain_conflict",
    );
  const [s] =
    await c.db`insert into talk_sheets(organization_id,org_unit_id,partner_name,partner_key,owner_profile_id,meeting_date,status,previous_sheet_id,created_by,updated_by) values(${p.organization_id},${p.org_unit_id},${partner},${key},${p.id},${a.meetingDate},'draft',${prev?.id ?? null},${c.actor.userId},${c.actor.userId}) returning *`;
  if (prev) {
    const old =
      await c.db`select * from talk_sheet_items where sheet_id=${prev.id} and status<>'completed' order by position`;
    for (const [i, r] of old.entries())
      await c.db`insert into talk_sheet_items(organization_id,sheet_id,position,topic,gap,agreement,corrective_action,responsible,timeline,status,root_cause,opened_on,origin_item_id,carried_from_item_id) values(${s.organization_id},${s.id},${i},${r.topic},${r.gap},${r.agreement},${r.corrective_action},${r.responsible},${r.timeline},${effectiveStatus(r, a.meetingDate)},${r.root_cause},${day(r.opened_on)},${r.origin_item_id ?? r.id},${r.id})`;
  }
  return s.id;
}
/** @param {any} c @param {any} a */
export async function saveSheet(c, a) {
  const s = await sheet(c, a.sheetId, true);
  const old =
    await c.db`select * from talk_sheet_items where sheet_id=${s.id} order by position`;
  if (a.nextContactDate) date(a.nextContactDate);
  if (a.acknowledgedByName !== undefined) text(a.acknowledgedByName, 120);
  if (a.items) {
    if (!Array.isArray(a.items) || a.items.length > 40)
      fail("Use at most 40 action items");
    const ids = a.items.map((/** @type {any} */ i) => i.itemId).filter(Boolean);
    if (new Set(ids).size !== ids.length) fail("Duplicate action item");
    for (const r of old)
      if (r.carried_from_item_id && !ids.includes(r.id))
        fail("Carried actions may close only at Completed");
    for (const id of ids)
      if (!old.some((/** @type {any} */ r) => r.id === id))
        fail("An action does not belong to this sheet", 403);
    // Keep existing IDs stable: later sheets refer to these immutable origin IDs.
    for (const r of old)
      if (!ids.includes(r.id))
        await c.db`delete from talk_sheet_items where id=${r.id}`;
    await c.db`update talk_sheet_items set position=position+1000 where sheet_id=${s.id}`;
    for (const [i, r] of a.items.entries()) {
      oneOf(r.topic, Object.keys(TOPIC_LABELS));
      oneOf(r.status, ["completed", "on_going", "overdue"]);
      date(r.timeline);
      for (const k of ["gap", "agreement", "correctiveAction", "responsible"])
        text(r[k]);
      if (r.rootCause !== undefined) text(r.rootCause);
      const original = old.find((/** @type {any} */ o) => o.id === r.itemId);
      if (original)
        await c.db`update talk_sheet_items set position=${i},topic=${r.topic},gap=${r.gap},agreement=${r.agreement},corrective_action=${r.correctiveAction},responsible=${r.responsible},timeline=${r.timeline},status=${r.status},root_cause=${r.rootCause ?? null} where id=${original.id}`;
      else
        await c.db`insert into talk_sheet_items(organization_id,sheet_id,position,topic,gap,agreement,corrective_action,responsible,timeline,status,root_cause,opened_on) values(${s.organization_id},${s.id},${i},${r.topic},${r.gap},${r.agreement},${r.correctiveAction},${r.responsible},${r.timeline},${r.status},${r.rootCause ?? null},${day(s.meeting_date)})`;
    }
  }
  await c.db`update talk_sheets set next_contact_date=${a.nextContactDate ?? (s.next_contact_date ? day(s.next_contact_date) : null)},acknowledged_by_name=${a.acknowledgedByName ?? s.acknowledged_by_name},updated_by=${c.actor.userId} where id=${s.id}`;
  return null;
}
/** @param {any} c @param {any} a */
export async function register(c, a) {
  const people = await roster(c, a, true);
  const { unitIds } = await scopeFilterForActor(c.db, c.actor);
  const ids = new Set(people.map((/** @type {any} */ p) => p.id));
  const all =
    await c.db`select t.*,p.name owner_name,u.name unit_name from talk_sheets t join profiles p on p.id=t.owner_profile_id join org_units u on u.id=t.org_unit_id where (${unitIds === null} or t.org_unit_id in ${c.db(unitIds?.length ? unitIds : [null])}) order by meeting_date desc,t.id desc`;
  const chains = [];
  const openItems = [];
  const seen = new Set();
  for (const s of all) {
    if (!ids.has(s.owner_profile_id)) continue;
    const key = s.org_unit_id + s.partner_key;
    if (seen.has(key)) continue;
    seen.add(key);
    await gate(c, "report.read", s.org_unit_id);
    const detail = await sheetDetail(c, s.id);
    const open = detail.items.filter((/** @type {any} */ i) =>
      carriesOver(i.effectiveStatus),
    );
    chains.push({
      latestSheetId: s.id,
      partnerName: s.partner_name,
      orgUnitId: s.org_unit_id,
      unitName: s.unit_name,
      ownerName: s.owner_name,
      lastMeetingDate: day(s.meeting_date),
      nextContactDate: s.next_contact_date ? day(s.next_contact_date) : null,
      contactOverdue:
        s.next_contact_date && day(s.next_contact_date) < today(c.now),
      draftSheetId: s.status === "draft" ? s.id : null,
      openCount: open.length,
      overdueCount: open.filter(
        (/** @type {any} */ i) => i.effectiveStatus === "overdue",
      ).length,
      rootCauseCount: open.filter((/** @type {any} */ i) => i.rootCauseDue)
        .length,
    });
    for (const i of open)
      openItems.push({
        itemId: i.item._id,
        sheetId: s.id,
        partnerName: s.partner_name,
        ownerName: s.owner_name,
        topic: i.item.topic,
        gap: i.item.gap,
        responsible: i.item.responsible,
        timeline: i.item.timeline,
        status: i.effectiveStatus,
        openedOn: i.item.openedOn,
        daysOpen: i.daysOpen,
        rootCauseDue: i.rootCauseDue,
        rootCause: i.item.rootCause ?? null,
      });
  }
  return { today: today(c.now), truncated: false, chains, openItems };
}
