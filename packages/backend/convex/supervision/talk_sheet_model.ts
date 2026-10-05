import { v, type Infer } from "convex/values";

/**
 * SOP-011 Talk Sheet (memo 2026-01-20, Annex E). Pure rules only, so the carry-over and
 * closing invariants are unit testable and the endpoints in `talk_sheet.ts` stay thin.
 *
 * A Talk Sheet records the gaps/issues an SFI sales representative discusses with an Area
 * Distribution Partner (ADP): agreement, corrective action, who is responsible, timeline
 * and status. Annex E rule: "On-going" and "Overdue" agreements carry to the next Talk
 * Sheet; an item closes only at "Completed"; an issue not addressed within one month is
 * re-reviewed for root causes by the ADP and the SFI sales representative.
 *
 * Successive sheets for the same partner inside the same organizational unit form one
 * chain; "the next Talk Sheet" is the next sheet in that chain.
 */

/** Annex E's standard issue lines, in form order. */
export const TALK_SHEET_TOPICS = [
  "siv_stt",
  "buying_accounts",
  "program_utilization",
  "report_submission",
  "inventory_days",
  "marketing_program",
  "other_operational",
] as const;
export type TalkSheetTopic = (typeof TALK_SHEET_TOPICS)[number];
export const talkSheetTopic = v.union(
  v.literal("siv_stt"),
  v.literal("buying_accounts"),
  v.literal("program_utilization"),
  v.literal("report_submission"),
  v.literal("inventory_days"),
  v.literal("marketing_program"),
  v.literal("other_operational"),
);
/** Client wording (call answer 9, 30 Sep: SIV Sell In Volume, STT Sales to Trade). */
export const TOPIC_LABELS: Record<TalkSheetTopic, string> = {
  siv_stt: "SIV and STT",
  buying_accounts: "Buying Accounts",
  program_utilization: "Program Utilization",
  report_submission: "Submission of Reports",
  inventory_days: "Inventory Days Level",
  marketing_program: "Marketing Program Execution",
  other_operational: "Other Operational Issues",
};

export const talkSheetItemStatus = v.union(
  v.literal("completed"),
  v.literal("on_going"),
  v.literal("overdue"),
);
export type TalkSheetItemStatus = Infer<typeof talkSheetItemStatus>;

export const talkSheetStatus = v.union(v.literal("draft"), v.literal("final"));
export type TalkSheetStatus = Infer<typeof talkSheetStatus>;

/** One gap/issue line as the author edits it. `itemId` is absent for a new line. */
export const talkSheetItemInput = v.object({
  itemId: v.optional(v.id("talkSheetItems")),
  topic: talkSheetTopic,
  gap: v.string(),
  agreement: v.string(),
  correctiveAction: v.string(),
  responsible: v.string(),
  timeline: v.string(), // YYYY-MM-DD target date
  status: talkSheetItemStatus,
  rootCause: v.optional(v.string()),
});
export type TalkSheetItemInput = Infer<typeof talkSheetItemInput>;

export const MAX_TEXT = 2_000;
export const MAX_SHORT_TEXT = 120;
export const MAX_ITEMS = 40;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(date: string) {
  if (!DATE_RE.test(date)) return false;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return (
    Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date
  );
}

/** Lowercased, whitespace-collapsed partner name: the chain key. */
export function partnerKey(name: string) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The same calendar day one month later, clamped to the month's last day. */
export function oneMonthAfter(date: string) {
  if (!isDate(date)) throw new Error("Invalid date");
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, lastDay)))
    .toISOString()
    .slice(0, 10);
}

/** Whole days between two dates (b − a). */
export function daysBetween(a: string, b: string) {
  return Math.round(
    (Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) /
      86_400_000,
  );
}

/**
 * The status that applies on `asOf`: Completed stays Completed; an item past its timeline
 * that is not Completed is Overdue even when the author left it On-going.
 */
export function effectiveStatus(
  item: { status: TalkSheetItemStatus; timeline: string },
  asOf: string,
): TalkSheetItemStatus {
  if (item.status === "completed") return "completed";
  if (item.status === "overdue" || item.timeline < asOf) return "overdue";
  return "on_going";
}

/** Annex E: only On-going and Overdue agreements carry to the next Talk Sheet. */
export function carriesOver(status: TalkSheetItemStatus) {
  return status !== "completed";
}

/**
 * Annex E: an issue not addressed within one month of when it was first raised needs a
 * root-cause re-review. Raised on 15 Sep → flagged from 15 Oct while still open.
 */
export function rootCauseDue(
  item: { status: TalkSheetItemStatus; openedOn: string },
  asOf: string,
) {
  return item.status !== "completed" && asOf >= oneMonthAfter(item.openedOn);
}

export const GAP_LABELS = {
  acknowledged_by: "Name who acknowledged and committed for the partner",
  next_contact: "Set the next contact date after the meeting",
  no_items: "Add at least one gap or issue",
  item_gap: "Describe every gap or issue",
  item_agreement: "Write the agreement for every line",
  item_action: "Write the corrective action for every line",
  item_responsible: "Name who is responsible for every line",
  item_timeline: "Give every line a timeline date",
  root_cause: "Write the root-cause review for lines open over a month",
} as const;
export type TalkSheetGap = keyof typeof GAP_LABELS;

const filled = (text: string | undefined) => !!text && text.trim().length > 0;

export type TalkSheetDraft = {
  meetingDate: string;
  acknowledgedByName?: string;
  nextContactDate?: string;
  items: readonly {
    gap: string;
    agreement: string;
    correctiveAction: string;
    responsible: string;
    timeline: string;
    status: TalkSheetItemStatus;
    openedOn: string;
    rootCause?: string;
  }[];
};

/** Everything still missing before a sheet may be finalized (signed off). */
export function finalizeGaps(draft: TalkSheetDraft): TalkSheetGap[] {
  const gaps: TalkSheetGap[] = [];
  if (!filled(draft.acknowledgedByName)) gaps.push("acknowledged_by");
  if (
    !draft.nextContactDate ||
    !isDate(draft.nextContactDate) ||
    draft.nextContactDate <= draft.meetingDate
  )
    gaps.push("next_contact");
  if (!draft.items.length) gaps.push("no_items");
  const every = (test: (item: TalkSheetDraft["items"][number]) => boolean) =>
    draft.items.every(test);
  if (!every((item) => filled(item.gap))) gaps.push("item_gap");
  if (!every((item) => filled(item.agreement))) gaps.push("item_agreement");
  if (!every((item) => filled(item.correctiveAction))) gaps.push("item_action");
  if (!every((item) => filled(item.responsible))) gaps.push("item_responsible");
  if (!every((item) => isDate(item.timeline))) gaps.push("item_timeline");
  if (
    !every(
      (item) =>
        !rootCauseDue(item, draft.meetingDate) || filled(item.rootCause),
    )
  )
    gaps.push("root_cause");
  return gaps;
}
