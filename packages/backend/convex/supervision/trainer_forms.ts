import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import schema from "../schema";
import { manilaDate } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { capabilityRoles, requireCapability } from "../lib/capabilities";
import type { AppRole } from "../lib/roles";
import { collectScopeUnitIds } from "../lib/scope";
import { topology } from "../org/validation";
import {
  FORM_GAP_LABELS,
  formGaps,
  isIsoDate,
  JOB_EVALUATION_ITEMS,
  jobEvaluationContent,
  MAX_FORM_SHORT_TEXT,
  MAX_FORM_TEXT,
  MAX_OBJECTIVES,
  emptyContent,
  trainerFormKind,
  trainingProgramContent,
  trainingSheetContent,
  type FormContent,
  type JobEvaluationContent,
  type TrainingProgramContent,
  type TrainingSheetContent,
} from "./trainer_forms_model";

/**
 * SOP-010 trainer forms (memo annexes D, F, G) on top of SOP-005 Work-With sessions.
 *
 * - The session's trainer (`visit.record`, trainee's unit in scope) creates, edits, signs
 *   or discards the forms of that session. Signing needs a completed session and a full
 *   form, and freezes it.
 * - The session's trainee acknowledges a signed form (the trainee's signature), with an
 *   optional comment. Nobody else can acknowledge for them.
 * - Supervisors (`people.read` + `visit.read` over the session's unit) read them.
 */

type Ctx = QueryCtx | MutationCtx;
type Form = Doc<"trainerForms">;
const MAX_LIST = 100;
const MAX_PERIOD_SESSIONS = 100;

function text(value: string, label: string, max = MAX_FORM_TEXT) {
  if (value.length > max) throw new ConvexError(`${label} is too long`);
  return value.trim();
}

/** Who the caller is and whether they may read a given form. */
async function reader(ctx: Ctx) {
  const { identity, profile } = await requireCapability(ctx, "visit.read");
  const has = (capability: "people.read" | "visit.read") =>
    profile.role === "super_admin" ||
    (capabilityRoles(capability) as readonly AppRole[]).includes(
      profile.role as AppRole,
    );
  let scope: Set<Id<"orgUnits">> | null = null;
  const supervises = async (unitId: Id<"orgUnits">) => {
    if (!has("people.read") || !has("visit.read")) return false;
    if (!scope)
      scope = new Set(
        profile.role === "super_admin" || profile.role === "analyst"
          ? (await topology(ctx, Date.now())).map((unit) => unit._id)
          : profile.orgUnitId
            ? await collectScopeUnitIds(ctx, profile.orgUnitId)
            : [],
      );
    return scope.has(unitId);
  };
  const canRead = async (row: {
    trainerProfileId: Id<"profiles">;
    traineeProfileId: Id<"profiles">;
    orgUnitId: Id<"orgUnits">;
  }) =>
    row.trainerProfileId === profile._id ||
    row.traineeProfileId === profile._id ||
    (await supervises(row.orgUnitId));
  return { identity, profile, canRead, supervises };
}

/** The caller is the form's trainer, still holds `visit.record` over its unit. */
async function trainerForm(ctx: MutationCtx, formId: Id<"trainerForms">) {
  const { identity, profile } = await requireCapability(ctx, "visit.record");
  const form = await ctx.db.get(formId);
  if (!form || form.trainerProfileId !== profile._id)
    throw new ConvexError("Trainer form not found");
  await requireCapability(ctx, "visit.record", form.orgUnitId);
  return { identity, profile, form };
}

function cleanProgram(input: TrainingProgramContent): TrainingProgramContent {
  if (input.objectives.length > MAX_OBJECTIVES)
    throw new ConvexError(
      `A training block has at most ${MAX_OBJECTIVES} objectives`,
    );
  return {
    area: text(input.area, "Area", MAX_FORM_SHORT_TEXT),
    objectives: input.objectives
      .map((row) => text(row, "Training objective"))
      .filter(Boolean),
    strengths: text(input.strengths, "Strengths"),
    improvementAreas: text(input.improvementAreas, "Areas needing improvement"),
    plansForNextContact: text(
      input.plansForNextContact,
      "Training plans for next contact",
    ),
  };
}

function cleanSheet(input: TrainingSheetContent): TrainingSheetContent {
  return {
    objective: text(input.objective, "Objective"),
    result: text(input.result, "Result"),
    learnings: text(input.learnings, "Learnings"),
    nextSteps: text(input.nextSteps, "Next steps"),
  };
}

