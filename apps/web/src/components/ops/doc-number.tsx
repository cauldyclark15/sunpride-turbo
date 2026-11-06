const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** TYPE-LOC-YYMMDD-NNNN, e.g. TRF-CEB-261106-0012 (see core/docnum.js). */
const DOC_NUMBER = /^[A-Z]{1,4}-[A-Z0-9-]+-\d{6}-\d{4,}$/;

export const looksLikeDocNumber = (v: string) => DOC_NUMBER.test(v);

/** A document number in monospace. A raw UUID is never shown: it reads "No number yet". */
export function DocNumber({
  value,
  className = "",
}: {
  value: string | null | undefined;
  className?: string;
}) {
  const text = value?.trim();
  if (!text || UUID.test(text))
    return (
      <span className={`text-muted ${className}`.trim()}>No number yet</span>
    );
  return (
    <span
      className={`font-mono text-[0.95em] tracking-tight whitespace-nowrap ${className}`.trim()}
    >
      {text}
    </span>
  );
}
