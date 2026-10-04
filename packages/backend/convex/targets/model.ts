/* Sales targets (CVX-017): pure validators and period rules shared by the schema, the
 * endpoints and their tests. Nothing here touches the database.
 *
 * A target is one number for one subject (employee, team or territory), one period
 * (daily or monthly) and one metric, valid over an effective interval with the document
 * it came from (`sourceRef`). History is kept: a revision closes the previous row at the
 * new row's start instead of overwriting it.
 */
import { ConvexError, v, type Infer } from "convex/values";

export const targetSubjectKindValidator = v.union(
  v.literal("employee"),
  v.literal("team"),
  v.literal("territory"),
);

/** Daily targets apply to each selling day; monthly targets to each Manila calendar month. */
export const targetPeriodValidator = v.union(
  v.literal("daily"),
  v.literal("monthly"),
);

/**
 * `sales_value` is in PHP minor units (centavos), like every other money field.
 * `calls` and `productive_calls` are counts (memo §2; call answers 1–2).
 */
export const targetMetricValidator = v.union(
  v.literal("sales_value"),
  v.literal("calls"),
  v.literal("productive_calls"),
);

export const targetSubjectValidator = v.union(
  v.object({ kind: v.literal("employee"), profileId: v.id("profiles") }),
  v.object({ kind: v.literal("team"), teamId: v.id("teams") }),
  v.object({ kind: v.literal("territory"), territoryId: v.id("territories") }),
);

export type TargetSubject = Infer<typeof targetSubjectValidator>;
export type TargetPeriod = Infer<typeof targetPeriodValidator>;
export type TargetMetric = Infer<typeof targetMetricValidator>;

export const MAX_TARGET_VALUE = 1e13; // ₱100 billion in centavos; far above any real target.
export const MAX_SOURCE_REF = 200;
export const MAX_NOTES = 500;

const DAY_MS = 86_400_000;
const MANILA_OFFSET_MS = 8 * 3_600_000; // Asia/Manila has no daylight saving.

export function isManilaMidnight(instant: number) {
  return (
    Number.isSafeInteger(instant) && (instant + MANILA_OFFSET_MS) % DAY_MS === 0
  );
}

export function isManilaMonthStart(instant: number) {
  return (
    isManilaMidnight(instant) &&
    new Date(instant + MANILA_OFFSET_MS).getUTCDate() === 1
  );
}

/** Start of the Manila day or month containing `instant`. */
export function manilaPeriodStart(period: TargetPeriod, instant: number) {
  const local = new Date(instant + MANILA_OFFSET_MS);
  const start =
    period === "daily"
      ? Date.UTC(
          local.getUTCFullYear(),
          local.getUTCMonth(),
          local.getUTCDate(),
        )
      : Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  return start - MANILA_OFFSET_MS;
}

/** Interval bounds must fall on the period's boundaries so a target never covers part of one. */
export function assertPeriodBoundary(
  period: TargetPeriod,
  instant: number,
  label: string,
) {
  const ok =
    period === "daily"
      ? isManilaMidnight(instant)
      : isManilaMonthStart(instant);
  if (!ok)
    throw new ConvexError(
      period === "daily"
        ? `${label} must be a Manila midnight`
        : `${label} must be the first day of a Manila month`,
    );
}

export function assertTargetValue(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TARGET_VALUE)
    throw new ConvexError("Target value must be a whole, non-negative number");
}

export function boundedText(
  value: string | undefined,
  label: string,
  max: number,
  required: boolean,
) {
  const trimmed = value?.trim() ?? "";
  if (required && !trimmed) throw new ConvexError(`${label} required`);
  if (trimmed.length > max)
    throw new ConvexError(`${label} is longer than ${max} characters`);
  return trimmed || undefined;
}

type Interval = { effectiveFrom: number; effectiveTo?: number };

export function inEffect(row: Interval, instant: number) {
  return (
    row.effectiveFrom <= instant &&
    (row.effectiveTo === undefined || instant < row.effectiveTo)
  );
}

/** The row in effect at `instant`; rows of one key never overlap, so at most one matches. */
export function targetAt<T extends Interval>(rows: T[], instant: number) {
  return rows.find((row) => inEffect(row, instant)) ?? null;
}
