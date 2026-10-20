import { outletOwnerUnit } from "../org/scope.js";
import { requireCapability } from "../../core/capabilities.js";
import { authorize, bound, date, day, digest, fail, today } from "./model.js";
import { partnerContext } from "./boundary.js";
import { retailAvailable, retailEvidence } from "./retail-seam.js";

/** F-319: derive billable work ONLY from canonical attendance/call evidence.
 * Never trust an agency-uploaded attendance sheet or a completed label alone.
 * @param {any} c @param {string} id @param {string} from @param {string} to */
export async function evidence(c, id, from, to) {
  const partner = await authorize(c, id);
  const retailReady = await retailAvailable(c.db);
  date(from);
  date(to);
  if (
    from > to ||
    to > today(c.now) ||
    Date.parse(to) - Date.parse(from) > 30 * 86400000
  )
    fail("Choose up to 31 elapsed days");
  const members = bound(
    await c.db`select m.*,p.name from distributor_users m join profiles p on p.id=m.profile_id
    where m.distributor_id=${id} and 'field'=any(m.grants) and m.effective_from<=now() and (m.effective_to is null or m.effective_to>now())
      and p.status='active' and p.deleted_at is null order by p.name,p.id limit 201`,
    200,
  );
  const ids = members.map((/** @type {any} */ m) => m.profile_id);
  const contracts =
    await c.db`select * from partner_contracts where distributor_id=${id} and effective_from<${new Date(`${to}T23:59:59.999+08:00`)}
    and (effective_to is null or effective_to>${new Date(`${from}T00:00:00+08:00`)}) order by version`;
  const plans = ids.length
    ? bound(
        await c.db`select pv.* from planned_visits pv join coverage_plans cp on cp.id=pv.plan_id
    where pv.assignee_profile_id in ${c.db(ids)} and pv.service_date between ${from}::date and ${to}::date and pv.deleted_at is null
      and pv.status='planned' and cp.deleted_at is null and cp.status in ('approved','active') and cp.approval_signature is not null order by pv.id limit 6201`,
        6200,
      )
    : [];
  const visits = ids.length
    ? bound(
        await c.db`select v.*,o.name as outlet_name from visit_executions v join outlets o on o.id=v.outlet_id
    where v.assignee_profile_id in ${c.db(ids)} and v.service_date between ${from}::date and ${to}::date
      and v.deleted_at is null and o.deleted_at is null order by v.service_date,v.id limit 6201`,
        6200,
      )
    : [];
  const grants =
    await c.db`select * from partner_outlet_assignments where distributor_id=${id} and effective_from<=now() and (effective_to is null or effective_to>now())`;
  const external = await partnerContext(c.db, c.actor);
  const allowedOutlets = new Set();
  for (const g of grants) {
    const owner = await outletOwnerUnit(c.db, g.outlet_id, c.now);
    // Current Sunpride ownership must still match this agency's supervising area.
    if (!owner || owner !== partner.org_unit_id) continue;
    if (!external) await requireCapability(c, "outlet.read", owner);
    allowedOutlets.add(g.outlet_id);
  }
  const activeAt = (/** @type {any} */ r, /** @type {number} */ at) =>
    new Date(r.effective_from).getTime() <= at &&
    (!r.effective_to || new Date(r.effective_to).getTime() > at);
  const details = [];
  for (const v of visits) {
    const member = members.find(
      (/** @type {any} */ m) => m.profile_id === v.assignee_profile_id,
    );
    const at = new Date(
      v.started_at ?? v.checked_in_at ?? v.created_at,
    ).getTime();
    if (
      !member ||
      !activeAt(member, at) ||
      !allowedOutlets.has(v.outlet_id) ||
      !grants.some(
        (/** @type {any} */ g) =>
          g.outlet_id === v.outlet_id && activeAt(g, at),
      )
    )
      continue;
    const kinds = bound(
      await c.db`select id,activity_kind,activity,device_time from visit_activities where visit_id=${v.id} and assignee_profile_id=${v.assignee_profile_id}
      and deleted_at is null order by server_time,id limit 501`,
      500,
    );
    const fixes =
      await c.db`select f.id,f.event,f.review_status,f.result,coalesce(
      (select e.summary_after from execution_events e where e.entity_id=f.id::text and e.kind='location.exception.decided' order by e.server_at desc,e.id desc limit 1),f.review_status) as decided
      from visit_location_evidence f where f.visit_id=${v.id} and f.deleted_at is null order by f.id`;
    const reviews =
      await c.db`select r.id,r.kind,d.decision from call_flow_reviews r join call_executions x on x.id=r.call_id
      left join call_flow_decisions d on d.review_id=r.id where x.visit_id=${v.id}`;
    const retail = await retailEvidence(c.db, v, retailReady);
    const contract = contracts.find((/** @type {any} */ k) => activeAt(k, at));
    const required = [
      ...new Set([
        ...(contract?.required_kinds ?? []),
        ...(v.activity_rules_snapshot ?? [])
          .filter((/** @type {any} */ r) => v.intents.includes(r.intent))
          .flatMap(
            (/** @type {any} */ r) =>
              r.activities
                ?.filter((/** @type {any} */ a) => a.required)
                .map((/** @type {any} */ a) => a.kind) ?? [],
          ),
      ]),
    ];
    const missing = required.filter(
      (/** @type {any} */ k) =>
        !kinds.some((/** @type {any} */ a) => a.activity_kind === k),
    );
    const negative = kinds.some(
      (/** @type {any} */ a) =>
        (a.activity_kind === "merchandising" &&
          a.activity.displayCondition !== "compliant") ||
        (a.activity_kind === "price_check" && a.activity.compliant === false) ||
        (a.activity_kind === "promotion" &&
          a.activity.finding === "not_executed"),
    );
    const attended = Boolean(
      v.started_at &&
      fixes.some(
        (/** @type {any} */ f) =>
          f.event === "check_in" &&
          ["verified", "approved_exception"].includes(f.decided),
      ),
    );
    const completed = Boolean(
      v.ended_at &&
      v.checked_out_at &&
      ["completed", "checked-out"].includes(v.state),
    );
    const dwell = completed ? new Date(v.ended_at).getTime() - at : null;
    const issues = [];
    if (!attended) issues.push("Attendance location needs review");
    if (!completed) issues.push("Call is not completed");
    if (
      !fixes.some(
        (/** @type {any} */ f) =>
          f.event === "check_out" &&
          ["verified", "approved_exception"].includes(f.decided),
      )
    )
      issues.push("Checkout location needs review");
    if (missing.length) issues.push("Required activity evidence is missing");
    if (negative) issues.push("Execution compliance needs action");
    if (
      retail.audits.some(
        (/** @type {any} */ a) =>
          a.component_score !== null &&
          contract &&
          Number(a.component_score) < Number(contract.minimum_retail_score),
      )
    )
      issues.push("Retail execution audit needs action");
    for (const item of retail.cases.filter(
      (/** @type {any} */ item) =>
        !["resolved", "rejected"].includes(item.status),
    ))
      issues.push(
        `${item.kind === "incident" ? "Field incident" : "Retail follow-up"} needs action`,
      );
    if (
      kinds.some(
        (/** @type {any} */ a) =>
          new Date(a.device_time).getTime() < at ||
          (v.ended_at &&
            new Date(a.device_time).getTime() > new Date(v.ended_at).getTime()),
      )
    )
      issues.push("Activity capture time is outside the call");
    if (v.late_review_status && v.late_review_status !== "accepted")
      issues.push("Late evidence needs office review");
    if (reviews.some((/** @type {any} */ r) => r.decision !== "approve"))
      issues.push("Call exception needs office review");
    if (!contract) issues.push("Billing contract needs setup");
    if (
      dwell !== null &&
      (dwell < 0 || dwell < Number(contract?.minimum_dwell_ms ?? 0))
    )
      issues.push("Call duration is below the contract minimum");
    details.push({
      id: v.id,
      profileId: v.assignee_profile_id,
      name: member.name,
      outletId: v.outlet_id,
      outlet: v.outlet_name,
      date: day(v.service_date),
      attended,
      completed,
      compliant: issues.length === 0,
      checkedInAt: v.started_at ? new Date(v.started_at).getTime() : null,
      checkedOutAt: v.ended_at ? new Date(v.ended_at).getTime() : null,
      dwellMs: dwell,
      issues,
      sources: {
        retail,
        visitRevision: String(v.change_seq),
        activities: kinds.map((/** @type {any} */ a) => ({
          id: a.id,
          kind: a.activity_kind,
          contentHash: digest(a.activity),
          at: a.device_time,
        })),
        locations: fixes,
        reviews,
        contractId: contract?.id ?? null,
        contractVersion: contract?.version ?? null,
        contractPolicy: contract
          ? {
              rateCentavos: Number(contract.rate_centavos),
              minimumCalls: contract.minimum_calls,
              minimumDwellMs: Number(contract.minimum_dwell_ms),
              minimumRetailScore: contract.minimum_retail_score,
              requiredKinds: contract.required_kinds,
              sourceRef: contract.source_ref,
              sample: contract.sample,
            }
          : null,
      },
    });
  }
  /** @type {any[]} */
  const rows = [];
  for (let at = Date.parse(from); at <= Date.parse(to); at += 86400000) {
    const serviceDate = new Date(at).toISOString().slice(0, 10);
    for (const m of members) {
      const start = Date.parse(`${serviceDate}T00:00:00+08:00`);
      if (
        new Date(m.effective_from).getTime() >= start + 86400000 ||
        (m.effective_to && new Date(m.effective_to).getTime() <= start)
      )
        continue;
      const calls = details.filter(
        (v) => v.profileId === m.profile_id && v.date === serviceDate,
      );
      const signedPlans = plans.filter(
        (/** @type {any} */ p) =>
          p.assignee_profile_id === m.profile_id &&
          day(p.service_date) === serviceDate &&
          allowedOutlets.has(p.outlet_id),
      );
      // A legitimate first call may follow a mid-day contract publication.
      // Use its actual governing version, never the service-day midnight.
      const contract = calls.length
        ? contracts.find(
            (/** @type {any} */ k) => k.id === calls[0].sources.contractId,
          )
        : contracts.find((/** @type {any} */ k) =>
            activeAt(
              k,
              Math.max(
                start,
                new Date(m.effective_from).getTime(),
                Math.min(c.now, start + 86400000 - 1),
              ),
            ),
          );
      const consistentContract = calls.every(
        (v) => v.sources.contractId === contract?.id,
      );
      const compliant = calls.filter((v) => v.compliant).length;
      const minimum = contract?.minimum_calls ?? null;
      const qualified =
        minimum !== null &&
        compliant >= minimum &&
        consistentContract &&
        calls.every((v) => !v.issues.length);
      rows.push({
        profileId: m.profile_id,
        name: m.name,
        date: serviceDate,
        planned: signedPlans.length,
        attended: calls.filter((v) => v.attended).length,
        completed: calls.filter((v) => v.completed).length,
        compliant,
        issues:
          calls.reduce((n, v) => n + v.issues.length, 0) +
          (consistentContract ? 0 : 1),
        billingIssue: consistentContract
          ? null
          : "Multiple contract versions govern this day; office review required",
        target: minimum,
        eligible: qualified,
        amountCentavos: qualified ? Number(contract.rate_centavos) : 0,
        contractId: contract?.id ?? null,
        contractVersion: contract?.version ?? null,
        visits: calls,
      });
    }
  }
  const sum = (/** @type {string} */ key) =>
    rows.reduce((n, /** @type {any} */ r) => n + Number(r[key] ?? 0), 0);
  return {
    partner: {
      id: partner.id,
      name: partner.name,
      sample: partner.source === "sample",
    },
    from,
    to,
    rows,
    visits: details,
    summary: {
      staff: members.length,
      planned: sum("planned"),
      attended: sum("attended"),
      completed: sum("completed"),
      compliant: sum("compliant"),
      issues: sum("issues"),
      eligibleDays: rows.filter((r) => r.eligible).length,
      amountCentavos: sum("amountCentavos"),
    },
    source:
      "System visit, location, required-activity and independent review evidence; not agency-reported attendance.",
    retailIssueFeedAvailable: retailReady,
    evidenceHash: digest({ from, to, rows }),
  };
}