function cleanEvaluation(input: JobEvaluationContent): JobEvaluationContent {
  if (!isIsoDate(input.periodStart) || !isIsoDate(input.periodEnd))
    throw new ConvexError("Invalid training period");
  const seen = new Set<string>();
  for (const row of input.ratings) {
    if (!JOB_EVALUATION_ITEMS.has(row.item))
      throw new ConvexError("Unknown job evaluation item");
    if (seen.has(row.item))
      throw new ConvexError("Each item is rated only once");
    seen.add(row.item);
  }
  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    district: text(input.district, "District", MAX_FORM_SHORT_TEXT),
    area: text(input.area, "Area", MAX_FORM_SHORT_TEXT),
    ratings: input.ratings.map((row) => ({
      item: row.item,
      rating: row.rating,
    })),
    ...(input.overall !== undefined ? { overall: input.overall } : {}),
    remarks: text(input.remarks, "Remarks"),
  };
}

function content(form: Form): FormContent {
  return {
    ...(form.program ? { program: form.program } : {}),
    ...(form.sheet ? { sheet: form.sheet } : {}),
    ...(form.evaluation ? { evaluation: form.evaluation } : {}),
  };
}

/** Start a form of one kind for a Work-With session the caller trains. */
export const create = mutation({
  args: { sessionId: v.id("workWithSessions"), kind: trainerFormKind },
  returns: v.id("trainerForms"),
  handler: async (ctx, args) => {
    const { identity, profile } = await requireCapability(ctx, "visit.record");
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.trainerProfileId !== profile._id)
      throw new ConvexError("Work-With session not found");
    await requireCapability(ctx, "visit.record", session.orgUnitId);
    if (session.status === "cancelled")
      throw new ConvexError("This Work-With session was cancelled");
    const existing = await ctx.db
      .query("trainerForms")
      .withIndex("by_sessionId_and_kind", (q) =>
        q.eq("sessionId", session._id).eq("kind", args.kind),
      )
      .first();
    if (existing) throw new ConvexError("This session already has that form");
    const now = Date.now();
    return await ctx.db.insert("trainerForms", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      kind: args.kind,
      sessionId: session._id,
      trainerProfileId: session.trainerProfileId,
      traineeProfileId: session.traineeProfileId,
      orgUnitId: session.orgUnitId,
      serviceDate: session.serviceDate,
      status: "draft",
      ...emptyContent(args.kind, session.serviceDate),
      createdBy: identity.tokenIdentifier,
      createdAt: now,
      updatedBy: identity.tokenIdentifier,
      updatedAt: now,
    });
  },
});

