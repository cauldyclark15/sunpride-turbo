import { v, type Infer } from "convex/values";

/**
 * SOP-010 Trainer forms (memo 2026-01-20, annexes D, F and G). Pure rules only, so every
 * requirement is unit testable and `trainer_forms.ts` stays thin.
 *
 * Each form is a structured record attached to one Work-With session (SOP-005). The
 * session's trainer writes and signs it; the session's trainee then acknowledges it
 * (the memo's "Trainee signature"). A signed form is frozen.
 *
 * - Annex D — Performance Summary & Training Program: one record is one dated block
 *   (training objectives 1–3, strengths, areas needing improvement, plans for the next
 *   contact). The trainee's sheet is the list of blocks, newest first.
 * - Annex F — Training Sheet (training memo): objective, result, learnings, next steps.
 * - Annex G — Job Evaluation Report: a training period, district and area, the listed
 *   items rated 1 Excellent … 4 Unsatisfactory, and the overall job standard. The dates
 *   are the trainer's completed Work-With sessions with the trainee inside the period,
 *   frozen when the trainer signs.
 */

export const TRAINER_FORM_KINDS = [
  "training_program",
  "training_sheet",
  "job_evaluation",
] as const;
export const trainerFormKind = v.union(
  v.literal("training_program"),
  v.literal("training_sheet"),
  v.literal("job_evaluation"),
);
export type TrainerFormKind = Infer<typeof trainerFormKind>;

export const TRAINER_FORM_LABELS: Record<TrainerFormKind, string> = {
  training_program: "Performance summary & training program (Annex D)",
  training_sheet: "Training sheet (Annex F)",
  job_evaluation: "Job evaluation report (Annex G)",
};

export const trainerFormStatus = v.union(
  v.literal("draft"),
  v.literal("signed"),
  v.literal("acknowledged"),
);
export type TrainerFormStatus = Infer<typeof trainerFormStatus>;

/** Annex G scale: 1 Excellent, 2 Good, 3 Satisfactory, 4 Unsatisfactory. */
export const jobRating = v.union(
  v.literal(1),
  v.literal(2),
  v.literal(3),
  v.literal(4),
);
export type JobRating = Infer<typeof jobRating>;
export const JOB_RATING_LABELS: Record<JobRating, string> = {
  1: "Excellent",
  2: "Good",
  3: "Satisfactory",
  4: "Unsatisfactory",
};

/** Annex G sections and items, in the form's order and wording. */
export const JOB_EVALUATION_SECTIONS = [
  {
    code: "preparation",
    label: "Preparation",
    items: [
      ["review_plans", "Review plans"],
      ["equipment_check", "Equipment check"],
      ["vehicle_check", "Vehicle check"],
    ],
  },
  {
    code: "trade_coverage",
    label: "Trade coverage",
    items: [
      ["route_order", "Calls in route order"],
      ["time_allocation", "Time allocation"],
    ],
  },
  {
    code: "call_procedure",
    label: "Call procedure",
    items: [
      ["review_plans", "Review plans"],
      ["greet_dealer", "Greet dealer"],
      ["store_check", "Store check and plan order"],
      ["presentation", "Presentation"],
      ["close", "Close"],
      ["stack_delivery", "Arrange for stack delivery"],
      ["records_reports", "Records and reports"],
      ["delivery_payment", "Delivery and payment"],
      ["resale_work", "Resale work"],
      ["next_coverage", "Tell customer your next coverage"],
      ["call_analysis", "Call analysis"],
    ],
  },
  {
    code: "closing_day",
    label: "Closing for the day",
    items: [
      ["fund_accounting", "Fund accounting"],
      [
        "records_completion",
        "Completion of records, reports and correspondence",
      ],
      ["reviewing_performance", "Reviewing performance"],
      ["preparing_next_day", "Preparing for next day"],
    ],
  },
  {
    code: "area_management",
    label: "Area management",
    items: [
      ["meeting_objectives", "Meeting objectives"],
      ["competitive_activity", "Reporting competitive activity"],
    ],
  },
  {
    code: "sales_qualities",
    label: "Sales qualities",
    items: [
      ["initiative", "Initiative"],
      ["enthusiasm", "Enthusiasm"],
      ["self_motivation", "Self-motivation"],
      ["positiveness", "Positiveness"],
    ],
  },
  {
    code: "others",
    label: "Others",
    items: [
      ["account_penetration", "Account penetration (brand's growth)"],
      ["distribution_level", "Distribution level"],
      ["availability_level", "Availability level"],
      ["shelf_space", "Shelf space and position"],
      ["display_position", "Display position"],
      ["reputation", "Reputation as #1"],
      ["contact_anytime", "Can contact anytime"],
      ["goodwill", "Degree of goodwill"],
      ["trade_rapport", "Trade rapport"],
      ["merchandiser_management", "Merchandiser management"],
    ],
  },
] as const;

type EvaluationSection = {
  code: string;
  label: string;
  items: readonly (readonly [string, string])[];
};
const SECTIONS: readonly EvaluationSection[] = JOB_EVALUATION_SECTIONS;

/** `section.item`, e.g. `call_procedure.close`. */
export const JOB_EVALUATION_ITEMS: ReadonlySet<string> = new Set(
  SECTIONS.flatMap((section) =>
    section.items.map(([item]) => `${section.code}.${item}`),
  ),
);

