import type { ReactNode } from "react";
export type FiscalSapPosting = {
  status: string;
  reference: string | null;
  source: string | null;
};
/** F-119: queueing is never an acknowledgement; mock acknowledgements stay visibly SAMPLE. */
export function FiscalPosting({
  posting,
}: {
  posting?: FiscalSapPosting | null;
}): ReactNode {
  if (!posting) return <span>No linked business posting</span>;
  if (
    posting.status === "completed" &&
    posting.reference &&
    ["sap", "sample"].includes(posting.source ?? "")
  )
    return (
      <span>
        {posting.source === "sample" ? "SAMPLE SAP accepted" : "SAP accepted"} ·{" "}
        {posting.reference}
      </span>
    );
  const words: Record<string, string> = {
    pending: "Queued for SAP",
    processing: "Sending to SAP",
    failed: "SAP retry pending",
    dead_letter: "SAP refused — open integration exceptions",
    quarantined: "Posting conflict — open integration exceptions",
  };
  return <span>{words[posting.status] ?? "SAP result needs review"}</span>;
}
