import { tx } from "@sunpride/db/client";
import { actorFor } from "../../core/context.js";
import { requireCapability } from "../../core/capabilities.js";
import { ApiError, invalid, conflict } from "../../core/errors.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { enqueue } from "../../core/jobs.js";
import { recordChange } from "../../core/sync.js";
import {
  accessibleOrder,
  outletContext,
  ORDER_FROM,
  ORDER_ACCESS,
  scopeParams,
} from "../orders/access.js";
import {
  date,
  text,
  uuid,
  integer,
  instant,
  manilaDate,
} from "../orders/validation.js";
import { tripFor } from "../van/access.js";
import { writeAudit } from "../org/audit.js";
import { policyAt } from "./promise.js";

/** @param {any} value */
export const day = (value) =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
/** F-302: read the source order's current access before ANY replay, not merely cached delivery ownership.
 * @param {any} ctx @param {string} id */
export async function dropFor(ctx, id) {
  const [row] =
    await ctx.db`select d.*,h.order_id,h.outlet_id,h.org_unit_id,h.snapshot,h.status as handoff_status from delivery_drops d join delivery_handoffs h on h.id=d.handoff_id where d.id=${uuid(id)} for update of d`;
  if (!row) throw invalid("Delivery drop not found");
  await accessibleOrder(ctx, row.order_id);
  return row;
}
/** @param {any} ctx @param {string} id @param {string} [cap] */
export async function runFor(ctx, id, cap = "van.manage") {
  const [r] =
    await ctx.db`select * from delivery_runs where id=${uuid(id)} for update`;
  if (!r) throw invalid("Delivery run not found");
  const trip = await tripFor(ctx.db, ctx.actor, r.trip_id, cap, true);
  return { ...r, trip };
}
/** F-301 F-302: confirmed promise + immutable release outbox, one transaction, never a competing order.
 * @param {any} ctx @param {any} p */
export async function confirm(ctx, p) {
  const order = await accessibleOrder(ctx, uuid(p.orderId), true);
  await requireCapability(ctx, "order.approve", order.org_unit_id);
  if (
    !["approved", "posted"].includes(order.status) ||
    !order.outlet_id ||
    !order.org_unit_id
  )
    throw invalid(
      "Approve this store's pre-sell order before confirming delivery",
    );
  const [promise] =
    await ctx.db`select * from presell_order_promises where order_id=${order.id} for update`;
  if (!promise)
    throw invalid("This order has no requested pre-sell delivery date");
  const confirmed = date(p.confirmedDeliveryDate),
    reason = text(p.reason, "Delivery confirmation reason");
  if (confirmed < manilaDate(ctx.now))
    throw invalid("Confirmed delivery cannot be in the past");
  const latest =
    Date.parse(day(promise.requested_delivery_date)) +
    promise.policy_snapshot.sla_days * 86400000;
  if (
    Date.parse(confirmed) > latest ||
    confirmed < day(promise.requested_delivery_date)
  )
    throw invalid(
      "Confirmation must be on or after the requested day and inside the captured SLA",
    );
  const [prior] =
    await ctx.db`select * from delivery_handoffs where order_id=${order.id}`;
  if (prior) {
    if (
      day(promise.confirmed_delivery_date) !== confirmed ||
      prior.status === "cancelled"
    )
      throw conflict("An immutable handoff already exists for this order");
    return { id: prior.id, status: prior.status };
  }
  const lines =
    await ctx.db`select * from order_lines where order_id=${order.id} and deleted_at is null order by ordinal,id`;
  if (
    !lines.length ||
    lines.length > 100 ||
    lines.some(
      (/** @type {any} */ l) =>
        !l.product_id ||
        !Number.isSafeInteger(Number(l.quantity_base)) ||
        Number(l.quantity_base) <= 0,
    )
  )
    throw invalid(
      "All delivery lines need a governed whole base-unit conversion",
    );
  const snapshot = {
    orderNumber: order.order_number,
    orderId: order.id,
    customerCode: order.customer_code,
    outletId: order.outlet_id,
    requestedDeliveryDate: day(promise.requested_delivery_date),
    confirmedDeliveryDate: confirmed,
    policy: promise.policy_snapshot,
    lines: lines.map((/** @type {any} */ l) => ({
      id: l.id,
      ordinal: l.ordinal,
      productId: l.product_id,
      productCode: l.product_code,
      description: l.description,
      uom: l.uom,
      quantity: Number(l.quantity),
      expectedBase: Number(l.quantity_base),
    })),
  };
  await ctx.db`update presell_order_promises set confirmed_delivery_date=${confirmed},confirmed_at=${new Date(ctx.now)},confirmed_by=${ctx.actor.subject},confirmation_reason=${reason} where id=${promise.id}`;
  const [handoff] =
    await ctx.db`insert into delivery_handoffs(order_id,org_unit_id,outlet_id,snapshot,payload_hash) values(${order.id},${order.org_unit_id},${order.outlet_id},${snapshot},${sha256Hex(canonicalJson(snapshot))}) returning id,status`;
  await enqueue(ctx.db, {
    kind: "presell.handoff",
    key: handoff.id,
    payload: { id: handoff.id },
  });
  return handoff;
}
/** SEAM(SAP): deterministic mock acceptance with stable upstream key. Swap adapter, never bypass this outbox.
 * Not inventory allocation, pricing, credit approval or a financial posting.
 * @param {any} db @param {string} id */
