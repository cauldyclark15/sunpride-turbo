import { tx } from "@sunpride/db/client";
import { seams } from "./seams.js";
import { commitBudget } from "./campaigns.js";
import { publish } from "../../core/realtime.js";
import { writeAudit } from "../org/audit.js";
import { changed, bounded, command, office } from "./common.js";
import { fail, integer, safe, text, uuid } from "../orders/validation.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";

/** F-504 transactional operational staging, handed to the SAP-owned outbox when available.
 * @param {any} c @param {any} input */
export async function posting(c, input) {
  const [sample] =
    await c.db`select 1 from promotion_earnings e join campaign_versions v on v.id=e.campaign_version_id join promotions p on p.id=e.promotion_id
    where e.id=${input.earningId ?? null}::uuid and (v.source='sample' or p.source='sample')
    union all select 1 from claim_settlements s join claims q on q.id=s.claim_id join claim_types ct on ct.id=q.type_id
    where s.id=${input.settlementId ?? null}::uuid and ct.source='sample' limit 1`;
  // SAP adapters must retain this provenance and refuse sample postings on a real connection.
  input = { ...input, sourceMode: sample ? "sample" : "operational" };
  const key = text(input.sourceKey, "Posting source", 200);
  const [old] =
    await c.db`select * from tpm_posting_instructions where source_key=${key}`;
  if (old) {
    if (canonicalJson(old.payload) !== canonicalJson(input))
      fail("Posting source conflicts");
    return old;
  }
  const [p] =
    await c.db`insert into tpm_posting_instructions(source_key,kind,earning_id,settlement_id,amount_centavos,payload) values(${key},${input.kind},${input.earningId ?? null},${input.settlementId ?? null},${integer(input.amountCentavos)},${input}) returning *`;
  const sent = await seams.enqueueSapPosting(
    c.db,
    {
      ...input,
      instructionId: p.id,
    },
    c.env,
  );
  if (sent)
    await c.db`update tpm_posting_instructions set status='queued',updated_at=now() where id=${p.id}`;
  return p;
}
/** F-410/F-501 reserve partner orders before the durable SAP handoff, using the same accrual key.
 * @param {any} c @param {any} order */
export async function reserveOrder(c, order) {
  for (const p of order.pricing_snapshot?.promotionsApplied ?? []) {
    const amount = integer(
      Number(p.discountCentavos ?? 0) +
        Number(p.earnedCentavos ?? 0) +
        Number(p.freeGoodsValueCentavos ?? 0),
    );
    if (!p.campaignVersionId || !amount) continue;
    await commitBudget(
      {
        ...c,
        now:
          order.pricing_snapshot.pricedAt ??
          new Date(order.offline_created_at ?? order.created_at).getTime(),
      },
      {
        campaignVersionId: p.campaignVersionId,
        amountCentavos: amount,
        sourceKey: `earned:order:${order.id}:promotion:${p.id}`,
      },
    );
  }
}
/** F-504 server-earned facts come only from the frozen canonical order snapshot, never caller money.
 * Invoke within the source order transaction after approval; replay is by source order+scheme.
 * @param {any} c @param {any} order */
export async function accrueOrder(c, order) {
  if (!["approved", "posted", "fulfilled"].includes(order.status))
    fail("Only accepted orders earn promotion liability");
  await reserveOrder(c, order);
  for (const p of order.pricing_snapshot?.promotionsApplied ?? []) {
    const benefit =
      p.benefitTiming === "claimable" ? p.earnedCentavos : p.discountCentavos;
    if (!p.campaignVersionId || !benefit) continue;
    const key = `order:${order.id}:promotion:${p.id}`;
    const facts = {
      key,
      version: p.campaignVersionId,
      promotion: p.id,
      amount: benefit,
      account: order.customer_code,
      outlet: order.outlet_id,
    };
    const hash = sha256Hex(canonicalJson(facts));
    const [old] =
      await c.db`select * from promotion_earnings where source_key=${key}`;
    if (old) {
      if (old.source_hash !== hash) fail("Earning source conflicts");
      continue;
    }

    if (p.benefitTiming !== "claimable") continue;
    const [earning] =
      await c.db`insert into promotion_earnings(campaign_version_id,promotion_id,source_key,source_hash,outlet_id,account_key,earned_at,amount_centavos) values(${uuid(p.campaignVersionId)},${uuid(p.id)},${key},${hash},${order.outlet_id},${order.customer_code},${new Date(order.offline_created_at ?? order.created_at)},${integer(p.earnedCentavos)}) returning *`;
    await posting(c, {
      sourceKey: `accrue:${key}`,
      kind: "accrual",
      earningId: earning.id,
      amountCentavos: Number(earning.amount_centavos),
      currency: "PHP",
      source: key,
      accountKey: order.customer_code,
    });
    await changed(c, "earning.accrued", earning.id, facts);
  }
}
/** F-504 source void reversal. Block a void after settlement allocation until Finance reconciles.
 * @param {any} c @param {string} orderId */
