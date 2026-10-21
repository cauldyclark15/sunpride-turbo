import { enqueueSapPosting } from "./outbox.js";
import { bindCreditDecision, sapCreditCheck } from "./credit.js";
import { sapConfig } from "./transport.js";
import { applySapAcknowledgement } from "../tpm/finance.js";
import {
  authorize,
  fail,
  integer,
  master,
  digest,
} from "../distributors/model.js";
import { office } from "../tpm/common.js";
import { acknowledgeRetailAction } from "../retail/sap.js";
import { executionEvidence } from "../tpm/evidence-sources.js";
import { authorize as authorizeAgency } from "../partners/model.js";

/** F-504/F-507: the SAP outbox owns delivery; the TPM instruction is its source, not another transport.
 * @param {any} db @param {any} i @param {Record<string,string|undefined>} [env] @returns {Promise<{postingId:string}|null>} */
export async function enqueueTpmPosting(db, i, env = undefined) {
  if (i.sourceMode === "sample" && sapConfig(db, env).mode !== "mock")
    fail("Sample financial instructions cannot be sent to real SAP");
  const [source] =
    await db`select created_at from tpm_posting_instructions where id=${i.instructionId}`;
  const result = await enqueueSapPosting(db, {
    kind: i.kind,
    sourceType: "tpm_instruction",
    sourceId: i.instructionId,
    effectId: `tpm:${i.instructionId}`,
    document: {
      sourceType: "tpm_instruction",
      sourceId: i.instructionId,
      customerCode: i.accountKey ?? i.partyId ?? null,
      currency: "PHP",
      amountCentavos: integer(i.amountCentavos),
      occurredAt: +new Date(source.created_at),
      lines: [],
      facts: i,
    },
  });
  if (result.quarantined)
    fail("Financial posting content conflicts", "conflict", 409);
  return { postingId: result.id };
}

/** F-404: cached partner masters never grant credit in the integrated application.
 * @param {any} c @param {any} d @param {number} amount */
export async function distributorCredit(c, d, amount) {
  const m = await master(c, d.id);
  const code =
    d.sap_customer_code ??
    (m.source === "sample" ? m.payload.mockSapCustomerCode : null);
  if (!code) return { status: "unknown", source: "sap", freshness: "unknown" };
  const r = await sapCreditCheck(c.db, code, amount, { env: c.env });
  return {
    ...r,
    limitCentavos: r.limit,
    exposureCentavos: r.exposure,
    additionalCentavos: amount,
    checkedAt: r.freshness === "live" ? new Date().toISOString() : null,
    authority: "SAP gateway",
  };
}

/** F-401/F-403/F-415: stage immutable partner effects on the same transactional SAP outbox.
 * @param {any} c @param {any} d @param {string} kind @param {string} key @param {any} payload */
export async function enqueueDistributorPosting(c, d, kind, key, payload) {
  if (d.source === "sample" && sapConfig(c.db, c.env).mode !== "mock")
    fail("Sample distributors cannot post to real SAP");
  const [old] =
    await c.db`select * from distributor_sap_requests where distributor_id=${d.id} and kind=${kind} and request_key=${key}`;
  if (old) {
    if (digest(old.payload) !== digest(payload))
      fail("Partner posting content conflicts", "conflict", 409);
    return old;
  }
  // A SAP reservation survives SQL rollback: its identity must survive command retry too.
  const hash = digest({
    distributorId: d.id,
    kind,
    key: c.body?.requestKey ?? key,
  });
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const [request] =
    await c.db`insert into distributor_sap_requests(id,distributor_id,kind,request_key,payload,status,source) values(${id},${d.id},${kind},${key},${payload},'pending',${d.source}) returning *`;
  const sapKind =
    kind === "primary_order"
      ? "order"
      : kind === "remittance"
        ? "payment"
        : "business_partner";
  let amount = payload.totalCentavos ?? 0;
  if (kind === "remittance") {
    const [r] =
      await c.db`select amount_centavos from distributor_remittances where id=${key}`;
    amount = Number(r.amount_centavos);
  }
  let creditDecision = null;
  if (kind === "primary_order") {
    const id = await bindCreditDecision(c.db, {
      customerCode: d.sap_customer_code,
      amountCentavos: amount,
      sourceType: "distributor_request",
      sourceId: request.id,
      env: c.env,
    });
    const [decision] =
      await c.db`select decision_token from sap_credit_decisions where id=${id}`;
    creditDecision = { token: decision.decision_token };
  }
  const result = await enqueueSapPosting(c.db, {
    kind: sapKind,
    sourceType: "distributor_request",
    sourceId: request.id,
    document: {
      sourceType: "distributor_request",
      sourceId: request.id,
      customerCode: d.sap_customer_code ?? null,
      currency: "PHP",
      amountCentavos: integer(amount),
      occurredAt: +new Date(request.created_at),
      lines: [...(payload.lines ?? []), ...(payload.freeGoods ?? [])].map(
        (l) => ({
          productCode: l.productCode,
          uom: l.uom,
          quantityBase: l.quantityBase,
          lotId: null,
          fromLocationCode: null,
          toLocationCode: null,
          unitPriceCentavos: l.unitPriceCentavos,
          taxCode: null,
          taxBasisPoints: null,
        }),
      ),
      facts: {
        ...payload,
        distributorId: d.id,
        sourceMode: d.source,
        creditDecision,
      },
    },
  });
  if (result.quarantined)
    fail("Partner posting content conflicts", "conflict", 409);
  return request;
}

