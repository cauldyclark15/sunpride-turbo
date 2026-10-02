"use client";
import { useEffect, useState } from "react";
import { absoluteTimestamp, relativeTimestamp } from "../../lib/issues";
export function IssueTimestamp({
  value,
  label = "Updated",
}: {
  value: number;
  label?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const absolute = absoluteTimestamp(value);
  return (
    <time
      suppressHydrationWarning
      dateTime={new Date(value).toISOString()}
      title={absolute}
      aria-label={`${label} ${absolute}`}
    >
      {relativeTimestamp(value, now)} · {absolute}
    </time>
  );
}