export const trainingProgramContent = v.object({
  area: v.string(),
  objectives: v.array(v.string()),
  strengths: v.string(),
  improvementAreas: v.string(),
  plansForNextContact: v.string(),
});
export type TrainingProgramContent = Infer<typeof trainingProgramContent>;

export const trainingSheetContent = v.object({
  objective: v.string(),
  result: v.string(),
  learnings: v.string(),
  nextSteps: v.string(),
});
export type TrainingSheetContent = Infer<typeof trainingSheetContent>;

export const jobEvaluationContent = v.object({
  periodStart: v.string(), // YYYY-MM-DD
  periodEnd: v.string(),
  district: v.string(),
  area: v.string(),
  ratings: v.array(v.object({ item: v.string(), rating: jobRating })),
  overall: v.optional(jobRating),
  remarks: v.string(),
});
export type JobEvaluationContent = Infer<typeof jobEvaluationContent>;

export const MAX_FORM_TEXT = 2_000;
export const MAX_FORM_SHORT_TEXT = 120;
export const MAX_OBJECTIVES = 3;
/** Longest Annex G training period. */
export const MAX_PERIOD_DAYS = 92;

export function emptyContent(kind: TrainerFormKind, serviceDate: string) {
  if (kind === "training_program")
    return {
      program: {
        area: "",
        objectives: [],
        strengths: "",
        improvementAreas: "",
        plansForNextContact: "",
      } satisfies TrainingProgramContent,
    };
  if (kind === "training_sheet")
    return {
      sheet: {
        objective: "",
        result: "",
        learnings: "",
        nextSteps: "",
      } satisfies TrainingSheetContent,
    };
  return {
    evaluation: {
      periodStart: serviceDate,
      periodEnd: serviceDate,
      district: "",
      area: "",
      ratings: [],
      remarks: "",
    } satisfies JobEvaluationContent,
  };
}

export const FORM_GAP_LABELS = {
  area: "Write the area",
  objectives: "Write at least one training objective",
  strengths: "Write the strengths",
  improvement_areas: "Write the areas needing improvement",
  next_contact: "Write the training plans for the next contact",
  objective: "Write the objective",
  result: "Write the result",
  learnings: "Write the learnings",
  next_steps: "Write the next steps",
  period: "Give a training period that includes the Work-With day",
  section_unrated: "Rate at least one item in every section",
  overall: "Rate the overall job standard",
} as const;
export type FormGap = keyof typeof FORM_GAP_LABELS;

const filled = (text: string | undefined) => !!text && text.trim().length > 0;
const DAY = 86_400_000;

export function isIsoDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return (
    Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date
  );
}

/** Period start/end are real dates, ordered, and no longer than the maximum. */
export function validPeriod(start: string, end: string) {
  if (!isIsoDate(start) || !isIsoDate(end) || start > end) return false;
  const days =
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY;
  return days + 1 <= MAX_PERIOD_DAYS;
}

export type FormContent = {
  program?: TrainingProgramContent;
  sheet?: TrainingSheetContent;
  evaluation?: JobEvaluationContent;
};

/** Everything still missing before the trainer may sign the form. */
export function formGaps(
  kind: TrainerFormKind,
  content: FormContent,
  serviceDate: string,
): FormGap[] {
  const gaps: FormGap[] = [];
  if (kind === "training_program") {
    const program = content.program;
    if (!filled(program?.area)) gaps.push("area");
    if (!program?.objectives.some(filled)) gaps.push("objectives");
    if (!filled(program?.strengths)) gaps.push("strengths");
    if (!filled(program?.improvementAreas)) gaps.push("improvement_areas");
    if (!filled(program?.plansForNextContact)) gaps.push("next_contact");
    return gaps;
  }
  if (kind === "training_sheet") {
    const sheet = content.sheet;
    if (!filled(sheet?.objective)) gaps.push("objective");
    if (!filled(sheet?.result)) gaps.push("result");
    if (!filled(sheet?.learnings)) gaps.push("learnings");
    if (!filled(sheet?.nextSteps)) gaps.push("next_steps");
    return gaps;
  }
  const evaluation = content.evaluation;
  if (
    !evaluation ||
    !validPeriod(evaluation.periodStart, evaluation.periodEnd) ||
    serviceDate < evaluation.periodStart ||
    serviceDate > evaluation.periodEnd
  )
    gaps.push("period");
  if (!filled(evaluation?.area)) gaps.push("area");
  const rated = new Set(
    (evaluation?.ratings ?? []).map((row) => row.item.split(".")[0]),
  );
  if (!SECTIONS.every((section) => rated.has(section.code)))
    gaps.push("section_unrated");
  if (evaluation?.overall === undefined) gaps.push("overall");
  return gaps;
}

/** Average of the item ratings per section (lower is better), for summaries. */
export function sectionAverages(ratings: JobEvaluationContent["ratings"]) {
  return SECTIONS.map((section) => {
    const rows = ratings.filter((row) =>
      row.item.startsWith(`${section.code}.`),
    );
    return {
      section: section.code,
      label: section.label,
      rated: rows.length,
      average: rows.length
        ? Math.round(
            (rows.reduce((sum, row) => sum + row.rating, 0) / rows.length) *
              100,
          ) / 100
        : null,
    };
  });
}
