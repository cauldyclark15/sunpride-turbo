import { tx } from "@sunpride/db/client";
import {
  command,
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
  text,
  today,
} from "./common.js";
import { completeness, dsr, fieldDay, perDiem, wholeTeam } from "./reads.js";
import {
  cadence,
  completeSession,
  createSheet,
  register,
  saveSheet,
  session,
  sessionDetail,
  sessionSummary,
  sheet,
  sheetDetail,
  startSession,
  updateSession,
} from "./coaching.js";
import {
  acknowledgeForm,
  createForm,
  form,
  formDetail,
  formSummary,
  program,
  signForm,
  updateForm,
} from "./forms.js";
import * as calls from "./call-sheets.js";
import { activity, cockpit, exceptions, options, teamDay } from "./team.js";
import { productivity, productivityRoster } from "./productivity.js";
import { reportKindFor, RULE_VERSION } from "./rules.js";
import { scopeFilterForActor } from "../org/scope.js";
import { installProjections } from "./mobile.js";

/** @param {any} router @param {any} platform */
export function install(router, platform) {
  installProjections(platform);
  const base = "/api/v1/fieldreports/";
  /** @param {string} name @param {(c:any,a:any)=>Promise<any>} fn */
  const get = (name, fn) =>
    router.get(
      base + name.replaceAll(".", "/"),
      async (/** @type {any} */ c) => {
        await requireCapability(c, "report.read");
        let args = {};
        try {
          args = JSON.parse(c.url.searchParams.get("args") ?? "{}");
        } catch {
          fail("Invalid query parameters", 400);
        }
        return tx(c.db, async (/** @type {any} */ db) => {
          await db`set transaction isolation level repeatable read read only`;
          return fn({ ...c, db }, args);
        });
      },
    );
  /** @param {string} name @param {string} topic @param {(c:any,a:any,replay?:any)=>Promise<any>} auth @param {(c:any,a:any)=>Promise<any>} fn */
  const post = (name, topic, auth, fn) =>
    router.post(base + name.replaceAll(".", "/"), (/** @type {any} */ c) =>
      command(c, platform, name, topic, auth, fn),
    );
  /** @param {any} c */
  const record = async (c) => {
    await requireCapability(c, "visit.record");
  };
  get("lib.capabilities.currentPermissions", async (c) => ({
    version: 1,
    role: c.actor.role,
    orgUnitId: c.actor.orgUnitId,
    scopeUnitIds: (await scopeFilterForActor(c.db, c.actor)).unitIds ?? [],
    capabilities: [...c.actor.capabilities],
  }));
  get("domains.profiles.current", async (c) => {
    const p = await person(c, c.actor.profileId);
    return {
      ...dto(p),
      authSubject: p.user_id ?? "",
      role: p.role,
      status: p.status,
    };
  });
  get("supervision.team.options", options);
  get("supervision.team.day", teamDay);
  get("supervision.team.cockpit", cockpit);
  get("supervision.activity.map", activity);
  get("supervision.exceptions.queue", exceptions);
  get("analytics.productivity.roster", productivityRoster);
  get("analytics.productivity.person", productivity);
  get("dsr.report.day", dsr);
  get("dsr.report.team", wholeTeam);
  get("dsr.report.salesmen", async (c, a) => {
    const self = c.actor.role === "sales";
    const members = self
      ? [await person(c, c.actor.profileId)]
      : await roster(c, a);
    return {
      self,
      truncated: false,
      people: members.map((/** @type {any} */ p) => ({
        profileId: p.id,
        name: p.name,
        employeeCode: p.employee_code,
        position: p.position_label,
      })),
    };
  });
  get("supervision.work_with.detail", (c, a) => sessionDetail(c, a.sessionId));
  get("supervision.work_with.cadence", cadence);
  get("supervision.work_with.mine", async (c, a) => {
    await requireCapability(c, "visit.record");
    date(a.serviceDate);
    const members = await roster(c, a);
    const rows =
      await c.db`select w.*,tr.name trainer_name,te.name trainee_name from work_with_sessions w join profiles tr on tr.id=w.trainer_profile_id join profiles te on te.id=w.trainee_profile_id where (w.trainer_profile_id=${c.actor.profileId} or w.trainee_profile_id=${c.actor.profileId}) and w.service_date=${a.serviceDate} order by w.created_at desc`;
    for (const r of rows) await gate(c, "report.read", r.org_unit_id);
    return {
      sessions: rows.map(sessionSummary),
      trainees: members
        .filter((/** @type {any} */ p) => p.id !== c.actor.profileId)
        .map((/** @type {any} */ p) => ({
          profileId: p.id,
          name: p.name,
          employeeCode: p.employee_code,
        })),
      traineesTruncated: false,
    };
  });
  post(
    "supervision.work_with.start",
    "supervision",
    async (c, a, replay) => {
      await person(c, a.traineeProfileId, "visit.record");
      await person(c, c.actor.profileId, "visit.record");
      if (replay) {
        const s = await session(c, replay);
        await gate(c, "visit.record", s.org_unit_id);
      }
    },
    startSession,
  );
  post(
    "supervision.work_with.update",
    "supervision",
    async (c, a) => {
      await session(c, a.sessionId, true, false);
    },
    updateSession,
  );
  post(
    "supervision.work_with.complete",
    "supervision",
    async (c, a) => {
      await session(c, a.sessionId, true, false);
    },
    completeSession,
  );
  post(
    "supervision.work_with.cancel",
    "supervision",
    async (c, a) => {
      await session(c, a.sessionId, true, false);
    },
    async (c, a) => {
      const s = await session(c, a.sessionId, true);
      const reason = text(a.reason, 500);
      if (!reason) fail("Give a cancellation reason");
      await c.db`update work_with_sessions set status='cancelled',cancel_reason=${reason},cancelled_at=${new Date(c.now)},updated_by=${c.actor.userId} where id=${s.id}`;
      return null;
    },
  );
  get("supervision.talk_sheet.detail", (c, a) => sheetDetail(c, a.sheetId));
  get("supervision.talk_sheet.register", register);
  get("supervision.talk_sheet.mine", async (c) => {
    await requireCapability(c, "visit.record");
    const rows =
      await c.db`select t.*,p.name owner_name,u.name unit_name from talk_sheets t join profiles p on p.id=t.owner_profile_id join org_units u on u.id=t.org_unit_id where t.owner_profile_id=${c.actor.profileId} order by meeting_date desc`;
    for (const s of rows) await gate(c, "report.read", s.org_unit_id);
    return {
      sheets: rows.map((/** @type {any} */ s) => ({
        sheetId: s.id,
        partnerName: s.partner_name,
        meetingDate: day(s.meeting_date),
        nextContactDate: s.next_contact_date ? day(s.next_contact_date) : null,
        status: s.status,
        carriedFrom: s.previous_sheet_id,
      })),
      partners: [
        ...new Set(rows.map((/** @type {any} */ s) => s.partner_name)),
      ],
    };
  });
  post(
    "supervision.talk_sheet.create",
    "supervision",
    async (c, a, replay) => {
      await person(c, c.actor.profileId, "visit.record");
      if (replay) {
        const s = await sheet(c, replay);
        await gate(c, "visit.record", s.org_unit_id);
      }
    },
    createSheet,
  );
  post(
    "supervision.talk_sheet.save",
    "supervision",
    async (c, a) => {
      await sheet(c, a.sheetId, true, false);
    },
    saveSheet,
  );
  post(
    "supervision.talk_sheet.finalize",
    "supervision",
    async (c, a) => {
      await sheet(c, a.sheetId, true, false);
    },
    async (c, a) => {
      await sheet(c, a.sheetId, true);
      const d = await sheetDetail(c, a.sheetId);
      if (d.gaps.length) fail(d.gaps.map((g) => g.label).join("; "));
      await c.db`update talk_sheets set status='final',finalized_at=${new Date(c.now)},updated_by=${c.actor.userId} where id=${a.sheetId}`;
      return null;
    },
  );
  post(
    "supervision.talk_sheet.discard",
    "supervision",
    async (c, a) => {
      await sheet(c, a.sheetId, true, false);
    },
    async (c, a) => {
      await sheet(c, a.sheetId, true);
      await c.db`delete from talk_sheet_items where sheet_id=${a.sheetId}`;
      await c.db`delete from talk_sheets where id=${a.sheetId}`;
      return null;
    },
  );
  get("supervision.trainer_forms.detail", (c, a) => formDetail(c, a.formId));
  get("supervision.trainer_forms.program", program);
  get("supervision.trainer_forms.forSession", async (c, a) => {
    const s = await session(c, a.sessionId);
    const rows =
      await c.db`select f.*,tr.name trainer_name,te.name trainee_name from trainer_forms f join profiles tr on tr.id=f.trainer_profile_id join profiles te on te.id=f.trainee_profile_id where f.session_id=${s.id} order by f.kind`;
    return {
      forms: rows.map(formSummary),
      canCreate:
        c.actor.profileId === s.trainer_profile_id &&
        s.status !== "cancelled" &&
        roleHas(c.actor.role, "visit.record"),
    };
  });
  get("supervision.trainer_forms.mine", async (c) => {
    const rows =
      await c.db`select f.*,tr.name trainer_name,te.name trainee_name from trainer_forms f join profiles tr on tr.id=f.trainer_profile_id join profiles te on te.id=f.trainee_profile_id where f.trainer_profile_id=${c.actor.profileId} or f.trainee_profile_id=${c.actor.profileId} order by f.service_date desc`;
    for (const f of rows) await gate(c, "report.read", f.org_unit_id);
    return {
      written: rows
        .filter(
          (/** @type {any} */ f) => f.trainer_profile_id === c.actor.profileId,
        )
        .map(formSummary),
      received: rows
        .filter(
          (/** @type {any} */ f) => f.trainee_profile_id === c.actor.profileId,
        )
        .map(formSummary),
      toAcknowledge: rows
        .filter(
          (/** @type {any} */ f) =>
            f.trainee_profile_id === c.actor.profileId && f.status === "signed",
        )
        .map(formSummary),
    };
  });
  post(
    "supervision.trainer_forms.create",
    "supervision",
    async (c, a) => {
      const s = await session(c, a.sessionId);
      await gate(c, "visit.record", s.org_unit_id);
      if (s.trainer_profile_id !== c.actor.profileId)
        fail("Only the trainer may create forms", 403);
    },
    createForm,
  );
  post(
    "supervision.trainer_forms.update",
    "supervision",
    async (c, a) => {
      await form(c, a.formId, true, false);
    },
    updateForm,
  );
  post(
    "supervision.trainer_forms.sign",
    "supervision",
    async (c, a) => {
      await form(c, a.formId, true, false);
    },
    signForm,
  );
  post(
    "supervision.trainer_forms.acknowledge",
    "supervision",
    async (c, a) => {
      const f = await form(c, a.formId);
      await gate(c, "visit.record", f.org_unit_id);
      if (f.trainee_profile_id !== c.actor.profileId)
        fail("Only the trainee may acknowledge", 403);
    },
    acknowledgeForm,
  );
  post(
    "supervision.trainer_forms.discard",
    "supervision",
    async (c, a) => {
      await form(c, a.formId, true, false);
    },
    async (c, a) => {
      await form(c, a.formId, true);
      await c.db`delete from trainer_forms where id=${a.formId}`;
      return null;
    },
  );
  get("supervision.per_diem.validation", perDiem);
  post(
    "supervision.per_diem.decide",
    "supervision",
    async (c, a) => {
      const p = await person(c, a.profileId, "perdiem.approve");
      if (p.id === c.actor.profileId)
        fail("A different supervisor must validate your evidence", 403);
    },
    async (c, a) => {
      const p = await person(c, a.profileId, "perdiem.approve");
      await c.db`select pg_advisory_xact_lock(hashtextextended(${p.id + "perdiem"},0))`;
      const report = await perDiem(c, a);
      const s = report.selected;
      if (!s || s.contentHash !== a.contentHash)
        fail(
          "The evidence changed. Refresh before deciding.",
          409,
          "stale_evidence",
        );
      oneOf(a.decision, ["validated", "returned"]);
      if (a.decision === "validated" && s.totals.heldCalls)
        fail("Resolve held evidence before validating");
      const [r] =
        await c.db`insert into per_diem_validations(organization_id,profile_id,org_unit_id,local_month,period_from,period_to,decision,note,content_hash,rule_version,planned_stops,valid_calls,invalid_calls,not_visited,valid_days,valid_dates,decided_by,decider_profile_id,decided_at) values(${p.organization_id},${p.id},${p.org_unit_id},${report.localMonth},${a.from},${a.to},${a.decision},${a.note ? text(a.note, 500) : null},${s.contentHash},${RULE_VERSION},${s.totals.plannedStops},${s.totals.validCalls},${s.totals.invalidCalls},${s.totals.notVisited},${s.totals.validDays},${c.db.array(
          s.days
            .filter((d) => d.dayStatus === "valid")
            .map((d) => d.serviceDate),
          "DATE",
        )},${c.actor.userId},${c.actor.profileId},${new Date(c.now)}) returning id`;
      return r.id;
    },
  );
  get("field_reports.reports.day", fieldDay);
  get("field_reports.reports.myKind", async (c) =>
    reportKindFor((await person(c, c.actor.profileId)).position_code),
  );
  get("field_reports.reports.completeness", completeness);
  post(
    "field_reports.reports.submit",
    "field_reports",
    async (c) => {
      await requireCapability(c, "deliverable.submit");
    },
    async (c, a) => {
      await c.db`select pg_advisory_xact_lock(hashtextextended(${c.actor.profileId + a.serviceDate + "report"},0))`;
      const r = await fieldDay(c, { serviceDate: a.serviceDate });
      if (!r || !r.canSubmit)
        fail(
          r?.submitBlockedReason ??
            "This position does not submit a DAR or ROAR",
        );
      const revision = r.revisions + 1;
      const p = await person(c, c.actor.profileId);
      await c.db`insert into field_day_reports(organization_id,profile_id,org_unit_id,service_date,kind,revision,remarks,summary,submitted_by,submitted_at) values(${p.organization_id},${p.id},${p.org_unit_id},${a.serviceDate},${r.kind},${revision},${text(a.remarks)},${r.summary},${c.actor.userId},${new Date(c.now)})`;
      return { revision, late: c.now > r.dueAt, summary: r.summary };
    },
  );
  get("callSheets.accounts.list", calls.list);
  get("callSheets.accounts.detail", calls.detail);
  get("callSheets.report.month", calls.month);
  get("callSheets.accounts.outletByCode", async (c, a) => {
    const code = text(a.code, 80).toUpperCase();
    const [o] =
      await c.db`select id,code,name from outlets where code=${code} and deleted_at is null`;
    if (!o) return null;
    try {
      await calls.detail(c, { outletId: o.id });
      return o;
    } catch (e) {
      if (e instanceof Error && "status" in e && e.status === 403) return null;
      throw e;
    }
  });
  get("callSheets.accounts.productSearch", async (c, a) => {
    await requireCapability(c, "outlet.manage");
    const prefix = text(a.prefix, 40).toUpperCase();
    if (!prefix) return [];
    const rows =
      await c.db`select id,code,name,uom,category from products where active and deleted_at is null and starts_with(code,${prefix}) order by code limit 20`;
    return rows.map((/** @type {any} */ p) => ({
      productId: p.id,
      code: p.code,
      name: p.name,
      uom: p.uom,
      category: p.category,
    }));
  });
  post(
    "callSheets.accounts.save",
    "call_sheets",
    async (c, a) => {
      await calls.detail(c, a);
      await requireCapability(c, "outlet.manage");
    },
    (c, a) => calls.save(c, a, platform),
  );
  post("callSheets.entries.record", "call_sheets", record, (c, a) =>
    calls.recordEntries(c, a, platform),
  );
  for (const topic of ["supervision", "field_reports", "call_sheets"])
    platform.registerTopic(
      topic,
      (/** @type {any} */ actor) =>
        !!actor &&
        roleHas(
          actor.role,
          topic === "supervision" ? "people.read" : "report.read",
        ),
    );
}
