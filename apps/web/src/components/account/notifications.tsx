"use client";
import { useState } from "react";
import { useApi, mutate } from "../../lib/api";
export type AccountNotice = {
  id: string;
  kind: string;
  title: string;
  message: string;
  read: boolean;
  href: string;
  at?: number;
};
export function NotificationList({
  rows,
  onRead,
}: {
  rows: AccountNotice[];
  onRead?: (row: AccountNotice) => void;
}) {
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted">
        {rows.filter((r) => !r.read).length} unread in this view
      </p>
      {rows.length ? (
        rows.map((r) => (
          <article
            key={`${r.kind}:${r.id}`}
            className="rounded-lg border border-border p-3"
          >
            <h3 className="font-medium">{r.title}</h3>
            <p className="mt-1 text-sm">{r.message}</p>
            <div className="mt-2 flex flex-wrap gap-3 text-sm">
              <a href={r.href} className="underline">
                Open current details
              </a>
              {!r.read && onRead ? (
                <button className="underline" onClick={() => onRead(r)}>
                  Mark read
                </button>
              ) : null}
              {r.read ? <span className="text-muted">Read</span> : null}
            </div>
          </article>
        ))
      ) : (
        <p className="text-sm text-muted">
          No current notifications for your access.
        </p>
      )}
    </div>
  );
}
/** Fresh mount keys avoid reusing a previous account/scope's inbox; denials hide all retained rows. */
export function AccountNotifications({
  partner,
  readAlerts,
}: {
  partner: boolean;
  readAlerts: boolean;
}) {
  const [view] = useState(() => crypto.randomUUID()),
    [message, setMessage] = useState("");
  const base = partner
    ? "/api/v1/partners/notifications"
    : "/api/v1/account/claim-notices";
  const claims = useApi<{
    rows: AccountNotice[];
    mailMode: string;
    limitNote: string;
  }>(["account-notices", base, view], base);
  const alerts = useApi<{
    rows: { id: string; title: string; read: boolean }[];
  }>(readAlerts ? ["account-alerts", view] : null, "/api/v1/alerts");
  const rows = [
    ...(claims.data?.rows ?? []),
    ...(alerts.data?.rows ?? []).map((a) => ({
      ...a,
      kind: "alert",
      message:
        "Your subscribed threshold needs attention. Open the current authorized figures.",
      href: "/decide",
    })),
  ];
  async function read(row: AccountNotice) {
    setMessage("");
    try {
      await mutate(
        row.kind === "alert" ? "/api/v1/alerts/read" : base + "/read",
        { id: row.id, kind: row.kind },
        { invalidate: [["account-notices"], ["account-alerts"]] },
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The notification could not be updated.",
      );
    } finally {
      await Promise.all([claims.refetch(), alerts.refetch()]);
    }
  }
  const error = claims.error ?? alerts.error;
  return (
    <section
      aria-label="Your notifications"
      className="grid gap-4 rounded-2xl border border-border bg-surface p-5 sm:p-6"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Notifications</h2>
        <button
          className="text-sm underline"
          onClick={() => void Promise.all([claims.refetch(), alerts.refetch()])}
        >
          Refresh
        </button>
      </div>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm">
          {error.message}
        </p>
      ) : !claims.data || (readAlerts && !alerts.data) ? (
        <p className="text-sm text-muted">Loading current notifications…</p>
      ) : (
        <NotificationList rows={rows} onRead={(r) => void read(r)} />
      )}
      <p className="text-xs text-muted">
        {!claims.data
          ? "Email delivery mode loads with this inbox."
          : claims.data.mailMode === "dev_sink"
            ? "Development email sink: messages are recorded locally; no external email is sent."
            : "Configured email provider acceptance does not prove inbox delivery."}
      </p>
      {claims.data?.limitNote ? (
        <p className="text-xs text-muted">{claims.data.limitNote}</p>
      ) : null}
    </section>
  );
}
