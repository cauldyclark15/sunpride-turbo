import { advance, ownedCall } from "../callflow/engine.js";
import { DSR_ACCESS } from "../distributors/dsr-context.js";
import { ApiError, forbidden, invalid } from "../../core/errors.js";
import { requireCapability } from "../../core/capabilities.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { reauthorizeDevice } from "../../core/devices.js";
import { audit as vanAudit } from "../van/facts.js";
import { currentActor, tripFor, outletFor } from "../van/access.js";
import {
  accessOutlet,
  ownedVisit,
  validTime,
  uuid,
  manilaDate,
} from "../visits/shared.js";
import { bounded, dateOf, midnight } from "../fieldsync/model.js";
import { releasesAt, outletAt, audit } from "./masters.js";
import {
  VERSION,
  checklist,
  deriveOfftake,
  matches,
  resolveSet,
  suggest,
  quantity,
} from "./rules.js";

/** Scope source orders independently of physical-outlet membership.
 * @param {any} db @param {string[]} outlets @param {any} scope @param {string} from @param {string} to */
export async function orderFacts(db, outlets, scope, from, to) {
  if (!outlets.length) return [];
  const units = scope.ids?.length ? scope.ids : [null];
  return bounded(
    await db`
    select o.id as order_id,o.outlet_id,l.product_id,l.quantity_base,o.service_date,va.visit_id,
      o.salesperson_profile_id as profile_id,o.org_unit_id,'field' as source
    from orders o join order_lines l on l.order_id=o.id
    join analytics_people pe on pe.id=o.salesperson_profile_id
    left join inventory_locations loc on loc.id=o.source_location_id
    left join visit_activities va on va.id=o.source_activity_id and va.deleted_at is null
    where o.outlet_id in ${db(outlets)} and o.deleted_at is null and l.deleted_at is null
      and o.status not in ('draft','rejected','voided') and o.service_date between ${from} and ${to}
      and o.org_unit_id in ${db(units)} and pe.current_unit_id in ${db(units)}
      and (${scope.ownProfileId ?? null}::uuid is null or pe.id=${scope.ownProfileId ?? null})
      and (o.source_location_id is null or (loc.active and loc.deleted_at is null and loc.org_unit_id in ${db(units)}))
    union all
    select s.id,s.outlet_id,l.product_id,l.quantity_base,t.service_date,null::uuid,
      t.salesperson_profile_id,t.org_unit_id,'van'
    from van_sales s join van_sale_lines l on l.sale_id=s.id join van_trips t on t.id=s.trip_id
    join analytics_people pe on pe.id=t.salesperson_profile_id
    join inventory_locations loc on loc.id=t.truck_location_id
    where s.outlet_id in ${db(outlets)} and t.deleted_at is null and t.service_date between ${from} and ${to}
      and t.org_unit_id in ${db(units)} and pe.current_unit_id in ${db(units)}
      and loc.active and loc.deleted_at is null and loc.org_unit_id in ${db(units)}
      and (${scope.ownProfileId ?? null}::uuid is null or pe.id=${scope.ownProfileId ?? null})
      and not exists(select 1 from van_sale_voids v where v.sale_id=s.id)
    order by service_date desc,order_id,product_id limit 20001`,
    20000,
  );
}
/** @param {any} ctx @param {string} outletId @param {string} day */
export async function authorizeCall(ctx, outletId, day) {
  const { outlet, owner } = await accessOutlet(ctx, outletId, "outlet.read");
  const app = ctx.app ?? "web";
  // SEAM(CALLFLOW): current outlet scope also permits reasoned unplanned calls.
  // record() separately binds evidence to the caller's owned open execution.
  if (app === "van-android") {
    await outletFor(ctx.db, ctx.actor, outletId);
    const trips =
      await ctx.db`select id from van_trips where salesperson_profile_id=${ctx.actor.profileId} and service_date=${day} and status not in ('cancelled','closed') and deleted_at is null`;
    if (trips.length !== 1)
      throw forbidden("No unique open trip", "out_of_scope");
    await tripFor(ctx.db, ctx.actor, trips[0].id, "van.operate");
  }
  return { outlet, owner };
}
/** F-211/F-218/F-219: authorized immutable projection, shared by web, field and van.
 * @param {any} ctx @param {string} outletId @param {string} day @param {boolean} [persist] */
