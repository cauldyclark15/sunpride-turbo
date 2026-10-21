import { tx } from "@sunpride/db/client";
import { ApiError } from "../../core/errors.js";
import { canonicalJson, sha256Hex, isUuid } from "../../core/util.js";
import { actorFor } from "../../core/context.js";
import { requireCapability } from "../../core/capabilities.js";
import { tripFor } from "../van/access.js";
import { currentFinancialActor as currentActor } from "../fiscal/actors.js";
import { requestOverride, enforceAuthority } from "../fiscal/authority.js";
import { authorize as distributorAccess } from "../distributors/model.js";
import { accessibleOrder } from "../orders/access.js";
import { sapCreditCheck } from "./credit.js";
import { sapRequest } from "./transport.js";

const fail = (/** @type {string} */ m) => {
  throw new ApiError("credit_exception_required", 409, m);
};
/** F-404: source reference is exact, not a second credit balance or financial authority.
 * @param {any} c @param {any} input */
export async function createCreditException(c, input) {
  const actor = await currentActor(c.db, c.actor);
  let orgUnitId = actor.orgUnitId;
  let party = null;
  if (input.distributorId) {
    party = await distributorAccess(
      { ...c, actor },
      input.distributorId,
      "order",
    );
    if (
      party.sap_customer_code !== input.customerCode ||
      input.sourceType !== "distributor_order"
    )
      fail("Distributor credit must use its own SAP account and order");
    orgUnitId = party.org_unit_id;
  } else await requireCapability({ ...c, actor }, "order.create", orgUnitId);
  const key = input.idempotencyKey,
    reason = input.reason;
  if (
    typeof key !== "string" ||
    key.length < 8 ||
    key.length > 160 ||
    typeof reason !== "string" ||
    reason.trim().length < 3 ||
    reason.length > 300
  )
    fail("Enter a bounded request reference and reason");
  if (!Number.isSafeInteger(input.amountCentavos) || input.amountCentavos < 1)
    fail("Supply the complete known credit amount");
  const sourceType = input.sourceType ?? "next_document",
    sourceId = input.sourceId ?? key;
  if (
    !["next_document", "order", "van_sale", "distributor_order"].includes(
      sourceType,
    ) ||
    typeof sourceId !== "string" ||
    !sourceId.length ||
    sourceId.length > 200 ||
    (["order", "van_sale"].includes(sourceType) && !isUuid(sourceId))
  )
    fail("Choose a valid source document");
  const [localCustomer] =
    await c.db`select code,channel from customers where code=${input.customerCode} and active and deleted_at is null`;
  const customer =
    localCustomer ??
    (party ? { code: party.sap_customer_code, channel: "distributor" } : null);
  if (!customer) fail("The accounting customer is unavailable");
  if (sourceType === "order") {
    const document = await accessibleOrder({ ...c, actor }, sourceId, true);
    if (
      document.created_by_subject !== actor.subject ||
      document.customer_code !== customer.code ||
      !document.amount_known ||
      Number(document.total_centavos) !== input.amountCentavos
    )
      fail("Use your own order and its complete governed amount");
    orgUnitId = document.org_unit_id;
  }
  if (sourceType === "van_sale" && input.tripId) {
    if (!isUuid(input.tripId)) fail("Choose a valid current trip");
    const trip = await tripFor(c.db, actor, input.tripId, "van.operate", true);
    if (
      trip.salesperson_profile_id !== actor.profileId ||
      trip.status !== "active"
    )
      fail("Use your own active trip");
    orgUnitId = trip.org_unit_id;
  }
  const channel = party ? "distributor" : (customer.channel ?? "*"),
    factsKey = {
      customerCode: customer.code,
      amountCentavos: input.amountCentavos,
      currency: "PHP",
      sourceType,
      sourceId,
      reason: reason.trim(),
      orgUnitId,
      channel,
    },
    requestHash = sha256Hex(canonicalJson(factsKey));
  await c.db`select pg_advisory_xact_lock(hashtextextended(${`sap-override:${actor.profileId}:${key}`},0))`;
  const [prior] =
    await c.db`select * from sap_credit_override_requests where requester_profile_id=${actor.profileId} and request_key=${key}`;
  if (prior) {
    if (prior.request_hash !== requestHash)
      throw new ApiError(
        "idempotency_conflict",
        409,
        "Credit request key was reused for different facts",
      );
    return exceptionDto(c.db, prior, true);
  }
  const exposure = await sapCreditCheck(
    c.db,
    customer.code,
    input.amountCentavos,
    { env: c.env },
  );
  if (exposure.freshness !== "live" || exposure.status === "unknown")
    fail("Refresh SAP exposure before asking for an exception");
  const facts = {
    version: 1,
    kind: "sap_credit_exception",
    ...factsKey,
    limitCentavos: exposure.limit,
    exposureCentavos: exposure.exposure,
    projectedExposureCentavos: exposure.projectedExposure,
    checkedAt: exposure.checkedAt,
    source: exposure.source,
    distributorId: party?.id ?? null,
    tripId: sourceType === "van_sale" ? (input.tripId ?? null) : null,
  };
  const id = crypto.randomUUID(),
    fiscalId = crypto.randomUUID();
  await requestOverride(c.db, actor, {
    id: fiscalId,
    kind: "credit",
    orgUnitId,
    channel,
    amountCentavos: String(input.amountCentavos),
    facts,
    reason: reason.trim(),
    forceSecond: true,
  });
  const [row] =
    await c.db`insert into sap_credit_override_requests(id,customer_code,amount_centavos,facts_hash,requester_profile_id,org_unit_id,reason,request_key,request_hash,fiscal_request_id,request_facts) values(${id},${customer.code},${input.amountCentavos},${sha256Hex(canonicalJson(facts))},${actor.profileId},${orgUnitId},${reason.trim()},${key},${requestHash},${fiscalId},${facts}) returning *`;
  return exceptionDto(c.db, row, false);
}
/** @param {any} db @param {any} r @param {boolean} [duplicate] */
export async function exceptionDto(db, r, duplicate = false) {
  const events = r.fiscal_request_id
    ? await db`select kind from fiscal_override_events where request_id::text=${r.fiscal_request_id} and kind in ('approved','rejected')`
    : [];
  const phase = !r.fiscal_request_id
    ? "refresh_request"
    : r.status === "approved"
      ? "approved"
      : r.status === "rejected" ||
          events.some((/** @type {any} */ e) => e.kind === "rejected")
        ? "rejected"
        : events.some((/** @type {any} */ e) => e.kind === "approved")
          ? "awaiting_sap"
          : "awaiting_finance";
  return {
    id: r.id,
    status: r.status,
    phase,
    duplicate,
    fiscalRequestId: r.fiscal_request_id,
    customerCode: r.customer_code,
    amountCentavos: Number(r.amount_centavos),
    sourceType: r.request_facts.sourceType ?? "next_document",
    sourceId: r.request_facts.sourceId ?? null,
    reference: r.sap_reference,
    expiresAt: r.sap_expires_at ? new Date(r.sap_expires_at).getTime() : null,
    source: r.sap_result?.source ?? r.request_facts.source ?? null,
    reason: r.reason,
    exposure: r.request_facts,
    providerReason: r.sap_result?.reason ?? null,
    policy:
      "Independent Finance approval then SAP authority; one matching document only",
  };
}
/** Revalidate the original requester and independent reviewer even after provider acknowledgement.
 * @param {any} db @param {any} row @param {any} env */
