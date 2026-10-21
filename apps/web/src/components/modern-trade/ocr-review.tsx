export function OcrReview({
  extraction,
}: {
  extraction?: { modelVersion?: string; text?: string } | null;
}) {
  if (!extraction?.text) return null;
  return (
    <details className="rounded-xl border border-line p-4">
      <summary className="cursor-pointer text-sm font-medium">
        Recognized source text · review before confirming
      </summary>
      <p className="mt-2 text-xs text-muted">
        {extraction.modelVersion}. Recognition is assistive, not a price or
        purchase-order approval. Edit the extracted fields below against the
        original.
      </p>
      <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-xs">
        {extraction.text}
      </pre>
    </details>
  );
}