export async function reverseOrder(c, orderId) {
  const rows =
    await c.db`select * from promotion_earnings where source_key like ${"order:" + orderId + ":promotion:%"} for update`;
  for (const e of rows) {
    if (Number(e.reversed_centavos) === Number(e.amount_centavos)) continue;
    const [used] =
      await c.db`select 1 from claims where earning_id=${e.id} and status not in ('rejected','needs_evidence') limit 1`;
    if (used) fail("Resolve the related claim before reversing its earning");
    await c.db`update promotion_earnings set reversed_centavos=amount_centavos,updated_at=now() where id=${e.id}`;
    await posting(c, {
      sourceKey: `reverse:${e.id}`,
      kind: "reversal",
      earningId: e.id,
      amountCentavos: Number(e.amount_centavos),
      currency: "PHP",
    });
    await changed(c, "earning.reversed", e.id);
  }
  // F-501: both immediate discounts and deferred rebates reserved campaign spend.
  // Voiding releases the remaining commitment without erasing the original reservation.
  const commitments =
    await c.db`select b.* from campaign_commitment_balances b where source_key like ${"earned:order:" + orderId + ":promotion:%"} and amount_centavos>0 order by campaign_id,id`;
  for (const b of commitments) {
    await c.db`select id from campaigns where id=${b.campaign_id} for update`;
    const [remaining] =
      await c.db`select amount_centavos from campaign_commitment_balances where id=${b.id}`;
    if (BigInt(remaining.amount_centavos) <= 0n) continue;
    const [release] =
      await c.db`insert into campaign_commitment_releases(commitment_id,source_key,amount_centavos,reason,actor_subject)
      values(${b.id},${"void:" + orderId + ":" + b.id},${remaining.amount_centavos},'Canonical order void',${c.actor.subject}) on conflict(source_key) do nothing returning id`;
    if (release) await changed(c, "budget.released", release.id);
  }
}
/** F-504/F-507 trusted SAP inbox seam only (not an office mark-posted HTTP endpoint).
 * @param {any} db @param {{instructionId:string,status:'acknowledged'|'rejected',sapDocument?:string,sourceEventId:string}} ack @param {Record<string,string|undefined>} [env] */