/** F-003: called only after identity/hash/lease verification, inside the ACK transaction.
 * @param {any} db @param {any} row @param {any} result @param {Record<string,string|undefined>} [env] */
export async function acknowledgeSpecPosting(db, row, result, env = undefined) {
  await acknowledgeRetailAction(db, row, result);
  if (row.source_type === "tpm_instruction")
    await applySapAcknowledgement(
      db,
      {
        instructionId: row.source_id,
        status: "acknowledged",
        sapDocument: result.documentNumber,
        sourceEventId: row.event_id,
      },
      env,
    );
  if (row.source_type !== "distributor_request") return;
  const [r] =
    await db`select * from distributor_sap_requests where id=${row.source_id} for update`;
  if (!r) fail("Partner posting source is missing");
  const ack = {
    reference: result.documentNumber,
    source: result.source,
    ...(result.customerCode ? { customerCode: result.customerCode } : {}),
  };
  await db`update distributor_sap_requests set status='acknowledged',acknowledgement=${ack} where id=${r.id}`;
  if (r.kind === "primary_order")
    await db`update orders set sap_document_number=${result.documentNumber},acknowledged_at=now(),sap_acknowledgement=${ack} where id=${r.request_key}::uuid and purchasing_distributor_id=${r.distributor_id}`;
  if (r.kind === "remittance")
    await db`update distributor_remittances set status='acknowledged',updated_at=now() where id=${r.request_key}::uuid and distributor_id=${r.distributor_id}`;
  if (r.kind === "business_partner" && result.customerCode) {
    await db`update distributors set status='accredited',sap_customer_code=${result.customerCode},updated_at=now() where id=${r.distributor_id}`;
    await db`update distributor_applications set stage='accredited',updated_at=now() where distributor_id=${r.distributor_id}`;
  }
}

/** F-505: effective partner grants, including office scope, precede every claimant read/write.
 * @param {any} c @param {string} type @param {string} id */
export async function authorizeClaimant(c, type, id) {
  if (type === "modern_trade" && (!c.actor || c.actor.role === "mt_customer")) {
    const { portalAccess } = await import("../mt/portal.js");
    const { allowed } = await portalAccess(c);
    if (!allowed.some((/** @type {any} */ b) => b.id === id))
      fail("Claimant outside your customer branch", "out_of_scope", 403);
    return;
  }
  if (type === "agency") {
    await authorizeAgency(c, id, "billing");
    return;
  }
  if (type === "distributor") {
    const [exists] =
      await c.db`select id from distributors where id::text=${id}`;
    if (exists) {
      await authorize(c, id, "claim");
      return;
    }
    if (c.actor?.role === "distributor")
      fail("Claimant outside your distributor", "out_of_scope", 403);
  }
  await office(c, "order.encode");
}

/** F-503: only unambiguous current partner membership is a trusted eligibility fact.
 * @param {any} c @param {any} q @returns {Promise<any>} */
export async function readEligibilityFacts(c, q) {
  const rows =
    await c.db`select distinct g.distributor_id from distributor_outlets g join distributors d on d.id=g.distributor_id where g.outlet_id=${q.outletId} and g.effective_from<=${new Date(q.at)} and (g.effective_to is null or g.effective_to>${new Date(q.at)}) and d.effective_from<=${new Date(q.at)} and (d.effective_to is null or d.effective_to>${new Date(q.at)}) and d.status='accredited' limit 2`;
  const [outlet] =
    await c.db`select o.classification,o.geography_id,v.id as geography_version_id from outlets o left join master_versions v on v.master_id=o.geography_id and v.status='active' and v.effective_from<=${new Date(q.at)} and (v.effective_to is null or v.effective_to>${new Date(q.at)}) where o.id=${q.outletId} and o.deleted_at is null`;
  return {
    distributorId: rows.length === 1 ? rows[0].distributor_id : null,
    classKey: outlet?.classification ?? null,
    geographyKey: outlet?.geography_version_id ? outlet.geography_id : null,
  };
}

/** F-506: uploaded documents prove identity/digest only, never a payable amount.
 * @param {any} c @param {string} kind @param {string} id @returns {Promise<any>} */
export async function readPartnerEvidence(c, kind, id) {
  if (kind !== "source_document") return executionEvidence(c, kind, id);
  const [deduction] =
    await c.db`select d.id,d.binding_id,d.amount_centavos,d.updated_at,m.received_on,m.reference from mt_deductions d join mt_remittances m on m.id=d.remittance_id where d.id=${id}`;
  if (deduction) {
    await authorizeClaimant(c, "modern_trade", deduction.binding_id);
    return {
      kind,
      sourceId: id,
      fingerprint: `mt-deduction:${id}:${deduction.amount_centavos}:${new Date(deduction.updated_at).toISOString()}`,
      verified: true,
      occurredAt: +new Date(deduction.received_on),
      partyType: "modern_trade",
      partyId: deduction.binding_id,
      amountCentavos: Number(deduction.amount_centavos),
    };
  }
  const [r] = await c.db`select * from distributor_documents where id=${id}`;
  if (!r) return null;
  await authorize(c, r.distributor_id, "claim");
  return {
    kind,
    sourceId: r.id,
    fingerprint: `distributor-document:${r.id}:${r.sha256}`,
    verified: true,
    occurredAt: +new Date(r.created_at),
    partyType: "distributor",
    partyId: r.distributor_id,
  };
}
