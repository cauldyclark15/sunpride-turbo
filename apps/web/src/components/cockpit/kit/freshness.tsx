import { formatTime } from "../format";
import type { ResponseHeader } from "../types";

export function freshnessText(freshness: ResponseHeader["freshness"]) {
  const updated = `Updated ${formatTime(freshness.asOf)}`;
  if (!freshness.devicesBehind) return `${updated} · All phones synced`;
  const phones =
    freshness.devicesBehind === 1
      ? "1 phone not synced"
      : `${freshness.devicesBehind} phones not synced`;
  return freshness.oldestDeviceSyncAt
    ? `${updated} · ${phones} since ${formatTime(freshness.oldestDeviceSyncAt)}`
    : `${updated} · ${phones}`;
}

/** "Updated 3:05 PM · 3 phones not synced since 2:10 PM": figures may still move. */
export function FreshnessNote({
  freshness,
}: {
  freshness: ResponseHeader["freshness"];
}) {
  const behind = freshness.devicesBehind > 0;
  return (
    <p
      className={`inline-flex items-center gap-1.5 text-[12px] ${behind ? "text-[#a15c07]" : "text-muted"}`}
      title={
        behind
          ? "Figures can still change when those phones send what they recorded."
          : undefined
      }
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${behind ? "bg-[#d97706]" : "bg-[#2e9d59]"}`}
      />
      {freshnessText(freshness)}
    </p>
  );
}

export function DemoBadge({ demo }: { demo: boolean }) {
  if (!demo) return null;
  return (
    <span
      className="inline-flex h-6 items-center rounded-md border border-foreground/80 px-2 text-[11px] font-semibold uppercase tracking-wider text-foreground"
      title="These figures come from the demo company, not from Sunpride's records."
    >
      Demo data
    </span>
  );
}
