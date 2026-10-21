import { command, bounded } from "./common.js";
import { command as customerCommand } from "../mt/common.js";
import { claimantClaims, submitClaimPacket, readEvidence } from "./claims.js";
import { seams } from "./seams.js";
import { fail, text, uuid } from "../orders/validation.js";

/** F-505/F-507 one claimant view and one financial object, behind each existing portal's fence.
 * @param {any} c @param {string} partyType @param {string} partyId */
export async function claimantPortal(c, partyType, partyId) {
  await seams.authorizeClaimant(c, partyType, partyId);
  const claims = await claimantClaims(c, { partyType, partyId });
  const types = bounded(
    await c.db`select id,code,required_evidence,source from claim_types where effective_from<=now() and effective_to>now() order by code limit 501`,
  );
  const notices = bounded(
    await c.db`select id,claim_id,message,read_at,created_at from claim_notifications where party_type=${partyType} and party_id=${partyId} order by created_at desc limit 501`,
  );
  let candidates;
  if (partyType === "agency")
    candidates =
      await c.db`select l.id,'attendance' as kind,p.period_from::text||' — approved staff day' as label from partner_billing_lines l join partner_billing_periods p on p.id=l.period_id join partner_billing_decisions d on d.period_id=p.id and d.evidence_hash=p.evidence_hash and d.decision='approved' where p.distributor_id=${partyId} and l.amount_centavos>0 and not exists(select 1 from claim_evidence e where e.kind='attendance' and e.source_id=l.id) order by l.service_date desc,l.id limit 101`;
  else if (partyType === "distributor")
    candidates =
      await c.db`select s.id,'secondary_sale' as kind,s.invoice_number||' — secondary sale' as label from distributor_secondary_current s where s.distributor_id=${partyId} and s.kind='sale' and not exists(select 1 from claim_evidence e where e.kind='secondary_sale' and e.source_id=s.id) order by s.sale_date desc,s.id limit 101`;
  else
    candidates =
      await c.db`select d.id,'source_document' as kind,m.reference||' — remittance deduction' as label from mt_deductions d join mt_remittances m on m.id=d.remittance_id where d.binding_id=${partyId} and not exists(select 1 from claim_evidence e where e.kind='source_document' and e.source_id=d.id) order by m.received_on desc,d.id limit 101`;
  const sources = [];
  for (const candidate of candidates.slice(0, 100)) {
    const source = await readEvidence(c, candidate.kind, candidate.id);
    if (source?.verified)
      sources.push({
        ...candidate,
        amountCentavos: source.amountCentavos ?? null,
      });
  }
  return {
    ...claims,
    types,
    notices,
    sources,
    sourcesTruncated: candidates.length > 100,
  };
}
/** @param {any} c @param {string} partyType @param {string} partyId @param {any[]} packets */
export async function submitClaimBatch(c, partyType, partyId, packets) {
  await seams.authorizeClaimant(c, partyType, partyId);
  if (!Array.isArray(packets) || !packets.length || packets.length > 25)
    fail("Submit 1–25 claims per batch");
  const [party] =
    partyType === "modern_trade"
      ? await c.db`select label as name from mt_account_bindings where id=${partyId}`
      : await c.db`select name from distributors where id=${partyId}`;
  if (!party) fail("Claimant unavailable");
  const actor = c.actor ?? {
    subject: c.user.id,
    userId: c.user.id,
    profileId: null,
    role: "mt_customer",
  };
  const rows = [];
  for (const packet of packets)
    rows.push(
      await submitClaimPacket(
        { ...c, actor },
        {
          ...packet,
          sources: packet.sources ?? [],
          partyType,
          partyId,
          partyName: party.name,
        },
      ),
    );
  return { rows };
}
/** @param {any} router */
export function installClaimantPortals(router) {
  for (const [base, partyType] of [
    ["/api/v1/partners/claims/shared", "agency"],
    ["/api/v1/distributors/claims/shared", "distributor"],
    ["/api/v1/portal/claims", "modern_trade"],
  ]) {
    router.get(base, async (/** @type {any} */ c) =>
      claimantPortal(
        c,
        partyType,
        text(c.url.searchParams.get("partyId"), "Claimant party", 160),
      ),
    );
    for (const action of ["submit", "bulk", "read"])
      router.post(`${base}/${action}`, (/** @type {any} */ c) => {
        const b = c.body,
          partyId = text(b?.partyId, "Claimant party", 160);
        const authorize = (/** @type {any} */ cc) =>
          seams.authorizeClaimant(cc, partyType, partyId);
        const work = async (/** @type {any} */ cc) => {
          if (action === "read") {
            const [r] =
              await cc.db`update claim_notifications set read_at=now() where id=${uuid(b.id)} and party_type=${partyType} and party_id=${partyId} returning id`;
            if (!r) fail("Notice not found");
            return r;
          }
          return submitClaimBatch(
            cc,
            partyType,
            partyId,
            action === "bulk" ? b.rows : [b],
          );
        };
        return partyType === "modern_trade"
          ? customerCommand(c, `claims.${action}`, b, authorize, work, true)
          : command(c, `claims.portal.${action}`, b, authorize, work);
      });
  }
}
