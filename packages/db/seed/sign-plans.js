/** Signs bulk sample MCPs with the API's own approval format, so every seeded
 * approved/active plan passes coverage `verifySignature` and opens on the web.
 * @param {import('./store.js').Dataset} d */
export async function signSamplePlans(d) {
  const api = new URL("../../../apps/api/src/", import.meta.url);
  const { digest } = await import(
    new URL("domains/coverage/workflow.js", api).href
  );
  const { dto, civil } = await import(
    new URL("domains/coverage/model.js", api).href
  );
  const { verifySignature } = await import(
    new URL("domains/coverage/activation.js", api).href
  );
  let signed = 0;
  for (const plan of d.rows("coverage_plans")) {
    if (!["approved", "active", "superseded"].includes(String(plan.status)))
      continue;
    if (plan.signed_content) continue;
    const of = (/** @type {string} */ table) =>
      d.rows(table).filter((r) => r.plan_id === plan.id);
    plan.signed_content = {
      source: "sample",
      plan: {
        id: plan.id,
        version: plan.version,
        assignee: plan.assignee_profile_id,
        month: plan.local_month,
        organization: plan.organization_id,
        unit: plan.org_unit_id,
        effectiveFrom: Date.parse(String(plan.effective_from)),
        effectiveTo: Date.parse(String(plan.effective_to)),
        requestedFrom: Date.parse(String(plan.requested_from)),
        requestedTo: Date.parse(String(plan.requested_to)),
        basedOn: plan.based_on_plan_id ?? null,
        reason: plan.revision_reason ?? null,
        preparedBy: plan.prepared_by,
      },
      assignments: dto(of("coverage_assignments")),
      outlets: dto(of("coverage_plan_outlets")),
      slots: of("coverage_plan_slots").map((s) => civil(s)),
    };
    plan.content_hash = digest(plan.signed_content);
    plan.approval_signature = `${plan.id}:${plan.version}:${plan.approved_by}:${Date.parse(String(plan.approved_at))}:${plan.content_hash}`;
    verifySignature(plan);
    for (const a of d
      .rows("coverage_audit_events")
      .filter((a) => a.plan_id === plan.id))
      a.approval_signature_ref = plan.approval_signature;
    signed++;
  }
  return signed;
}
