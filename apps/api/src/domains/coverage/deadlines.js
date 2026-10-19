import { DAY, localDate, manilaDate, monthBounds } from "./model.js";
/** @param {string} month */
export function mcpDeadlines(month) {
  const { from } = monthBounds(month);
  return {
    localMonth: month,
    submissionOpensDate: manilaDate(from - 7 * DAY),
    submissionDueDate: manilaDate(from - DAY),
    approvalDueDate: manilaDate(from + 6 * DAY),
    submissionOpensAt: from - 7 * DAY,
    submissionDueAt: from,
    approvalDueAt: from + 7 * DAY,
  };
}
/** @param {ReturnType<typeof mcpDeadlines>} d @param {any} p @param {number} now */
export function deadlineState(d, p, now) {
  const submitted = !!p && p.status !== "draft",
    approved = !!p && ["approved", "active", "superseded"].includes(p.status);
  const submittedLate =
    submitted &&
    p.submitted_at != null &&
    +new Date(p.submitted_at) >= d.submissionDueAt;
  const approvedLate =
    approved &&
    p.approved_at != null &&
    +new Date(p.approved_at) >= d.approvalDueAt;
  return {
    state: approved
      ? approvedLate
        ? "approved_late"
        : "approved"
      : submitted
        ? now >= d.approvalDueAt
          ? "approval_overdue"
          : "awaiting_approval"
        : now < d.submissionOpensAt
          ? "not_open"
          : now < d.submissionDueAt
            ? "due"
            : "overdue",
    submittedLate,
    approvedLate,
  };
}
/** @param {any[]} plans */
export function deadlinePlan(plans) {
  const originals = plans.filter((p) => !p.based_on_plan_id);
  const rank = {
    draft: 0,
    submitted: 1,
    superseded: 2,
    approved: 3,
    active: 4,
  };
  return (
    [...(originals.length ? originals : plans)].sort(
      (a, b) =>
        /** @type {any} */ (rank)[b.status] -
          /** @type {any} */ (rank)[a.status] || b.version - a.version,
    )[0] ?? null
  );
}
/** @param {string} from @param {string} to */
export function awayBounds(from, to) {
  return { from: localDate(from), to: localDate(to) + DAY };
}