export async function processHandoff(db, id) {
  return tx(db, async (t) => {
    const [h] =
      await t`select * from delivery_handoffs where id=${uuid(id)} for update`;
    if (!h || ["acknowledged", "cancelled"].includes(h.status)) return;
    const [order] =
      await t`select status from orders where id=${h.order_id} for share`;
    if (!order || !["approved", "posted"].includes(order.status)) {
      await t`update delivery_handoffs set status='failed',attempts=attempts+1,last_error='source_order_not_confirmable' where id=${id}`;
      return;
    }
    if (h.payload_hash !== sha256Hex(canonicalJson(h.snapshot)))
      throw invalid("Handoff snapshot changed");
    const [drop] =
      await t`insert into delivery_drops(handoff_id) values(${h.id}) returning id`;
    for (const l of h.snapshot.lines)
      await t`insert into delivery_drop_lines(drop_id,order_line_id,ordinal,product_id,product_code,description,uom,ordered_quantity,expected_base)
      values(${drop.id},${l.id},${l.ordinal ?? 0},${l.productId},${l.productCode},${l.description},${l.uom},${l.quantity},${l.expectedBase})`;
    await t`update delivery_handoffs set status='acknowledged',attempts=attempts+1,sap_reference=${`MOCK-DELIVERY-${h.id}`},source='mock_sap',last_error=null,updated_at=now() where id=${id}`;
    await recordChange(t, {
      entity: "delivery",
      entityId: drop.id,
      scopeKey: `unit:${h.org_unit_id}`,
    });
  });
}
/** @param {any} ctx @param {any} p */
export async function createRun(ctx, p) {
  const trip = await tripFor(
    ctx.db,
    ctx.actor,
    uuid(p.tripId),
    "van.manage",
    true,
  );
  if (!["planned", "loading", "loaded", "active"].includes(trip.status))
    throw invalid("Choose an open truck trip");
  const [r] =
    await ctx.db`insert into delivery_runs(trip_id,label,created_by) values(${trip.id},${text(p.label, "Run label", 100)},${ctx.actor.subject}) returning id`;
  return r;
}
/** @param {any} ctx @param {any} p */
export async function schedule(ctx, p) {
  const drop = await dropFor(ctx, p.dropId),
    run = await runFor(ctx, p.runId);
  await requireCapability(ctx, "van.manage", drop.org_unit_id);
  if (
    run.status !== "planning" ||
    !["ready", "scheduled"].includes(drop.status) ||
    drop.handoff_status !== "acknowledged"
  )
    throw invalid("Only unstarted drops can be planned");
  if (drop.run_id && drop.run_id !== run.id) {
    const old = await runFor(ctx, drop.run_id);
    if (old.status !== "planning")
      throw invalid("A released drop cannot change truck");
  }
  const order = await accessibleOrder(ctx, drop.order_id, true);
  if (
    !["approved", "posted"].includes(order.status) ||
    run.trip.org_unit_id !== drop.org_unit_id ||
    day(run.trip.service_date) !== drop.snapshot.confirmedDeliveryDate
  )
    throw invalid("Truck, source order and confirmed delivery day must match");
  const [n] =
    await ctx.db`select coalesce(max(sequence),0)+1 as next from delivery_drops where run_id=${run.id}`;
  if (Number(n.next) > 500) throw invalid("A run supports at most 500 drops");
  await ctx.db`update delivery_drops set run_id=${run.id},sequence=${Number(n.next)},status='scheduled',updated_at=now() where id=${drop.id}`;
  return { id: drop.id };
}
/** @param {any} ctx @param {any} p */
export async function sequence(ctx, p) {
  const run = await runFor(ctx, p.runId);
  if (run.status !== "planning") throw invalid("Released manifests are frozen");
  const drops =
    await ctx.db`select id from delivery_drops where run_id=${run.id} order by sequence for update`;
  if (
    !Array.isArray(p.dropIds) ||
    p.dropIds.length !== drops.length ||
    new Set(p.dropIds).size !== drops.length ||
    p.dropIds.some(
      (/** @type {any} */ id) =>
        !drops.some((/** @type {any} */ d) => d.id === id),
    )
  )
    throw invalid("Sequence every assigned drop exactly once");
  for (let i = 0; i < p.dropIds.length; i++) {
    await dropFor(ctx, p.dropIds[i]);
    await ctx.db`update delivery_drops set sequence=${i + 1} where id=${p.dropIds[i]}`;
  }
  return { id: run.id };
}
/** @param {any} ctx @param {any} p */
export async function releaseRun(ctx, p) {
  const r = await runFor(ctx, p.runId);
  if (r.status !== "planning") throw invalid("Run is already released");
  const drops =
    await ctx.db`select id from delivery_drops where run_id=${r.id} and status='scheduled' order by sequence for update`;
  if (!drops.length) throw invalid("Assign at least one drop");
  for (const d of drops) {
    const row = await dropFor(ctx, d.id),
      order = await accessibleOrder(ctx, row.order_id, true);
    if (!["approved", "posted"].includes(order.status))
      throw invalid("A source order is no longer confirmed");
  }
  await ctx.db`update delivery_runs set status='released',released_at=${new Date(ctx.now)} where id=${r.id}`;
  return { id: r.id };
}
/** @param {any} ctx @param {any} p */
export async function book(ctx, p) {
  const drop = await dropFor(ctx, p.dropId);
  await requireCapability(ctx, "van.manage", drop.org_unit_id);
  if (!["ready", "scheduled"].includes(drop.status) || drop.arrived_at)
    throw invalid("Cannot rebook a started drop");
  const [slot] =
    await ctx.db`select * from delivery_receiving_slots where id=${uuid(p.slotId)} for update`;
  if (
    !slot ||
    slot.outlet_id !== drop.outlet_id ||
    day(new Date(+new Date(slot.starts_at) + 8 * 3600000)) !==
      drop.snapshot.confirmedDeliveryDate ||
    +new Date(slot.ends_at) <= ctx.now
  )
    throw invalid("Choose a receiving slot for this store and confirmed day");
  const [count] =
    await ctx.db`select count(*)::int as n from delivery_appointments where slot_id=${slot.id} and cancelled_at is null and drop_id<>${drop.id}`;
  if (count.n >= slot.capacity) throw conflict("This unloading slot is full");
  const reference = text(p.bookingReference, "Booking reference", 100);
  await ctx.db`update delivery_appointments set cancelled_at=now() where drop_id=${drop.id} and cancelled_at is null`;
  await ctx.db`insert into delivery_appointments(drop_id,slot_id,booking_reference,created_by) values(${drop.id},${slot.id},${reference},${ctx.actor.subject})`;
  await ctx.db`update delivery_drops set window_start=${slot.starts_at},window_end=${slot.ends_at},booking_reference=${reference} where id=${drop.id}`;
  return { id: drop.id };
}
/** @param {any} ctx @param {any} p */
export async function slot(ctx, p) {
  const { outlet } = await outletContext(ctx, uuid(p.outletId), "van.manage");
  const start = instant(p.startsAt),
    end = instant(p.endsAt),
    capacity = integer(p.capacity, "Slot capacity", 50);
  if (
    start.getTime() < ctx.now ||
    end <= start ||
    end.getTime() - start.getTime() > 86400000 ||
    capacity < 1
  )
    throw invalid("Use a future slot lasting at most a day");
  const [s] =
    await ctx.db`insert into delivery_receiving_slots(outlet_id,label,starts_at,ends_at,capacity,source,created_by) values(${outlet.id},${text(p.label, "Slot label", 100)},${start},${end},${capacity},'office',${ctx.actor.subject}) returning id`;
  return s;
}
/** @param {any} ctx @param {any} p */
export async function eta(ctx, p) {
  const drop = await dropFor(ctx, p.dropId);
  await requireCapability(ctx, "van.manage", drop.org_unit_id);
  if (drop.status !== "scheduled")
    throw invalid("Only scheduled drops have an ETA");
  const at = instant(p.eta);
  if (
    at.getTime() < ctx.now ||
    manilaDate(at) !== drop.snapshot.confirmedDeliveryDate
  )
    throw invalid("ETA must be a future time on the confirmed day");
  const channel = p.channel;
  if (!["sms", "email"].includes(channel)) throw invalid("Choose SMS or email");
  // Explicit opt-in per message. This mock never sends to an external provider.
  if (p.consent !== true)
    throw invalid("Record recipient consent before queueing a message");
  const recipient = text(p.recipient, "Consenting recipient", 160);
  if (
    channel === "sms"
      ? !/^\+?[0-9]{10,15}$/.test(recipient)
      : !/^\S+@\S+\.\S+$/.test(recipient)
  )
    throw invalid("Enter a valid recipient");
  const message = `Sample delivery update: ${drop.snapshot.orderNumber} is expected ${at.toLocaleString("en-PH", { timeZone: "Asia/Manila" })}.`;
  const [n] =
    await ctx.db`insert into delivery_notification_outbox(drop_id,request_key,channel,recipient,message,eta) values(${drop.id},${`${ctx.actor.subject}:${p.idempotencyKey}`},${channel},${recipient},${message},${at}) returning id`;
  await ctx.db`update delivery_drops set eta=${at} where id=${drop.id}`;
  await enqueue(ctx.db, {
    kind: "presell.notify",
    key: n.id,
    payload: { id: n.id },
  });
  return n;
}
/** F-612: durable dev sink, idempotent retry after uncertain adapter response.
 * @param {any} db @param {string} id */
