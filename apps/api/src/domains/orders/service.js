import { tx } from "@sunpride/db/client";
import { bindCreditDecision } from "../integration/credit.js";
import { configureSap } from "../integration/transport.js";
import { enqueueOrderPosting } from "../integration/posting.js";
import { requireCapability } from "../../core/capabilities.js";
import { actorFor } from "../../core/context.js";
import { ApiError } from "../../core/errors.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { recordChange } from "../../core/sync.js";
import { writeAudit } from "../org/audit.js";
import { enqueueRefresh } from "../analytics/refresh.js";
import { accessibleOrder, outletContext, scoped } from "./access.js";
import { eligibilityFacts } from "../tpm/campaigns.js";
import { accrueOrder, reverseOrder } from "../tpm/finance.js";
import { enforceCompanyDiscount } from "../fiscal/commercial.js";
import {
  activePromotions,
  applyPromotions,
  baseQuantity,
  creditCheck,
  resolvePrice,
} from "./pricing.js";
import {
  ORGANIZATION,
  MAX_CENTAVOS,
  choice,
  date,
  decimalMoney,
  divide,
  fail,
  manilaDate,
  quantityMilli,
  safe,
  text,
  uuid,
} from "./validation.js";

/** @param {any} ctx @param {string} action @param {string} entityId @param {string|null} [details] @param {string} [entityType] */
export async function audit(
  ctx,
  action,
  entityId,
  details = null,
  entityType = "order",
) {
  await writeAudit(ctx.db, {
    subject: ctx.actor.subject,
    actor: ctx.actor,
    action,
    entityType,
    entityId,
    details,
    at: ctx.now,
  });
}
/** @param {any} ctx @param {any} row */
export async function changed(ctx, row) {
  await recordChange(ctx.db, {
    entity: "order",
    entityId: row.id,
    scopeKey: `unit:${row.org_unit_id ?? "none"}`,
  });
}
/** Called strictly after commit. @param {any} ctx @param {any[]} rows */
export async function notify(ctx, rows = []) {
  await ctx.publish("orders");
  for (const row of rows)
    await enqueueRefresh(ctx, {
      kind: "order",
      date: new Date(row.service_date ?? manilaDate(ctx.now))
        .toISOString()
        .slice(0, 10),
      unitId: row.org_unit_id ?? null,
    });
}
/**
 * Idempotent web command. Reauthorize inside transaction, before command replay.
 * @param {any} ctx @param {string} action @param {any} input
 * @param {(c:any)=>Promise<void>} authorize @param {(c:any)=>Promise<any>} work
 */
export async function command(ctx, action, input, authorize, work) {
  if (!ctx.actor)
    throw new ApiError("unauthenticated", 401, "Sign in to continue");
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("Command body must be an object");
  const key = text(
    input.idempotencyKey ??
      input.clientRequestId ??
      ctx.req.headers.get("idempotency-key"),
    "Request key",
    160,
  );
  const hash = sha256Hex(canonicalJson({ action, input }));
  return tx(ctx.db, async (db) => {
    const actor = ctx.actor ? await actorFor(db, ctx.actor.userId) : null;
    if (!actor)
      throw new ApiError("forbidden", 403, "Your access is no longer active");
    configureSap(db, ctx.env ?? process.env);
    const c = { ...ctx, db, actor };
    await authorize(c);
    await db`select set_config('sunpride.actor',${actor.userId},true)`;
    await db`select pg_advisory_xact_lock(hashtextextended(${ctx.actor.subject + ":" + key}, 0))`;
    const [existing] =
      await db`select * from orders_commands where actor_subject = ${ctx.actor.subject} and request_key = ${key}`;
    if (existing) {
      if (existing.payload_hash !== hash)
        throw new ApiError(
          "idempotency_conflict",
          409,
          "Request key was reused for different content",
        );
      if (action === "create") await accessibleOrder(c, existing.response.id);
      return action === "outside.encode"
        ? { ...existing.response, replayed: true }
        : existing.response;
    }
    const response = await work(c);
    await db`insert into orders_commands(actor_subject,request_key,payload_hash,response) values(${ctx.actor.subject},${key},${hash},${response})`;
    return response;
  });
}

