"use client";
import { formatDateTime } from "../lib/format";
import Image from "next/image";
import { useState } from "react";
import { useApi } from "../lib/api";
export type CollectionEvidenceItem = {
  id: string;
  note: string;
  collector: string;
  capturedAt: number;
  receivedAt: number;
  photo: {
    mimeType: "image/jpeg";
    bytesBase64: string;
    width: number;
    height: number;
  } | null;
};
/** F-613 photos stay in the scoped canonical Money capture, never a public object URL. */
export function CollectionEvidenceView({
  items,
}: {
  items: CollectionEvidenceItem[];
}) {
  return (
    <div className="grid gap-2">
      {items.length === 0 ? (
        <p className="text-xs text-muted">
          No field capture evidence received. A phone-only queued capture may
          still exist.
        </p>
      ) : (
        items.map((i) => (
          <article
            key={i.id}
            className="grid gap-1 rounded border border-border p-2"
          >
            <p className="text-sm">
              {i.collector} · {i.note}
            </p>
            <p className="text-xs text-muted">
              Captured {formatDateTime(i.capturedAt)} · received{" "}
              {formatDateTime(i.receivedAt)}
            </p>
            {i.photo && (
              <Image
                src={`data:image/jpeg;base64,${i.photo.bytesBase64}`}
                width={i.photo.width}
                height={i.photo.height}
                unoptimized
                className="max-h-72 w-auto max-w-full rounded object-contain"
                alt="Collector-captured cheque or bank-notice evidence"
              />
            )}
          </article>
        ))
      )}
    </div>
  );
}
function ReadEvidence({
  kind,
  id,
}: {
  kind: "cheque" | "promise";
  id: string;
}) {
  const read = useApi<{ items: CollectionEvidenceItem[] }>(
    ["money", "collection-evidence", kind, id],
    `/api/v1/money/collections/evidence?${kind === "cheque" ? "chequeId" : "promiseId"}=${encodeURIComponent(id)}`,
  );
  if (read.error)
    return (
      <p role="alert">
        Evidence unavailable under the current account permission. Reconnect or
        ask an administrator.
      </p>
    );
  if (!read.data)
    return <p className="text-xs text-muted">Loading authorized evidence…</p>;
  return <CollectionEvidenceView items={read.data.items} />;
}
export function CollectionEvidence({
  kind,
  id,
}: {
  kind: "cheque" | "promise";
  id: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        className="min-h-10 rounded-[10px] border border-border px-3 py-2 text-sm"
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide" : "Review"} field capture evidence
      </button>
      {open && <ReadEvidence kind={kind} id={id} />}
    </div>
  );
}