/** Save a draft. Pass the content matching the form's kind. */
export const update = mutation({
  args: {
    formId: v.id("trainerForms"),
    program: v.optional(trainingProgramContent),
    sheet: v.optional(trainingSheetContent),
    evaluation: v.optional(jobEvaluationContent),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity, form } = await trainerForm(ctx, args.formId);
    if (form.status !== "draft")
      throw new ConvexError("A signed form cannot be changed");
    const patch: Partial<Form> = {};
    const wrong = () => {
      throw new ConvexError("That content does not belong to this form");
    };
    if (args.program !== undefined) {
      if (form.kind !== "training_program") wrong();
      patch.program = cleanProgram(args.program);
    }
    if (args.sheet !== undefined) {
      if (form.kind !== "training_sheet") wrong();
      patch.sheet = cleanSheet(args.sheet);
    }
    if (args.evaluation !== undefined) {
      if (form.kind !== "job_evaluation") wrong();
      patch.evaluation = cleanEvaluation(args.evaluation);
    }
    await ctx.db.patch(form._id, {
      ...patch,
      updatedBy: identity.tokenIdentifier,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * The trainer's signature. Needs the Work-With completed and every field the annex asks
 * for; the job evaluation freezes its dates (the completed sessions in the period).
 */
export const sign = mutation({
  args: { formId: v.id("trainerForms") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity, form } = await trainerForm(ctx, args.formId);
    if (form.status !== "draft")
      throw new ConvexError("This form is already signed");
    const session = await ctx.db.get(form.sessionId);
    if (!session || session.status !== "completed")
      throw new ConvexError("Complete the Work-With session before signing");
    const gaps = formGaps(form.kind, content(form), form.serviceDate);
    if (gaps.length)
      throw new ConvexError(
        `Form is not complete: ${gaps.map((gap) => FORM_GAP_LABELS[gap]).join("; ")}`,
      );
    const now = Date.now();
    const patch: Partial<Form> = {};
    if (form.kind === "job_evaluation" && form.evaluation) {
      const { periodStart, periodEnd } = form.evaluation;
      if (periodEnd > manilaDate(now))
        throw new ConvexError("The training period has not ended yet");
      patch.evaluationSessions = (
        await ctx.db
          .query("workWithSessions")
          .withIndex("by_trainerProfileId_and_serviceDate", (q) =>
            q
              .eq("trainerProfileId", form.trainerProfileId)
              .gte("serviceDate", periodStart)
              .lte("serviceDate", periodEnd),
          )
          .take(MAX_PERIOD_SESSIONS * 4)
      )
        .filter(
          (row) =>
            row.traineeProfileId === form.traineeProfileId &&
            row.status === "completed",
        )
        .slice(0, MAX_PERIOD_SESSIONS)
        .map((row) => ({ sessionId: row._id, serviceDate: row.serviceDate }));
    }
    await ctx.db.patch(form._id, {
      ...patch,
      status: "signed",
      signedAt: now,
      signedBy: identity.tokenIdentifier,
      updatedBy: identity.tokenIdentifier,
      updatedAt: now,
    });
    return null;
  },
});

/** Throw away a draft the trainer no longer wants. Signed forms stay. */
export const discard = mutation({
  args: { formId: v.id("trainerForms") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { form } = await trainerForm(ctx, args.formId);
    if (form.status !== "draft")
      throw new ConvexError("A signed form cannot be discarded");
    await ctx.db.delete(form._id);
    return null;
  },
});

/** The trainee's acknowledgement (signature) of a signed form. */
export const acknowledge = mutation({
  args: { formId: v.id("trainerForms"), comment: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity, profile } = await requireCapability(ctx, "visit.read");
    const form = await ctx.db.get(args.formId);
    if (!form || form.traineeProfileId !== profile._id)
      throw new ConvexError("Trainer form not found");
    if (form.status === "draft")
      throw new ConvexError("The trainer has not signed this form yet");
    if (form.status === "acknowledged")
      throw new ConvexError("You already acknowledged this form");
    const comment =
      args.comment === undefined ? "" : text(args.comment, "Comment");
    const now = Date.now();
    await ctx.db.patch(form._id, {
      status: "acknowledged",
      acknowledgedAt: now,
      acknowledgedBy: identity.tokenIdentifier,
      ...(comment ? { traineeComment: comment } : {}),
      updatedBy: identity.tokenIdentifier,
      updatedAt: now,
    });
    return null;
  },
});

const formRow = v.object({
  formId: v.id("trainerForms"),
  kind: trainerFormKind,
  sessionId: v.id("workWithSessions"),
  serviceDate: v.string(),
  status: v.string(),
  trainerName: v.string(),
  traineeName: v.string(),
});

async function formRows(ctx: QueryCtx, rows: Form[]) {
  const names = new Map<Id<"profiles">, string>();
  const name = async (id: Id<"profiles">) => {
    if (!names.has(id))
      names.set(id, (await ctx.db.get(id))?.name ?? "Former user");
    return names.get(id)!;
  };
  const out = [];
  for (const row of rows.sort(
    (a, b) =>
      b.serviceDate.localeCompare(a.serviceDate) || b.createdAt - a.createdAt,
  ))
    out.push({
      formId: row._id,
      kind: row.kind,
      sessionId: row.sessionId,
      serviceDate: row.serviceDate,
      status: row.status,
      trainerName: await name(row.trainerProfileId),
      traineeName: await name(row.traineeProfileId),
    });
  return out;
}

/** The forms of one Work-With session and whether the caller may add more. */
export const forSession = query({
  args: { sessionId: v.id("workWithSessions") },
  returns: v.object({
    forms: v.array(formRow),
    canCreate: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { profile, canRead } = await reader(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session || !(await canRead(session)))
      throw new ConvexError("Work-With session not found");
    const forms = await ctx.db
      .query("trainerForms")
      .withIndex("by_sessionId_and_kind", (q) => q.eq("sessionId", session._id))
      .take(10);
    return {
      forms: await formRows(ctx, forms),
      canCreate:
        session.trainerProfileId === profile._id &&
        session.status !== "cancelled" &&
        (profile.role === "super_admin" ||
          (capabilityRoles("visit.record") as readonly AppRole[]).includes(
            profile.role as AppRole,
          )),
    };
  },
});

const gapRow = v.object({ code: v.string(), label: v.string() });

/** One form with names, what is missing before signing, and the caller's actions. */
export const detail = query({
  args: { formId: v.id("trainerForms") },
  returns: v.object({
    form: schema.doc("trainerForms"),
    trainerName: v.string(),
    traineeName: v.string(),
    sessionStatus: v.string(),
    gaps: v.array(gapRow),
    canEdit: v.boolean(),
    canAcknowledge: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { profile, canRead } = await reader(ctx);
    const form = await ctx.db.get(args.formId);
    if (!form || !(await canRead(form)))
      throw new ConvexError("Trainer form not found");
    const session = await ctx.db.get(form.sessionId);
    const gaps =
      form.status === "draft"
        ? formGaps(form.kind, content(form), form.serviceDate)
        : [];
    return {
      form,
      trainerName:
        (await ctx.db.get(form.trainerProfileId))?.name ?? "Former user",
      traineeName:
        (await ctx.db.get(form.traineeProfileId))?.name ?? "Former user",
      sessionStatus: session?.status ?? "cancelled",
      gaps: gaps.map((code) => ({ code, label: FORM_GAP_LABELS[code] })),
      canEdit: form.status === "draft" && form.trainerProfileId === profile._id,
      canAcknowledge:
        form.status === "signed" && form.traineeProfileId === profile._id,
    };
  },
});

/**
 * The caller's own forms: those waiting for their acknowledgement, the rest they received
 * and the ones they wrote as a trainer (newest first).
 */
export const mine = query({
  args: {},
  returns: v.object({
    toAcknowledge: v.array(formRow),
    received: v.array(formRow),
    written: v.array(formRow),
  }),
  handler: async (ctx) => {
    const { profile } = await requireCapability(ctx, "visit.read");
    const received = await ctx.db
      .query("trainerForms")
      .withIndex("by_traineeProfileId_and_serviceDate", (q) =>
        q.eq("traineeProfileId", profile._id),
      )
      .order("desc")
      .take(MAX_LIST);
    const visible = received.filter((row) => row.status !== "draft");
    const written = await ctx.db
      .query("trainerForms")
      .withIndex("by_trainerProfileId_and_serviceDate", (q) =>
        q.eq("trainerProfileId", profile._id),
      )
      .order("desc")
      .take(MAX_LIST);
    return {
      toAcknowledge: await formRows(
        ctx,
        visible.filter((row) => row.status === "signed"),
      ),
      received: await formRows(
        ctx,
        visible.filter((row) => row.status === "acknowledged"),
      ),
      written: await formRows(ctx, written),
    };
  },
});

/**
 * Annex D for one trainee: the signed training-program blocks (newest first) and the
 * latest signed job evaluation the blocks are written against. Only rows the caller may
 * read are returned; drafts stay with their trainer.
 */
export const program = query({
  args: { traineeProfileId: v.id("profiles") },
  returns: v.object({
    traineeName: v.string(),
    blocks: v.array(
      v.object({
        formId: v.id("trainerForms"),
        serviceDate: v.string(),
        trainerName: v.string(),
        status: v.string(),
        program: trainingProgramContent,
      }),
    ),
    latestEvaluation: v.union(
      v.null(),
      v.object({
        formId: v.id("trainerForms"),
        serviceDate: v.string(),
        trainerName: v.string(),
        evaluation: jobEvaluationContent,
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const { profile, canRead, supervises } = await reader(ctx);
    const trainee = await ctx.db.get(args.traineeProfileId);
    if (!trainee) throw new ConvexError("Trainee not found");
    const rows = await ctx.db
      .query("trainerForms")
      .withIndex("by_traineeProfileId_and_serviceDate", (q) =>
        q.eq("traineeProfileId", trainee._id),
      )
      .order("desc")
      .take(MAX_LIST);
    // The trainee themself, a supervisor over their unit, or someone who trained them.
    const allowed =
      trainee._id === profile._id ||
      (trainee.orgUnitId !== undefined &&
        (await supervises(trainee.orgUnitId))) ||
      rows.some((row) => row.trainerProfileId === profile._id);
    if (!allowed) throw new ConvexError("Trainee not found");
    const names = new Map<Id<"profiles">, string>();
    const name = async (id: Id<"profiles">) => {
      if (!names.has(id))
        names.set(id, (await ctx.db.get(id))?.name ?? "Former user");
      return names.get(id)!;
    };
    const blocks = [];
    let latestEvaluation = null;
    for (const row of rows) {
      if (row.status === "draft" || !(await canRead(row))) continue;
      if (row.kind === "training_program" && row.program)
        blocks.push({
          formId: row._id,
          serviceDate: row.serviceDate,
          trainerName: await name(row.trainerProfileId),
          status: row.status,
          program: row.program,
        });
      if (row.kind === "job_evaluation" && row.evaluation && !latestEvaluation)
        latestEvaluation = {
          formId: row._id,
          serviceDate: row.serviceDate,
          trainerName: await name(row.trainerProfileId),
          evaluation: row.evaluation,
        };
    }
    return { traineeName: trainee.name, blocks, latestEvaluation };
  },
});