export async function callSnapshot(ctx, outletId, day, persist = true) {
  const { owner } = await authorizeCall(ctx, outletId, day);
  const at = Math.min(ctx.now ?? Date.now(), midnight(day) + 86_400_000 - 1);
  const outlet = await outletAt(ctx.db, outletId);
  const msl = resolveSet(outlet, await releasesAt(ctx.db, "msl", at));
  const rules = await releasesAt(ctx.db, "rules", at);
  if (rules.length > 1)
    throw invalid("More than one availability rules policy is active");
  const policy = rules[0]?.payload ?? null;
  const focus = (await releasesAt(ctx.db, "focus", at)).filter(
    (/** @type {any} */ r) =>
      (!r.sample || outlet.is_sample === true) && matches(outlet, r.payload),
  );
  const [past] =
    await ctx.db`select * from availability_checks where outlet_id=${outletId} and profile_id=${ctx.actor.profileId} and device_time<=${new Date(at)} order by device_time desc,id desc limit 1`;
  const observations = past?.lines ?? [];
  const historyKey = JSON.stringify([
    owner,
    ctx.actor.role === "sales" ? ctx.actor.profileId : null,
    day,
  ]);
  let allHistory = ctx.availabilityHistory?.get(historyKey);
  if (!allHistory) {
    allHistory = ctx[DSR_ACCESS]
      ? []
      : await orderFacts(
          ctx.db,
          ctx.availabilityOutletIds ?? [outletId],
          {
            ids: [owner],
            ownProfileId:
              ctx.actor.role === "sales" ? ctx.actor.profileId : null,
          },
          dateOf(new Date(midnight(day) - 83 * 86_400_000)),
          day,
        );
    ctx.availabilityHistory?.set(historyKey, allHistory);
  }
  const history = allHistory.filter(
    (/** @type {any} */ h) => h.outlet_id === outletId,
  );
  const promotions =
    await ctx.db`select * from suggested_order_promotions where organization_id='sunpride' and deleted_at is null and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`;
  const required = msl?.payload.lines ?? [];
  const allIds = [
    ...new Set([
      ...required.map((/** @type {any} */ l) => l.productId),
      ...focus.flatMap((/** @type {any} */ r) =>
        r.payload.lines.map((/** @type {any} */ l) => l.productId),
      ),
    ]),
  ];
  const products = allIds.length
    ? await ctx.db`select p.id,p.code,p.name,p.uom,p.quantity_scale,u.code as base_uom,
    coalesce((select jsonb_agg(b.barcode order by b.barcode) from product_barcodes b where b.product_id=p.id and b.active and b.deleted_at is null),'[]') as barcodes
    from products p left join units_of_measure u on u.id=p.base_uom_id where p.id in ${ctx.db(allIds)} and p.active and p.deleted_at is null`
    : [];
  if (products.length !== allIds.length)
    throw invalid(
      "Published MSL includes an unavailable product. Publish a replacement set.",
    );
  const lines = [];
  for (const p of products) {
    const l = required.find((/** @type {any} */ l) => l.productId === p.id);
    const f = focus
      .flatMap((/** @type {any} */ r) => r.payload.lines)
      .find((/** @type {any} */ l) => l.productId === p.id);
    const obs =
      policy &&
      past &&
      at - new Date(past.device_time).getTime() <=
        policy.freshnessDays * 86_400_000
        ? observations.find((/** @type {any} */ o) => o.productId === p.id)
        : null;
    const h = history.filter((/** @type {any} */ h) => h.product_id === p.id);
    const uplift = Math.max(
      0,
      ...promotions
        .filter((/** @type {any} */ r) => r.product_id === p.id)
        .map((/** @type {any} */ r) => Number(r.uplift_pct)),
    );
    const recommendation = policy
      ? suggest(
          {
            offtake: obs?.offtake ?? null,
            historyDailyBase: h.length
              ? h.reduce(
                  (/** @type {number} */ n, /** @type {any} */ r) =>
                    n + Number(r.quantity_base ?? 0),
                  0,
                ) / 84
              : null,
            stockBase:
              obs?.shelfBase != null && obs?.backroomBase != null
                ? obs.shelfBase + obs.backroomBase
                : null,
            absent: obs?.state === "absent",
            minimumBase: l?.minimumBase ?? 1,
            focus: f,
            upliftPct: uplift,
            availableBase: null,
          },
          policy,
        )
      : {
          quantityBase: 0,
          status: "unknown",
          reasons: ["Availability rules need setup"],
          daysCover: null,
        };
    lines.push({
      productId: p.id,
      code: p.code,
      name: p.name,
      uom: p.base_uom ?? p.uom,
      quantityScale: Number(p.quantity_scale ?? 1),
      barcodes: p.barcodes,
      required: !!l,
      minimumBase: l?.minimumBase ?? 1,
      objective: f?.objective ?? null,
      ...recommendation,
    });
  }
  const body = {
    version: VERSION,
    outletId,
    serviceDate: day,
    msl: msl
      ? {
          id: msl.id,
          version: msl.version,
          label: msl.label,
          sample: msl.sample,
        }
      : null,
    policy: policy ? { ...policy, id: rules[0].id } : null,
    focus: focus.map((/** @type {any} */ r) => ({
      id: r.id,
      version: r.version,
      label: r.label,
      objectives: r.payload.lines,
    })),
    lines,
    setupNeeded: !msl || !policy,
    sample: msl?.sample === true,
  };
  if (!persist) return { ...body, snapshotId: null };
  const hash = sha256Hex(canonicalJson(body));
  const app = ctx.app ?? "web";
  const [row] =
    await ctx.db`insert into availability_call_snapshots(outlet_id,profile_id,app,service_date,content_hash,body) values (${outletId},${ctx.actor.profileId},${app},${day},${hash},${body}) on conflict(outlet_id,profile_id,app,service_date,content_hash) do nothing returning id`;
  const existing =
    row ??
    (
      await ctx.db`select id from availability_call_snapshots where outlet_id=${outletId} and profile_id=${ctx.actor.profileId} and app=${app} and service_date=${day} and content_hash=${hash}`
    )[0];
  return { ...body, snapshotId: existing.id };
}
/** F-212/F-213/F-217: immutable observation and absent-line proposal; all work is in caller tx.
 * @param {any} ctx */
