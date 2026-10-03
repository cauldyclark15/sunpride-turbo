/**
 * Pure supervision rules (WEB-022/023/024). No database access here, so every rule is
 * unit-testable and the read endpoints stay thin.
 *
 * Client answers of 2 Oct 2026 drive the time rules: the field day closes at 10 PM Manila
 * (updates after that are "late"), and a salesperson must follow the MCP order.
 */
const HOUR = 3_600_000;
const MANILA_OFFSET = 8 * HOUR;

/** People one supervision read covers. Larger teams narrow by unit or channel. */
export const MAX_PEOPLE = 80;
/** Visits/planned stops read per person per day. Field standards top out at 30 calls. */
export const MAX_DAY_ROWS = 60;
/** Day close: client answer 14 (2 Oct 2026) — the day's updates must be in by 10 PM. */
export const DAY_CLOSE_HOUR = 22;
/** PROVISIONAL: a fix delivered more than this after it was taken counts as a late sync. */
export const LATE_SYNC_MS = 2 * HOUR;

export const DONE_STATES = new Set(["checked-out", "completed"]);
export const OPEN_STATES = new Set(["arrived", "checked-in", "in-progress"]);

/** Manila midnight of a YYYY-MM-DD service date plus the 10 PM close. */
export function dayCloseAt(serviceDate: string) {
  const midnight = Date.parse(`${serviceDate}T00:00:00.000Z`) - MANILA_OFFSET;
  return midnight + DAY_CLOSE_HOUR * HOUR;
}

export type VisitLike = {
  _id: string;
  state: string;
  source: string;
  productivity: string;
  plannedVisitId?: string;
  checkedInAt?: number;
  checkedOutAt?: number;
  lastServerTime: number;
};

/**
 * MCP order rule (client answer 13): a visit checked in after a stop with a higher planned
 * sequence jumped the order. Returns the visit ids that broke the order and the stop they
 * jumped from.
 */
export function outOfSequence(
  visits: readonly VisitLike[],
  sequenceOf: (visit: VisitLike) => number | undefined,
) {
  const ordered = visits
    .filter((v) => v.checkedInAt !== undefined && sequenceOf(v) !== undefined)
    .sort((a, b) => a.checkedInAt! - b.checkedInAt!);
  const broken = new Map<string, { sequence: number; after: number }>();
  let highest: number | undefined;
  for (const visit of ordered) {
    const sequence = sequenceOf(visit)!;
    if (highest !== undefined && sequence < highest)
      broken.set(visit._id, { sequence, after: highest });
    highest = highest === undefined ? sequence : Math.max(highest, sequence);
  }
  return broken;
}

export type EvidenceLike = {
  deviceTime: number;
  serverTime: number;
};

/** Late when the day's update arrived after the 10 PM close or long after it happened. */
export function isLateSync(
  visit: VisitLike,
  evidence: readonly EvidenceLike[],
  closeAt: number,
) {
  return (
    visit.lastServerTime > closeAt ||
    evidence.some((row) => row.serverTime - row.deviceTime > LATE_SYNC_MS)
  );
}

export function summarizeDay(args: {
  plannedActive: number;
  plannedIds: ReadonlySet<string>;
  visits: readonly VisitLike[];
  outOfSequence: number;
  openExceptions: number;
  lateSync: number;
}) {
  const { visits } = args;
  const checkIns = visits.flatMap((v) =>
    v.checkedInAt === undefined ? [] : [v.checkedInAt],
  );
  const checkOuts = visits.flatMap((v) =>
    v.checkedOutAt === undefined ? [] : [v.checkedOutAt],
  );
  const done = visits.filter((v) => DONE_STATES.has(v.state));
  return {
    planned: args.plannedActive,
    plannedDone: done.filter(
      (v) => v.plannedVisitId && args.plannedIds.has(v.plannedVisitId),
    ).length,
    done: done.length,
    productive: visits.filter((v) => v.productivity === "verified").length,
    nonproductive: visits.filter((v) => v.productivity === "nonproductive")
      .length,
    unplanned: visits.filter((v) => v.source === "unplanned").length,
    inProgress: visits.some((v) => OPEN_STATES.has(v.state)),
    outOfSequence: args.outOfSequence,
    openExceptions: args.openExceptions,
    lateSync: args.lateSync,
    firstCheckInAt: checkIns.length ? Math.min(...checkIns) : null,
    lastCheckOutAt: checkOuts.length ? Math.max(...checkOuts) : null,
    lastActivityAt: visits.length
      ? Math.max(...visits.map((v) => v.lastServerTime))
      : null,
  };
}

/** Channel grouping for the per-channel "field commander" view. */
export function channelOf(
  channelScope: string | undefined,
  positionLabel: string | undefined,
) {
  return channelScope?.trim() || positionLabel?.trim() || "Unassigned";
}
