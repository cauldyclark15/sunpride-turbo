import { join } from "node:path";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { ApiError, invalid, notFound } from "../../core/errors.js";
import { filesDir } from "../../core/media.js";
import { scopeFilterForActor } from "../org/scope.js";
import {
  accessVisit,
  uuid,
  date,
  manilaDate,
  ms,
  employeeAt,
  ORGANIZATION,
} from "./shared.js";
import { dateString } from "./commands.js";
import { isProductive } from "./productive.js";

/** @param {any} row */
export function dto(row) {
  return {
    id: row.id,
    personId: row.assignee_profile_id,
    personName: row.person_name ?? null,
    outletId: row.outlet_id,
    outletName: row.outlet_name ?? null,
    serviceDate: dateString(row.service_date),
    state: row.state,
    status: row.state,
    onPlan: !!row.planned_visit_id,
    plannedVisitId: row.planned_visit_id,
    source: row.source,
    intents: row.intents,
    productivity: row.productivity,
    missingActivities: row.missing_activities,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    unplannedReason: row.unplanned_reason,
    checkedInAt: row.checked_in_at ? ms(row.checked_in_at) : null,
    checkedOutAt: row.checked_out_at ? ms(row.checked_out_at) : null,
    startedAt: row.started_at ? ms(row.started_at) : null,
    endedAt: row.ended_at ? ms(row.ended_at) : null,
    callDurationMs:
      row.call_duration_ms == null ? null : Number(row.call_duration_ms),
    lateReviewStatus: row.late_review_status,
    activityRuleVersion: row.activity_rule_version,
  };
}
/** @param {any} ctx */
export async function list(ctx) {
  const actor = await requireCapability(ctx, "visit.read");
  const q = ctx.url.searchParams;
  const day = q.get("date") ? date(q.get("date")) : null;
  const from = day ?? date(q.get("from") ?? manilaDate(ctx.now)),
    to = day ?? date(q.get("to") ?? from);
  if (from > to) throw invalid();
  const person = q.get("person") ?? q.get("personId");
  if (person) uuid(person);
  const outlet = q.get("outlet") ?? q.get("outletId");
  if (outlet) uuid(outlet);
  const status = q.get("status");
  if (
    status &&
    ![
      "planned",
      "arrived",
      "checked-in",
      "in-progress",
      "checked-out",
      "completed",
      "skipped",
      "rescheduled",
      "missed",
    ].includes(status)
  )
    throw invalid();
  const onPlan = q.get("onPlan");
  if (onPlan !== null && !["true", "false"].includes(onPlan)) throw invalid();
  const cursor = q.get("cursor");
  if (cursor) uuid(cursor);
  const limit = Number(q.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  const { unitIds } = await scopeFilterForActor(ctx.db, actor);
  if (unitIds?.length === 0) return { rows: [], next: null };
  const rows =
    await ctx.db`select v.*,p.name as person_name,o.name as outlet_name from visit_executions v
    join profiles p on p.id=v.assignee_profile_id join outlets o on o.id=v.outlet_id
    where v.organization_id=${ORGANIZATION} and v.deleted_at is null and v.service_date>=${from} and v.service_date<=${to}
    and (${person}::uuid is null or v.assignee_profile_id=${person}::uuid)
    and (${outlet}::uuid is null or v.outlet_id=${outlet}::uuid)
    and (${status}::text is null or v.state=${status})
    and (${onPlan}::text is null or (v.planned_visit_id is not null)=${onPlan === "true"})
    and (${actor.role !== "sales"} or v.assignee_profile_id=${actor.profileId})
    and ${unitIds === null ? ctx.db`true` : ctx.db`v.org_unit_id in ${ctx.db(unitIds)}`}
    and (${cursor}::uuid is null or v.id>${cursor}::uuid) order by v.id limit ${limit + 1}`;
  const page = rows.slice(0, limit),
    visible = [];
  for (const row of page) {
    try {
      await accessVisit(ctx, row);
      visible.push(dto(row));
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 403) throw e;
    }
  }
  return { rows: visible, next: rows.length > limit ? page.at(-1).id : null };
}
/** @param {any} ctx */
export async function detail(ctx) {
  const id = uuid(
    ctx.url.searchParams.get("visitId") ?? ctx.url.searchParams.get("id"),
  );
  const [visit] =
    await ctx.db`select v.*,p.name as person_name,o.name as outlet_name from visit_executions v
    join profiles p on p.id=v.assignee_profile_id join outlets o on o.id=v.outlet_id where v.id=${id}`;
  await accessVisit(ctx, visit);
  const activities =
    await ctx.db`select * from visit_activities where visit_id=${id} and deleted_at is null order by server_time,id limit 501`;
  if (activities.length > 500) throw invalid("Visit activity limit exceeded");
  const collections =
    await ctx.db`select * from field_collections where visit_id=${id} and deleted_at is null order by server_time,id`;
  const photos =
    await ctx.db`select * from field_evidence_files where visit_id=${id} and deleted_at is null order by uploaded_at,id`;
  const fixes =
    await ctx.db`select f.*,e.summary_after as decided_status,e.summary_reason_code as decision_reason,e.server_at as decided_at,
    p.name as decided_by from visit_location_evidence f left join execution_events e on e.entity_id=f.id::text and e.kind='location.exception.decided'
    left join profiles p on p.user_id::text=e.actor_subject where f.visit_id=${id} order by f.server_time,f.id`;
  const events =
    await ctx.db`select e.*,p.name as actor_name from execution_events e left join profiles p on p.user_id::text=e.actor_subject
    where e.correlation_id=${id} order by e.server_at,e.id`;
  const rawAllowed = roleHas(ctx.actor.role, "visit.locationException.approve");
  const locations = fixes.map((/** @type {any} */ f) => ({
    id: f.id,
    event: f.event,
    result: f.result,
    reviewStatus: f.decided_status ?? f.review_status,
    rawReviewStatus: f.review_status,
    distanceMeters: f.distance_meters,
    radiusMeters: f.radius_meters,
    distanceLabel:
      f.distance_meters === null
        ? "Distance unknown"
        : `${Math.round(f.distance_meters)} m from verified pin`,
    latitude: rawAllowed ? f.latitude : null,
    longitude: rawAllowed ? f.longitude : null,
    accuracyMeters: f.accuracy_meters,
    provider: f.provider,
    mockSignal: f.mock_signal,
    deviceTime: ms(f.device_time),
    serverTime: ms(f.server_time),
    fixTime: f.fix_time ? ms(f.fix_time) : null,
    decision: f.decided_status
      ? {
          status: f.decided_status,
          reason: f.decision_reason,
          at: ms(f.decided_at),
          by: f.decided_by ?? "Former colleague",
        }
      : null,
  }));
  const person = await employeeAt(
    ctx.db,
    visit.assignee_profile_id,
    ms(visit.started_at),
  );
  const [standard] = person.position_id
    ? await ctx.db`select productive_call_rule from position_standards where position_id=${person.position_id} and deleted_at is null
    and effective_from<=${visit.started_at} and (effective_to is null or effective_to>${visit.started_at})`
    : [];
  const evaluation = isProductive(
    {
      inRoutePlan: !!visit.planned_visit_id,
      state: visit.state,
      outcome: visit.outcome,
      productivePolicySnapshot: visit.productive_policy_snapshot,
      activityKinds: activities.map((/** @type {any} */ a) => a.activity_kind),
      collectionCount: collections.filter(
        (/** @type {any} */ c) => c.status === "recorded",
      ).length,
      reasonCode: visit.reason_code,
    },
    { productiveCallRule: standard?.productive_call_rule },
  );
  return {
    visit: dto(visit),
    productiveCall: evaluation,
    activities: activities.map((/** @type {any} */ a) => ({
      id: a.id,
      activity: a.activity,
      deviceTime: ms(a.device_time),
      serverTime: ms(a.server_time),
    })),
    collections: collections.map((/** @type {any} */ c) => ({
      id: c.id,
      amountMinor: Number(c.amount_minor),
      currency: c.currency,
      method: c.method,
      reference: c.reference,
      status: c.status,
      deviceTime: ms(c.device_time),
      serverTime: ms(c.server_time),
    })),
    photos: photos.map((/** @type {any} */ p) => ({
      id: p.id,
      url: `/api/v1/visits/media/${p.id}`,
      photoType: p.photo_type,
      status: p.status,
      capturedAt: ms(p.captured_at),
      uploadedAt: ms(p.uploaded_at),
    })),
    locationEvidence: locations,
    timeline: events.map((/** @type {any} */ e) => ({
      id: e.id,
      kind: e.kind,
      entityType: e.entity_type,
      entityId: e.entity_id,
      at: ms(e.occurred_at),
      serverAt: ms(e.server_at),
      actor: e.actor_name ?? "Former colleague",
      before: e.summary_before,
      after: e.summary_after,
      reasonCode: e.summary_reason_code,
    })),
    merchandising: await auditForVisit(ctx.db, id),
  };
}
/** @param {any} db @param {string} visitId */
export async function auditForVisit(db, visitId) {
  const [audit] =
    await db`select * from merchandising_audits where visit_id=${visitId} and deleted_at is null`;
  if (!audit) return null;
  const availability =
    await db`select a.*,p.name as product_name,p.code as product_code from merchandising_availability a join products p on p.id=a.product_id where a.audit_id=${audit.id} order by a.id`;
  const compliance =
    await db`select * from merchandising_compliance_checks where audit_id=${audit.id} order by id`;
  const competitors =
    await db`select * from competitor_observations where audit_id=${audit.id} order by id`;
  const missing =
    await db`select product_id from merchandising_audit_missing_products where merchandising_audit_id=${audit.id} order by ordinal`;
  return {
    id: audit.id,
    requiredCount: audit.required_count,
    requiredAvailableCount: audit.required_available_count,
    requiredOutOfStockCount: audit.required_out_of_stock_count,
    onShelfAvailabilityPercent: audit.required_count
      ? Math.round(
          (audit.required_available_count / audit.required_count) * 1000,
        ) / 10
      : null,
    missingRequiredProductIds: missing.map(
      (/** @type {any} */ p) => p.product_id,
    ),
    availability: availability.map((/** @type {any} */ a) => ({
      productId: a.product_id,
      productName: a.product_name,
      productCode: a.product_code,
      status: a.status,
      required: a.required,
      facings: a.facings,
      note: a.note,
    })),
    compliance: compliance.map((/** @type {any} */ c) => ({
      kind: c.kind,
      finding: c.finding,
      programRef: c.program_ref,
      shareOfShelfPercent: c.share_of_shelf_percent,
      actionTaken: c.action_taken,
    })),
    competitors: competitors.map((/** @type {any} */ c) => ({
      kind: c.kind,
      brand: c.brand,
      productCategory: c.product_category,
      observedPriceMinor:
        c.observed_price_minor === null ? null : Number(c.observed_price_minor),
      currency: c.currency,
      note: c.note,
    })),
  };
}
/** Media never has an unauthenticated public blob URL. @param {any} ctx */
export async function media(ctx) {
  const [file] =
    await ctx.db`select e.*,f.path,f.sha256 from field_evidence_files e join files f on f.id=e.storage_id where e.id=${uuid(ctx.params.id)} and e.deleted_at is null and e.status<>'rejected' and f.status='stored'`;
  if (!file) throw notFound();
  const [visit] =
    await ctx.db`select * from visit_executions where id=${file.visit_id}`;
  await accessVisit(ctx, visit);
  if (file.path !== `${file.sha256.slice(0, 2)}/${file.sha256}`)
    throw notFound();
  const blob = Bun.file(join(filesDir(ctx.env), file.path));
  if (!(await blob.exists())) throw notFound();
  return new Response(blob, {
    headers: {
      "Content-Type": file.mime,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
