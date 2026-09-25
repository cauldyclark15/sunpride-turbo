import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { auditPlan, planState } from "./audit";
import {
  bounded,
  employeeAt,
  localDate,
  manilaDate,
  MAX_PLAN_ROWS,
  monthDates,
  planAccess,
} from "./validation";

const SOURCE = "SALES_OPS_STANDARDS_MEMO_2026-01-20.md §5";
const templateDoc = schema.doc("positionRoutineTemplates");
type Day = {
  dayKind: "selling" | "field" | "admin" | "day_off";
  name: string;
  activity: string;
};
const day = (dayKind: Day["dayKind"], name: string, activity: string): Day => ({
  dayKind,
  name,
  activity,
});
// Source §5.1–5.4; these are provisional editable data, not inferred for other positions.
const general: Day[] = [
  day("day_off", "Day-Off", ""),
  day("admin", "ADMIN Work (SFI Office)", "Reports, PDCA/WOR"),
  day("field", "AM: ADP, PM Field Work", "Pre-Take Off Meeting, Coaching"),
  day("field", "Field Work (End to End)", "DSP Coaching"),
  day("field", "Field Work (End to End)", "Field Validation and Evaluation"),
  day(
    "field",
    "Field Work (End to End)",
    "Territory Expansion — Spotting Opportunity",
  ),
  day(
    "admin",
    "ADMIN Work (ADP Office)",
    "Reports (STT, UBA, PC), ADP Inventory, ADP DSP Meeting",
  ),
];
const managers: Day[] = [
  day("day_off", "Day Off", ""),
  day("admin", "ADMIN Work (SFI Office)", "Reports, PDCA/WOR"),
  day(
    "field",
    "Field Work and Trade Audit and Meetings",
    "Field Validation and Evaluation and Meetings",
  ),
  day(
    "field",
    "Field Work and Trade Audit and Meetings",
    "Field Validation and Evaluation and Meetings",
  ),
  day("field", "Field Work (End to End)", "KAS Coaching"),
  day("field", "Field Work (End to End)", "KAS Coaching"),
  day(
    "field",
    "PDCA and Field Audit Work",
    "Meeting and Updates Internal with KAS and Booking",
  ),
];
const sellers: Day[] = [
  day("day_off", "Day-Off", ""),
  day("admin", "ADMIN Work (SFI Office)", "Reports and Updates Office"),
  ...Array.from({ length: 4 }, () =>
    day(
      "selling",
      "Selling Activity",
      "Selling, Merchandising, Countering, and Program Execution. (Consultation as agreed with Buyers)",
    ),
  ),
  day("field", "PDCA Internal to CDM and Collection", "Meeting and Collection"),
];
const senior: Day[] = [
  day("day_off", "Day-Off", ""),
  day("admin", "ADMIN Work (SFI Office)", "Reports, PDCA/WOR"),
  day("admin", "ADMIN Work", "SFI Inventory, Delivery, Accounting, HR, Fleet"),
  day("field", "Field Work (ADP)", "Coaching and Trade Development"),
  day(
    "field",
    "Field Work (ADP)",
    "Territory Expansion — Spotting Opportunity",
  ),
  day("admin", "ADMIN Work (ADP Office)", "Business Review, Meeting"),
  day("admin", "ADMIN Work (SFI Office)", "Reports, Meeting"),
];
const patterns: Record<string, Day[]> = {
  RS: general,
  ADP_PERSONNEL: general,
  DS: general,
  CDM_GT: managers,
  CDM_KA: managers,
  KAS: sellers,
  BOOKING: sellers,
  SCDM: senior,
};
/** Operator-only idempotent initial seed; cannot invent an individual plan audit row. */
export const seedProvisional = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    // Internal CLI/operator path, not exposed to clients. Existing versions are not overwritten.
    const positions = await bounded(
      ctx.db
        .query("positions")
        .withIndex("by_organizationId_and_active", (q) =>
          q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("active", true),
        )
        .take(MAX_PLAN_ROWS + 1),
      "Positions",
    );
    let count = 0;
    for (const position of positions) {
      const pattern = patterns[position.code];
      if (!pattern) continue;
      const existing = await templates(ctx, position._id);
      for (let weekday = 0; weekday < pattern.length; weekday++) {
        if (
          existing.some(
            (row) => row.weekday === weekday && row.sourceRef === SOURCE,
          )
        )
          continue;
        const item = pattern[weekday]!;
        await ctx.db.insert("positionRoutineTemplates", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          positionId: position._id,
          effectiveFrom: Date.UTC(2026, 1, 1) - 8 * 3600000,
          weekday: weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6,
          dayKind: item.dayKind,
          activities: [
            { sequence: 1, name: item.name, kind: "non_visit" },
            ...(item.activity
              ? [
                  {
                    sequence: 2,
                    name: item.activity,
                    kind: "non_visit" as const,
                  },
                ]
              : []),
          ],
          sourceRef: SOURCE,
          provisional: true,
          actorSubject: "internal:memo-seed",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        count++;
      }
    }
    return count;
  },
});
async function templates(ctx: QueryCtx | MutationCtx, id: Id<"positions">) {
  return bounded(
    ctx.db
      .query("positionRoutineTemplates")
      .withIndex("by_positionId_and_effectiveFrom", (q) =>
        q.eq("positionId", id),
      )
      .take(MAX_PLAN_ROWS + 1),
    "Position routine history",
  );
}
async function forPlan(
  ctx: QueryCtx | MutationCtx,
  planId: Id<"coveragePlans">,
) {
  const plan = await ctx.db.get(planId);
  if (!plan) throw new ConvexError("Plan not found");
  await planAccess(ctx, plan, "mcp.read");
  // The position and its templates must be read at the same first live instant.
  const effectiveInstant = Math.max(plan.effectiveFrom, Date.now());
  const assignment = await employeeAt(
    ctx,
    plan.assigneeProfileId,
    effectiveInstant,
  );
  const rows = assignment.positionId
    ? await templates(ctx, assignment.positionId)
    : [];
  const active = rows.filter(
    (row) =>
      row.effectiveFrom <= effectiveInstant &&
      (row.effectiveTo === undefined || row.effectiveTo > effectiveInstant),
  );
  if (new Set(active.map((row) => row.weekday)).size !== active.length)
    throw new ConvexError("Overlapping routine templates");
  return {
    plan,
    rows: active,
    warning: active.length
      ? null
      : "No weekly routine for position; no routine inferred",
  };
}
export const listForPosition = query({
  args: { planId: v.id("coveragePlans") },
  returns: v.object({
    templates: v.array(templateDoc),
    warning: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { planId }) => {
    const { rows, warning } = await forPlan(ctx, planId);
    return { templates: rows, warning };
  },
});
export const applyToDraft = mutation({
  args: { planId: v.id("coveragePlans") },
  returns: v.object({
    created: v.number(),
    warning: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { planId }) => {
    const { plan, rows, warning } = await forPlan(ctx, planId);
    const access = await planAccess(ctx, plan, "mcp.plan");
    if (plan.status !== "draft")
      throw new ConvexError("Only draft plans can change");
    const existing = await bounded(
      ctx.db
        .query("coveragePlanSlots")
        .withIndex("by_planId_and_serviceDate", (q) => q.eq("planId", planId))
        .take(MAX_PLAN_ROWS + 1),
      "Plan slots",
    );
    for (const slot of existing.filter((s) => s.slotKey.startsWith("routine:")))
      await ctx.db.delete(slot._id);
    let created = 0;
    for (const date of monthDates(plan.localMonth)) {
      if (
        localDate(date) < plan.effectiveFrom ||
        localDate(date) < localDate(manilaDate(Date.now())) ||
        localDate(date) >= plan.effectiveTo
      )
        continue;
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      const row = rows.find((r) => r.weekday === weekday);
      if (!row) continue;
      for (const activity of row.activities) {
        if (existing.length + created >= MAX_PLAN_ROWS)
          throw new ConvexError("Routine exceeds slot limit");
        await ctx.db.insert("coveragePlanSlots", {
          slotKey: `routine:${date}:${activity.sequence}`,
          planId,
          assigneeProfileId: plan.assigneeProfileId,
          serviceDate: date,
          kind: "non_visit",
          activityKind: row.dayKind === "day_off" ? "day_off" : activity.name,
          requiredObjectives: [],
          intents: [],
          sequence: activity.sequence,
          expectedDurationMinutes: 0,
          contentRevision: plan.contentRevision + 1,
          updatedBy: access.identity.tokenIdentifier,
          updatedAt: Date.now(),
        });
        created++;
      }
    }
    await ctx.db.patch(planId, {
      contentRevision: plan.contentRevision + 1,
      updatedBy: access.identity.tokenIdentifier,
      updatedAt: Date.now(),
    });
    await auditPlan(
      ctx,
      plan,
      access.identity.tokenIdentifier,
      "routine.applied",
      planState(plan),
      {
        ...planState(plan),
        contentRevision: plan.contentRevision + 1,
        routineSlots: created,
      },
    );
    return { created, warning };
  },
});
