/* ANA-008 route/coverage compliance: pure rules shared by the query, its tests and the web
 * mirror (`apps/web/src/lib/coverage-compliance.ts`, kept equal by a test). Nothing here
 * touches the database.
 *
 * Compliance is the KPI sheet's plan completion: planned MCP stops visited and checked out
 * on their planned day, out of the stops that are due (their day has closed, or they are
 * already done). Persistent under-coverage is a run of closed weeks below the threshold.
 * The threshold and run length are ours, not Sunpride's: provisional until the KPIs are
 * signed off (memo §6, KPI_DEFINITIONS.md "Plan completion %").
 */

export const COMPLIANCE_SOURCE =
  "KPI_DEFINITIONS.md plan completion % (provisional) · memo 2026-01-20 §3 MCP · call answers 2 Oct 2026";

/** Weeks shown by default and at most (8 weeks = 56 days of one person's plan). */
export const DEFAULT_WEEKS = 8;
export const MAX_WEEKS = 8;
export const MIN_WEEKS = 2;
/** A closed week below this plan compliance is under-covered (provisional). */
export const UNDER_COVERAGE_PCT = 90;
/** This many under-covered closed weeks in a row is persistent under-coverage (provisional). */
export const PERSISTENT_WEEKS = 3;

const DAY = 86_400_000;

/** One week of one person, territory or store. */
export type WeekFigures = {
  /** Approved MCP stops still planned (not cancelled or replaced). */
  planned: number;
  /** Planned stops visited and checked out on their planned day. */
  done: number;
  /** Planned stops of a closed day (after the 10 PM close) with no completed visit. */
  missed: number;
  /** Planned stops of a day still open with no completed visit yet. */
  pending: number;
};

export type WeekWindow = {
  /** Monday of the week (YYYY-MM-DD). */
  weekStart: string;
  /** First and last date of the week inside the window. */
  from: string;
  to: string;
  /** Every date of the week inside the window has closed. */
  closed: boolean;
};

export type CoverageVerdict = {
  /** Plan compliance over every week of the window; null with nothing due. */
  compliancePct: number | null;
  /** Closed weeks with stops due that came in under the threshold. */
  underWeeks: number;
  /** Closed weeks with stops due. */
  judgedWeeks: number;
  /** Under-covered closed weeks in a row, counting back from the latest judged week. */
  streak: number;
  persistent: boolean;
};

/** Whole percent, rounded down; null without a positive base. */
export function ratePct(part: number, whole: number) {
  if (whole <= 0) return null;
  return Math.floor((part * 100) / whole);
}

export function emptyWeek(): WeekFigures {
  return { planned: 0, done: 0, missed: 0, pending: 0 };
}

/** Stops whose outcome is known: done, or missed after the day closed. */
export function dueStops(week: WeekFigures) {
  return week.done + week.missed;
}

export function weekCompliancePct(week: WeekFigures) {
  return ratePct(week.done, dueStops(week));
}

export function addWeeks(
  into: WeekFigures[],
  rows: readonly WeekFigures[],
): WeekFigures[] {
  rows.forEach((row, index) => {
    const target = into[index] ?? (into[index] = emptyWeek());
    target.planned += row.planned;
    target.done += row.done;
    target.missed += row.missed;
    target.pending += row.pending;
  });
  return into;
}

/** Week-by-week sums of several series (numerators and denominators, never averages). */
export function combineWeeks(
  series: readonly (readonly WeekFigures[])[],
): WeekFigures[] {
  const total: WeekFigures[] = [];
  for (const row of series) addWeeks(total, row);
  return total;
}

function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
}

/** Monday of the ISO week holding a Manila date. */
export function mondayOf(date: string) {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

/**
 * The window: `weeks` Monday-to-Sunday weeks ending with the week of `endDate`, the last
 * one cut at `endDate`. `closedBefore(date)` says whether a date's 10 PM close has passed.
 */
export function weekWindows(
  endDate: string,
  weeks: number,
  closedBefore: (date: string) => boolean,
): WeekWindow[] {
  const lastMonday = mondayOf(endDate);
  const windows: WeekWindow[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = addDays(lastMonday, -7 * i);
    const sunday = addDays(weekStart, 6);
    const to = sunday < endDate ? sunday : endDate;
    windows.push({ weekStart, from: weekStart, to, closed: closedBefore(to) });
  }
  return windows;
}

/** Index of the window week holding `date`, or -1 outside the window. */
export function weekIndex(windows: readonly WeekWindow[], date: string) {
  return windows.findIndex((week) => date >= week.from && date <= week.to);
}

/** Why a window is not allowed, or null when it is. */
export function weeksError(weeks: number): string | null {
  if (!Number.isInteger(weeks) || weeks < MIN_WEEKS || weeks > MAX_WEEKS)
    return `Pick between ${MIN_WEEKS} and ${MAX_WEEKS} weeks`;
  return null;
}

/**
 * Judges a weekly series. Only closed weeks with stops due are judged; weeks with nothing
 * planned neither break nor extend a run (a store planned every other week stays judged
 * on the weeks it was planned).
 */
export function coverageVerdict(
  series: readonly WeekFigures[],
  windows: readonly Pick<WeekWindow, "closed">[],
): CoverageVerdict {
  let done = 0,
    due = 0,
    underWeeks = 0,
    judgedWeeks = 0;
  const judged: boolean[] = [];
  series.forEach((week, index) => {
    done += week.done;
    due += dueStops(week);
    if (!windows[index]?.closed) return;
    const pct = weekCompliancePct(week);
    if (pct === null) return;
    judgedWeeks++;
    const under = pct < UNDER_COVERAGE_PCT;
    if (under) underWeeks++;
    judged.push(under);
  });
  let streak = 0;
  for (let i = judged.length - 1; i >= 0 && judged[i]; i--) streak++;
  return {
    compliancePct: ratePct(done, due),
    underWeeks,
    judgedWeeks,
    streak,
    persistent: streak >= PERSISTENT_WEEKS,
  };
}

/**
 * Worst first: persistent under-coverage, then the longest run, then the most under weeks,
 * then the lowest compliance; rows with nothing due go last; ties keep the code order.
 */
export function rankByCoverage<
  T extends { code: string; verdict: CoverageVerdict },
>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const va = a.verdict;
    const vb = b.verdict;
    if (va.persistent !== vb.persistent) return va.persistent ? -1 : 1;
    if (va.streak !== vb.streak) return vb.streak - va.streak;
    if (va.underWeeks !== vb.underWeeks) return vb.underWeeks - va.underWeeks;
    if (va.compliancePct === null || vb.compliancePct === null) {
      if (va.compliancePct !== vb.compliancePct)
        return (
          Number(va.compliancePct === null) - Number(vb.compliancePct === null)
        );
    } else if (va.compliancePct !== vb.compliancePct)
      return va.compliancePct - vb.compliancePct;
    return a.code.localeCompare(b.code);
  });
}
