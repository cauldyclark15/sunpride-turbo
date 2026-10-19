import { humanize, toneFor } from "../format";
import { TONE_DOT, TONE_TEXT } from "./tone";

export function StatusDot({ status }: { status: string | null | undefined }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-2 shrink-0 rounded-full ${TONE_DOT[toneFor(status)]}`}
    />
  );
}

/** A status word with its colour dot; `label` overrides the plain-words default. */
export function StatusChip({
  status,
  label,
}: {
  status: string | null | undefined;
  label?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] font-medium ${TONE_TEXT[toneFor(status)]}`}
    >
      <StatusDot status={status} />
      {label ?? humanize(status)}
    </span>
  );
}