export async function record(ctx) {
  const p = ctx.payload ?? ctx.body;
  const id = uuid(p.checkId),
    snapshotId = uuid(p.snapshotId),
    callKey = uuid(p.callKey);
  validTime(p.deviceTime, ctx.now);
  if (ctx.device) {
    if (!ctx[DSR_ACCESS]) await currentActor(ctx.db, ctx.actor);
    await reauthorizeDevice(ctx.db, ctx.actor, ctx.device.id);
  }
  const [snapshot] =
    await ctx.db`select * from availability_call_snapshots where id=${snapshotId}`;
  if (
    !snapshot ||
    snapshot.profile_id !== ctx.actor.profileId ||
    snapshot.app !== (ctx.app ?? "web")
  )
    throw forbidden(
      "This checklist belongs to another session",
      "out_of_scope",
    );
  const { owner } = await authorizeCall(
    ctx,
    snapshot.outlet_id,
    dateOf(snapshot.service_date),
  );
  if (
    manilaDate(p.deviceTime) !== dateOf(snapshot.service_date) ||
    !snapshot.body.msl ||
    typeof p.complete !== "boolean"
  )
    throw invalid("Checklist date or MSL is unavailable");
  let visit = null,
    trip = null;
  if (ctx.app === "van-android") {
    trip = await tripFor(
      ctx.db,
      ctx.actor,
      uuid(p.tripId),
      "van.operate",
      true,
    );
    if (
      trip.salesperson_profile_id !== ctx.actor.profileId ||
      dateOf(trip.service_date) !== dateOf(snapshot.service_date) ||
      ["closed", "cancelled"].includes(trip.status) ||
      (trip.started_device_id && trip.started_device_id !== ctx.device?.id)
    )
      throw forbidden();
  } else {
    const [v] =
      await ctx.db`select id from visit_executions where client_visit_id=${callKey} and assignee_profile_id=${ctx.actor.profileId} and deleted_at is null`;
    visit = await ownedVisit(
      { ...ctx, app: ctx.app ?? "web" },
      v?.id ?? p.visitId,
      true,
    );
    if (
      visit.client_visit_id !== callKey ||
      visit.outlet_id !== snapshot.outlet_id ||
      dateOf(visit.service_date) !== dateOf(snapshot.service_date) ||
      p.deviceTime < new Date(visit.started_at).getTime() ||
      (visit.ended_at && p.deviceTime > new Date(visit.ended_at).getTime())
    )
      throw invalid("Availability must be captured during this call");
  }
  const result = checklist(
    snapshot.body.lines.filter((/** @type {any} */ l) => l.required),
    p.lines,
    p.complete,
  );
  const hash = sha256Hex(
    canonicalJson({
      snapshotId,
      callKey,
      tripId: trip?.id ?? null,
      visitId: visit?.id ?? null,
      deviceTime: p.deviceTime,
      complete: p.complete,
      lines: result.lines,
    }),
  );
  const [replay] =
    await ctx.db`select * from availability_checks where id=${id}`;
  if (replay) {
    if (
      replay.payload_hash !== hash ||
      replay.profile_id !== ctx.actor.profileId
    )
      throw invalid(
        "Check was already saved with different answers",
        "idempotency_conflict",
      );
    if (trip && ctx.op)
      await vanAudit(ctx.db, trip, ctx.actor, "availability.record", id, {
        clientOpId: ctx.op.clientOpId,
      });
    return { entityId: id, eventIds: [] };
  }
  const [before] =
    await ctx.db`select * from availability_checks where outlet_id=${snapshot.outlet_id} and (${!ctx[DSR_ACCESS]} or profile_id=${ctx.actor.profileId}) and device_time<${new Date(p.deviceTime)} order by device_time desc,id desc limit 1`;
  const lines = result.lines.map((l) => {
    const previous = before?.lines.find(
      (/** @type {any} */ r) => r.productId === l.productId,
    );
    return {
      ...l,
      offtake: deriveOfftake(
        previous
          ? { ...previous, at: new Date(before.device_time).getTime() }
          : null,
        { ...l, at: p.deviceTime },
      ),
    };
  });
  const proposals = lines
    .filter((l) => l.state === "absent")
    .map((l) => {
      const source = snapshot.body.lines.find(
        (/** @type {any} */ r) => r.productId === l.productId,
      );
      return {
        productId: l.productId,
        quantityBase: Math.max(source.minimumBase, source.quantityBase),
        reasons: [`Absent MSL line: ${source.name}`, ...source.reasons],
      };
    });
  await ctx.db`insert into availability_checks(id,snapshot_id,outlet_id,profile_id,org_unit_id,visit_id,trip_id,call_key,service_date,device_time,complete,required_count,checked_count,present_count,lines,proposals,payload_hash,actor_subject) values (${id},${snapshotId},${snapshot.outlet_id},${ctx.actor.profileId},${owner},${visit?.id ?? null},${trip?.id ?? null},${callKey},${dateOf(snapshot.service_date)},${new Date(p.deviceTime)},${p.complete},${result.required},${result.checked},${result.present},${lines},${proposals},${hash},${ctx.actor.subject})`;
  await audit(ctx, "availability.checked", id);
  if (result.checked === result.required && p.complete && ctx.op) {
    const call = await ownedCall(
      ctx,
      visit ? { visitId: visit.id } : { clientCallId: callKey },
    );
    if (
      call?.definition_snapshot.steps.some(
        (/** @type {any} */ s) => s.adapter === "availability",
      )
    )
      await advance(ctx, call, "availability", id);
  }
  if (trip && ctx.op)
    await vanAudit(ctx.db, trip, ctx.actor, "availability.record", id, {
      clientOpId: ctx.op.clientOpId,
    });
  await ctx.change("availability.check", id, owner);
  ctx.publish("analytics");
  ctx.publish("availability");
  return { entityId: id, eventIds: [] };
}
/** @param {any} ctx */
export async function decideProposal(ctx) {
  const p = ctx.payload ?? ctx.body,
    id = uuid(p.decisionId);
  if (ctx.device) {
    if (!ctx[DSR_ACCESS]) await currentActor(ctx.db, ctx.actor);
    await reauthorizeDevice(ctx.db, ctx.actor, ctx.device.id);
  }
  const [check] =
    await ctx.db`select * from availability_checks where id=${uuid(p.checkId)}`;
  if (!check || check.profile_id !== ctx.actor.profileId) throw forbidden();
  await authorizeCall(ctx, check.outlet_id, dateOf(check.service_date));
  if (
    !check.proposals.some(
      (/** @type {any} */ l) => l.productId === p.productId,
    ) ||
    !["accepted", "dismissed"].includes(p.decision)
  )
    throw invalid();
  const qty = quantity(p.quantityBase);
  if (p.decision === "accepted" ? qty === 0 || !p.orderKey : qty !== 0)
    throw invalid();
  const orderKey = p.orderKey == null ? null : uuid(p.orderKey);
  const hash = sha256Hex(
    canonicalJson({
      checkId: p.checkId,
      productId: p.productId,
      decision: p.decision,
      quantityBase: qty,
      orderKey,
    }),
  );
  const [prior] =
    await ctx.db`select * from availability_proposal_decisions where check_id=${check.id} and product_id=${uuid(p.productId)}`;
  if (prior) {
    if (prior.payload_hash !== hash)
      throw invalid(
        "Proposal decision already recorded",
        "idempotency_conflict",
      );
    if (check.trip_id && ctx.op)
      await vanAudit(
        ctx.db,
        { id: check.trip_id },
        ctx.actor,
        "availability.proposal",
        prior.id,
        { clientOpId: ctx.op.clientOpId },
      );
    return { entityId: prior.id, eventIds: [] };
  }
  await ctx.db`insert into availability_proposal_decisions(id,check_id,product_id,decision,quantity_base,order_key,actor_subject,payload_hash) values (${id},${check.id},${p.productId},${p.decision},${qty},${orderKey},${ctx.actor.subject},${hash})`;
  await audit(ctx, "availability.proposal_decided", id);
  if (check.trip_id && ctx.op)
    await vanAudit(
      ctx.db,
      { id: check.trip_id },
      ctx.actor,
      "availability.proposal",
      id,
      { clientOpId: ctx.op.clientOpId },
    );
  ctx.publish("availability");
  return { entityId: id, eventIds: [] };
}
/** SEAM(CALLFLOW): the engine calls this before completing its availability step.
 * @param {any} db @param {string} profileId @param {string} callKey */
export async function availabilityStepComplete(db, profileId, callKey) {
  const [row] =
    await db`select complete,checked_count,required_count from availability_checks where profile_id=${profileId} and call_key=${callKey} order by device_time desc,id desc limit 1`;
  return !!row && row.complete && row.checked_count === row.required_count;
}
