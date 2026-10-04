import type { StatusTone } from "@sunpride/ui";

/**
 * Pure view rules for the trainer forms (SOP-010, memo annexes D, F, G). A UI-only mirror
 * of `packages/backend/convex/supervision/trainer_forms_model.ts`; the test compares the
 * two so the labels and Annex G items never drift.
 */

export type TrainerFormKind =
  "training_program" | "training_sheet" | "job_evaluation";

export const FORM_KIND_LABELS: Record<TrainerFormKind, string> = {
  training_program: "Training program",
  training_sheet: "Training sheet",
  job_evaluation: "Job evaluation",
};

export const FORM_KIND_ANNEX: Record<TrainerFormKind, string> = {
  training_program: "Annex D",
  training_sheet: "Annex F",
  job_evaluation: "Annex G",
};

export const FORM_KINDS: TrainerFormKind[] = [
  "training_sheet",
  "training_program",
  "job_evaluation",
];

export const FORM_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  signed: "Waiting for trainee",
  acknowledged: "Acknowledged",
};

export function formStatusTone(status: string): StatusTone {
  return status === "acknowledged"
    ? "success"
    : status === "signed"
      ? "warning"
      : "neutral";
}

export type JobRating = 1 | 2 | 3 | 4;
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

/** Rating per `section.item`, from the stored list. */
export function ratingMap(
  ratings: readonly { item: string; rating: JobRating }[],
) {
  return new Map(ratings.map((row) => [row.item, row.rating]));
}

/** Stored list back from the map, in the form's order. */
export function ratingList(map: ReadonlyMap<string, JobRating>) {
  const out: { item: string; rating: JobRating }[] = [];
  for (const section of JOB_EVALUATION_SECTIONS)
    for (const [item] of section.items) {
      const key = `${section.code}.${item}`;
      const rating = map.get(key);
      if (rating !== undefined) out.push({ item: key, rating });
    }
  return out;
}

/** Up to three objective lines for the editor, padded with blanks. */
export function objectiveLines(objectives: readonly string[]) {
  return [0, 1, 2].map((i) => objectives[i] ?? "");
}
