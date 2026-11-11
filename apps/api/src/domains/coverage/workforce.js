// F-209/F-222: non-call captures use the platform signed-operation ledger, not another call flow.
import { tx } from "@sunpride/db/client";
import { join } from "node:path";
import { filesDir } from "../../core/media.js";
import {
  ApiError,
  invalid,
  forbidden,
  conflict,
  notFound,
} from "../../core/errors.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { reauthorizeDevice } from "../../core/devices.js";
import { currentActor } from "../van/access.js";
import { scopeFilterForActor, outletOwnerUnit } from "../org/scope.js";
import { enrolmentCommand } from "../org/outlets.js";
import { required } from "../org/model.js";
import { haversine } from "../visits/location.js";
import { validTime } from "../visits/shared.js";
import { employeeAt, localDate, manilaDate, DAY, uuid } from "./model.js";
import {
  formPolicyAt,
  workforceContext,
  workforceHash,
  saveFormPolicy,
  readFormPolicies,
} from "./workforce-policies.js";
const ZERO = "00000000-0000-0000-0000-000000000000";
const TABLES = new Set([
  "attendance_sessions",
  "attendance_adjustments",
  "workforce_events",
  "outlet_enrolments",
]);
/** JSON arrays stay JSON (ORG's helper intentionally handles PostgreSQL array columns). @param {any} v */
const parameter = (v) => v ?? null;
/** @param {any} db @param {string} table @param {any} values */
async function insert(db, table, values) {
  const keys = Object.keys(values);
  if (!TABLES.has(table) || keys.some((k) => !/^[a-z_]+$/.test(k)))
    throw new Error("Unknown workforce table/column");
  const [row] = await db.unsafe(
    `insert into ${table} (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
    keys.map((k) => parameter(values[k])),
  );
  return row;
}
/** @param {any} db @param {string} table @param {string} id @param {any} values */
async function update(db, table, id, values) {
  const keys = Object.keys(values);
  if (!TABLES.has(table) || keys.some((k) => !/^[a-z_]+$/.test(k)))
    throw new Error("Unknown workforce table/column");
  const [row] = await db.unsafe(
    `update ${table} set ${keys.map((k, i) => `${k}=$${i + 2}`).join(",")},updated_at=now() where id=$1 returning *`,
    [id, ...keys.map((k) => parameter(values[k]))],
  );
  return row;
}
/** Stored source and current persisted universe owner both gate captured KYC. @param {any} c @param {any} row @param {string} capability */
async function prospectAccess(c, row, capability) {
  await requireCapability(c, capability, row.org_unit_id);
  const unit = await outletOwnerUnit(c.db, row.outlet_id, c.now);
  if (!unit) throw forbidden("Prospect has no current master owner");
  await requireCapability(c, capability, unit);
}

/** @param {any} d */
const dateText = (d) =>
  d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
/** @param {any} ctx @param {string} capability */
async function fieldActor(ctx, capability) {
  const actor = await currentActor(ctx.db, ctx.actor),
    checked = await reauthorizeDevice(ctx.db, actor, ctx.device.id);
  if (checked.device.app !== ctx.app)
    throw forbidden("Device application changed");
  await requireCapability({ ...ctx, actor }, capability, actor.orgUnitId);
  return actor;
}
/** The generic platform claim binds an as-yet-unsent aggregate UUID to person/device/purpose. @param {any} db @param {any} actor @param {any} claim */
export async function canClaimWorkforceMedia(db, actor, claim) {
  if (
    !["prospect-photo", "attendance-photo"].includes(claim.purpose) ||
    !claim.ownerId
  )
    return false;
  try {
    return await tx(db, async (t) => {
      uuid(claim.ownerId);
      const fresh = await currentActor(t, actor),
        checked = await reauthorizeDevice(t, fresh, uuid(claim.deviceId));
      await requireCapability(
        { db: t, actor: fresh },
        claim.purpose === "prospect-photo"
          ? "outlet.enrol.propose"
          : "workforce.record",
        fresh.orgUnitId,
      );
      return (
        checked.device.org_unit_id === fresh.orgUnitId &&
        !!(await formPolicyAt(t, fresh.orgUnitId, Date.now()))
      );
    });
  } catch {
    return false;
  }
}
/** @param {any} ctx @param {string} capability @param {boolean} photo */
async function captureFacts(ctx, capability, photo = true) {
  const actor = await fieldActor(ctx, capability),
    p = ctx.payload;
  validTime(p.capturedAt, ctx.now);
  if (ctx.op.clientTime !== p.capturedAt)
    throw invalid("Capture time must match its immutable operation");
  const employee = await employeeAt(ctx.db, actor.profileId, p.capturedAt);
  if (employee.org_unit_id !== actor.orgUnitId)
    throw forbidden("Captured work belongs to a previous scope");
  const policy = await formPolicyAt(ctx.db, employee.org_unit_id, p.capturedAt);
  if (
    !policy ||
    uuid(p.policyId) !== policy.id ||
    p.policyVersion !== policy.version ||
    p.policyHash !== policy.content_hash ||
    p.capturedAt < +new Date(policy.created_at)
  )
    throw invalid("Refresh the published field form policy");
  const configuration = policy.configuration,
    day = manilaDate(p.capturedAt),
    midnight = localDate(day);
  if (
    p.capturedAt < midnight + configuration.dayStartMinutes * 60000 ||
    p.capturedAt >= midnight + configuration.dayEndMinutes * 60000
  )
    throw invalid("Capture is outside this field form policy window");
  const flags = [];
  if (photo) {
    const g = p.geo,
      f = p.photo;
    if (
      !g ||
      !Number.isFinite(g.latitude) ||
      g.latitude < -90 ||
      g.latitude > 90 ||
      !Number.isFinite(g.longitude) ||
      g.longitude < -180 ||
      g.longitude > 180 ||
      !Number.isFinite(g.accuracyMeters) ||
      g.accuracyMeters < 0 ||
      typeof g.mockSignal !== "boolean" ||
      !Number.isSafeInteger(g.takenAt) ||
      Math.abs(g.takenAt - p.capturedAt) > configuration.maxFixAgeSeconds * 1000
    )
      throw invalid("Capture a recent location fix");
    if (g.accuracyMeters > configuration.maxAccuracyMeters)
      flags.push("low_accuracy");
    if (g.mockSignal) flags.push("mock_signal");
    if (
      !f ||
      f.mime !== "image/jpeg" ||
      !Number.isSafeInteger(f.size) ||
      f.size < 1 ||
      f.size > 10 * 1024 * 1024 ||
      typeof f.checksum !== "string" ||
      !/^[0-9a-f]{64}$/.test(f.checksum) ||
      !Number.isSafeInteger(f.capturedAt) ||
      Math.abs(f.capturedAt - p.capturedAt) >
        configuration.maxFixAgeSeconds * 1000
    )
      throw invalid("Capture a recent JPEG photo");
    const [file] =
      await ctx.db`select * from files where id=${uuid(f.blobId)} for update`;
    const purpose =
      capability === "outlet.enrol.propose"
        ? "prospect-photo"
        : "attendance-photo";
    if (
      !file ||
      file.purpose !== purpose ||
      file.owner_id !== ctx.op.clientOpId ||
      file.created_by !== actor.userId ||
      file.device_id !== ctx.device.id ||
      file.status !== "stored" ||
      file.sha256 !== f.checksum ||
      file.mime !== f.mime ||
      Number(file.size) !== f.size ||
      !file.stored_at
    )
      throw invalid("Photo provenance does not match this capture");
  }
  return {
    actor,
    employee,
    policy,
    day,
    flags,
    snapshot: {
      policy: {
        id: policy.id,
        version: policy.version,
        label: policy.label,
        sourceRef: policy.source_ref,
        contentHash: policy.content_hash,
        configuration: policy.configuration,
      },
      capturedAt: p.capturedAt,
      deviceId: ctx.device.id,
      geo: photo ? p.geo : null,
      photo: photo ? p.photo : null,
      requestHash: workforceHash(p),
    },
  };
}
/** @param {any} c @param {string} kind @param {string} id @param {any} detail */
async function event(c, kind, id, detail = {}) {
  const row = await insert(c.db, "workforce_events", {
    profile_id: c.actor.profileId,
    org_unit_id: c.actor.orgUnitId,
    actor_id: c.actor.profileId,
    device_id: c.device?.id,
    kind,
    entity_id: id,
    detail,
  });
  c.publish?.("coverage");
  return row.id;
}
/** @param {any} ctx */
export async function captureProspect(ctx) {
  const f = await captureFacts(ctx, "outlet.enrol.propose"),
    p = ctx.payload,
    c = { ...ctx, actor: f.actor };
  if (!p.kyc || Array.isArray(p.kyc) || typeof p.kyc !== "object")
    throw invalid("KYC answers are required");
  const fields = f.policy.configuration.fields,
    allowed = new Set(fields.map((/** @type {any} */ x) => x.key));
  if (Object.keys(p.kyc).some((k) => !allowed.has(k)))
    throw invalid("KYC contains a field outside the captured policy");
  const answers = /** @type {Record<string,string>} */ ({});
  for (const field of fields) {
    const value = p.kyc[field.key];
    if (value == null && !field.required) continue;
    if (
      typeof value !== "string" ||
      value.length > field.maxLength ||
      (field.required && !value.trim()) ||
      (field.type === "select" && !field.options.includes(value))
    )
      throw invalid(`Check ${field.label}`);
    answers[field.key] = value;
  }
  const [previous] =
    await ctx.db`select * from outlet_enrolments where proposed_by_profile_id=${f.actor.profileId} and client_request_id=${ctx.op.clientOpId} for update`;
  if (previous) {
    await requireCapability(c, "outlet.enrol.propose", previous.org_unit_id);
    if (previous.capture_snapshot?.requestHash !== workforceHash(p))
      throw conflict("Capture request key changed");
    return { entityId: previous.id, eventIds: [] };
  }
  // SEAM(MASTERS): canonical enrolment is the only universe writer. The proposal stays provisional.
  const result = await enrolmentCommand(c, "propose", {
    name: required(p.name, "Prospect name", 200),
    address: answers.address,
    channel: answers.channel,
    contactName: answers.contactName,
    contactPhone: answers.contactPhone,
    latitude: p.geo.latitude,
    longitude: p.geo.longitude,
    photoStorageIds: [p.photo.blobId],
    clientRequestId: ctx.op.clientOpId,
    note: "Captured through the offline prospect form",
    // SP-0170 (additive): the client's customer fields when the phone sends them.
    ...(p.customer &&
    typeof p.customer === "object" &&
    !Array.isArray(p.customer)
      ? { customer: p.customer }
      : {}),
  });
  if (!result) throw invalid("Prospect enrolment did not return its record");
  await update(ctx.db, "outlet_enrolments", result.enrolmentId, {
    capture_snapshot: { ...f.snapshot, answers, flags: f.flags },
  });
  return {
    entityId: result.enrolmentId,
    eventIds: [await event(c, "prospect_captured", result.enrolmentId)],
  };
}
/** @param {any} ctx */
export async function clockIn(ctx) {
  const f = await captureFacts(ctx, "workforce.record"),
    c = { ...ctx, actor: f.actor };
  await ctx.db`select pg_advisory_xact_lock(hashtext(${`attendance:${f.actor.profileId}:${f.day}`}))`;
  const old =
    await ctx.db`select id from attendance_sessions where profile_id=${f.actor.profileId} and service_date=${f.day}::date`;
  if (old.length)
    throw conflict(
      "A clock-in already exists for this day; reconcile it instead of recapturing",
    );
  const row = await insert(ctx.db, "attendance_sessions", {
    profile_id: f.actor.profileId,
    org_unit_id: f.employee.org_unit_id,
    service_date: f.day,
    clock_in_request_id: ctx.op.clientOpId,
    clock_in_at: new Date(ctx.payload.capturedAt),
    clock_in_device_id: ctx.device.id,
    clock_in_snapshot: f.snapshot,
    photo_file_id: ctx.payload.photo.blobId,
    review_flags: f.flags,
  });
  return { entityId: row.id, eventIds: [await event(c, "clock_in", row.id)] };
}
/** @param {any} ctx */
export async function clockOut(ctx) {
  const f = await captureFacts(ctx, "workforce.record", false),
    p = ctx.payload,
    c = { ...ctx, actor: f.actor };
  uuid(p.clockInRequestId);
  await ctx.db`select pg_advisory_xact_lock(hashtext(${`attendance:${f.actor.profileId}:${f.day}`}))`;
  const [row] =
    await ctx.db`select * from attendance_sessions where profile_id=${f.actor.profileId} and clock_in_request_id=${p.clockInRequestId} for update`;
  if (
    !row ||
    row.org_unit_id !== f.actor.orgUnitId ||
    dateText(row.service_date) !== f.day
  )
    throw invalid(
      "Clock-out must reference your captured clock-in on this day",
    );
  if (row.clock_out_at) throw conflict("This attendance day is already closed");
  const start = +new Date(row.clock_in_at);
  if (p.capturedAt < start) throw invalid("Clock-out precedes clock-in");
  const flags = [...row.review_flags];
  if (p.capturedAt - start > f.policy.configuration.maxShiftHours * 3600000)
    flags.push("long_shift");
  await update(ctx.db, "attendance_sessions", row.id, {
    clock_out_request_id: ctx.op.clientOpId,
    clock_out_at: new Date(p.capturedAt),
    clock_out_device_id: ctx.device.id,
    clock_out_snapshot: f.snapshot,
    review_flags: flags,
  });
  return { entityId: row.id, eventIds: [await event(c, "clock_out", row.id)] };
}
/** Current source scope and current employee scope both apply. @param {any} c @param {string} day */
export async function workforcePeople(c, day) {
  await requireCapability(c, "workforce.read");
  localDate(day);
  const { unitIds } = await scopeFilterForActor(c.db, c.actor),
    units = unitIds?.length ? unitIds : [ZERO];
  const rows =
    await c.db`select p.id,p.name,p.employee_code,p.role,hist.org_unit_id as unit_id,hu.name as unit_name from profiles p
 left join employee_assignments a on a.profile_id=p.id and a.deleted_at is null and a.effective_from<=${new Date(c.now)} and (a.effective_to is null or a.effective_to>${new Date(c.now)})
 join lateral(select h.* from employee_assignments h where h.profile_id=p.id and h.deleted_at is null and h.effective_from<${new Date(localDate(day) + DAY)} and (h.effective_to is null or h.effective_to>${new Date(localDate(day))}) order by h.effective_from desc,h.id limit 1) hist on true
 join org_units u on u.id=coalesce(a.org_unit_id,p.org_unit_id) join org_units hu on hu.id=hist.org_unit_id
 where (p.status='active' or ${day < manilaDate(c.now)}) and p.deleted_at is null
 and (hist.role in ('sales','manager') or exists(select 1 from attendance_sessions s where s.profile_id=p.id and s.service_date=${day}::date))
 and (${unitIds === null} or (u.id in ${c.db(units)} and hu.id in ${c.db(units)}))
 and (${c.actor.role !== "sales"} or p.id=${c.actor.profileId}) order by p.name,p.id limit 1001`;
  if (rows.length > 1000)
    throw conflict("Workforce roster exceeds the complete supported bound");
  return { rows, unitIds, units };
}
/** @param {any} c @param {string} day */
export async function attendanceDay(c, day) {
  const scope = await workforcePeople(c, day),
    ids = scope.rows.map((/** @type {any} */ p) => p.id);
  if (!ids.length)
    return {
      day,
      people: [],
      canApprove: roleHas(c.actor.role, "workforce.approve"),
      canCorrect: roleHas(c.actor.role, "workforce.correct"),
      actorProfileId: c.actor.profileId,
      canImport: roleHas(c.actor.role, "workforce.import"),
    };
  const sessions =
    await c.db`select * from attendance_sessions where service_date=${day}::date and profile_id in ${c.db(ids)} and (${scope.unitIds === null} or org_unit_id in ${c.db(scope.units)})`;
  const adjustments =
    await c.db`select a.*,p.name as prepared_name,v.name as approved_name from attendance_adjustments a join profiles p on p.id=a.prepared_by left join profiles v on v.id=a.approved_by where a.profile_id in ${c.db(ids)} and a.service_date=${day}::date and (${scope.unitIds === null} or a.org_unit_id in ${c.db(scope.units)}) order by a.created_at,a.id limit 5001`;
  if (adjustments.length > 5000)
    throw conflict("Attendance review exceeds its supported bound");
  const calls =
    await c.db`select assignee_profile_id,min(checked_in_at) as first_call,max(checked_out_at) as last_call,count(*) filter(where checked_in_at is not null)::int as calls from visit_executions where service_date=${day}::date and deleted_at is null and assignee_profile_id in ${c.db(ids)} and (${scope.unitIds === null} or org_unit_id in ${c.db(scope.units)}) group by assignee_profile_id`;
  return {
    day,
    canApprove: roleHas(c.actor.role, "workforce.approve"),
    canCorrect: roleHas(c.actor.role, "workforce.correct"),
    actorProfileId: c.actor.profileId,
    canImport: roleHas(c.actor.role, "workforce.import"),
    people: scope.rows.map((/** @type {any} */ person) => {
      const s = sessions.find(
          (/** @type {any} */ x) => x.profile_id === person.id,
        ),
        changes = adjustments.filter(
          (/** @type {any} */ x) => x.profile_id === person.id,
        ),
        approved = changes.filter(
          (/** @type {any} */ x) => x.status === "approved",
        ),
        applied = approved.find(
          (/** @type {any} */ x) =>
            !approved.some(
              (/** @type {any} */ child) => child.replaces_id === x.id,
            ),
        ),
        call = calls.find(
          (/** @type {any} */ x) => x.assignee_profile_id === person.id,
        );
      const start = applied
          ? applied.proposed_start
            ? +new Date(applied.proposed_start)
            : null
          : s
            ? +new Date(s.clock_in_at)
            : null,
        end = applied
          ? applied.proposed_end
            ? +new Date(applied.proposed_end)
            : null
          : s?.clock_out_at
            ? +new Date(s.clock_out_at)
            : null;
      return {
        id: person.id,
        name: person.name,
        employeeCode: person.employee_code,
        unitName: person.unit_name,
        clockIn: s ? +new Date(s.clock_in_at) : null,
        clockOut: s?.clock_out_at ? +new Date(s.clock_out_at) : null,
        sessionId: s?.id ?? null,
        flags: s?.review_flags ?? [],
        firstCall: call?.first_call ? +new Date(call.first_call) : null,
        lastCall: call?.last_call ? +new Date(call.last_call) : null,
        calls: call?.calls ?? 0,
        start,
        end,
        hours:
          start !== null && end !== null
            ? Math.round((end - start) / 36000) / 100
            : null,
        attendance: applied?.kind ?? (s ? "recorded" : "no_clock_in"),
        appliedId: applied?.id ?? null,
        changes: changes.map((/** @type {any} */ x) => ({
          id: x.id,
          kind: x.kind,
          status: x.status,
          start: x.proposed_start ? +new Date(x.proposed_start) : null,
          end: x.proposed_end ? +new Date(x.proposed_end) : null,
          reason: x.reason,
          sourceRef: x.source_ref,
          preparedBy: x.prepared_name,
          approvedBy: x.approved_name,
          preparedId: x.prepared_by,
        })),
      };
    }),
  };
}
/** @param {any} c @param {any} body */
export async function proposeAdjustment(c, body) {
  return tx(c.db, (db) => proposeAdjustmentIn({ ...c, db }, body));
}
/** @param {any} c @param {any} body @param {string|null} [externalIdentity] */
async function proposeAdjustmentIn(c, body, externalIdentity = null) {
  const db = c.db;
  const actor = await currentActor(db, c.actor),
    ctx = { ...c, db, actor };
  await requireCapability(ctx, "workforce.correct");
  const id = uuid(body.profileId),
    day = body.day;
  localDate(day);
  const { rows } = await workforcePeople(ctx, day),
    person = rows.find((/** @type {any} */ p) => p.id === id);
  if (!person) throw forbidden("Employee is outside your current scope");
  if (actor.role === "sales" && id !== actor.profileId)
    throw forbidden("You can request only your own correction");
  const [original] =
    await db`select org_unit_id from attendance_sessions where profile_id=${id} and service_date=${day}::date`;
  if (original)
    await requireCapability(ctx, "workforce.correct", original.org_unit_id);
  const key = required(body.idempotencyKey, "Request key", 150),
    hash = workforceHash(body),
    [old] = externalIdentity
      ? await db`select * from attendance_adjustments where external_identity=${externalIdentity}`
      : await db`select * from attendance_adjustments where prepared_by=${actor.profileId} and client_key=${key}`;
  if (old) {
    await requireCapability(ctx, "workforce.correct", old.org_unit_id);
    if (old.request_hash !== hash)
      throw conflict("Correction request key changed");
    return { id: old.id };
  }
  if (!["correction", "absence", "leave"].includes(body.kind))
    throw invalid("Choose correction, absence or leave");
  const start = body.start == null ? null : body.start,
    end = body.end == null ? null : body.end;
  if (
    body.kind === "correction" &&
    (!Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start === null ||
      end === null ||
      end <= start ||
      manilaDate(start) !== day ||
      manilaDate(end) !== day)
  )
    throw invalid("A correction needs start and end times on that Manila day");
  if (body.kind !== "correction" && (start !== null || end !== null))
    throw invalid("Leave or absence does not invent clock times");
  const replaces = body.replacesId == null ? null : uuid(body.replacesId);
  const row = await insert(db, "attendance_adjustments", {
    profile_id: id,
    org_unit_id: person.unit_id,
    service_date: day,
    kind: body.kind,
    proposed_start: start === null ? null : new Date(start),
    proposed_end: end === null ? null : new Date(end),
    reason: required(body.reason, "Reason", 1000),
    source_ref: required(body.sourceRef, "Import or correction source", 500),
    client_key: key,
    request_hash: hash,
    external_identity: externalIdentity,
    replaces_id: replaces,
    prepared_by: actor.profileId,
  });
  return { id: row.id };
}
/** @param {any} c @param {any} body */
export async function decideAdjustment(c, body) {
  return tx(c.db, async (db) => {
    const actor = await currentActor(db, c.actor),
      ctx = { ...c, db, actor };
    await requireCapability(ctx, "workforce.approve");
    const [row] =
      await db`select * from attendance_adjustments where id=${uuid(body.id)} for update`;
    if (!row) throw notFound();
    await requireCapability(ctx, "workforce.approve", row.org_unit_id);
    const roster = await workforcePeople(ctx, dateText(row.service_date));
    if (!roster.rows.some((/** @type {any} */ p) => p.id === row.profile_id))
      throw forbidden("Employee moved outside your current scope");
    if (
      row.prepared_by === actor.profileId ||
      row.profile_id === actor.profileId
    )
      throw forbidden("Someone else must approve this attendance change");
    const [original] =
      await db`select org_unit_id from attendance_sessions where profile_id=${row.profile_id} and service_date=${dateText(row.service_date)}::date`;
    if (original)
      await requireCapability(ctx, "workforce.approve", original.org_unit_id);
    const reason = required(body.reason, "Decision reason", 1000);
    if (!["approved", "rejected"].includes(body.decision))
      throw invalid("Choose an approval decision");
    if (row.status !== "pending") {
      if (
        row.status === body.decision &&
        row.approved_by === actor.profileId &&
        row.decision_reason === reason
      )
        return { id: row.id };
      throw conflict("Attendance change is already decided");
    }
    await db`select pg_advisory_xact_lock(hashtext(${`attendance:${row.profile_id}:${dateText(row.service_date)}`}))`;
    const active =
      await db`select a.id from attendance_adjustments a where a.profile_id=${row.profile_id} and a.service_date=${dateText(row.service_date)} and a.status='approved' and not exists(select 1 from attendance_adjustments child where child.replaces_id=a.id and child.status='approved')`;
    if (
      body.decision === "approved" &&
      (active.length > 1 || (active[0]?.id ?? null) !== row.replaces_id)
    )
      throw conflict(
        "An attendance decision changed; refresh before approving its replacement",
      );
    await update(db, "attendance_adjustments", row.id, {
      status: body.decision,
      approved_by: actor.profileId,
      approved_at: new Date(c.now),
      decision_reason: reason,
    });
    return { id: row.id };
  });
}
/** @param {any} c @param {any} body */
export async function importAbsence(c, body) {
  await requireCapability(c, "workforce.import");
  if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 100)
    throw invalid("Import one to 100 absence/leave rows");
  const source = required(body.sourceRef, "HR source", 500);
  // SEAM(HR): stable source+external identity, atomic import, no payroll or automatic approval.
  return tx(c.db, async (db) => {
    const actor = await currentActor(db, c.actor),
      ctx = { ...c, db, actor };
    await requireCapability(ctx, "workforce.import");
    await db`select pg_advisory_xact_lock(hashtextextended(${"hr-import:" + source},0))`;
    const ids = [];
    for (const r of body.rows) {
      if (!["leave", "absence"].includes(r.kind))
        throw invalid("The HR adapter accepts only absence and leave");
      let profileId = r.profileId;
      if (r.employeeCode != null) {
        if (
          typeof r.employeeCode !== "string" ||
          !r.employeeCode ||
          r.employeeCode !== r.employeeCode.trim() ||
          r.employeeCode.length > 100
        )
          throw invalid(
            "Employee code must be exact text, including any leading zeroes",
          );
        const roster = await workforcePeople(ctx, r.day),
          matches = roster.rows.filter(
            (/** @type {any} */ p) => p.employee_code === r.employeeCode,
          );
        if (matches.length !== 1)
          throw forbidden("Employee code is unavailable in your scope");
        if (profileId != null && profileId !== matches[0].id)
          throw invalid("Employee identifiers disagree");
        profileId = matches[0].id;
      }
      const externalKey = r.externalKey;
      if (
        typeof externalKey !== "string" ||
        !externalKey ||
        externalKey !== externalKey.trim() ||
        externalKey.length > 100
      )
        throw invalid("Provide an exact HR source row key");
      const identity = workforceHash({ source, externalKey });
      ids.push(
        await proposeAdjustmentIn(
          ctx,
          { ...r, profileId, sourceRef: source, idempotencyKey: identity },
          identity,
        ),
      );
    }
    return { rows: ids };
  });
}
/** @param {any} c */
export async function prospectList(c) {
  await requireCapability(c, "outlet.read");
  const { unitIds } = await scopeFilterForActor(c.db, c.actor),
    units = unitIds?.length ? unitIds : [ZERO];
  const rows =
    await c.db`select e.*,o.name,o.code,o.custodian_org_unit_id,p.name as prepared_name from outlet_enrolments e join outlets o on o.id=e.outlet_id join profiles p on p.id=e.proposed_by_profile_id where e.capture_snapshot is not null and e.deleted_at is null and o.deleted_at is null and (${unitIds === null} or (e.org_unit_id in ${c.db(units)} and o.custodian_org_unit_id in ${c.db(units)})) and (${c.actor.role !== "sales"} or e.proposed_by_profile_id=${c.actor.profileId}) order by e.proposed_at desc,e.id limit 501`;
  if (rows.length > 500)
    throw conflict("Prospect review exceeds its complete supported bound");
  const visible = [];
  for (const row of rows) {
    try {
      await prospectAccess(c, row, "outlet.read");
      visible.push(row);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 403)) throw e;
    }
  }
  return {
    canApprove: roleHas(c.actor.role, "outlet.enrol.approve"),
    rows: visible.map((/** @type {any} */ r) => ({
      id: r.id,
      outletId: r.outlet_id,
      name: r.name,
      code: r.code,
      status: r.resolved_outlet_id ? "linked_existing" : r.status,
      preparedBy: r.prepared_name,
      preparedId: r.proposed_by_profile_id,
      capturedAt: r.capture_snapshot.capturedAt,
      answers: r.capture_snapshot.answers,
      policy: r.capture_snapshot.policy,
      flags: r.capture_snapshot.flags ?? [],
      photoUrl: `/api/v1/coverage/workforce/photo/prospect/${r.id}`,
    })),
  };
}
/** Conservative adapter only; MASTERS replaces it with governed cross-key resolution. @param {any} c @param {any} row */
async function duplicateCandidates(c, row) {
  // SEAM(MASTERS): never overwrite or silently merge an existing customer/outlet master.
  const { unitIds } = await scopeFilterForActor(c.db, c.actor),
    units = unitIds?.length ? unitIds : [ZERO];
  const [proposed] =
    await c.db`select name from outlets where id=${row.outlet_id}`;
  const all =
    await c.db`select o.id,o.name,o.code,p.latitude,p.longitude from outlets o left join outlet_pins p on p.outlet_id=o.id and p.status='verified' and p.deleted_at is null and p.effective_from<=now() and (p.effective_to is null or p.effective_to>now()) where o.id<>${row.outlet_id} and o.status='active' and o.enrolment_status<>'provisional' and o.deleted_at is null and (${unitIds === null} or o.custodian_org_unit_id in ${c.db(units)}) order by o.id limit 5001`;
  if (all.length > 5000)
    throw conflict(
      "Master dedupe adapter exceeds its complete supported bound",
    );
  const [policy] =
    await c.db`select configuration from workforce_form_policies where id=${row.capture_snapshot.policy.id}`;
  const normalized = (/** @type {string} */ name) =>
    name.trim().toLowerCase().replace(/\s+/g, " ");
  const accessible = [];
  for (const row of all) {
    const owner = await outletOwnerUnit(c.db, row.id, c.now);
    if (!owner) continue;
    try {
      await requireCapability(c, "outlet.enrol.approve", owner);
      accessible.push(row);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 403)) throw e;
    }
  }
  const candidates = accessible
    .filter(
      (/** @type {any} */ r) =>
        normalized(r.name) === normalized(proposed.name) ||
        (r.latitude != null &&
          r.longitude != null &&
          haversine(row.capture_snapshot.geo, r) <=
            policy.configuration.dedupeRadiusMeters),
    )
    .map((/** @type {any} */ r) => ({ id: r.id, name: r.name, code: r.code }));
  return {
    candidates,
    token: workforceHash({
      id: row.id,
      hash: row.capture_snapshot.requestHash,
      candidates,
    }),
  };
}
/** @param {any} c @param {string} id */
export async function prospectReview(c, id) {
  const [r] =
    await c.db`select * from outlet_enrolments where id=${uuid(id)} and capture_snapshot is not null`;
  if (!r) throw notFound();
  await prospectAccess(c, r, "outlet.enrol.approve");
  return duplicateCandidates(c, r);
}
/** @param {any} c @param {any} b */
export async function decideProspect(c, b) {
  return tx(c.db, async (db) => {
    const actor = await currentActor(db, c.actor),
      ctx = { ...c, db, actor },
      [r] =
        await db`select * from outlet_enrolments where id=${uuid(b.id)} and capture_snapshot is not null for update`;
    if (!r) throw notFound();
    await prospectAccess(ctx, r, "outlet.enrol.approve");
    if (r.proposed_by_profile_id === actor.profileId)
      throw forbidden("Someone else must review your prospect");
    const hash = workforceHash({ actor: actor.profileId, body: b });
    if (r.capture_review) {
      if (r.capture_review.hash !== hash)
        throw conflict("Prospect decision changed");
      return r.capture_review.result;
    }
    const review = await duplicateCandidates(ctx, r);
    if (review.token !== b.dedupeToken)
      throw conflict("Master candidates changed; review again");
    const reason = required(b.reason, "Dedupe and decision reason", 1000);
    if (!["approve_distinct", "link_existing", "reject"].includes(b.decision))
      throw invalid("Choose a prospect decision");
    const target =
      b.decision === "link_existing" ? uuid(b.existingOutletId) : null;
    if (
      target &&
      !review.candidates.some((/** @type {any} */ p) => p.id === target)
    )
      throw invalid("Choose a reviewed existing master");
    if (
      b.decision === "approve_distinct" &&
      review.candidates.length &&
      b.confirmDistinct !== true
    )
      throw invalid("Confirm that reviewed candidates are different stores");
    await enrolmentCommand(ctx, "decide", {
      enrolmentId: r.id,
      decision: b.decision === "approve_distinct" ? "approved" : "rejected",
      reason,
    });
    const result = {
      id: r.id,
      status:
        b.decision === "approve_distinct"
          ? "approved"
          : target
            ? "linked_existing"
            : "rejected",
    };
    await update(db, "outlet_enrolments", r.id, {
      resolved_outlet_id: target,
      capture_review: {
        hash,
        result,
        actorId: actor.profileId,
        reason,
        at: c.now,
      },
    });
    return result;
  });
}
/** @param {any} c */
export async function workforcePhoto(c) {
  const id = uuid(c.params.id),
    kind = c.params.kind;
  let fileId, unit, owner;
  if (kind === "attendance") {
    const [r] =
      await c.db`select photo_file_id,org_unit_id,profile_id,service_date from attendance_sessions where id=${id}`;
    if (!r) throw notFound();
    const current = await employeeAt(c.db, r.profile_id, c.now);
    await requireCapability(c, "workforce.read", current.org_unit_id);
    fileId = r.photo_file_id;
    unit = r.org_unit_id;
    owner = r.profile_id;
    if (c.actor.profileId !== owner)
      await requireCapability(c, "workforce.approve", unit);
    await requireCapability(c, "workforce.read", unit);
  } else if (kind === "prospect") {
    const [r] =
      await c.db`select e.* from outlet_enrolments e join outlets o on o.id=e.outlet_id where e.id=${id} and e.capture_snapshot is not null and o.deleted_at is null`;
    if (!r) throw notFound();
    await prospectAccess(c, r, "outlet.read");
    fileId = r.capture_snapshot.photo.blobId;
    unit = r.org_unit_id;
    owner = r.proposed_by_profile_id;
    if (c.actor.profileId !== owner)
      await requireCapability(c, "outlet.enrol.approve", unit);
    await requireCapability(c, "outlet.read", unit);
  } else throw notFound();
  const [file] =
    await c.db`select * from files where id=${fileId} and status='stored'`;
  if (
    !file ||
    file.mime !== "image/jpeg" ||
    file.path !== `${file.sha256.slice(0, 2)}/${file.sha256}`
  )
    throw notFound();
  const data = Bun.file(join(filesDir(c.env), file.path));
  if (!(await data.exists())) throw notFound();
  return new Response(data, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
/** @param {any} router @param {any} platform */
export function installWorkforce(router, platform) {
  for (const [name, handler] of Object.entries({
    "workforce.prospect": captureProspect,
    "workforce.clockIn": clockIn,
    "workforce.clockOut": clockOut,
  }))
    platform.registerOp(name, async (/** @type {any} */ ctx) => {
      try {
        return await handler(ctx);
      } catch (e) {
        if (e instanceof ApiError)
          ctx.reject(
            e.status === 403
              ? "out_of_scope"
              : e.status === 409
                ? "idempotency_conflict"
                : "invalid_request",
          );
        throw e;
      }
    });
  router.get(
    "/api/v1/coverage/workforce/policies",
    (/** @type {any} */ c) => readFormPolicies(c),
    { auth: "required" },
  );
  router.post(
    "/api/v1/coverage/workforce/policies",
    (/** @type {any} */ c) => saveFormPolicy(c, c.body),
    { auth: "required" },
  );
  router.get(
    "/api/v1/coverage/workforce/day",
    (/** @type {any} */ c) =>
      attendanceDay(c, c.url.searchParams.get("day") ?? manilaDate(c.now)),
    { auth: "required" },
  );
  router.get(
    "/api/v1/coverage/workforce/prospects",
    (/** @type {any} */ c) => prospectList(c),
    { auth: "required" },
  );
  router.get(
    "/api/v1/coverage/workforce/prospects/:id",
    (/** @type {any} */ c) => prospectReview(c, c.params.id),
    { auth: "required" },
  );
  router.post(
    "/api/v1/coverage/workforce/prospects/decide",
    (/** @type {any} */ c) => decideProspect(c, c.body),
    { auth: "required" },
  );
  router.post(
    "/api/v1/coverage/workforce/corrections",
    (/** @type {any} */ c) => proposeAdjustment(c, c.body),
    { auth: "required" },
  );
  router.post(
    "/api/v1/coverage/workforce/corrections/decide",
    (/** @type {any} */ c) => decideAdjustment(c, c.body),
    { auth: "required" },
  );
  router.post(
    "/api/v1/coverage/workforce/absence-import",
    (/** @type {any} */ c) => importAbsence(c, c.body),
    { auth: "required" },
  );
  router.get(
    "/api/v1/coverage/workforce/photo/:kind/:id",
    (/** @type {any} */ c) => workforcePhoto(c),
    { auth: "required" },
  );
}
