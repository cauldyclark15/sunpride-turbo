/** Shapes and pure rules of the Decide inbox (`GET /api/v1/decide/inbox`, `POST /api/v1/decide/act`). */

export type DecideKind =
  | "load_difference"
  | "transfer_variance"
  | "reload_difference"
  | "load_in_difference"
  | "count_review"
  | "disposition"
  | "cash_variance"
  | "override_review";

export type DecideItem = {
  id: string;
  ref: string;
  kind: DecideKind;
  kindLabel: string;
  title: string;
  documentNumber: string | null;
  askedBy: string | null;
  askedAt: number | null;
  valueCentavos: number | null;
  rule: string | null;
  link: string | null;
  canDecide: boolean;
  blockedReason: string | null;
  makerChecker: string;
  lines: Array<{ label: string; value: string }>;
  needs: { chargeTo?: boolean };
  openOnly?: boolean;
  sentBack?: { by: string | null; reason: string; at: number } | null;
};

export type DecideRecent = {
  kind: string;
  refId: string;
  verdict: "approved" | "rejected";
  reason: string;
  documentNumber: string | null;
  valueCentavos: number | null;
  at: number;
  by: string;
};

export type DecideInboxData = {
  asOf: number;
  total: number;
  counts: Partial<Record<DecideKind, number>>;
  kinds: Record<DecideKind, string>;
  items: DecideItem[];
  warnings: Array<{ kind: string; message: string }>;
  recent: DecideRecent[];
};

export type DecideForm = {
  verdict: "approve" | "reject";
  reason: string;
  chargeTo: string;
};

export const CHARGE_CHOICES = [
  { value: "dispatch_side", label: "Sending side (the depot)" },
  { value: "receive_side", label: "Receiving side" },
  { value: "carrier", label: "Carrier" },
  { value: "driver", label: "Driver" },
] as const;

const TRANSFER_KINDS: DecideKind[] = [
  "transfer_variance",
  "reload_difference",
  "load_in_difference",
];

export const isTransferKind = (kind: DecideKind) =>
  TRANSFER_KINDS.includes(kind);

/** What is wrong with the form, in words, before the server is asked. Empty means it can be sent. */
export function decideProblems(item: DecideItem, form: DecideForm): string[] {
  const problems: string[] = [];
  if (form.verdict === "reject" && form.reason.trim().length < 3)
    problems.push("Say why you are rejecting this, in a few words.");
  if (form.verdict === "approve" && item.needs.chargeTo && !form.chargeTo)
    problems.push(
      "Say who carries the difference: sending side, receiving side, carrier or driver.",
    );
  return problems;
}

/** The body the server takes. The key makes a double tap decide once. */
export function decideBody(item: DecideItem, form: DecideForm, key: string) {
  return {
    id: item.id,
    verdict: form.verdict,
    reason: form.reason.trim(),
    ...(form.verdict === "approve" && item.needs.chargeTo
      ? { chargeTo: form.chargeTo }
      : {}),
    idempotencyKey: key,
  };
}

/** "5 min", "3 h", "2 days": how long it has been waiting. */
export function ageText(since: number | null, now: number): string {
  if (since == null) return "—";
  const minutes = Math.max(0, Math.floor((now - since) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** The button label for a verdict, in the words of the kind. */
export function verdictLabels(kind: DecideKind) {
  switch (kind) {
    case "transfer_variance":
    case "reload_difference":
    case "load_in_difference":
      return { approve: "Write it off", reject: "Send back for a recount" };
    case "count_review":
      return { approve: "Approve count", reject: "Send back for a recount" };
    case "cash_variance":
      return { approve: "Accept", reject: "Investigate" };
    case "override_review":
      return { approve: "Looks fine", reject: "Flag it" };
    default:
      return { approve: "Approve", reject: "Reject" };
  }
}

/** Items shown for a kind filter (null = everything). */
export function filterItems(items: DecideItem[], kind: DecideKind | null) {
  return kind ? items.filter((i) => i.kind === kind) : items;
}
