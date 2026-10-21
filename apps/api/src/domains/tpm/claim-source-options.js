import { date } from "../orders/validation.js";
/** F-506 all canonical evidence families, bounded before a reviewer selects a source.
 * Callers retain authorization and re-read each candidate before exposing its facts.
 * @param {any} c @param {any} r */
export async function claimSourceOptions(c, r) {
  const day = (/** @type {any} */ v) =>
      date(String(v instanceof Date ? v.toISOString() : v).slice(0, 10)),
    from = day(r.period_from),
    to = day(r.period_to);
  return c.db`select * from (
  select e.id,'photo'::text as kind,'Photo · '||o.name as label,e.captured_at as at from field_evidence_files e join outlets o on o.id=e.outlet_id join files f on f.id=e.storage_id
  where e.organization_id='sunpride' and e.deleted_at is null and e.status<>'rejected' and f.status='stored'
  and (e.captured_at at time zone 'Asia/Manila')::date between ${from} and ${to} and (${r.outlet_id}::uuid is null or e.outlet_id=${r.outlet_id})
  union all
  select e.id,'checklist','Campaign checklist · '||o.name,a.device_time from merchandising_compliance_checks e join merchandising_audits a on a.id=e.audit_id and a.deleted_at is null join outlets o on o.id=e.outlet_id
  where e.organization_id='sunpride' and e.deleted_at is null and e.kind='promotion' and e.finding='compliant' and e.service_date between ${from} and ${to} and (${r.outlet_id}::uuid is null or e.outlet_id=${r.outlet_id})
  union all
  select a.id,case a.kind when 'posm' then 'posm' else 'checklist' end,case a.kind when 'posm' then 'POSM audit · ' else 'Campaign checklist · ' end||o.name,a.captured_at from retail_execution_audits a join visit_executions v on v.id=a.visit_id and v.deleted_at is null join outlets o on o.id=a.outlet_id
  where v.organization_id='sunpride' and a.kind in ('posm','promotion') and a.component_score=100 and (a.captured_at at time zone 'Asia/Manila')::date between ${from} and ${to} and (${r.outlet_id}::uuid is null or a.outlet_id=${r.outlet_id})
  union all
  select s.id,'secondary_sale','Secondary invoice '||s.invoice_number||' · '||p.name,s.sale_date::timestamptz from distributor_secondary_current s join products p on p.id=s.product_id
  where ${r.claimant_party_type}='distributor' and s.distributor_id::text=${r.claimant_party_id} and s.kind='sale' and s.sale_date between ${from} and ${to} and (${r.outlet_id}::uuid is null or s.outlet_id=${r.outlet_id})
  union all
  select l.id,'attendance','Approved staff day · '||person.name,l.service_date::timestamptz from partner_billing_lines l join partner_billing_periods p on p.id=l.period_id join profiles person on person.id=l.profile_id join partner_billing_decisions d on d.period_id=p.id and d.evidence_hash=p.evidence_hash and d.decision='approved'
  where ${r.claimant_party_type}='agency' and p.distributor_id::text=${r.claimant_party_id} and l.service_date between ${from} and ${to}
  union all
  select d.id,'source_document','Remittance deduction · '||m.reference,m.received_on::timestamptz from mt_deductions d join mt_remittances m on m.id=d.remittance_id
  where ${r.claimant_party_type}='modern_trade' and d.binding_id::text=${r.claimant_party_id} and m.received_on between ${from} and ${to}
  union all
  select d.id,'source_document','Original document · '||d.title,d.created_at from distributor_documents d where d.distributor_id::text=${r.claimant_party_id} and ${r.claimant_party_type}='distributor' and (d.created_at at time zone 'Asia/Manila')::date between ${from} and ${to}
 ) proof order by at desc,id limit 101`;
}