async function permission(db, row, env) {
  const [p] =
    await db`select user_id from profiles where id=${row.requester_profile_id}`;
  const actor = p ? await actorFor(db, p.user_id) : null;
  if (!actor) fail("The requester is no longer active");
  const [f] =
    await db`select * from fiscal_override_requests where id::text=${row.fiscal_request_id}`;
  if (
    !f ||
    !f.requires_second ||
    f.kind !== "credit" ||
    f.requester_id !== row.requester_profile_id ||
    f.facts_hash !== row.facts_hash
  )
    fail("Create a new exact credit exception request");
  await enforceAuthority(
    db,
    actor,
    {
      kind: "credit",
      overrideId: f.id,
      operationId: row.id,
      orgUnitId: f.org_unit_id,
      channel: f.channel,
      amountCentavos: String(row.amount_centavos),
      facts: row.request_facts,
      reason: row.reason,
    },
    env,
  );
  return f;
}
/** Current-scope read access is distinct from financial consumption. @param {any} db @param {any} actor @param {any} r */
export async function exceptionAccess(db, actor, r) {
  if (actor.profileId === r.requester_profile_id) {
    if (actor.role === "distributor")
      await distributorAccess(
        { db, actor },
        r.request_facts.distributorId,
        "order",
      );
    else await requireCapability({ db, actor }, "order.create", r.org_unit_id);
  } else await requireCapability({ db, actor }, "order.approve", r.org_unit_id);
}
/** F-404: the server sends an approved decision to the actual configured provider, never invents its receipt.
 * @param {any} c @param {string} id */
