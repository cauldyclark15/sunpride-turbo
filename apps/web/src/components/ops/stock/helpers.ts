import type { DispositionDecision, DispositionRequest } from "./types";

/** "March 31, 2031 (1606 days)" — the Itemcount batch style, in plain words. */
export function expiryLabel(expiresAt: number, daysLeft: number): string {
  const date = new Date(expiresAt).toLocaleDateString("en-PH", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Manila",
  });
  if (daysLeft < 0) return `${date} (expired ${-daysLeft} ${-daysLeft === 1 ? "day" : "days"} ago)`;
  if (daysLeft === 0) return `${date} (expires today)`;
  return `${date} (${daysLeft} ${daysLeft === 1 ? "day" : "days"})`;
}

/** Colour of the days-left chip: red when gone or within 30 days, amber within 60, neutral after. */
export function expiryTone(daysLeft: number): "danger" | "warning" | "neutral" {
  if (daysLeft <= 30) return "danger";
  if (daysLeft <= 60) return "warning";
  return "neutral";
}

export const DECISION_CHOICES: {
  value: DispositionDecision;
  label: string;
  hint: string;
}[] = [
  { value: "write_off", label: "Write off", hint: "Take it off the books. Needs a reason." },
  { value: "return_to_supplier", label: "Return to supplier", hint: "Send it back. Add the return slip number." },
  { value: "destroy", label: "Destroy", hint: "Throw it away. Needs a photo as proof." },
  { value: "release", label: "Put back on sale", hint: "It is fine to sell. Say why." },
];

/** What the person still has to give before the request can be sent. Empty = ready. */
export function missingForRequest(input: {
  decision: DispositionDecision | null;
  quantityBase: number;
  maxBase: number;
  reasonCode: string | null;
  note: string;
  supplierRef: string;
  photos: number;
  reasonNeedsNote?: boolean;
  reasonNeedsPhoto?: boolean;
}): string[] {
  const out: string[] = [];
  if (!input.decision) return ["Choose what to do with this stock."];
  if (input.quantityBase < 1) out.push("Enter how many.");
  else if (input.quantityBase > input.maxBase) out.push("That is more than is waiting.");
  if (input.decision === "release") {
    if (!input.note.trim()) out.push("Say why this stock is fine to sell again.");
    return out;
  }
  if (!input.reasonCode) out.push("Choose a reason.");
  if (input.reasonNeedsNote && !input.note.trim()) out.push("Add a short note.");
  if (input.decision === "return_to_supplier" && !input.supplierRef.trim())
    out.push("Add the supplier or return slip number.");
  if ((input.decision === "destroy" || input.reasonNeedsPhoto) && input.photos < 1)
    out.push("Take a photo.");
  return out;
}

/** Plain sentence about who has to approve and why. */
export function approvalHint(r: Pick<DispositionRequest, "approvalLevel" | "approvalLimitCentavos">, formatPeso: (c: number | null) => string): string {
  return r.approvalLevel === "manager"
    ? `Needs a manager: over ${formatPeso(r.approvalLimitCentavos)}.`
    : "A supervisor can approve this.";
}

/** Download link for the stock CSV (money in pesos). */
export function csvQuery(query: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) p.set(k, v);
  p.set("format", "csv");
  return `/api/v1/inventory/valuation?${p.toString()}`;
}
