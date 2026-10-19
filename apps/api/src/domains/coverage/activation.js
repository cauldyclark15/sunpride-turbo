import {
  audit,
  civil,
  fail,
  loadPlan,
  localDate,
  manilaDate,
  planRows,
} from "./model.js";
import { digest } from "./workflow.js";
import { enqueue } from "../../core/jobs.js";
/** @param {any} p */
export function verifySignature(p) {
  if (
    !p.signed_content ||
    digest(p.signed_content) !== p.content_hash ||
    p.signed_content.plan.id !== p.id ||
    p.signed_content.plan.version !== p.version ||
    p.signed_content.plan.assignee !== p.assignee_profile_id ||
    p.signed_content.plan.unit !== p.org_unit_id ||
    p.signed_content.plan.month !== p.local_month ||
    p.signed_content.plan.effectiveFrom !== +new Date(p.effective_from) ||
    p.signed_content.plan.effectiveTo !== +new Date(p.effective_to) ||
    p.approval_signature !==
      `${p.id}:${p.version}:${p.approved_by}:${+new Date(p.approved_at)}:${p.content_hash}`
  )
    fail("Signed plan content does not match approval", "invalid_signature");
}
/** Caller owns the transaction and permissions. @param {any} ctx @param {any} p @param {any} platform */
export async function activate(ctx, p, platform) {
  const db = ctx.db,
    today = manilaDate(ctx.now);
  if (!["approved", "active"].includes(p.status))
    fail("Only approved or active plans can activate");
  if (+new Date(p.effective_from) > ctx.now)
    fail("Coverage plan not yet effective");
  verifySignature(p);
  const slots = p.signed_content.slots;
  const affected = new Set();
  const changed = new Set();
  for (const s of slots) {
    if (
      s.kind !== "outlet_visit" ||
      s.serviceDate < today ||
      localDate(s.serviceDate) >= +new Date(p.effective_to)
    )
      continue;
    if (!s.approvedSnapshot) fail("Approved outlet snapshot missing");
    const [row] =
      await db`insert into planned_visits(generation_key,plan_id,plan_version,plan_slot_id,assignee_profile_id,outlet_id,service_date,status,approved_snapshot,required_objectives,intents,expected_duration_minutes,generated_at)
    values (${`${p.id}:${s._id}`},${p.id},${p.version},${s._id},${p.assignee_profile_id},${s.outletId},${s.serviceDate},'planned',${s.approvedSnapshot},${db.array(s.requiredObjectives, "TEXT")},${db.array(s.intents, "TEXT")},${s.expectedDurationMinutes},${new Date(ctx.now)}) on conflict (generation_key) do nothing returning id`;
    if (row) affected.add(s.serviceDate);
  }
  if (p.based_on_plan_id && p.status !== "active") {
    const prior = await loadPlan(db, p.based_on_plan_id, true);
    if (!["approved", "active"].includes(prior.status))
      fail("Successor predecessor is not approved or active");
    const olds =
      await db`select v.* from planned_visits v where plan_id=${prior.id} and service_date>=${manilaDate(+new Date(p.effective_from))} and status='planned' for update`;
    for (const old of olds) {
      // A revision must not rewrite work already executed or queued against the old plan.
      const [execution] =
        await db`select id from visit_executions where planned_visit_id=${old.id} and deleted_at is null limit 1`;
      if (execution)
        fail("Existing execution prevents replacing this planned visit");
      const [replacement] =
        await db`select id from planned_visits where plan_id=${p.id} and outlet_id=${old.outlet_id} and service_date=${civil(old).serviceDate}`;
      await db`update planned_visits set status=${replacement ? "replaced" : "cancelled"},replaced_by_visit_id=${replacement?.id ?? null},cancellation_reason='MCP revised',cancelled_at=${new Date(ctx.now)} where id=${old.id}`;
      if (replacement)
        await db`update planned_visits set replacement_of_visit_id=${old.id} where id=${replacement.id}`;
      changed.add(old.id);
      affected.add(civil(old).serviceDate);
    }
    await db`update coverage_plans set status='superseded',superseded_at=${new Date(ctx.now)},active_through=${p.effective_from} where id=${prior.id}`;
    await audit(
      ctx,
      prior,
      "plan.superseded",
      { status: prior.status },
      { status: "superseded" },
    );
  }
  if (p.status !== "active") {
    await db`update coverage_plans set status='active',activated_at=${new Date(ctx.now)} where id=${p.id}`;
    await audit(
      ctx,
      p,
      "plan.activated",
      { status: p.status },
      { status: "active" },
    );
  }
  const visits =
    await db`select * from planned_visits where plan_id=${p.id} order by service_date,(approved_snapshot->>'sequence')::integer,id`;
  for (const date of affected)
    await enqueue(db, {
      kind: "coverage.refresh",
      key: `${p.assignee_profile_id}:${date}`,
      payload: { date, unitId: p.org_unit_id },
    });
  for (const id of changed)
    await platform.recordChange(db, {
      entity: "planned_visits",
      entityId: id,
      scopeKey: p.org_unit_id,
    });
  for (const v of visits)
    await platform.recordChange(db, {
      entity: "planned_visits",
      entityId: v.id,
      scopeKey: p.org_unit_id,
    });
  await platform.recordChange(db, {
    entity: "coverage_plans",
    entityId: p.id,
    scopeKey: p.org_unit_id,
  });
  return {
    visitIds: visits.map(/** @param {any} v */ (v) => v.id),
    count: visits.length,
  };
}