export async function completeCreditException(c, id) {
  if (!isUuid(id)) fail("Choose a valid credit request");
  return tx(c.db, async (db) => {
    const actor = await currentActor(db, c.actor),
      [r] =
        await db`select * from sap_credit_override_requests where id=${id} for update`;
    if (!r) fail("Credit exception not found");
    await exceptionAccess(db, actor, r);
    if (!r.fiscal_request_id) return exceptionDto(db, r);
    const events =
      await db`select kind,actor_profile_id from fiscal_override_events where request_id::text=${r.fiscal_request_id}`;
    if (events.some((/** @type {any} */ e) => e.kind === "rejected"))
      return exceptionDto(db, r);
    const approval = events.find(
      (/** @type {any} */ e) => e.kind === "approved",
    );
    if (!approval) return exceptionDto(db, r);
    if (r.status === "rejected") return exceptionDto(db, r);
    const f = await permission(db, r, c.env);
    if (r.status !== "pending_sap" && r.status !== "submitted")
      return exceptionDto(db, r);
    const request = {
      schemaVersion: 1,
      requestId: r.id,
      customerCode: r.customer_code,
      amountCentavos: Number(r.amount_centavos),
      currency: "PHP",
      sourceType: r.request_facts.sourceType,
      sourceId: r.request_facts.sourceId,
      approvalReference: f.id,
      approvedBy: approval.actor_profile_id,
      reason: r.reason,
      expiresAt: new Date(f.expires_at).getTime(),
    };
    let result;
    try {
      result = await sapRequest(db, "/v1/credit/exception", {
        body: request,
        schema: "creditExceptionResult",
        env: c.env,
      });
    } catch {
      return exceptionDto(db, r);
    }
    if (
      [
        "requestId",
        "customerCode",
        "amountCentavos",
        "currency",
        "sourceType",
        "sourceId",
      ].some(
        (k) => result[k] !== request[/** @type {keyof typeof request} */ (k)],
      ) ||
      result.checkedAt > Date.now() + 60000 ||
      result.expiresAt > request.expiresAt ||
      (result.status === "approved" &&
        (!result.reference || result.expiresAt <= Date.now()))
    )
      fail("SAP exception acknowledgement does not match");
    const [saved] =
      await db`update sap_credit_override_requests set status=${result.status === "approved" ? "approved" : "rejected"},sap_reference=${result.reference},sap_expires_at=${new Date(result.expiresAt)},sap_result=${result},updated_at=now() where id=${r.id} returning *`;
    return exceptionDto(db, saved);
  });
}
/** Advance only explicit, independently approved requests; every item revalidates live authority.
 * @param {any} c */
export async function advanceCreditExceptions(c) {
  const rows =
    await c.db`select r.id,p.user_id from sap_credit_override_requests r join profiles p on p.id=r.requester_profile_id where r.status in ('pending_sap','submitted') and p.status='active' and p.deleted_at is null and exists(select 1 from fiscal_override_events e where e.request_id::text=r.fiscal_request_id and e.kind='approved') order by r.created_at,r.id limit 5`;
  let completed = 0;
  for (const row of rows) {
    const actor = await actorFor(c.db, row.user_id);
    if (!actor) continue;
    try {
      const result = await completeCreditException({ ...c, actor }, row.id);
      if (["approved", "rejected"].includes(result.status)) completed++;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    }
  }
  return completed;
}
/** F-404 field/office own-order control view. No offline cache or cross-person financial disclosure.
 * @param {any} c */
export async function creditControlData(c) {
  return tx(c.db, async (db) => {
    const actor = await currentActor(db, c.actor);
    await requireCapability({ db, actor }, "order.create");
    const candidates =
      await db`select id from orders where created_by_subject=${actor.subject} and status in ('draft','submitted','pending_approval') and amount_known and total_centavos>0 and deleted_at is null order by created_at desc,id limit 101`;
    const orders = [];
    for (const candidate of candidates.slice(0, 100)) {
      try {
        const row = await accessibleOrder({ ...c, db, actor }, candidate.id);
        orders.push({
          id: row.id,
          number: row.order_number,
          customerCode: row.customer_code,
          customerName: row.customer_name,
          outletId: row.outlet_id,
          amountCentavos: Number(row.total_centavos),
          status: row.status,
        });
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 403) throw e;
      }
    }
    const rows =
      await db`select * from sap_credit_override_requests where requester_profile_id=${actor.profileId} order by created_at desc,id limit 101`;
    const requests = [];
    for (const row of rows.slice(0, 100)) {
      try {
        await exceptionAccess(db, actor, row);
        requests.push(await exceptionDto(db, row));
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 403) throw e;
      }
    }
    return {
      orders,
      requests,
      truncated: candidates.length > 100 || rows.length > 100,
    };
  });
}
/** Finite same-trip statuses in the existing signed van policy; latest denial never falls back to an older approval.
 * @param {any} db @param {any} actor @param {any} trip */
