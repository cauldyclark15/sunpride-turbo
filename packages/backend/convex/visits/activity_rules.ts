import { ConvexError, v } from "convex/values";
import type { Infer } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { capabilityRoles, requireCapability } from "../lib/capabilities";
import { requireNationalScope } from "../lib/scope";
import { prospective } from "../org/validation";

/**
 * AND-013: which structured activity forms a visit needs, by visit intent (the visit's
 * objectives). Rules are backend data, delivered to the field phones in the bootstrap, so
 * the office changes them without an app release.
 *
 * Enforcement is deliberately split. The phone refuses a "completed" End until each
 * required form it can capture is recorded (it may still end "not productive" with a
 * reason). The server never refuses a queued End — an offline phone must not get stuck —
 * but on End it re-evaluates the rules in effect when the call started and records any
 * missing required activity on the visit for supervisor review.
 */
export const VISIT_INTENTS = [
  "sell",
  "collect",
  "merchandise",
  "audit",
  "deliver",
  "promotion",
  "complaint",
  "follow-up",
] as const;
export type VisitIntent = (typeof VISIT_INTENTS)[number];
export const visitIntentValidator = v.union(...VISIT_INTENTS.map(v.literal));

/** Activity kinds of the v1 `visit.activity` wire that a rule may require. */
export const RULE_ACTIVITY_KINDS = [
  "call_sheet",
  "merchandising",
  "inventory_check",
  "price_check",
  "promotion",
  "order_intent",
  "note",
] as const;
export type RuleActivityKind = (typeof RULE_ACTIVITY_KINDS)[number];
export const ruleActivityValidator = v.object({
  kind: v.union(...RULE_ACTIVITY_KINDS.map(v.literal)),
  required: v.boolean(),
});
export type RuleActivity = Infer<typeof ruleActivityValidator>;

/** One intent's rule on the phone wire (`bootstrap.activityRules[]`). */
export const activityRuleDTO = v.object({
  intent: v.string(),
  version: v.string(),
  activities: v.array(v.object({ kind: v.string(), required: v.boolean() })),
});
export type ActivityRule = Infer<typeof activityRuleDTO>;

export const DEFAULT_ACTIVITY_RULE_VERSION = "visit-activities/2026-10-04";
export const DEFAULT_ACTIVITY_RULE_SOURCE =
  "Provisional: memo 2026-01-20 §I execution standards + client call 2 Oct 2026 answer 2 (productive per visit objective)";
/**
 * Provisional defaults until Sunpride confirms a per-intent list. An intent with no table
 * row uses these. Collection and order capture have no phone form yet (collection.record
 * is unsupported and order capture is off), so they require nothing here.
 */
