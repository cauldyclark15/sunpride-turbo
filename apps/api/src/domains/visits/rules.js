import { invalid } from "../../core/errors.js";
import { writeAudit } from "../org/audit.js";
import { INTENTS, ORGANIZATION, text } from "./shared.js";

export const ACTIVITY_KINDS = [
  "call_sheet",
  "merchandising",
  "inventory_check",
  "price_check",
  "promotion",
  "order_intent",
  "note",
];
export const DEFAULT_VERSION = "visit-activities/2026-10-04";
/** Provisional defaults, not a client's all-items productive checklist. */
export const DEFAULTS = {
  sell: [{ kind: "call_sheet", required: true }],
  collect: [{ kind: "note", required: false }],
  merchandise: [
    { kind: "merchandising", required: true },
    { kind: "price_check", required: false },
  ],
  audit: [
    { kind: "inventory_check", required: true },
    { kind: "price_check", required: false },
    { kind: "merchandising", required: false },
  ],
  deliver: [{ kind: "note", required: false }],
  promotion: [{ kind: "promotion", required: true }],
  complaint: [{ kind: "note", required: true }],
  "follow-up": [{ kind: "note", required: true }],
};
/** @param {any} db @param {number} at */
export async function rulesAt(db, at) {
  const rows =
    await db`select r.*, coalesce((select jsonb_agg(jsonb_build_object('kind', a.kind, 'required', a.required) order by a.ordinal)
    from visit_activity_rule_activities a where a.visit_activity_rule_id=r.id and a.deleted_at is null), '[]'::jsonb) as activities
    from visit_activity_rules r where organization_id=${ORGANIZATION} and deleted_at is null
    and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`;
  return INTENTS.map((intent) => {
    const row = rows.find((/** @type {any} */ r) => r.intent === intent);
    return {
      intent,
      version: row ? `rule:${row.id}` : DEFAULT_VERSION,
      activities:
        row?.activities ??
        DEFAULTS[/** @type {keyof typeof DEFAULTS} */ (intent)],
      sourceRef:
        row?.source_ref ??
        "Provisional defaults; memo 2026-01-20 and client call 2 Oct 2026",
      provisional: row?.provisional ?? true,
    };
  });
}
/** FIELD SYNC imports this projection; it does not register a competing field.bundle. @param {any} db @param {number} at */
export async function phoneRules(db, at) {
  return (await rulesAt(db, at)).map(({ intent, version, activities }) => ({
    intent,
    version,
    activities,
  }));
}
/** @param {any[]} rules @param {string[]} intents @param {string[]} recorded */
export function missingKinds(rules, intents, recorded) {
  return [
    ...new Set(
      rules
        .filter((r) => intents.includes(r.intent))
        .flatMap((r) =>
          r.activities
            .filter((/** @type {any} */ a) => a.required)
            .map((/** @type {any} */ a) => a.kind),
        ),
    ),
  ].filter((kind) => !recorded.includes(kind));
}
/** Caller wraps transaction and national master-data authorization. @param {any} ctx */
export async function setRule(ctx) {
  const p = ctx.body;
  if (
    !INTENTS.includes(p.intent) ||
    !Number.isSafeInteger(p.effectiveFrom) ||
    p.effectiveFrom <= ctx.now ||
    typeof p.provisional !== "boolean" ||
    !Array.isArray(p.activities) ||
    p.activities.length > ACTIVITY_KINDS.length ||
    new Set(p.activities.map((/** @type {any} */ a) => a.kind)).size !==
      p.activities.length ||
    p.activities.some(
      (/** @type {any} */ a) =>
        !ACTIVITY_KINDS.includes(a.kind) || typeof a.required !== "boolean",
    )
  )
    throw invalid();
  const source = text(p.sourceRef);
  await ctx.db`select pg_advisory_xact_lock(hashtext(${`visit-rule:${p.intent}`}))`;
  const future =
    await ctx.db`select 1 from visit_activity_rules where organization_id=${ORGANIZATION} and intent=${p.intent} and effective_from>=${new Date(p.effectiveFrom)} and deleted_at is null`;
  if (future.length) throw invalid("A later rule is already scheduled");
  await ctx.db`update visit_activity_rules set effective_to=${new Date(p.effectiveFrom)} where organization_id=${ORGANIZATION} and intent=${p.intent}
    and effective_from<${new Date(p.effectiveFrom)} and (effective_to is null or effective_to>${new Date(p.effectiveFrom)}) and deleted_at is null`;
  const [row] =
    await ctx.db`insert into visit_activity_rules (organization_id, intent, effective_from, source_ref, provisional, actor_subject)
    values (${ORGANIZATION}, ${p.intent}, ${new Date(p.effectiveFrom)}, ${source}, ${p.provisional}, ${ctx.actor.subject}) returning id`;
  for (const [ordinal, a] of p.activities.entries())
    await ctx.db`insert into visit_activity_rule_activities (visit_activity_rule_id, ordinal, kind, required) values (${row.id}, ${ordinal}, ${a.kind}, ${a.required})`;
  await writeAudit(ctx.db, {
    subject: ctx.actor.subject,
    action: "visit.rule.set",
    entityType: "visit_activity_rules",
    entityId: row.id,
    details: null,
  });
  await ctx.change("activityRule", row.id, "national");
  ctx.publish("visits");
  return { id: row.id };
}
