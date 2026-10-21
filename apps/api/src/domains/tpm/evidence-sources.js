import { sha256Hex, canonicalJson } from "../../core/util.js";
import { authorize } from "../distributors/model.js";
import { executionEvidenceAccess } from "./evidence-access.js";

/** F-506: canonical immutable execution and current secondary revisions, not uploaded assertions.
 * Current grants are rechecked on every validation, including after a claim was approved.
 * @param {any} c @param {string} kind @param {string} id */
export async function executionEvidence(c, kind, id) {
  if (["checklist", "posm"].includes(kind)) {
    const [r] =
      await c.db`select a.*,v.assignee_profile_id from retail_execution_audits a join visit_executions v on v.id=a.visit_id and v.deleted_at is null
      where a.id=${id} and a.kind=${kind === "posm" ? "posm" : "promotion"} and a.component_score=100`;
    if (!r) return null;
    const scope = await executionEvidenceAccess(c, {
      outletId: r.outlet_id,
      occurredAt: +new Date(r.captured_at),
    });
    if (!scope) return null;
    return {
      kind,
      sourceId: r.id,
      outletId: r.outlet_id,
      occurredAt: +new Date(r.captured_at),
      ...scope,
      ...(r.facts.campaignVersionId
        ? { campaignVersionId: r.facts.campaignVersionId }
        : {}),
      fingerprint: `retail:${r.id}:${r.payload_hash}`,
      verified: true,
    };
  }
  if (kind === "secondary_sale") {
    const [r] =
      await c.db`select f.*,anchor.id as evidence_source_id from distributor_secondary_lines original
      join distributor_secondary_current f on f.distributor_id=original.distributor_id and f.invoice_number=original.invoice_number and f.line_key=original.line_key and f.kind='sale'
      join lateral(select id from distributor_secondary_lines where distributor_id=original.distributor_id and invoice_number=original.invoice_number and line_key=original.line_key order by revision limit 1)anchor on true
      where original.id=${id}`;
    if (!r) return null;
    await authorize(c, r.distributor_id, "claim");
    // A return reduces the value/quantity available to support a claim. Later corrections invalidate its snapshot.
    const returns =
      await c.db`select id,revision,quantity_base,amount_centavos from distributor_secondary_current where distributor_id=${r.distributor_id}
      and original_invoice_number=${r.invoice_number} and outlet_id=${r.outlet_id} and product_id=${r.product_id} and kind='return' order by id`;
    const returnedQuantity = returns.reduce(
      (/** @type {bigint} */ n, /** @type {any} */ x) =>
        n + BigInt(x.quantity_base),
      0n,
    );
    const remaining = BigInt(r.quantity_base) - returnedQuantity;
    if (remaining <= 0n) return null;
    const amount =
      (BigInt(r.amount_centavos) * remaining) / BigInt(r.quantity_base);
    return {
      kind,
      sourceId: r.evidence_source_id,
      outletId: r.outlet_id,
      occurredAt: +new Date(
        String(
          r.sale_date instanceof Date
            ? r.sale_date.toISOString().slice(0, 10)
            : r.sale_date,
        ).slice(0, 10) + "T12:00:00+08:00",
      ),
      partyType: "distributor",
      partyId: r.distributor_id,
      amountCentavos: Number(amount),
      quantityBase: String(remaining),
      productId: r.product_id,
      evidenceVersion: 2,
      uom: r.uom,
      unitsPerUom: r.units_per_uom == null ? null : Number(r.units_per_uom),
      fingerprint: `secondary:${r.id}:${sha256Hex(canonicalJson({ hash: r.payload_hash, returns }))}`,
      verified: true,
    };
  }
  if (kind === "attendance") {
    const [line] =
      await c.db`select l.*,p.distributor_id,p.evidence_hash,d.id as decision_id,d.decision from partner_billing_lines l
      join partner_billing_periods p on p.id=l.period_id join partner_billing_decisions d on d.period_id=p.id and d.evidence_hash=p.evidence_hash
      where l.id=${id} and d.decision='approved'`;
    if (!line) return null;
    const { billing } = await import("../partners/index.js");
    const pack = await billing(c, line.distributor_id, line.period_id);
    if (pack.stale || pack.decision?.decision !== "approved") return null;
    return {
      kind,
      sourceId: line.id,
      occurredAt: +new Date(line.service_date),
      partyType: "agency",
      partyId: line.distributor_id,
      amountCentavos: Number(line.amount_centavos),
      fingerprint: `agency-billing:${line.id}:${line.evidence_hash}:${line.decision_id}`,
      verified: true,
    };
  }
  return null;
}