export const DEFAULT_ACTIVITY_RULES: Record<VisitIntent, RuleActivity[]> = {
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

const MAX_RULE_HISTORY = 50;
const MAX_RULE_ACTIVITIES = RULE_ACTIVITY_KINDS.length;

function activeRow(rows: Doc<"visitActivityRules">[], instant: number) {
  return (
    rows.find(
      (row) =>
        row.effectiveFrom <= instant &&
        (row.effectiveTo === undefined || row.effectiveTo > instant),
    ) ?? null
  );
}

async function history(ctx: QueryCtx | MutationCtx, intent: VisitIntent) {
  return ctx.db
    .query("visitActivityRules")
    .withIndex("by_organizationId_and_intent_and_effectiveFrom", (q) =>
      q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("intent", intent),
    )
    .order("desc")
    .take(MAX_RULE_HISTORY);
}

/** Every intent's rule in effect at `instant`: the table row, else the provisional default. */
export async function rulesAt(
  ctx: QueryCtx | MutationCtx,
  instant: number,
): Promise<Array<ActivityRule & { sourceRef: string; provisional: boolean }>> {
  const rules = [];
  for (const intent of VISIT_INTENTS) {
    const row = activeRow(await history(ctx, intent), instant);
    rules.push(
      row
        ? {
            intent,
            version: `rule:${row._id}`,
            activities: row.activities,
            sourceRef: row.sourceRef,
            provisional: row.provisional,
          }
        : {
            intent,
            version: DEFAULT_ACTIVITY_RULE_VERSION,
            activities: DEFAULT_ACTIVITY_RULES[intent],
            sourceRef: DEFAULT_ACTIVITY_RULE_SOURCE,
            provisional: true,
          },
    );
  }
  return rules;
}

/** Phone wire projection: only what the form engine needs. */
export function phoneRules(rules: ActivityRule[]): ActivityRule[] {
  return rules.map(({ intent, version, activities }) => ({
    intent,
    version,
    activities: activities.map(({ kind, required }) => ({ kind, required })),
  }));
}

/** Required activity kinds for a visit's intents (union, stable rule order). Pure. */
export function requiredKinds(
  rules: ActivityRule[],
  intents: readonly string[],
): string[] {
  const kinds: string[] = [];
  for (const rule of rules)
    if (intents.includes(rule.intent))
      for (const activity of rule.activities)
        if (activity.required && !kinds.includes(activity.kind))
          kinds.push(activity.kind);
  return kinds;
}

/** Required kinds not yet recorded at the visit. Pure. */
export function missingKinds(
  rules: ActivityRule[],
  intents: readonly string[],
  recorded: readonly string[],
): string[] {
  return requiredKinds(rules, intents).filter((k) => !recorded.includes(k));
}

/** Which rule versions governed a visit, for the audit trail. Pure. */
export function ruleVersionFor(
  rules: ActivityRule[],
  intents: readonly string[],
) {
  return rules
    .filter((rule) => intents.includes(rule.intent))
    .map((rule) => `${rule.intent}=${rule.version}`)
    .join(",");
}

const ruleRow = v.object({
  intent: v.string(),
  version: v.string(),
  activities: v.array(ruleActivityValidator),
  sourceRef: v.string(),
  provisional: v.boolean(),
});

/** Rules in effect (now, or `asOf`) for every intent. Anyone who can read coverage plans. */
export const current = query({
  args: { asOf: v.optional(v.number()) },
  returns: v.array(ruleRow),
  handler: async (ctx, { asOf }) => {
    await requireCapability(ctx, "mcp.read");
    if (asOf !== undefined && !Number.isSafeInteger(asOf))
      throw new ConvexError("invalid_request");
    return (await rulesAt(ctx, asOf ?? Date.now())).map((rule) => ({
      ...rule,
      activities: rule.activities as RuleActivity[],
    }));
  },
});

/**
 * Office change to one intent's rule, national master data. Future-effective only; the
 * open prior row is closed at the new start and history is never rewritten.
 */
export const set = mutation({
  args: {
    intent: visitIntentValidator,
    activities: v.array(ruleActivityValidator),
    effectiveFrom: v.number(),
    sourceRef: v.string(),
    provisional: v.boolean(),
  },
  returns: v.id("visitActivityRules"),
  handler: async (ctx, args) => {
    const { identity } = await requireNationalScope(
      ctx,
      capabilityRoles("masterdata.manage"),
    );
    prospective(args.effectiveFrom);
    const sourceRef = args.sourceRef.trim();
    if (!sourceRef || sourceRef.length > 200)
      throw new ConvexError("invalid_request");
    const kinds = args.activities.map((a) => a.kind);
    if (
      kinds.length > MAX_RULE_ACTIVITIES ||
      new Set(kinds).size !== kinds.length
    )
      throw new ConvexError("invalid_request");
    const rows = await history(ctx, args.intent);
    if (rows.length >= MAX_RULE_HISTORY)
      throw new ConvexError("invalid_request");
    // A later scheduled row would make this change ambiguous; supersede it explicitly.
    if (rows.some((row) => row.effectiveFrom >= args.effectiveFrom))
      throw new ConvexError("conflict");
    const open = activeRow(rows, args.effectiveFrom);
    if (open) await ctx.db.patch(open._id, { effectiveTo: args.effectiveFrom });
    const now = Date.now();
    return ctx.db.insert("visitActivityRules", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      intent: args.intent,
      activities: args.activities,
      effectiveFrom: args.effectiveFrom,
      sourceRef,
      provisional: args.provisional,
      actorSubject: identity.tokenIdentifier,
      createdAt: now,
    });
  },
});
