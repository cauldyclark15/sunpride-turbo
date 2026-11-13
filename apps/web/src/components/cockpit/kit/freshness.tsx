import Link from "next/link";
import { useOptionalRole } from "@/lib/auth/session";
import { canAccessWebModule } from "@/lib/module-access";
import { manilaToday } from "../period";
import { formatTime } from "../format";
import type { ResponseHeader } from "../types";

type Behind = NonNullable<
  ResponseHeader["freshness"]["devicesBehindList"]
>[number];

/** SP-0175: where a "not synced" phone leads: Setup > Phones for those who may open it, else
 * the person's day. */
export function behindHref(device: Behind, canOpenPhones: boolean) {
  return canOpenPhones
    ? "/admin?section=devices"
    : `/coverage-people/agent?profileId=${encodeURIComponent(device.profileId)}&date=${manilaToday()}`;
}

/** "Rhea Santos's phone (FLD-07)": who, and which phone. */
export function behindLabel(device: Behind) {
  const app = device.app === "van-android" ? "van phone" : "phone";
  return device.name
    ? `${device.name}'s ${app} (${device.phone})`
    : `${app} ${device.phone}`;
}

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

/** "Updated 3:05 PM · 3 phones not synced since 2:10 PM": figures may still move. SP-0175: the
 * phones behind are named and each is a link (Setup > Phones for admins, else the person's day). */
export function FreshnessNote({
  freshness,
  canOpenPhones: canOpenPhonesProp,
}: {
  freshness: ResponseHeader["freshness"];
  canOpenPhones?: boolean;
}) {
  const role = useOptionalRole();
  const canOpenPhones = canOpenPhonesProp ?? canAccessWebModule("admin", role);
  const behind = freshness.devicesBehind > 0;
  const list = freshness.devicesBehindList ?? [];
  return (
    <div className="grid justify-items-start gap-0.5 sm:justify-items-end">
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
      {behind && list.length ? (
        <p className="text-[12px] text-[#a15c07]" data-testid="phones-behind">
          Not synced:{" "}
          {list.map((d, i) => (
            <span key={d.deviceId}>
              {i ? ", " : ""}
              <Link
                href={behindHref(d, canOpenPhones)}
                className="font-medium underline underline-offset-2 hover:text-foreground"
                title={
                  d.lastSeenAt
                    ? `Last synced ${formatTime(d.lastSeenAt)}`
                    : "Never synced"
                }
              >
                {behindLabel(d)}
              </Link>
            </span>
          ))}
          {freshness.devicesBehind > list.length
            ? ` and ${freshness.devicesBehind - list.length} more`
            : ""}
        </p>
      ) : null}
    </div>
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