/** Validated, immutable line pricing at capture time. @param {any} ctx @param {any} input */
export async function quote(ctx, input) {
  configureSap(ctx.db, ctx.env ?? process.env);
  if (
    !Array.isArray(input.lines) ||
    !input.lines.length ||
    input.lines.length > 100
  )
    fail("Add 1–100 product lines");
  const seen = new Set();
  const priced = [];
  for (const raw of input.lines) {
    const [product] = raw.productId
      ? await ctx.db`select * from products where id = ${uuid(raw.productId)} and active and deleted_at is null`
      : await ctx.db`select * from products where code = ${text(raw.productCode, "Product code", 100)} and active and deleted_at is null`;
    if (
      !product ||
      (product.organization_id && product.organization_id !== ORGANIZATION)
    )
      fail("Product not available");
    const uom = text(raw.uom ?? product.uom, "Selling unit", 32);
    const key = `${product.id}|${uom}`;
    if (seen.has(key)) fail("Each product/unit may appear once");
    seen.add(key);
    const milli = quantityMilli(raw.quantity);
    const quantity = Number(milli) / 1000;
    const quantityBase = await baseQuantity(
      ctx.db,
      product,
      uom,
      quantity,
      input.at ?? ctx.now,
    );
    const price = await resolvePrice(ctx.db, {
      organizationId: ORGANIZATION,
      productId: product.id,
      uom,
      channelKey: input.channelKey ?? null,
      customerCode: input.customerCode ?? null,
      outletId: input.outletId ?? null,
      at: input.at ?? ctx.now,
    });
    const lineTotalCentavos =
      price.unitPriceCentavos === null
        ? null
        : safe(divide(BigInt(price.unitPriceCentavos) * milli, 1000n));
    const [list] = price.priceListId
      ? await ctx.db`select code,name from price_lists where id = ${price.priceListId}`
      : [];
    priced.push({
      productId: product.id,
      productCode: product.code,
      description: product.name,
      uom,
      quantity,
      quantityBase,
      ...price,
      priceListCode: list?.code ?? null,
      priceListName: list?.name ?? null,
      lineTotalCentavos,
    });
  }
  const promo = applyPromotions(
    priced,
    await activePromotions(ctx.db, ORGANIZATION, input.at ?? ctx.now),
    await eligibilityFacts(ctx, input),
  );
  // Freeze NET line facts too: analytics sum(order_lines) must equal order.total.
  if (promo.knownSubtotalCentavos > MAX_CENTAVOS)
    fail("Order amount exceeds the supported accounting range");
  // F-511: capture is a priced draft, not financial permission. The same Fiscal
  // matrix consumes exact persisted facts on independent approval, for ALL schemes.

  const allocations = promo.lineDiscounts;
  const net = priced.map((l, i) => ({
    ...l,
    grossLineTotalCentavos: l.lineTotalCentavos,
    discountCentavos: allocations[i] ?? 0,
    lineTotalCentavos:
      l.lineTotalCentavos === null
        ? null
        : l.lineTotalCentavos - (allocations[i] ?? 0),
  }));
  for (const gift of promo.promotionsApplied.flatMap((p) => p.freeGoods)) {
    const [p] =
      await ctx.db`select * from products where id = ${uuid(gift.productId)} and active and deleted_at is null`;
    if (!p || (p.organization_id && p.organization_id !== ORGANIZATION))
      fail("The promotion's free product is unavailable");
    gift.productName = p.name;
    gift.productCode = p.code;
    net.push({
      productId: p.id,
      productCode: p.code,
      description: p.name,
      uom: gift.uom,
      quantity: gift.quantity,
      quantityBase: await baseQuantity(
        ctx.db,
        p,
        gift.uom,
        gift.quantity,
        input.at ?? ctx.now,
      ),
      unitPriceCentavos: 0,
      priceListId: null,
      source: "promotion",
      priceListCode: null,
      priceListName: null,
      grossLineTotalCentavos: 0,
      lineTotalCentavos: 0,
      discountCentavos: 0,
    });
  }
  const credit = await creditCheck(ctx.db, {
    customerCode: input.customerCode ?? "",
    addCentavos: promo.totalCentavos,
  });
  return {
    lines: net,
    ...promo,
    credit,
    pricedAt: input.at ?? ctx.now,
    currency: "PHP",
  };
}

