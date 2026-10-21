"use client";
import { peso, words } from "./model";
export type EvidenceSnapshot = {
  occurredAt?: number;
  amountCentavos?: number;
  quantityBase?: string;
  unitsPerUom?: number;
  uom?: string;
  productId?: string;
  campaignVersionId?: string;
  partyType?: string;
};
export type EvidencePreview = {
  kind: string;
  source_id: string;
  snapshot?: EvidenceSnapshot;
};
/** F-506 readable source facts and an authenticated original-image view, never visual certification. */
export function ClaimEvidencePreview({
  claimId,
  evidence,
}: {
  claimId: string;
  evidence: EvidencePreview[];
}) {
  return (
    <div className="grid gap-3">
      {evidence.map((e, i) => (
        <article
          key={`${e.kind}:${e.source_id}:${i}`}
          className="rounded-lg border border-border p-3"
        >
          <h4 className="font-medium">{words(e.kind)}</h4>
          <p className="text-xs text-muted">
            {e.snapshot?.occurredAt != null
              ? new Date(e.snapshot.occurredAt).toLocaleDateString("en-PH", {
                  timeZone: "Asia/Manila",
                })
              : "Source date unavailable"}
          </p>
          <p className="text-sm">
            {e.snapshot?.amountCentavos != null
              ? `Source value: ${peso(e.snapshot.amountCentavos)}`
              : "This evidence does not certify a monetary value."}
          </p>
          {e.snapshot?.quantityBase != null ? (
            <p className="text-sm">
              {e.snapshot.quantityBase} source base units
              {e.snapshot.unitsPerUom
                ? ` · ${e.snapshot.unitsPerUom} base units per ${e.snapshot.uom}`
                : ""}
            </p>
          ) : null}
          {e.kind === "photo" ? (
            <a
              href={`/api/v1/tpm/claims/photo?id=${encodeURIComponent(claimId)}&sourceId=${encodeURIComponent(e.source_id)}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm underline"
            >
              Open original photograph for review
            </a>
          ) : null}
          {e.kind === "source_document" &&
          e.snapshot?.partyType === "distributor" ? (
            <a
              href={`/api/v1/tpm/claims/source-file?id=${encodeURIComponent(claimId)}&sourceId=${encodeURIComponent(e.source_id)}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm underline"
            >
              Open original document
            </a>
          ) : null}
        </article>
      ))}
      <p className="text-xs text-muted">
        Stored bytes and source records are verified separately from visual
        compliance. Missing or changed monetary proof cannot be waived.
      </p>
    </div>
  );
}