export async function creditRequestsForTrip(db, actor, trip) {
  const rows =
    await db`select distinct on(r.request_facts->>'sourceId') r.*,f.rule_id,f.expires_at fiscal_expiry,rule.role rule_role,rule.effective_from rule_from,rule.effective_to rule_to,rule.approver_roles,ap.actor_profile_id approver_id,pr.user_id approver_user
 from sap_credit_override_requests r join fiscal_override_requests f on f.id::text=r.fiscal_request_id join fiscal_authority_rules rule on rule.id=f.rule_id
 left join fiscal_override_events ap on ap.request_id=f.id and ap.kind='approved' left join profiles pr on pr.id=ap.actor_profile_id
 where r.requester_profile_id=${actor.profileId} and r.org_unit_id=${trip.org_unit_id} and r.request_facts->>'sourceType'='van_sale' and r.request_facts->>'tripId'=${trip.id}
 order by r.request_facts->>'sourceId',r.created_at desc,r.id desc limit 101`;
  if (rows.length > 100)
    fail("This trip has too many credit requests; review them in the office");
  /** @type {Record<string,any>} */ const output = {};
  const approvers = new Map();
  for (const r of rows) {
    const dto = await exceptionDto(db, r);
    let valid =
      r.rule_role === actor.role &&
      new Date(r.rule_from).getTime() <= Date.now() &&
      (!r.rule_to || new Date(r.rule_to).getTime() > Date.now()) &&
      new Date(r.fiscal_expiry).getTime() > Date.now();
    if (dto.phase === "approved") {
      if (!approvers.has(r.approver_id)) {
        const reviewer = r.approver_user
          ? await actorFor(db, r.approver_user)
          : null;
        let allowed =
          !!reviewer &&
          r.approver_roles.includes(reviewer.role) &&
          reviewer.profileId !== actor.profileId;
        if (allowed)
          try {
            await requireCapability(
              { db, actor: reviewer },
              "order.approve",
              r.org_unit_id,
            );
          } catch {
            allowed = false;
          }
        approvers.set(r.approver_id, allowed);
      }
      valid =
        valid &&
        approvers.get(r.approver_id) &&
        dto.expiresAt !== null &&
        dto.expiresAt > Date.now();
    }
    output[r.request_facts.sourceId] = valid
      ? dto
      : { ...dto, phase: "authority_changed" };
  }
  return output;
}
/** F-404: a receipt is not reusable permission, and never bypasses current Fiscal authority.
 * @param {any} db @param {any} q */
export async function creditExceptionReference(db, q) {
  if (!isUuid(q.exceptionId)) fail("Choose a valid approved credit exception");
  const [r] =
    await db`select * from sap_credit_override_requests where id=${q.exceptionId} for update`;
  if (
    !r ||
    r.status !== "approved" ||
    !r.sap_reference ||
    new Date(r.sap_expires_at).getTime() <= Date.now() ||
    r.customer_code !== q.customerCode ||
    Number(r.amount_centavos) !== q.amountCentavos
  )
    fail("SAP has not approved these exact credit facts");
  if (
    (q.orgUnitId && r.org_unit_id !== q.orgUnitId) ||
    (r.request_facts.tripId && r.request_facts.tripId !== q.tripId)
  )
    fail("The credit exception belongs to another branch or trip");
  if (q.ownerProfileId && r.requester_profile_id !== q.ownerProfileId)
    fail("The credit exception belongs to another requester");
  if (
    r.request_facts.sourceType !== "next_document" &&
    (r.request_facts.sourceType !== (q.exceptionSourceType ?? q.sourceType) ||
      r.request_facts.sourceId !== (q.exceptionSourceId ?? q.sourceId))
  )
    fail("The approved credit exception belongs to another document");
  await permission(db, r, q.env);
  return {
    reference: r.sap_reference,
    sourceType: r.request_facts.sourceType,
    sourceId: r.request_facts.sourceId,
  };
}
