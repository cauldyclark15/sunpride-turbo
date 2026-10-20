import { tx } from "@sunpride/db/client";
import { ApiError } from "../../core/errors.js";
import { requestOverride } from "./fiscal-adapter.js";
import { validate } from "../../../../../packages/integration-contracts/sap/v1/index.js";
import { sapRequest } from "./transport.js";

/** F-112/F-404 SAP-issued decision plus conservative cache. No local orders/AR sum.
 * @param {any} db @param {string} customer @param {number|null} amount
 * @param {{requestId?:string,reserve?:boolean,env?:Record<string,string|undefined>}} [opts]
 * @returns {Promise<any>}
 */
export async function sapCreditCheck(db, customer, amount, opts = {}) {
  if (amount === null || !Number.isSafeInteger(amount) || amount < 0)
    return {
      status: "unknown",
      limit: null,
      exposure: null,
      decisionId: null,
      freshness: "unknown",
      source: "sap",
    };
  const request = validate("creditRequest", {
    schemaVersion: 1,
    customerCode: customer,
    amountCentavos: amount,
    currency: "PHP",
    requestId: opts.requestId ?? crypto.randomUUID(),
    reserve: opts.reserve === true,
  });
  try {
    const r = await sapRequest(db, "/v1/credit/check", {
      body: request,
      schema: "creditResult",
      env: opts.env,
    });
    if (
      r.customerCode !== customer ||
      r.amountCentavos !== amount ||
      r.requestId !== request.requestId ||
      r.reserve !== request.reserve ||
      r.expiresAt <= Date.now() ||
      r.checkedAt > Date.now() + 60000
    )
      throw new Error("Mismatched SAP decision");
    const row = await tx(db, async (t) => {
      const [saved] =
        await t`insert into sap_credit_decisions(customer_code,amount_centavos,request_id,decision_token,status,limit_centavos,exposure_centavos,source,checked_at,expires_at)
        values(${customer},${amount},${r.requestId},${r.decisionToken},${r.status},${r.limitCentavos},${r.reserve ? r.projectedExposureCentavos : r.exposureCentavos},${r.source},${new Date(r.checkedAt)},${new Date(r.expiresAt)})
        on conflict(request_id) do update set decision_token=excluded.decision_token,status=excluded.status,limit_centavos=excluded.limit_centavos,exposure_centavos=excluded.exposure_centavos,checked_at=excluded.checked_at,expires_at=excluded.expires_at where sap_credit_decisions.consumed_by is null returning *`;
      if (
        !saved ||
        saved.customer_code !== customer ||
        Number(saved.amount_centavos) !== amount ||
        saved.decision_token !== r.decisionToken
      )
        throw new ApiError(
          "credit_conflict",
          409,
          "SAP credit decision does not match",
        );
      return saved;
    });
    return {
      status: r.status,
      limit: r.limitCentavos,
      exposure: r.projectedExposureCentavos,
      decisionId: row.id,
      expiresAt: r.expiresAt,
      freshness: "live",
      source: r.source,
    };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const [snapshot] =
      await db`select * from sap_credit_decisions where customer_code=${customer} order by checked_at desc limit 1`;
    return {
      status: "unknown",
      limit:
        snapshot?.limit_centavos === null || !snapshot
          ? null
          : Number(snapshot.limit_centavos),
      exposure: null,
      decisionId: null,
      expiresAt: snapshot ? new Date(snapshot.expires_at).getTime() : null,
      freshness: snapshot ? "stale" : "unknown",
      source: snapshot?.source ?? "sap",
      policy: "capture_pending_only",
      snapshot: snapshot
        ? {
            asOf: new Date(snapshot.checked_at).getTime(),
            exposureCentavos:
              snapshot.exposure_centavos === null
                ? null
                : Number(snapshot.exposure_centavos),
          }
        : null,
    };
  }
}
/** F-112 confirm against a live SAP reservation and bind exactly once to a document.
 * Retrying a confirmation uses the same request ID at SAP, including after DB rollback.
 * @param {any} db @param {{customerCode:string,amountCentavos:number,sourceType:string,sourceId:string,env?:Record<string,string|undefined>}} q
 */
export async function bindCreditDecision(db, q) {
  const source = `${q.sourceType}:${q.sourceId}`;
  const [prior] =
    await db`select * from sap_credit_decisions where consumed_by=${source} for update`;
  if (prior) {
    if (
      prior.customer_code !== q.customerCode ||
      Number(prior.amount_centavos) !== q.amountCentavos
    )
      throw new ApiError("credit_conflict", 409, "Credit facts changed");
    return prior.id;
  }
  const decision = await sapCreditCheck(db, q.customerCode, q.amountCentavos, {
    requestId: `confirm:${source}`,
    reserve: true,
    env: q.env,
  });
  if (decision.freshness !== "live" || decision.status === "unknown")
    throw new ApiError(
      "credit_unavailable",
      503,
      "SAP credit is unknown or stale; keep this document pending",
      true,
      { action: "retry", retryAfterMs: 5000 },
    );
  if (!["within", "no_limit"].includes(decision.status))
    throw new ApiError(
      "credit_required",
      422,
      "SAP refused the credit amount; request a credit exception",
    );
  const [row] =
    await db`update sap_credit_decisions set consumed_by=${source} where id=${decision.decisionId} and consumed_by is null and expires_at>now() returning id`;
  if (!row)
    throw new ApiError(
      "credit_expired",
      409,
      "Refresh SAP credit before confirming",
    );
  return row.id;
}
/** F-404/FISCAL: local fallback is a request only, never a financial approval.
 * @param {any} c @param {{customerCode:string,amountCentavos:number,reason:string,idempotencyKey:string}} q
 */
export async function requestCreditOverride(c, q) {
  if (
    typeof q.idempotencyKey !== "string" ||
    q.idempotencyKey.length < 8 ||
    q.idempotencyKey.length > 160 ||
    !Number.isSafeInteger(q.amountCentavos) ||
    q.amountCentavos < 0 ||
    typeof q.reason !== "string" ||
    q.reason.trim().length < 3 ||
    q.reason.length > 500
  )
    throw new ApiError("invalid_request", 400, "Enter amount and a reason");
  return requestOverride(c, { ...q, kind: "credit", currency: "PHP" });
}