export async function processNotification(db, id) {
  return tx(db, async (t) => {
    const [n] =
      await t`select * from delivery_notification_outbox where id=${uuid(id)} for update`;
    if (!n || n.status === "sent") return;
    await t`insert into delivery_notification_sink(notification_id,channel,recipient,message) values(${n.id},${n.channel},${n.recipient},${n.message}) on conflict(notification_id) do nothing`;
    await t`update delivery_notification_outbox set status='sent',attempts=attempts+1,last_error=null,updated_at=now() where id=${n.id}`;
  });
}
/** F-301: effective-dated web policy. Captured promises keep their old snapshot.
 * @param {any} ctx @param {any} p */
export async function publishPolicy(ctx, p) {
  await requireCapability(ctx, "admin.manage");
  const from = instant(p.effectiveFrom);
  if (+from < ctx.now || +from > ctx.now + 366 * 86400000)
    throw invalid("Choose a future policy date");
  const v = {
    label: text(p.label, "Policy label", 100),
    cutoff: integer(p.cutoffMinute, "Cut-off minute", 1439),
    lead: integer(p.leadDays, "Lead days", 30),
    horizon: integer(p.horizonDays, "Horizon", 90),
    sla: integer(p.slaDays, "SLA days", 90),
    target: integer(p.epodTargetPercent, "ePOD target", 100),
  };
  if (
    v.horizon < Math.max(1, v.lead) ||
    v.target < 1 ||
    !Array.isArray(p.varianceReasons) ||
    !p.varianceReasons.length ||
    p.varianceReasons.length > 40 ||
    p.varianceReasons.some(
      (/** @type {any} */ r) =>
        !r ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(r.code) ||
        typeof r.label !== "string" ||
        !r.label.trim() ||
        r.label.length > 100,
    ) ||
    new Set(p.varianceReasons.map((/** @type {any} */ r) => r.code)).size !==
      p.varianceReasons.length
  )
    throw invalid(
      "Choose delivery rules and unique controlled variance reasons",
    );
  await ctx.db`select pg_advisory_xact_lock(5300301)`;
  const rows =
    await ctx.db`select * from presell_policies order by effective_from desc for update`;
  if (rows[0] && +new Date(rows[0].effective_from) >= +from)
    throw conflict("A later policy is already scheduled");
  if (rows[0])
    await ctx.db`update presell_policies set effective_to=${from} where id=${rows[0].id}`;
  const [r] =
    await ctx.db`insert into presell_policies(label,version,cutoff_minute,lead_days,horizon_days,sla_days,epod_target_percent,variance_reasons,effective_from,source,published_by)
    values(${v.label},${(rows[0]?.version ?? 0) + 1},${v.cutoff},${v.lead},${v.horizon},${v.sla},${v.target},${{ values: p.varianceReasons }}::jsonb->'values',${from},'office',${ctx.actor.subject}) returning id`;
  return r;
}
/** @param {any} ctx @param {any} p */
export async function retryHandoff(ctx, p) {
  const [h] =
    await ctx.db`select * from delivery_handoffs where id=${uuid(p.handoffId)} for update`;
  if (!h) throw invalid("Handoff not found");
  const order = await accessibleOrder(ctx, h.order_id, true);
  await requireCapability(ctx, "van.manage", h.org_unit_id);
  if (
    !["approved", "posted"].includes(order.status) ||
    h.status === "cancelled"
  )
    throw invalid("Source order is no longer confirmed");
  if (h.status !== "acknowledged") {
    await ctx.db`update delivery_handoffs set status='pending',last_error=null where id=${h.id}`;
    await enqueue(ctx.db, {
      kind: "presell.handoff",
      key: h.id,
      payload: { id: h.id },
    });
  }
  return { id: h.id };
}
/** @param {any} ctx @param {any} p */
export async function cancel(ctx, p) {
  const [h] =
    await ctx.db`select * from delivery_handoffs where id=${uuid(p.handoffId)} for update`;
  if (!h) throw invalid("Handoff not found");
  await accessibleOrder(ctx, h.order_id, true);
  await requireCapability(ctx, "van.manage", h.org_unit_id);
  const [d] =
    await ctx.db`select * from delivery_drops where handoff_id=${h.id} for update`;
  if (d && (d.run_id || !["ready", "cancelled"].includes(d.status)))
    throw invalid("An assigned or started delivery cannot be cancelled");
  text(p.reason, "Cancellation reason");
  await ctx.db`update delivery_handoffs set status='cancelled' where id=${h.id}`;
  if (d)
    await ctx.db`update delivery_drops set status='cancelled' where id=${d.id}`;
  return { id: h.id };
}
export const actions = {
  confirm,
  createRun,
  schedule,
  sequence,
  releaseRun,
  book,
  slot,
  eta,
  publishPolicy,
  retryHandoff,
  cancel,
};
/** @param {any} ctx @param {keyof typeof actions} action */
export async function command(ctx, action) {
  const p = ctx.body;
  const key = text(p?.idempotencyKey, "Request key", 160),
    hash = sha256Hex(canonicalJson({ action, p }));
  const result = await tx(ctx.db, async (db) => {
    const actor = ctx.actor && (await actorFor(db, ctx.actor.userId));
    if (!actor)
      throw new ApiError("forbidden", 403, "Your access is no longer active");
    const c = { ...ctx, db, actor };
    await requireCapability(
      c,
      action === "confirm"
        ? "order.approve"
        : action === "publishPolicy"
          ? "admin.manage"
          : "van.manage",
    );
    // Reauthorize exact targets before consulting command receipts.
    if (p.orderId) await accessibleOrder(c, uuid(p.orderId));
    if (p.dropId) await dropFor(c, p.dropId);
    if (p.runId) await runFor(c, p.runId);
    if (p.tripId) await tripFor(db, actor, uuid(p.tripId), "van.manage");
    if (p.outletId) await outletContext(c, uuid(p.outletId), "van.manage");
    if (p.handoffId) {
      const [h] =
        await db`select order_id from delivery_handoffs where id=${uuid(p.handoffId)}`;
      if (!h) throw invalid("Handoff not found");
      await accessibleOrder(c, h.order_id);
    }
    await db`select pg_advisory_xact_lock(hashtextextended(${actor.subject + ":presell:" + key},0))`;
    const [prior] =
      await db`select * from presell_commands where actor_subject=${actor.subject} and request_key=${key}`;
    if (prior) {
      if (prior.payload_hash !== hash)
        throw conflict("Request key was reused for different content");
      return prior.response;
    }
    const response = await actions[action](c, p);
    await writeAudit(db, {
      subject: actor.subject,
      action: `presell.${action}`,
      entityType: "delivery",
      entityId: response.id,
      details: { reason: p.reason ?? null },
    });
    await db`insert into presell_commands(actor_subject,request_key,payload_hash,response) values(${actor.subject},${key},${hash},${response})`;
    await recordChange(db, {
      entity: "delivery",
      entityId: response.id,
      scopeKey: `unit:${actor.orgUnitId ?? "national"}`,
    });
    return response;
  });
  await ctx.publish("delivery");
  return result;
}
/** F-303: complete bounded projection, source-order scope checked in SQL BEFORE the cap.
 * @param {any} ctx */
