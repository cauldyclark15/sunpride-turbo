import type { ReactNode } from "react";
import { StatusPill as BasePill, type StatusTone } from "@sunpride/ui";

type Tone = StatusTone | "info";

/** Every state a person sees on a phone or a document, in plain words (SPEC 3.7, 4.1, 5.1). */
export const STATUS_STATES = {
  // Handheld truth states
  saved_on_phone: { label: "Saved on phone", tone: "neutral" },
  sent: { label: "Sent", tone: "info" },
  accepted: { label: "Accepted", tone: "success" },
  sap_posted: { label: "SAP posted", tone: "success", tick: true },
  needs_review: { label: "Needs review", tone: "warning" },
  // Documents
  draft: { label: "Draft", tone: "neutral" },
  planned: { label: "Planned", tone: "neutral" },
  requested: { label: "Requested", tone: "info" },
  approved: { label: "Approved", tone: "info" },
  picking: { label: "Picking", tone: "info" },
  dispatched: { label: "In transit", tone: "info" },
  partially_received: { label: "Partly received", tone: "warning" },
  received: { label: "Received", tone: "success" },
  counting: { label: "Counting", tone: "info" },
  submitted: { label: "Submitted", tone: "info" },
  review: { label: "In review", tone: "warning" },
  posted: { label: "Posted", tone: "success" },
  closed: { label: "Closed", tone: "success" },
  open: { label: "Open", tone: "warning" },
  resolved: { label: "Resolved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  reversed: { label: "Reversed", tone: "neutral" },
} as const satisfies Record<
  string,
  { label: string; tone: Tone; tick?: boolean }
>;

export type StatusState = keyof typeof STATUS_STATES;

/** Server spellings that mean one of the states above. */
const ALIASES: Record<string, StatusState> = {
  review_needed: "needs_review",
  in_transit: "dispatched",
  canceled: "cancelled",
};

export function statusFor(state: string): {
  label: string;
  tone: Tone;
  tick?: boolean;
} {
  const key = state.trim().toLowerCase().replaceAll(" ", "_");
  const known = (
    STATUS_STATES as Record<
      string,
      { label: string; tone: Tone; tick?: boolean }
    >
  )[ALIASES[key] ?? key];
  if (known) return known;
  const text = key.replaceAll("_", " ");
  return {
    label: text.charAt(0).toUpperCase() + text.slice(1),
    tone: "neutral",
  };
}

const BLUE = "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200";

/** State pill with one set of words and colours for phones, documents and screens. */
export function StatusPill({
  state,
  children,
}: {
  state: StatusState | (string & {});
  /** Replaces the default words, e.g. "Needs review: short 2 cs". */
  children?: ReactNode;
}) {
  const s = statusFor(state);
  const label = children ?? s.label;
  const content = "tick" in s && s.tick ? <>✓ {label}</> : label;
  if (s.tone === "info")
    return (
      <span
        className={`inline-flex w-fit items-center rounded-md px-2 py-0.5 text-xs font-medium ${BLUE}`}
      >
        {content}
      </span>
    );
  return <BasePill tone={s.tone}>{content}</BasePill>;
}
