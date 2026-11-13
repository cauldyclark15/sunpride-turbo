import { tx } from "@sunpride/db/client";
import { actorFor } from "../../core/context.js";
import { enqueue } from "../../core/jobs.js";
import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { captureFieldOrder } from "./field.js";
import { outletContext, scoped } from "./access.js";
import { command, notify } from "./service.js";
import { fail, uuid } from "./validation.js";

/**
 * Exact native op is visit.activity with activity.kind=order_intent. Its activity INSERT
 * queues commercial work transactionally via 0271, without a competing op registration.
 * Accepted is an observation, never a price/credit approval. Failed capture is visible review.
 * @param {any} ctx installer ctx or {db,publish,env?}
 * @returns {Promise<{captured:number,review:number}>}
 */
export async function drainFieldOrders(ctx) {
  let captured = 0,
    review = 0;
  for (let i = 0; i < 50; i++) {
    const topics = new Set();
    const outcome = await tx(ctx.db, async (db) => {
      const [item] =
        await db`select * from order_intent_queue where status='pending' order by created_at,id limit 1 for update skip locked`;
      if (!item) return null;
      try {
        // A savepoint ensures ANY partial commercial writes are rolled back before review.
        await tx(db, async (t) => {
          const [activity] =
            await t`select a.*,p.user_id from visit_activities a join profiles p on p.id=a.assignee_profile_id where a.id=${item.activity_id} and a.deleted_at is null`;
          const actor = activity?.user_id
            ? await actorFor(t, activity.user_id)
            : null;
          if (!actor)
            throw new ApiError(
              "out_of_scope",
              403,
              "Recording person is no longer active",
            );
          await captureFieldOrder(
            {
              db: t,
              env: ctx.env ?? process.env,
              actor,
              app: "field-android",
              now: Date.now(),
              publish: (/** @type {string} */ topic) => topics.add(topic),
              enqueue: (/** @type {any} */ job) => enqueue(t, job),
            },
            { activityId: item.activity_id },
          );
        });
        await db`update order_intent_queue set status='captured',review_code=null,updated_at=now() where id=${item.id}`;
        return "captured";
      } catch (e) {
        if (!(e instanceof ApiError)) throw e; // Infrastructure errors remain pending for retry.
        await db`update order_intent_queue set status='review',review_code=${reviewCodeOf(e)},updated_at=now() where id=${item.id}`;
        topics.add("orders");
        return "review";
      }
    });
    if (!outcome) break;
    if (outcome === "captured") captured++;
    else review++;
    for (const topic of topics) await ctx.publish(topic);
  }
  return { captured, review };
}
/** WEB-106: why a captured phone order went to review, as a specific code (kept in review_code).
 * Classified only from structured facts: the refusal's `reviewCode` (set where the capture path
 * refuses) or its ApiError code. Never from message wording.
 * @param {ApiError & {reviewCode?:string}} e @returns {string} */
export function reviewCodeOf(e) {
  if (e.reviewCode && REVIEW_REASONS[e.reviewCode]) return e.reviewCode;
  return CODE_REVIEW[e.code] ?? "needs_review";
}
/** ApiError codes the capture path raises without a refusal-specific reviewCode. */
const CODE_REVIEW = /** @type {Record<string,string>} */ ({
  out_of_scope: "person_inactive",
  forbidden: "person_inactive",
  wrong_date: "wrong_time",
  idempotency_conflict: "already_captured",
  authority_required: "discount_authority",
  price_unknown: "missing_price",
});
/** Plain words per review code; older rows with a generic code keep the general sentence. */
export const REVIEW_REASONS = /** @type {Record<string,string>} */ ({
  missing_price: "Missing price",
  unknown_store: "Unknown store (no accounting customer linked)",
  store_not_set_up: "Store's selling list is not set up",
  product_not_listed: "Product was not on the store's list that day",
  product_unavailable: "Product is no longer available for selling",
  unit_not_set_up: "Product unit is not set up for selling",
  bad_quantity: "Quantity cannot be booked in this unit",
  amount_too_large: "Order amount is too large to book",
  discount_authority: "Promotion discount needs finance approval",
  person_inactive: "The person who took the order is no longer active",
  wrong_time: "Order time is outside the visit",
  already_captured: "Already captured",
  visit_unavailable: "Visit not available",
  bad_phone_record: "Phone order record is incomplete; ask the salesperson to resend it",
});
/** @param {string|null|undefined} code */
export const reviewReason = (code) =>
  (code && REVIEW_REASONS[code]) ||
  "Captured order needs selling setup or authorization review; the original phone evidence is retained.";
/** @param {any} router */
export function installFieldReview(router) {
  router.get("/api/v1/orders/field-review", async (/** @type {any} */ c) => {
    await requireCapability(c, "report.read");
    const rows =
      await c.db`select q.*,a.assignee_profile_id,a.org_unit_id,p.org_unit_id as person_unit,a.outlet_id,p.name,o.name as store_name,v.service_date from order_intent_queue q
      join visit_activities a on a.id=q.activity_id join profiles p on p.id=a.assignee_profile_id join outlets o on o.id=a.outlet_id
      join visit_executions v on v.id=a.visit_id where q.status in ('pending','review') order by q.created_at,q.id`;
    const items = [];
    for (const r of rows) {
      if (
        c.actor.role === "sales" &&
        c.actor.profileId !== r.assignee_profile_id
      )
        continue;
      try {
        await scoped(c, "report.read", r.org_unit_id);
        await scoped(c, "report.read", r.person_unit);
        await outletContext(c, r.outlet_id, "report.read");
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) continue;
        throw e;
      }
      items.push({
        id: r.id,
        storeName: r.store_name,
        salespersonName: r.name,
        serviceDate: new Date(r.service_date).toISOString().slice(0, 10),
        status: r.status,
        reviewCode: r.status === "pending" ? null : r.review_code,
        reason:
          r.status === "pending"
            ? "Waiting for commercial pricing"
            : reviewReason(r.review_code),
      });
    }
    return {
      rows: items.slice(0, 100),
      total: items.length,
      truncated: items.length > 100,
    };
  });
  router.post(
    "/api/v1/orders/field-review/retry",
    async (/** @type {any} */ c) => {
      const id = uuid(c.body.id);
      const result = await command(
        c,
        "field.retry",
        c.body,
        async (cc) => {
          const [r] =
            await cc.db`select a.outlet_id from order_intent_queue q join visit_activities a on a.id=q.activity_id where q.id=${id}`;
          if (!r) fail("Captured order not found");
          await outletContext(cc, r.outlet_id, "order.encode");
        },
        async (cc) => {
          await cc.db`update order_intent_queue set status='pending',review_code=null,updated_at=now() where id=${id} and status='review'`;
          return { ok: true };
        },
      );
      await notify(c);
      return result;
    },
  );
}
