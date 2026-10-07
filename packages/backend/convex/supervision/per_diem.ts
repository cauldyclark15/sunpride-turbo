import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { capabilityRoles, requireCapability } from "../lib/capabilities";
import type { AppRole } from "../lib/roles";
import {
  actorNames,
  evidenceDecision,
  supervisorContext,
  teamMembers,
  type SupervisorContext,
  type TeamMember,
} from "./access";
import {
  requiredKinds,
  ruleHistories,
  rulesFromHistories,
} from "../visits/activity_rules";
import { MAX_VISIT_ACTIVITIES } from "../visits/commands";
import { dayCloseAt } from "./model";
import {
  claimPeriod,
  classifyVisit,
  MAX_NOTE,
  MAX_PERIOD_ROWS,
  missingForms,
  PER_DIEM_RULE_VERSION,
  perDiemNote,
  perDiemReason,
  perDiemStatus,
  periodHash,
  summarizePeriod,
  type LocationFact,
  type PerDiemNote,
  type PerDiemReason,
} from "./per_diem_model";

/**
 * SOP-004 per-diem validation against the approved MCP. Supervisors (`people.read` +
 * `visit.read`) see one field person's claim period: every call checked against the signed
 * MCP and its reports, with the exceptions listed. A holder of `mcp.approve` for the
 * person's unit (the people who approve the MCP) validates or returns the period; the
 * decision freezes the counts and a hash of what was shown. No amount is computed: the
 * rate is set per position outside the system (call answer, 2 Oct 2026).
 */

type Ctx = QueryCtx | MutationCtx;

const periodArgs = {
  from: v.string(),
  to: v.string(),
  orgUnitId: v.optional(v.id("orgUnits")),
  channel: v.optional(v.string()),
  directOnly: v.optional(v.boolean()),
};

const nullableNumber = v.union(v.number(), v.null());
const decisionKind = v.union(v.literal("validated"), v.literal("returned"));

const item = v.object({
  id: v.string(),
  kind: v.union(v.literal("visit"), v.literal("not_visited")),
  serviceDate: v.string(),
  visitId: v.union(v.id("visitExecutions"), v.null()),
  outletCode: v.string(),
  outletName: v.string(),
  sequence: nullableNumber,
  status: perDiemStatus,
  reasons: v.array(perDiemReason),
  notes: v.array(perDiemNote),
  checkedInAt: nullableNumber,
  productivity: v.union(v.string(), v.null()),
  /** Required forms for the call's purpose that are not recorded. */
  missingForms: v.array(v.string()),
});
type Item = typeof item.type;

const totals = v.object({
  plannedStops: v.number(),
  validCalls: v.number(),
  heldCalls: v.number(),
  invalidCalls: v.number(),
  notVisited: v.number(),
  validDays: v.number(),
  heldDays: v.number(),
});

const decisionRow = v.object({
  id: v.id("perDiemValidations"),
  decision: decisionKind,
  note: v.union(v.string(), v.null()),
  deciderName: v.string(),
  decidedAt: v.number(),
  validCalls: v.number(),
  validDays: v.number(),
  ruleVersion: v.string(),
  /** The calls changed after this decision (late review, new visit, rule change). */
  stale: v.boolean(),
});

function filtersOf(args: {
  from: string;
  orgUnitId?: Id<"orgUnits">;
  channel?: string;
  directOnly?: boolean;
}) {
  return {
    serviceDate: args.from,
    ...(args.orgUnitId ? { orgUnitId: args.orgUnitId } : {}),
    ...(args.channel ? { channel: args.channel } : {}),
    ...(args.directOnly ? { directOnly: args.directOnly } : {}),
  };
}

async function decisionsFor(
  ctx: Ctx,
  profileId: Id<"profiles">,
  localMonth: string,
  from: string,
  to: string,
) {
  return (
    await ctx.db
      .query("perDiemValidations")
      .withIndex("by_profileId_and_localMonth", (q) =>
        q.eq("profileId", profileId).eq("localMonth", localMonth),
      )
      .order("desc")
      .take(50)
  ).filter((row) => row.periodFrom === from && row.periodTo === to);
}

/** Activity rows one validation may read before it refuses (Convex read budget). */
const MAX_PERIOD_ACTIVITY_READS = 16_000;

/**
 * The validation itself: planned stops and visits for the period, each visit classified
 * against its signed planned stop, location evidence, late-sync review and call reports.
 */
