/**
 * Sunpride's selling week (call 2026-10-02 at 12:23 and 13:13, email Q8): Saturday is a
 * selling day, a six-day week Monday to Saturday. Distributor sales personnel and outside
 * sales sell on Saturday; key accounts use it as a collection day and it still counts as a
 * working, productive day. Per diem follows the work activity actually done.
 *
 * Weekdays use JavaScript's 0–6 convention (Sunday = 0, Saturday = 6), as coverage does.
 * Dates are Asia/Manila `YYYY-MM-DD` service dates.
 */
export const DEFAULT_SELLING_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5, 6];

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Weekday of a Manila calendar date (the date itself carries no time zone). */
export function weekdayOf(serviceDate: string): number {
  const match = DATE.exec(serviceDate);
  if (!match) throw new Error(`Invalid service date ${serviceDate}`);
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (date.toISOString().slice(0, 10) !== serviceDate)
    throw new Error(`Invalid service date ${serviceDate}`);
  return date.getUTCDay();
}

export function isSellingDay(
  serviceDate: string,
  sellingWeekdays: readonly number[] = DEFAULT_SELLING_WEEKDAYS,
): boolean {
  return sellingWeekdays.includes(weekdayOf(serviceDate));
}

/** Selling dates of a `YYYY-MM` month, for monthly targets (daily target × selling days). */
export function sellingDatesInMonth(
  localMonth: string,
  sellingWeekdays: readonly number[] = DEFAULT_SELLING_WEEKDAYS,
): string[] {
  const match = /^(\d{4})-(\d{2})$/.exec(localMonth);
  if (!match) throw new Error(`Invalid month ${localMonth}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid month ${localMonth}`);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dates: string[] = [];
  for (let day = 1; day <= days; day += 1) {
    const date = `${localMonth}-${String(day).padStart(2, "0")}`;
    if (isSellingDay(date, sellingWeekdays)) dates.push(date);
  }
  return dates;
}

export type PerDiemBasis = "eligible" | "no_activity" | "needs_review";

/**
 * Per diem follows work actually done: a selling day with at least one call is the basis for
 * a claim (the supervisor still validates and approves it). Work on a non-selling day is not
 * refused, but it is flagged for the approver because no rule covers it yet.
 */
export function perDiemBasis(input: {
  serviceDate: string;
  calls: number;
  sellingWeekdays?: readonly number[];
}): PerDiemBasis {
  if (input.calls <= 0) return "no_activity";
  return isSellingDay(input.serviceDate, input.sellingWeekdays)
    ? "eligible"
    : "needs_review";
}