/** @param {any} ctx @param {any} input @param {{intake?:boolean}} [options] */
export async function createOrder(ctx, input, options = {}) {
  // F-306: trusted intake callers use the office capability, never the outside-call object.
  const officeIntake = options.intake === true;
  await ctx.db`select set_config('sunpride.actor',${ctx.actor.userId},true)`;
  const customerCode = text(input.customerCode, "Customer", 100);
  const [customer] =
    await ctx.db`select * from customers where code = ${customerCode} and active and deleted_at is null for update`;
  if (!customer) fail("Customer not available");
  let unit = ctx.actor.orgUnitId;
  let territoryId = null;
  let outletId = null;
  let sellingChannel = customer.channel;
  if (input.outletId) {
    const store = await outletContext(
      ctx,
      input.outletId,
      input.outsideCallId || officeIntake ? "order.encode" : "order.create",
    );
    const links =
      await ctx.db`select customer_id from outlet_customer_links where outlet_id = ${input.outletId} and deleted_at is null and effective_from <= now() and (effective_to is null or effective_to > now())`;
    if (links.length !== 1 || links[0].customer_id !== customer.id)
      fail("Store is not linked to this customer");
    unit = store.unit;
    sellingChannel = store.outlet.channel ?? customer.channel;
    territoryId = store.assignment?.territory_id ?? null;
    outletId = input.outletId;
  } else if (ctx.actor.role !== "super_admin") {
    const [assignment] =
      await ctx.db`select sa.* from sales_assignments sa where sa.customer_code = ${customerCode}
      and sa.territory = ${customer.territory} and sa.active and sa.salesperson_subject = ${ctx.actor.subject}`;
    if (!assignment)
      throw new ApiError(
        "out_of_scope",
        403,
        "Customer is not assigned to you",
      );
  }
  const [person] = input.salespersonProfileId
    ? await ctx.db`select * from profiles where id = ${uuid(input.salespersonProfileId)} and status = 'active' and deleted_at is null`
    : await ctx.db`select * from profiles where id = ${ctx.actor.profileId} and status = 'active' and deleted_at is null`;
  if (!person) fail("Salesperson not available");
  await scoped(
    ctx,
    input.outsideCallId || officeIntake ? "order.encode" : "order.create",
    person.org_unit_id,
  );
  if (!input.outsideCallId && person.id !== ctx.actor.profileId)
    fail("Only office outside-call POs may credit another salesperson");
  const serviceDate = input.serviceDate
    ? date(input.serviceDate)
    : manilaDate(ctx.now);
  const at = input.at ?? ctx.now;
  const pricing = await quote(ctx, {
    ...input,
    customerCode,
    channelKey: sellingChannel,
    at,
  });
  const id = crypto.randomUUID();
  const [{ sequence }] =
    await ctx.db`select nextval('orders_document_seq')::text as sequence`;
  const orderNumber = `SP-${serviceDate.replaceAll("-", "")}-${String(sequence).padStart(6, "0")}`;
  const status = choice(
    input.status ?? "pending_approval",
    ["draft", "submitted", "pending_approval"],
    "Order stage",
  );
  const [row] =
    await ctx.db`insert into orders(id,organization_id,client_request_id,order_number,order_type,customer_code,salesperson_subject,
    salesperson_profile_id,created_by_subject,org_unit_id,outlet_id,territory_id,channel_key,service_date,status,subtotal,total,subtotal_centavos,total_centavos,amount_known,
    credit_status,credit_limit_centavos,credit_exposure_centavos,pricing_snapshot,source_activity_id,outside_call_id,request_payload_hash,offline_created_at)
    values(${id},${ORGANIZATION},${input.clientRequestId ?? id},${orderNumber},${input.orderType ?? "booking"},${customerCode},${person.user_id ?? person.auth_subject},
    ${person.id},${ctx.actor.subject},${unit},${outletId},${territoryId},${String(sellingChannel).toLowerCase()},${serviceDate},${status},
    ${decimalMoney(pricing.knownSubtotalCentavos)},${decimalMoney(pricing.totalCentavos ?? pricing.knownSubtotalCentavos)},${pricing.subtotalCentavos},${pricing.totalCentavos},${pricing.totalCentavos !== null},
    ${pricing.credit.status},${pricing.credit.limit},${pricing.credit.exposure},${pricing},${input.activityId ?? null},${input.outsideCallId ?? null},${sha256Hex(canonicalJson(input))},${new Date(at)}) returning *`;
  for (let i = 0; i < pricing.lines.length; i++) {
    const l = pricing.lines[i];
    await ctx.db`insert into order_lines(order_id,ordinal,product_id,product_code,description,uom,quantity,quantity_base,unit_price,line_total,unit_price_centavos,line_total_centavos,price_list_id)
      values(${id},${i},${l.productId},${l.productCode},${l.description},${l.uom},${l.quantity},${l.quantityBase},${decimalMoney(l.unitPriceCentavos ?? 0)},${decimalMoney(l.lineTotalCentavos ?? 0)},${l.unitPriceCentavos},${l.lineTotalCentavos},${l.priceListId})`;
  }
  if (status === "pending_approval") await startWorkflow(ctx, row);
  await history(ctx, row, null, "created", null);
  await changed(ctx, row);
  return row;
}
/** @param {any} ctx @param {any} row */
async function startWorkflow(ctx, row) {
  const [w] =
    await ctx.db`insert into workflow_instances(entity_type,entity_id,workflow_type,status,current_step,requested_by)
    values('order',${row.id},'sales-order-approval','pending',1,${ctx.actor.subject}) returning id`;
  await ctx.db`insert into approvals(workflow_id,decision) values(${w.id},'pending')`;
}
/** @param {any} ctx @param {any} row @param {string|null} from @param {string} action @param {string|null} reason */
async function history(ctx, row, from, action, reason) {
  await ctx.db`insert into order_history(order_id,actor_subject,action,from_status,to_status,reason) values(${row.id},${ctx.actor.subject},${action},${from},${row.status},${reason})`;
  await audit(ctx, `order.${action}`, row.id, reason);
}
export const TRANSITIONS = Object.freeze({
  draft: ["submitted", "voided"],
  submitted: ["pending_approval", "voided"],
  pending_approval: ["approved", "rejected", "voided"],
  approved: ["posted", "fulfilled", "voided"],
  posted: ["fulfilled"],
  fulfilled: [],
  rejected: [],
  voided: [],
});
/** @param {string} from @param {string} to */
export function assertTransition(from, to) {
  if (
    !(/** @type {Record<string,string[]>} */ (TRANSITIONS)[from]?.includes(to))
  )
    fail("This order cannot move to that stage", "invalid_transition");
}
/** @param {any} ctx @param {string} id @param {string} status @param {string} reason @param {any} [input] */
export async function transition(ctx, id, status, reason, input = {}) {
  const row = await accessibleOrder(ctx, id, true);
  assertTransition(row.status, status);
  const capability = ["approved", "rejected", "fulfilled"].includes(status)
    ? "order.approve"
    : status === "posted"
      ? "integration.manage"
      : row.outside_call_id
        ? "order.encode"
        : "order.create";
  await scoped(ctx, capability, row.org_unit_id);
  const note = text(reason, "Reason");
  if (
    ["approved", "rejected"].includes(status) &&
    (row.created_by_subject === ctx.actor.subject ||
      row.salesperson_subject === ctx.actor.subject ||
      row.salesperson_profile_id === ctx.actor.profileId)
  )
    fail("You cannot decide your own order", "self_approval");
  if (
    ["submitted", "pending_approval", "voided"].includes(status) &&
    ctx.actor.role !== "super_admin" &&
    row.created_by_subject !== ctx.actor.subject &&
    row.salesperson_profile_id !== ctx.actor.profileId &&
    !(status === "voided" && row.outside_call_id)
  )
    fail("Only the requester can change this order");
  if (status === "approved" && !row.amount_known)
    fail(
      "Set up the missing prices and create a corrected order before approval",
      "price_unknown",
    );
  const before = row.status;
  if (status === "approved") {
    await enforceCompanyDiscount(ctx, row, note);
    const [latest] =
      await ctx.db`select id,status from sap_credit_override_requests where customer_code=${row.customer_code} and request_facts->>'sourceType'='order' and request_facts->>'sourceId'=${row.id} order by created_at desc,id desc limit 1`;
    const exceptionId =
      input.sapCreditExceptionId ??
      (latest?.status === "approved" ? latest.id : null);
    const decisionId = await bindCreditDecision(ctx.db, {
      customerCode: row.customer_code,
      amountCentavos: Number(row.total_centavos),
      sourceType: "order",
      sourceId: row.id,
      ...(exceptionId
        ? { exceptionId: uuid(exceptionId), orgUnitId: row.org_unit_id }
        : {}),
      env: ctx.env,
    });
    await ctx.db`update orders set sap_credit_decision_id=${decisionId} where id=${row.id}`;
    row.sap_credit_decision_id = decisionId;
  }
  if (["approved", "rejected"].includes(status)) {
    const [customer] =
      await ctx.db`select id from customers where code = ${row.customer_code} for update`;
    if (!customer) fail("Customer no longer exists");
    const credit = await creditCheck(ctx.db, {
      customerCode: row.customer_code,
      addCentavos: 0,
    });
    await ctx.db`update orders set credit_status = ${credit.status}, credit_limit_centavos = ${credit.limit}, credit_exposure_centavos = ${credit.exposure} where id = ${row.id}`;
    const [w] =
      await ctx.db`select * from workflow_instances where entity_type = 'order' and entity_id = ${row.id} and status = 'pending' for update`;
    if (!w) fail("Approval workflow not found");
    await ctx.db`update workflow_instances set status = ${status} where id = ${w.id}`;
    await ctx.db`update approvals set decision = ${status}, approver_subject = ${ctx.actor.subject}, comment = ${note}, decided_at = now() where workflow_id = ${w.id} and decision = 'pending'`;
  }
  // F-119 a typed document number is not a SAP acknowledgement.
  const postingDocument = status === "posted" ? row.sap_document_number : null;
  if (status === "posted" && !postingDocument)
    fail("Wait for SAP to acknowledge this order", "sap_pending");
  if (status === "approved") await enqueueOrderPosting(ctx.db, row);
  await ctx.db`update orders set status = ${status}, sap_document_number = coalesce(${postingDocument},sap_document_number) where id = ${id}`;
  row.status = status;
  if (status === "approved") await accrueOrder(ctx, row);
  if (status === "voided") await reverseOrder(ctx, row.id);
  if (status === "pending_approval") await startWorkflow(ctx, row);
  if (status === "voided" && before === "pending_approval") {
    await ctx.db`update approvals set decision = 'rejected', approver_subject = ${ctx.actor.subject}, comment = ${note}, decided_at = now()
      where workflow_id in (select id from workflow_instances where entity_type = 'order' and entity_id = ${id} and status = 'pending') and decision = 'pending'`;
    await ctx.db`update workflow_instances set status = 'rejected' where entity_type = 'order' and entity_id = ${id} and status = 'pending'`;
  }
  await history(ctx, row, before, status, note);
  await changed(ctx, row);
  return row;
}