async function computeValidation(
  ctx: Ctx,
  sc: SupervisorContext,
  member: TeamMember,
  from: string,
  to: string,
  now: number,
) {
  const { dates } = claimPeriod(from, to);
  const profileId = member.profile._id;
  const plannedRows = await ctx.db
    .query("plannedVisits")
    .withIndex("by_assigneeProfileId_and_serviceDate", (q) =>
      q
        .eq("assigneeProfileId", profileId)
        .gte("serviceDate", from)
        .lte("serviceDate", to),
    )
    .take(MAX_PERIOD_ROWS + 1);
  const visitRows = await ctx.db
    .query("visitExecutions")
    .withIndex("by_organizationId_and_assigneeProfileId_and_serviceDate", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("assigneeProfileId", profileId)
        .gte("serviceDate", from)
        .lte("serviceDate", to),
    )
    .take(MAX_PERIOD_ROWS + 1);
  const truncated =
    plannedRows.length > MAX_PERIOD_ROWS || visitRows.length > MAX_PERIOD_ROWS;
  const planned = plannedRows
    .slice(0, MAX_PERIOD_ROWS)
    .filter((row) => sc.scope.has(row.approvedSnapshot.orgUnitId));
  const visits = visitRows
    .slice(0, MAX_PERIOD_ROWS)
    .filter((row) => sc.scope.has(row.orgUnitId));

  const plannedById = new Map<string, Doc<"plannedVisits">>(
    planned.map((row) => [row._id, row]),
  );
  const planStatus = new Map<Id<"coveragePlans">, string | null>();
  const statusOfPlan = async (planId: Id<"coveragePlans">) => {
    if (!planStatus.has(planId))
      planStatus.set(planId, (await ctx.db.get(planId))?.status ?? null);
    return planStatus.get(planId) ?? null;
  };
  const sheetRequired = new Map<Id<"outlets">, boolean>();
  const outlets = new Map<Id<"outlets">, Doc<"outlets"> | null>();
  // Governing activity-form rules (AND-013), loaded once and resolved at each call's start.
  const histories = await ruleHistories(ctx);

  const items: Item[] = [];
  let activityReads = 0;
  for (const visit of visits) {
    let link = visit.plannedVisitId
      ? (plannedById.get(visit.plannedVisitId) ?? null)
      : null;
    if (visit.plannedVisitId && !link) {
      const row = await ctx.db.get(visit.plannedVisitId);
      link =
        row &&
        row.assigneeProfileId === profileId &&
        row.serviceDate === visit.serviceDate
          ? row
          : null;
    }
    const evidence = await ctx.db
      .query("visitLocationEvidence")
      .withIndex("by_visitId_and_serverTime", (q) => q.eq("visitId", visit._id))
      .take(10);
    const location: LocationFact[] = [];
    for (const row of evidence) {
      let status: string = row.reviewStatus;
      if (row.reviewStatus === "pending_review") {
        const decided = await evidenceDecision(ctx, row._id);
        if (decided?.summary.after) status = decided.summary.after;
      }
      location.push({
        event: row.event,
        hasFix: row.latitude !== undefined && row.longitude !== undefined,
        status,
      });
    }
    // Read the visit's complete activity set (the writer caps it at MAX_VISIT_ACTIVITIES):
    // a truncated prefix would miss later forms and leave the decision fingerprint stale.
    const activities = await ctx.db
      .query("visitActivities")
      .withIndex("by_visitId_and_serverTime", (q) => q.eq("visitId", visit._id))
      .take(MAX_VISIT_ACTIVITIES + 1);
    if (activities.length > MAX_VISIT_ACTIVITIES)
      throw new ConvexError("A call has more activities than supported");
    activityReads += activities.length;
    if (activityReads > MAX_PERIOD_ACTIVITY_READS)
      throw new ConvexError(
        "Too many call records in this period. Split it in two.",
      );
    if (!sheetRequired.has(visit.outletId))
      sheetRequired.set(
        visit.outletId,
        (await ctx.db
          .query("callSheetAccounts")
          .withIndex("by_outletId", (q) => q.eq("outletId", visit.outletId))
          .first()) !== null,
      );
    const recorded = activities.map((row) => row.activity.kind as string);
    const startedAt =
      visit.startedAt ?? visit.checkedInAt ?? visit._creationTime;
    const requiredMissing = missingForms({
      outcome: visit.outcome ?? null,
      storedMissing: visit.missingActivities ?? null,
      required: requiredKinds(
        rulesFromHistories(histories, startedAt),
        visit.intents,
      ),
      recorded,
    });
    const verdict = classifyVisit({
      source: visit.source,
      state: visit.state,
      // A link to a missing stop, or one of another person or day, is not in the MCP.
      hasPlannedLink: link !== null,
      planned: link
        ? { status: link.status, planStatus: await statusOfPlan(link.planId) }
        : null,
      location,
      lateReviewStatus: visit.lateReviewStatus ?? null,
      activityCount: activities.length,
      hasCallSheet: activities.some(
        (row) => row.activity.kind === "call_sheet",
      ),
      callSheetRequired: sheetRequired.get(visit.outletId) ?? false,
      requiredMissing,
    });
    let outletCode = link?.approvedSnapshot.outletCode;
    let outletName = link?.approvedSnapshot.outletName;
    if (!outletCode || !outletName) {
      if (!outlets.has(visit.outletId))
        outlets.set(visit.outletId, await ctx.db.get(visit.outletId));
      const outlet = outlets.get(visit.outletId) ?? null;
      outletCode = outlet?.code ?? "—";
      outletName = outlet?.name ?? "Unknown outlet";
    }
    items.push({
      id: visit._id,
      kind: "visit",
      serviceDate: visit.serviceDate,
      visitId: visit._id,
      outletCode,
      outletName,
      sequence: link?.approvedSnapshot.sequence ?? null,
      status: verdict.status,
      reasons: verdict.reasons,
      notes: verdict.notes,
      checkedInAt: visit.checkedInAt ?? null,
      productivity: visit.productivity,
      missingForms: requiredMissing,
    });
  }

  const visited = new Set(visits.map((visit) => visit.plannedVisitId));
  const plannedByDate = new Map<string, number>();
  for (const row of planned) {
    if (row.status !== "planned") continue;
    plannedByDate.set(
      row.serviceDate,
      (plannedByDate.get(row.serviceDate) ?? 0) + 1,
    );
    // Only a closed day can have a missed stop; today and later are still upcoming.
    if (visited.has(row._id) || dayCloseAt(row.serviceDate) > now) continue;
    items.push({
      id: row._id,
      kind: "not_visited",
      serviceDate: row.serviceDate,
      visitId: null,
      outletCode: row.approvedSnapshot.outletCode,
      outletName: row.approvedSnapshot.outletName,
      sequence: row.approvedSnapshot.sequence ?? null,
      status: "invalid",
      reasons: ["not_visited" as PerDiemReason],
      notes: [] as PerDiemNote[],
      checkedInAt: null,
      productivity: null,
      missingForms: [] as string[],
    });
  }
  items.sort(
    (a, b) =>
      a.serviceDate.localeCompare(b.serviceDate) ||
      (a.sequence ?? 999) - (b.sequence ?? 999) ||
      (a.checkedInAt ?? 0) - (b.checkedInAt ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const summary = summarizePeriod(dates, plannedByDate, items);
  const contentHash = await periodHash([
    PER_DIEM_RULE_VERSION,
    profileId,
    from,
    to,
    ...items
      // Required-form facts are part of what was decided: recording or losing a form,
      // or a rule change, makes an earlier decision stale.
      .map(
        (row) =>
          `${row.id}|${row.status}|${row.reasons.join(",")}|${row.missingForms.join(",")}`,
      )
      .sort(),
  ]);
  return { items, truncated, contentHash, ...summary };
}

function mayDecide(sc: SupervisorContext, member: TeamMember) {
  const roles = capabilityRoles("mcp.approve") as readonly AppRole[];
  const self =
    sc.profile._id === member.profile._id ||
    sc.identity.tokenIdentifier === member.profile.authSubject;
  return (
    !self &&
    (sc.profile.role === "super_admin" ||
      roles.includes(sc.profile.role as AppRole))
  );
}

/**
 * One claim period for the team (people and their latest decision) and, when a person is
 * picked, that person's full validation with every exception listed.
 */
export const validation = query({
  args: { ...periodArgs, profileId: v.optional(v.id("profiles")) },
  returns: v.object({
    localMonth: v.string(),
    from: v.string(),
    to: v.string(),
    ruleVersion: v.string(),
    truncated: v.boolean(),
    people: v.array(
      v.object({
        profileId: v.id("profiles"),
        name: v.string(),
        employeeCode: v.union(v.string(), v.null()),
        positionLabel: v.union(v.string(), v.null()),
        channel: v.string(),
        latest: v.union(
          v.object({ decision: decisionKind, decidedAt: v.number() }),
          v.null(),
        ),
      }),
    ),
    selected: v.union(
      v.null(),
      v.object({
        profileId: v.id("profiles"),
        name: v.string(),
        positionLabel: v.union(v.string(), v.null()),
        canDecide: v.boolean(),
        truncated: v.boolean(),
        contentHash: v.string(),
        totals,
        days: v.array(
          v.object({
            serviceDate: v.string(),
            plannedStops: v.number(),
            validCalls: v.number(),
            heldCalls: v.number(),
            invalidCalls: v.number(),
            notVisited: v.number(),
            dayStatus: v.union(
              v.literal("valid"),
              v.literal("held"),
              v.literal("none"),
            ),
          }),
        ),
        items: v.array(item),
        decisions: v.array(decisionRow),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const { localMonth } = claimPeriod(args.from, args.to);
    const filters = filtersOf(args);
    const sc = await supervisorContext(ctx, filters);
    const { members, truncated } = await teamMembers(ctx, sc, filters);
    const people = [];
    for (const member of members) {
      const latest = (
        await decisionsFor(
          ctx,
          member.profile._id,
          localMonth,
          args.from,
          args.to,
        )
      )[0];
      people.push({
        profileId: member.profile._id,
        name: member.profile.name,
        employeeCode: member.profile.employeeCode ?? null,
        positionLabel: member.positionLabel,
        channel: member.channel,
        latest: latest
          ? { decision: latest.decision, decidedAt: latest.decidedAt }
          : null,
      });
    }
    let selected = null;
    if (args.profileId) {
      const member = members.find((row) => row.profile._id === args.profileId);
      if (!member)
        throw new ConvexError("This person is outside your current view");
      const result = await computeValidation(
        ctx,
        sc,
        member,
        args.from,
        args.to,
        Date.now(),
      );
      const nameOf = actorNames(ctx);
      const decisions = [];
      for (const row of (
        await decisionsFor(
          ctx,
          member.profile._id,
          localMonth,
          args.from,
          args.to,
        )
      ).slice(0, 20))
        decisions.push({
          id: row._id,
          decision: row.decision,
          note: row.note ?? null,
          deciderName: await nameOf(row.decidedBy),
          decidedAt: row.decidedAt,
          validCalls: row.validCalls,
          validDays: row.validDays,
          ruleVersion: row.ruleVersion,
          stale: row.contentHash !== result.contentHash,
        });
      selected = {
        profileId: member.profile._id,
        name: member.profile.name,
        positionLabel: member.positionLabel,
        canDecide: mayDecide(sc, member),
        truncated: result.truncated,
        contentHash: result.contentHash,
        totals: result.totals,
        days: result.days,
        items: result.items,
        decisions,
      };
    }
    return {
      localMonth,
      from: args.from,
      to: args.to,
      ruleVersion: PER_DIEM_RULE_VERSION,
      truncated,
      people,
      selected,
    };
  },
});

/**
 * The supervisor's decision on one person's claim period. `validated` needs every held call
 * decided first; `returned` needs a note. The decision must match what the supervisor saw:
 * a changed validation (new visit, late review, rule change) is refused as stale.
 */
export const decide = mutation({
  args: {
    profileId: v.id("profiles"),
    from: v.string(),
    to: v.string(),
    decision: decisionKind,
    note: v.optional(v.string()),
    contentHash: v.string(),
  },
  returns: v.id("perDiemValidations"),
  handler: async (ctx, args) => {
    const { localMonth } = claimPeriod(args.from, args.to);
    const { identity, profile } = await requireCapability(ctx, "mcp.approve");
    const filters = { serviceDate: args.from };
    const sc = await supervisorContext(ctx, filters);
    const { members } = await teamMembers(ctx, sc, filters);
    const member = members.find((row) => row.profile._id === args.profileId);
    if (!member) throw new ConvexError("This person is outside your scope");
    if (!mayDecide(sc, member)) throw new ConvexError("self_approval_denied");
    await requireCapability(ctx, "mcp.approve", member.assignment.orgUnitId!);
    const note = args.note?.trim() ?? "";
    if (note.length > MAX_NOTE) throw new ConvexError("Note is too long");
    if (args.decision === "returned" && !note)
      throw new ConvexError("Say why the claim is returned");
    const now = Date.now();
    const result = await computeValidation(
      ctx,
      sc,
      member,
      args.from,
      args.to,
      now,
    );
    if (result.truncated)
      throw new ConvexError("Too many calls in this period. Split it in two.");
    if (result.contentHash !== args.contentHash)
      throw new ConvexError("stale_validation");
    if (args.decision === "validated" && result.totals.heldCalls > 0)
      throw new ConvexError("Decide the held calls before validating");
    const id = await ctx.db.insert("perDiemValidations", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      profileId: member.profile._id,
      orgUnitId: member.assignment.orgUnitId!,
      localMonth,
      periodFrom: args.from,
      periodTo: args.to,
      decision: args.decision,
      ...(note ? { note } : {}),
      contentHash: result.contentHash,
      ruleVersion: PER_DIEM_RULE_VERSION,
      plannedStops: result.totals.plannedStops,
      validCalls: result.totals.validCalls,
      invalidCalls: result.totals.invalidCalls,
      notVisited: result.totals.notVisited,
      validDays: result.totals.validDays,
      validDates: result.days
        .filter((day) => day.dayStatus === "valid")
        .map((day) => day.serviceDate),
      decidedBy: identity.tokenIdentifier,
      deciderProfileId: profile._id,
      decidedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: `perDiem.${args.decision}`,
      entityType: "perDiemValidations",
      entityId: id,
      details: `${args.from}..${args.to} valid ${result.totals.validCalls} calls / ${result.totals.validDays} days`,
      createdAt: now,
    });
    return id;
  },
});
