import { tx } from "@sunpride/db/client";
import {
  requireCapability,
  requireNationalScope,
  roleHas,
} from "../../core/capabilities.js";
import { ApiError, forbidden, invalid, conflict } from "../../core/errors.js";
import { setHooks } from "../../core/hooks.js";
import { enqueue } from "../../core/jobs.js";
import { OpRejected } from "../../core/sync.js";
import { isPlainObject } from "../../core/util.js";
import { enqueueRefresh } from "../analytics/refresh.js";
import {
  checkIn,
  activity,
  checkOut,
  collection,
  completeTask,
} from "./commands.js";
import { attach, canClaimVisitMedia } from "./evidence.js";
import { canClaimMedia as canClaimVanMedia } from "../van/media.js";
import {
  INVENTORY_MEDIA_PURPOSES,
  canClaimInventoryMedia,
} from "../inventory/media.js";
import { canClaimWorkforceMedia } from "../coverage/workforce.js";
import { decideLocation } from "./location.js";
import { list, detail, media } from "./reads.js";
import { trace, lateQueue } from "./review.js";
import { setRule, rulesAt } from "./rules.js";
import { assortmentAt, setAssortment, recordAudit } from "./merchandising.js";
import {
  accessOutlet,
  accessVisit,
  date,
  ms,
  uuid,
  ORGANIZATION,
  employeeAt,
  event,
  changed,
} from "./shared.js";