export async function applySapAcknowledgement(db, ack, env = undefined) {
  return tx(db, async (t) => {
    const [p] =
      await t`select * from tpm_posting_instructions where id=${uuid(ack.instructionId)} for update`;
    if (!p) fail("Posting instruction not found");
    const hash = sha256Hex(canonicalJson(ack));
    if (p.sap_response_hash) {
      if (hash !== p.sap_response_hash) fail("SAP acknowledgement conflicts");
      return { duplicate: true };
    }
    if (!["acknowledged", "rejected"].includes(ack.status))
      fail("Unknown SAP outcome");
    text(ack.sourceEventId, "SAP source event", 160);
    const doc =
      ack.status === "acknowledged"
        ? text(ack.sapDocument, "SAP document", 160)
        : null;
    await t`update tpm_posting_instructions set status=${ack.status},sap_document=${doc},sap_response_hash=${hash},updated_at=now() where id=${p.id}`;
    if (p.settlement_id && ["payment", "credit_memo"].includes(p.kind)) {
      const [s] =
        await t`select * from claim_settlements where id=${p.settlement_id} for update`;
      const [claim] =
        await t`select * from claims where id=${s.claim_id} for update`;
      await t`update claim_settlements set status=${ack.status},updated_at=now() where id=${s.id}`;
      const [sum] =
        await t`select coalesce(sum(amount_centavos),0) as n from claim_settlements where claim_id=${claim.id} and status='acknowledged'`;
      const status =
        Number(sum.n) >= Number(claim.amount_centavos)
          ? "settled"
          : Number(sum.n) > 0
            ? "part_settled"
            : "approved";
      await t`update claims set status=${status},updated_at=now() where id=${claim.id}`;
      await t`insert into claim_events(claim_id,action,actor_subject,details) values(${claim.id},${"sap." + ack.status},'system:sap',${{ settlementId: s.id, document: doc }})`;
      await t`insert into claim_notifications(claim_id,party_type,party_id,message) values(${claim.id},${claim.claimant_party_type},${claim.claimant_party_id},${ack.status === "acknowledged" ? "SAP confirmed your claim settlement." : "SAP rejected the settlement; Finance will review it."})`;
      if (ack.status === "acknowledged" && claim.earning_id)
        await posting(
          { db: t, env },
          {
            sourceKey: `release:${s.id}`,
            kind: "release",
            earningId: claim.earning_id,
            settlementId: s.id,
            amountCentavos: Number(s.amount_centavos),
            currency: "PHP",
          },
        );
    }
    await writeAudit(t, {
      subject: "system:sap",
      action: "tpm.sap_acknowledged",
      entityType: "tpm_posting",
      entityId: p.id,
      details: { outcome: ack.status, sourceEventId: ack.sourceEventId },
    });
    await publish(t, "tpm");
    // Only the SAP ledger's acknowledged release lowers the open financial liability.
    return { duplicate: false };
  });
}
/** @param {any} c */
export async function liabilities(c) {
  await office(c);
  const rows = bounded(
    await c.db`select e.*,v.name as campaign_name,p.name as promotion_name,
    coalesce((select sum(i.amount_centavos) from tpm_posting_instructions i where i.earning_id=e.id and i.kind='release' and i.status='acknowledged'),0) as released,
    coalesce((select sum(i.amount_centavos) from tpm_posting_instructions i where i.earning_id=e.id and i.kind='accrual' and i.status='acknowledged'),0) as ack_earned,
    coalesce((select sum(i.amount_centavos) from tpm_posting_instructions i where i.earning_id=e.id and i.kind='reversal' and i.status='acknowledged'),0) as ack_reversed,
    exists(select 1 from tpm_posting_instructions i where i.earning_id=e.id and i.status in ('awaiting_seam','queued')) as pending
    from promotion_earnings e join campaign_versions v on v.id=e.campaign_version_id join promotions p on p.id=e.promotion_id order by e.earned_at desc limit 501`,
  );
  return {
    ledger: "SAP",
    rows: rows.map((e) => ({
      id: e.id,
      campaignVersionId: e.campaign_version_id,
      campaignName: e.campaign_name,
      promotionName: e.promotion_name,
      accountKey: e.account_key,
      earnedCentavos: Number(e.amount_centavos),
      reversedCentavos: Number(e.reversed_centavos),
      releasedCentavos: Number(e.released),
      operationalOpenCentavos: safe(
        BigInt(e.amount_centavos) -
          BigInt(e.reversed_centavos) -
          BigInt(e.released),
      ),
      acknowledgedEarnedCentavos: safe(BigInt(e.ack_earned)),
      acknowledgedReversedCentavos: safe(BigInt(e.ack_reversed)),
      openCentavos:
        BigInt(e.ack_earned) > 0n
          ? safe(
              BigInt(e.ack_earned) -
                BigInt(e.ack_reversed) -
                BigInt(e.released),
            )
          : null,
      pendingSap: e.pending,
    })),
  };
}
/** @param {any} router */
export function installFinance(router) {
  router.get("/api/v1/tpm/liabilities", liabilities);
  router.post("/api/v1/tpm/postings/retry", (/** @type {any} */ c) =>
    command(
      c,
      "posting.retry",
      c.body,
      (cc) => office(cc, "integration.manage"),
      async (cc) => {
        const [p] =
          await cc.db`select * from tpm_posting_instructions where id=${uuid(c.body.id)} for update`;
        if (!p || !["awaiting_seam", "queued"].includes(p.status))
          fail("Only unacknowledged instructions can be retried");
        const sent = await seams.enqueueSapPosting(
          cc.db,
          {
            ...p.payload,
            instructionId: p.id,
          },
          cc.env,
        );
        if (sent)
          await cc.db`update tpm_posting_instructions set status='queued',updated_at=now() where id=${p.id}`;
        await changed(cc, "posting.retried", p.id);
        return { status: sent ? "queued" : "awaiting_seam" };
      },
    ),
  );
}
