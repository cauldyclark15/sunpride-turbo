/**
 * ANA-008 route/coverage compliance: web mirror of the pure rules in
 * `packages/backend/convex/analytics/compliance_model.ts` (a test keeps them equal), plus
 * the sums that turn per-person results into territory and store views. The server is
 * authoritative for every per-person figure; the web only sums, judges and ranks.
 */

export const DEFAULT_WEEKS = 8;
export const MAX_WEEKS = 8;
export const MIN_WEEKS = 2;
export const UNDER_COVERAGE_PCT = 90;
export const PERSISTENT_WEEKS = 3;

export type WeekFigures = {
  planned: number;
  done: number;
  missed: number;
  pending: number;
};

export type CoverageVerdict = {
  compliancePct: number | null;
  underWeeks: number;
  judgedWeeks: number;
  streak: number;
  persistent: boolean;
};

export function ratePct(part: number, whole: number) {
  if (whole <= 0) return null;
  return Math.floor((part * 100) / whole);
}

export function emptyWeek(): WeekFigures {
  return { planned: 0, done: 0, missed: 0, pending: 0 };
}

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

export function combineWeeks(
  series: readonly (readonly WeekFigures[])[],
): WeekFigures[] {
  const total: WeekFigures[] = [];
  for (const row of series) addWeeks(total, row);
  return total;
}

/** Only closed weeks with stops due are judged; empty weeks neither break nor extend a run. */
export function coverageVerdict(
  series: readonly WeekFigures[],
  windows: readonly { closed: boolean }[],
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

/** Worst first: persistent, longest run, most under weeks, lowest compliance; then code. */
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

/* ------------------------------ view aggregation ------------------------------ */

export type ComplianceView = "employee" | "territory" | "customer";

export const COMPLIANCE_VIEWS: [ComplianceView, string][] = [
  ["employee", "Employee"],
  ["territory", "Territory"],
  ["customer", "Customer (store)"],
];

export const WEEK_OPTIONS = [4, 6, 8] as const;

/** The parts of `analytics/compliance:person` the views read. */
export type PersonResult = {
  profileId: string;
  name: string;
  employeeCode: string | null;
  positionLabel: string | null;
  windows: { weekStart: string; from: string; to: string; closed: boolean }[];
  weeks: WeekFigures[];
  offPlanVisits: number[];
  territories: {
    territoryId: string;
    code: string;
    name: string;
    weeks: WeekFigures[];
  }[];
  outlets: {
    outletId: string;
    code: string;
    name: string;
    territoryCode: string;
    customerCode: string | null;
    customerName: string | null;
    weeks: WeekFigures[];
  }[];
  outletsTruncated: boolean;
};

export type ComplianceRow = {
  key: string;
  code: string;
  name: string;
  detail: string;
  people: string[];
  weeks: WeekFigures[];
  offPlanVisits: number | null;
  verdict: CoverageVerdict;
};

type Group = Omit<ComplianceRow, "verdict" | "people"> & {
  people: Set<string>;
};

function finish(
  groups: Iterable<Group>,
  windows: readonly { closed: boolean }[],
): ComplianceRow[] {
  return rankByCoverage(
    [...groups].map((group) => ({
      ...group,
      people: [...group.people].sort(),
      verdict: coverageVerdict(group.weeks, windows),
    })),
  );
}

/**
 * Rows for one view, worst first. A territory or store served by several people is one
 * row whose weeks are the sum of theirs.
 */
export function complianceRows(
  results: readonly PersonResult[],
  view: ComplianceView,
): ComplianceRow[] {
  const windows = results[0]?.windows ?? [];
  const groups = new Map<string, Group>();
  const group = (key: string, make: () => Omit<Group, "weeks" | "people">) => {
    let row = groups.get(key);
    if (!row) {
      row = { ...make(), weeks: [], people: new Set() };
      groups.set(key, row);
    }
    return row;
  };
  for (const person of results) {
    if (view === "employee") {
      const row = group(person.profileId, () => ({
        key: person.profileId,
        code: person.employeeCode ?? person.name,
        name: person.name,
        detail: [person.employeeCode, person.positionLabel]
          .filter(Boolean)
          .join(" · "),
        offPlanVisits: person.offPlanVisits.reduce((a, b) => a + b, 0),
      }));
      addWeeks(row.weeks, person.weeks);
      row.people.add(person.name);
      continue;
    }
    if (view === "territory") {
      for (const territory of person.territories) {
        const row = group(territory.territoryId, () => ({
          key: territory.territoryId,
          code: territory.code,
          name: territory.name,
          detail: territory.code,
          offPlanVisits: null,
        }));
        addWeeks(row.weeks, territory.weeks);
        row.people.add(person.name);
      }
      continue;
    }
    for (const outlet of person.outlets) {
      const row = group(outlet.outletId, () => ({
        key: outlet.outletId,
        code: outlet.code,
        name: outlet.name,
        detail: [
          outlet.code,
          outlet.customerCode &&
            `${outlet.customerCode}${outlet.customerName ? ` ${outlet.customerName}` : ""}`,
          outlet.territoryCode,
        ]
          .filter(Boolean)
          .join(" · "),
        offPlanVisits: null,
      }));
      addWeeks(row.weeks, outlet.weeks);
      row.people.add(person.name);
    }
  }
  return finish(groups.values(), windows);
}

export function pctText(value: number | null) {
  return value === null ? "—" : `${value}%`;
}

export function manilaToday(now = Date.now()) {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}