export async function board(ctx) {
  const params = await scopeParams(ctx),
    today = date(ctx.url.searchParams.get("date") ?? manilaDate(ctx.now));
  const from = manilaDate(Date.parse(today + "T00:00:00+08:00") - 7 * 86400000),
    to = manilaDate(Date.parse(today + "T00:00:00+08:00") + 7 * 86400000);
  const rows = await ctx.db.unsafe(
    `select o.id,o.order_number,o.status as order_status,s.requested_delivery_date,s.confirmed_delivery_date,s.policy_snapshot,
    store.name as outlet_name,o.outlet_id,h.id as handoff_id,h.status as handoff_status,h.source,h.last_error,
    d.id as drop_id,d.run_id,d.sequence,d.status as delivery_status,d.window_start,d.window_end,d.arrived_at,d.unloading_at,d.departed_at,d.eta,
    pr.id as proof_id,pr.within_sla,r.label as run_label,t.trip_number,t.id as trip_id,
    v.plate_number as truck,p.name as agent_name
    ${ORDER_FROM} join presell_order_promises s on s.order_id=o.id
    left join delivery_handoffs h on h.order_id=o.id left join delivery_drops d on d.handoff_id=h.id
    left join delivery_proofs pr on pr.drop_id=d.id left join delivery_runs r on r.id=d.run_id
    left join van_trips t on t.id=r.trip_id left join vehicles v on v.id=t.vehicle_id
    where ${ORDER_ACCESS} and coalesce(s.confirmed_delivery_date,s.requested_delivery_date) between $3::date and $4::date
    order by coalesce(s.confirmed_delivery_date,s.requested_delivery_date),d.sequence nulls first,o.order_number limit 1001`,
    [...params, from, to],
  );
  if (rows.length > 1000)
    throw invalid(
      "More than 1000 delivery orders in this fortnight; narrow the dispatch scope",
    );
  const runs =
    await ctx.db`select r.*,t.trip_number,t.org_unit_id,t.service_date from delivery_runs r join van_trips t on t.id=r.trip_id where t.service_date=${today} order by r.created_at limit 201`;
  const allowedRuns = [];
  for (const r of runs) {
    try {
      await tripFor(ctx.db, ctx.actor, r.trip_id);
      allowedRuns.push({ ...r, service_date: day(r.service_date) });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 403) throw e;
    }
  }
  if (runs.length > 200)
    throw invalid("More than 200 delivery runs; narrow the day");
  const current = rows.filter(
    (/** @type {any} */ r) =>
      day(r.confirmed_delivery_date ?? r.requested_delivery_date) === today &&
      r.handoff_status !== "cancelled",
  );
  const previous = rows.filter(
    (/** @type {any} */ r) =>
      day(r.confirmed_delivery_date ?? r.requested_delivery_date) === from &&
      r.handoff_status !== "cancelled",
  );
  const summarize = (/** @type {any[]} */ rs) => ({
    drops: rs.filter((r) => r.drop_id != null).length,
    proofs: rs.filter((r) => r.proof_id).length,
    withinSla: rs.filter((r) => r.within_sla === true).length,
    exceptions: rs.filter(
      (r) => r.delivery_status === "variance" || r.handoff_status === "failed",
    ).length,
  });
  return {
    date: today,
    targetPercent: (await policyAt(ctx.db, ctx.now)).epod_target_percent,
    current: summarize(current),
    prior: summarize(previous),
    priorDate: from,
    trend: Array.from({ length: 8 }, (_, i) => {
      const d = manilaDate(
        Date.parse(today + "T00:00:00+08:00") - (7 - i) * 86400000,
      );
      return {
        date: d,
        ...summarize(
          rows.filter(
            (/** @type {any} */ r) =>
              day(r.confirmed_delivery_date ?? r.requested_delivery_date) ===
                d && r.handoff_status !== "cancelled",
          ),
        ),
      };
    }),
    rows: rows.map((/** @type {any} */ r) => ({
      ...r,
      requested_delivery_date: day(r.requested_delivery_date),
      confirmed_delivery_date: r.confirmed_delivery_date
        ? day(r.confirmed_delivery_date)
        : null,
      policy_snapshot: undefined,
    })),
    runs: allowedRuns,
  };
}
/** @param {any} ctx */
export async function manifest(ctx) {
  const r = await runFor(ctx, ctx.url.searchParams.get("runId"), "van.read");
  const drops =
    await ctx.db`select id from delivery_drops where run_id=${r.id} order by sequence`;
  const rows = [];
  for (const d of drops) {
    const drop = await dropFor(ctx, d.id);
    const [outlet] =
      await ctx.db`select name,address from outlets where id=${drop.outlet_id}`;
    const lines =
      await ctx.db`select product_code,description,uom,ordered_quantity,expected_base from delivery_drop_lines where drop_id=${drop.id} order by ordinal`;
    rows.push({
      sequence: drop.sequence,
      store: outlet.name,
      address: outlet.address,
      order: drop.snapshot.orderNumber,
      deliveryDate: drop.snapshot.confirmedDeliveryDate,
      windowStart: drop.window_start,
      windowEnd: drop.window_end,
      bookingReference: drop.booking_reference,
      lines,
    });
  }
  return {
    label: r.label,
    tripNumber: r.trip.trip_number,
    truck:
      (
        await ctx.db`select plate_number from vehicles where id=${r.trip.vehicle_id}`
      )[0]?.plate_number ?? "Truck not named",
    driver:
      r.trip.driver_name ??
      (
        await ctx.db`select name from profiles where id=${r.trip.salesperson_profile_id}`
      )[0]?.name ??
      "Driver not named",
    serviceDate: day(r.trip.service_date),
    status: r.status,
    rows,
  };
}
