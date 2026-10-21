import { canonicalJson, sha256Hex } from "../../core/util.js";
import { actorFor } from "../../core/context.js";
import { office } from "./common.js";
import { fail, text } from "../orders/validation.js";
import { ApiError } from "../../core/errors.js";
const WAIVABLE = new Set([
  "Missing verified photo",
  "Missing verified checklist",
  "Missing verified posm",
  "Campaign execution evidence is missing",
]);
/** @param {any} policy @param {string[]} reasons */
export const executionExceptionEligible = (policy, reasons) =>
  Boolean(
    policy.allow_execution_override &&
    reasons.length &&
    reasons.every((reason) => WAIVABLE.has(reason)),
  );
/** Same value-band authority as ordinary claim approval; never another approval matrix.
 * @param {any} c @param {any} r */
async function band(c, r) {
  const rules =
    await c.db`select * from claim_approval_rules where (party_type='all' or party_type=${r.claimant_party_type}) and min_centavos<=${r.amount_centavos} and max_centavos>=${r.amount_centavos} and effective_from<=${new Date(c.now)} and effective_to>${new Date(c.now)}`;
  return rules.length === 1 && rules[0].approver_roles.includes(c.actor.role)
    ? rules[0]
    : null;
}
/** Missing execution proof can be explicitly excepted; changed sources, quantities, value and ownership never can.
 * The exception is bound to one complete source hash, and its approver is reauthorized every time.
 * @param {any} c @param {any} r @param {any} policy @param {any} base */
export async function applyExecutionOverride(c, r, policy, base) {
  if (!policy.allow_execution_override || !base.reasons.length) return base;
  const [override] =
    await c.db`select * from claim_execution_overrides where claim_id=${r.id} and base_hash=${base.baseHash} order by seq desc limit 1`;
  if (
    !override ||
    override.approved_by === r.created_by ||
    override.approved_by === r.last_material_by ||
    !base.reasons.every(
      (/** @type {string} */ reason) =>
        WAIVABLE.has(reason) && override.waived_reasons.includes(reason),
    )
  )
    return base;
  const [person] =
    await c.db`select user_id from profiles where (auth_subject=${override.approved_by} or user_id::text=${override.approved_by}) and deleted_at is null and status='active'`;
  const actor = person?.user_id ? await actorFor(c.db, person.user_id) : null;
  if (!actor) return base;
  const cc = { ...c, actor };
  try {
    await office(cc, "order.approve");
  } catch (error) {
    if (error instanceof ApiError && [401, 403].includes(error.status))
      return base;
    throw error;
  }
  const rule = await band(cc, r);
  if (!rule || rule.id !== override.approval_rule_id) return base;
  return {
    ...base,
    passed: true,
    reasons: [],
    waivedReasons: base.reasons,
    overrideId: override.id,
    hash: sha256Hex(
      canonicalJson({
        base: base.baseHash,
        override: override.id,
        rule: rule.id,
      }),
    ),
  };
}
/** @param {any} c @param {any} r @param {any} policy @param {any} base @param {any} b */
export async function approveExecutionOverride(c, r, policy, base, b) {
  await office(c, "order.approve");
  if (
    r.created_by === c.actor.subject ||
    r.last_material_by === c.actor.subject
  )
    fail(
      "A different Finance approver must authorize this exception",
      "self_approval",
    );
  if (!policy.allow_execution_override)
    fail("This effective claim type does not allow execution-proof exceptions");
  if (b.baseHash !== base.baseHash)
    fail("Source facts changed; refresh the evidence preview");
  if (
    !base.reasons.length ||
    !base.reasons.every((/** @type {string} */ reason) => WAIVABLE.has(reason))
  )
    fail(
      "Source ownership, changed evidence, quantities and monetary proof cannot be overridden",
    );
  const rule = await band(c, r);
  if (!rule) fail("Choose a Finance approver in this claim value band");
  const [row] =
    await c.db`insert into claim_execution_overrides(claim_id,base_hash,waived_reasons,reason,evidence_reference,approved_by,approval_rule_id)values(${r.id},${base.baseHash},${base.reasons},${text(b.reason, "Exception reason", 1000)},${text(b.evidenceReference, "Alternative evidence reference", 500)},${c.actor.subject},${rule.id})returning id`;
  return row.id;
}
