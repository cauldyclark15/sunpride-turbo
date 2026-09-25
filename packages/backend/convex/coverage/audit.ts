import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Append only; state payloads are explicit typed projections, not free-form PII dumps. */
export async function auditPlan(
  ctx: MutationCtx,
  plan: Doc<"coveragePlans">,
  actorSubject: string,
  action: string,
  before: Record<string, string | number | boolean | null>,
  after: Record<string, string | number | boolean | null>,
  opts: {
    reason?: string;
    affectedEntity?: string;
    affectedRowId?: string;
    approvalSignatureRef?: string;
  } = {},
) {
  await ctx.db.insert("coverageAuditEvents", {
    planId: plan._id,
    assigneeProfileId: plan.assigneeProfileId,
    orgUnitId: plan.orgUnitId,
    localMonth: plan.localMonth,
    createdAt: Date.now(),
    actorSubject,
    action,
    reason: opts.reason,
    affectedEntity: opts.affectedEntity ?? "coveragePlan",
    affectedRowId: opts.affectedRowId ?? plan._id,
    before,
    after,
    diff: Object.fromEntries(
      Object.keys(after)
        .filter((key) => before[key] !== after[key])
        .map((key) => [
          key,
          { from: before[key] ?? null, to: after[key] ?? null },
        ]),
    ),
    planVersion: plan.version,
    approvalSignatureRef: opts.approvalSignatureRef,
  });
}
export function planState(plan: Doc<"coveragePlans">) {
  return {
    status: plan.status,
    contentRevision: plan.contentRevision,
    effectiveFrom: plan.effectiveFrom,
    effectiveTo: plan.effectiveTo,
    assigneeProfileId: plan.assigneeProfileId,
    orgUnitId: plan.orgUnitId,
  };
}
