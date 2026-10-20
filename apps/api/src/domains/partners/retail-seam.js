import { bound } from "./model.js";

/** F-319 SEAM(MERCH): read its canonical execution/case tables when merged.
 * Never create another incident model or relabel the software QA tracker.
 * The caller has already authorized current staff, capture-time membership,
 * shared outlet grant and current Sunpride owner for this exact visit.
 * @param {any} db */
export async function retailAvailable(db) {
  const [tables] =
    await db`select to_regclass('public.retail_execution_audits') as audits,to_regclass('public.retail_action_cases') as cases`;
  return Boolean(tables.audits && tables.cases);
}
/** @param {any} db @param {any} visit @param {boolean} available */
export async function retailEvidence(db, visit, available) {
  if (!available) return { available: false, audits: [], cases: [] };
  const audits = bound(
    await db`select id,kind,payload_hash,master_version_id,component_score,captured_at from retail_execution_audits
    where visit_id=${visit.id} and profile_id=${visit.assignee_profile_id} and outlet_id=${visit.outlet_id} order by id limit 501`,
    500,
  );
  const cases = bound(
    await db`select c.id,c.kind,c.status,c.due_at from retail_action_cases c join retail_execution_audits a on a.id=c.audit_id
    where a.visit_id=${visit.id} and a.profile_id=${visit.assignee_profile_id} and a.outlet_id=${visit.outlet_id} and c.outlet_id=a.outlet_id order by c.id limit 501`,
    500,
  );
  return { available: true, audits, cases };
}
