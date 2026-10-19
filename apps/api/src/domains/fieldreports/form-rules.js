export const TRAINER_FORM_KINDS = [
  "training_program",
  "training_sheet",
  "job_evaluation",
];
export const JOB_RATING_LABELS = {
  1: "Excellent",
  2: "Good",
  3: "Satisfactory",
  4: "Unsatisfactory",
};
export const TRAINER_FORM_LABELS = {
  training_program: "Performance summary & training program (Annex D)",
  training_sheet: "Training sheet (Annex F)",
  job_evaluation: "Job evaluation report (Annex G)",
};
/** @param {string} kind @param {string} d */
export function emptyContent(kind, d) {
  return kind === "training_program"
    ? {
        program: {
          area: "",
          objectives: [],
          strengths: "",
          improvementAreas: "",
          plansForNextContact: "",
        },
      }
    : kind === "training_sheet"
      ? { sheet: { objective: "", result: "", learnings: "", nextSteps: "" } }
      : {
          evaluation: {
            periodStart: d,
            periodEnd: d,
            district: "",
            area: "",
            ratings: [],
            remarks: "",
          },
        };
}

/** @param {string} kind @param {any} content @param {string} d */
export function formGaps(kind, content, d) {
  const gaps = [];
  const missing = (
    /** @type {any} */ value,
    /** @type {string} */ code,
    /** @type {string} */ label,
  ) => {
    if (typeof value !== "string" || !value.trim()) gaps.push({ code, label });
  };
  if (kind === "training_program") {
    const p = content.program ?? {};
    missing(p.area, "area", "Write the area");
    if (!p.objectives?.some((/** @type {string} */ s) => s.trim()))
      gaps.push({
        code: "objectives",
        label: "Write at least one training objective",
      });
    missing(p.strengths, "strengths", "Write the strengths");
    missing(
      p.improvementAreas,
      "improvement_areas",
      "Write the areas needing improvement",
    );
    missing(
      p.plansForNextContact,
      "next_contact",
      "Write the training plans for the next contact",
    );
  } else if (kind === "training_sheet") {
    const s = content.sheet ?? {};
    for (const [k, code, label] of [
      ["objective", "objective", "Write the objective"],
      ["result", "result", "Write the result"],
      ["learnings", "learnings", "Write the learnings"],
      ["nextSteps", "next_steps", "Write the next steps"],
    ])
      missing(s[k], code, label);
  } else {
    const e = content.evaluation ?? {};
    if (
      !e.periodStart ||
      !e.periodEnd ||
      e.periodStart > d ||
      e.periodEnd < d ||
      e.periodStart > e.periodEnd ||
      (Date.parse(e.periodEnd) - Date.parse(e.periodStart)) / 86400000 >= 92
    )
      gaps.push({
        code: "period",
        label: "Give a training period that includes the Work-With day",
      });
    missing(e.area, "area", "Write the area");
    const sections = [
      "preparation",
      "trade_coverage",
      "call_procedure",
      "closing_day",
      "area_management",
      "sales_qualities",
      "others",
    ];
    if (
      !sections.every((s) =>
        (e.ratings ?? []).some((/** @type {any} */ r) =>
          r.item.startsWith(s + "."),
        ),
      )
    )
      gaps.push({
        code: "section_unrated",
        label: "Rate at least one item in every section",
      });
    if (![1, 2, 3, 4].includes(e.overall))
      gaps.push({ code: "overall", label: "Rate the overall job standard" });
  }
  return gaps;
}

// Annex G's exact item catalogue, retained from the client memo.
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
];
export const JOB_EVALUATION_ITEMS = new Set(
  JOB_EVALUATION_SECTIONS.flatMap((/** @type {any} */ s) =>
    s.items.map((/** @type {any} */ i) => s.code + "." + i[0]),
  ),
);
