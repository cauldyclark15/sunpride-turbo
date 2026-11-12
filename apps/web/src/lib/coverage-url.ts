/** URL state for /sales-force coverage: ?month=YYYY-MM&person=<id>&plan=<id>. */

export type CoverageSelection = {
  month: string;
  /** Assignee chosen on the Plan tab (kept even before a plan is opened). */
  personId: string | null;
  selected: {
    id: string;
    assigneeId: string;
    assigneeName: string;
  } | null;
};

/** Current Manila month as YYYY-MM. */
export function currentManilaMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}

export function coverageSelectionFromParams(
  params: URLSearchParams,
  now = new Date(),
): CoverageSelection {
  const raw = params.get("month") ?? "";
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : currentManilaMonth(now);
  const plan = params.get("plan");
  const person = params.get("person");
  return {
    month,
    personId: person || null,
    selected: plan
      ? { id: plan, assigneeId: person ?? "", assigneeName: "" }
      : null,
  };
}

/** The URL patch for a planner selection, or null when the URL already matches. */
export function coverageSelectionPatch(
  params: URLSearchParams,
  next: { month: string; personId: string | null; planId: string | null },
) {
  const patch = {
    month: next.month || null,
    person: next.personId,
    plan: next.planId,
  };
  const same =
    (params.get("month") ?? null) === patch.month &&
    (params.get("person") ?? null) === patch.person &&
    (params.get("plan") ?? null) === patch.plan;
  return same ? null : patch;
}