/** @param {any} handler */
function opHandler(handler) {
  return async (/** @type {any} */ ctx) => {
    try {
      return await handler(ctx);
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
  };
}
/** @param {any} router @param {any} installCtx */
export function install(router, installCtx) {
  for (const [kind, handler] of Object.entries({
    "visit.checkIn": checkIn,
    "visit.activity": activity,
    "visit.checkOut": checkOut,
    "collection.record": collection,
    "task.complete": completeTask,
    "evidence.attach": attach,
    "merchandising.record": recordAudit,
  }))
    installCtx.registerOp(kind, opHandler(handler));
  installCtx.registerTopic("visits", (/** @type {any} */ actor) =>
    roleHas(actor.role, "visit.read"),
  );
  setHooks({
    canClaimMedia: (db, actor, claim) =>
      claim.purpose === "truck-damage"
        ? canClaimVanMedia(db, actor, claim)
        : INVENTORY_MEDIA_PURPOSES.includes(claim.purpose)
          ? canClaimInventoryMedia(db, actor, claim)
          : ["prospect-photo", "attendance-photo"].includes(claim.purpose)
          ? canClaimWorkforceMedia(db, actor, claim)
          : canClaimVisitMedia(db, actor, claim),
  });
  installCtx.registerJob(
    "visits.refresh",
    async (/** @type {any} */ jobCtx) => {
      await enqueueRefresh(
        {
          ...jobCtx,
          publish: installCtx.publish,
          enqueue: (/** @type {any} */ job) => enqueue(jobCtx.db, job),
        },
        jobCtx.payload,
      );
    },
  );
  /** Web writes share the exact transactional business bodies with sync writes. @param {any} handler @param {string} capability */
  const command = (handler, capability) => async (/** @type {any} */ ctx) => {
    if (!isPlainObject(ctx.body)) throw invalid();
    const topics = new Set();
    const result = await tx(ctx.db, async (t) => {
      const c = {
        ...ctx,
        db: t,
        app: "web",
        payload: ctx.body,
        change: (
          /** @type {string} */ entity,
          /** @type {string} */ entityId,
          /** @type {string} */ scopeKey,
        ) => installCtx.recordChange(t, { entity, entityId, scopeKey }),
        publish: (/** @type {string} */ topic) => topics.add(topic),
        enqueue: (/** @type {any} */ job) => enqueue(t, job),
      };
      await requireCapability(c, capability);
      try {
        return await handler(c);
      } catch (e) {
        if (e instanceof OpRejected)
          throw new ApiError(
            e.code,
            422,
            "The request does not satisfy the visit rules",
          );
        throw e;
      }
    });
    for (const topic of topics) await ctx.publish(topic);
    return result;
  };
  router.get("/api/v1/visits/list", list);
  router.get("/api/v1/visits/detail", detail);
  router.get("/api/v1/visits/trace", trace);
  router.get("/api/v1/visits/late-sync/list", lateQueue);
  router.get("/api/v1/visits/media/:id", media);
  router.post(
    "/api/v1/visits/location-exception/decide",
    command(decideLocation, "visit.locationException.approve"),
  );
  router.post(
    "/api/v1/visits/late-sync/decide",
    command(decideLate, "visit.locationException.approve"),
  );
  router.get(
    "/api/v1/visits/activity-rules",
    async (/** @type {any} */ ctx) => {
      await requireCapability(ctx, "mcp.read");
      const at = ctx.url.searchParams.get("asOf");
      if (at !== null && !Number.isSafeInteger(Number(at))) throw invalid();
      return {
        rules: await rulesAt(ctx.db, at === null ? ctx.now : Number(at)),
      };
    },
  );
  router.post(
    "/api/v1/visits/activity-rules/set",
    command(async (/** @type {any} */ ctx) => {
      await requireNationalScope(ctx, ["super_admin", "admin", "operations"]);
      return setRule(ctx);
    }, "masterdata.manage"),
  );
  router.get(
    "/api/v1/visits/assortments/current",
    async (/** @type {any} */ ctx) => {
      const id = uuid(ctx.url.searchParams.get("outletId"));
      await accessOutlet(ctx, id, "outlet.read");
      const at = ctx.url.searchParams.get("asOf");
      if (at !== null && !Number.isSafeInteger(Number(at))) throw invalid();
      return {
        assortment: await assortmentAt(
          ctx.db,
          id,
          at === null ? ctx.now : Number(at),
        ),
      };
    },
  );
  router.post(
    "/api/v1/visits/assortments/set",
    command(setAssortment, "outlet.manage"),
  );
  router.post(
    "/api/v1/visits/merchandising/record",
    command(recordAudit, "visit.record"),
  );
  router.get("/api/v1/visits/tasks", taskList);
  router.post(
    "/api/v1/visits/tasks/create",
    command(createTask, "mcp.approve"),
  );
}
/** @param {any} ctx */
async function decideLate(ctx) {
  const p = ctx.body;
  if (
    !["accept", "reject"].includes(p.decision) ||
    typeof p.reason !== "string" ||
    !/^[a-zA-Z0-9_.-]{1,80}$/.test(p.reason)
  )
    throw invalid();
  const [visit] =
    await ctx.db`select * from visit_executions where id=${uuid(p.visitId)} for update`;
  await accessVisit(ctx, visit);
  if (visit.assignee_profile_id === ctx.actor.profileId)
    throw forbidden("You cannot review your own visit", "self_approval_denied");
  if (visit.late_review_status !== "pending_review")
    throw conflict("Already reviewed", "already_reviewed");
  const status = p.decision === "accept" ? "accepted" : "rejected";
  await ctx.db`update visit_executions set late_review_status=${status} where id=${visit.id}`;
  const eventId = await event(
    ctx,
    visit,
    "visit",
    visit.id,
    "visit.late_sync.decided",
    { after: status, reasonCode: p.reason },
  );
  await changed(ctx, visit);
  return { lateReviewStatus: status, eventId };
}
/** @param {any} ctx */
async function createTask(ctx) {
  const p = ctx.body;
  const person = await employeeAt(ctx.db, uuid(p.personId), ctx.now);
  await requireCapability(ctx, "mcp.approve", person.org_unit_id);
  if (
    ![
      "inventory_check",
      "merchandising",
      "price_check",
      "promotion",
      "follow_up",
    ].includes(p.kind) ||
    typeof p.required !== "boolean" ||
    !Number.isSafeInteger(p.effectiveFrom) ||
    (p.effectiveTo != null &&
      (!Number.isSafeInteger(p.effectiveTo) ||
        p.effectiveTo <= p.effectiveFrom))
  )
    throw invalid();
  if (p.outletId) {
    const { owner } = await accessOutlet(ctx, uuid(p.outletId), "mcp.approve");
    if (owner !== person.org_unit_id)
      throw forbidden(
        "Task and person must share the current store owner",
        "out_of_scope",
      );
  }
  const [row] =
    await ctx.db`insert into field_tasks (organization_id,org_unit_id,assignee_profile_id,outlet_id,kind,required,effective_from,effective_to,status)
    values (${ORGANIZATION},${person.org_unit_id},${p.personId},${p.outletId ?? null},${p.kind},${p.required},${new Date(p.effectiveFrom)},${p.effectiveTo ? new Date(p.effectiveTo) : null},'open') returning id`;
  await event(
    ctx,
    { id: row.id, org_unit_id: person.org_unit_id },
    "task",
    row.id,
    "task.assigned",
    { after: "open" },
  );
  await ctx.change("task", row.id, person.org_unit_id);
  ctx.publish("visits");
  return { id: row.id };
}
/** @param {any} ctx */
async function taskList(ctx) {
  const actor = await requireCapability(ctx, "visit.read");
  const personId = uuid(
    ctx.url.searchParams.get("personId") ?? actor.profileId,
  );
  if (actor.role === "sales" && personId !== actor.profileId) throw forbidden();
  const person = await employeeAt(ctx.db, personId, ctx.now);
  await requireCapability(ctx, "visit.read", person.org_unit_id);
  const day = date(
    ctx.url.searchParams.get("date") ??
      new Date(ctx.now + 28800000).toISOString().slice(0, 10),
  );
  const rows =
    await ctx.db`select * from field_tasks where assignee_profile_id=${personId} and deleted_at is null
    and effective_from<${new Date(`${day}T23:59:59.999+08:00`)} and (effective_to is null or effective_to>${new Date(`${day}T00:00:00+08:00`)}) order by id limit 501`;
  if (rows.length > 500) throw invalid("Too many field tasks");
  const visible = [];
  for (const row of rows) {
    await requireCapability(ctx, "visit.read", row.org_unit_id);
    if (row.outlet_id) await accessOutlet(ctx, row.outlet_id, "visit.read");
    visible.push({
      id: row.id,
      kind: row.kind,
      required: row.required,
      status: row.status,
      outletId: row.outlet_id,
      visitId: row.visit_id,
      effectiveFrom: ms(row.effective_from),
      effectiveTo: row.effective_to ? ms(row.effective_to) : null,
    });
  }
  return { rows: visible };
}
