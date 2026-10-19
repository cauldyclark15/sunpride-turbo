"use client";

import { useEffect, useSyncExternalStore } from "react";
import { cachedSince, subscribeDataSource } from "@/lib/pwa/data-source";
import {
  applyUpdate,
  pwaServerSnapshot,
  pwaSnapshot,
  startPwa,
  subscribePwa,
} from "@/lib/pwa/runtime";

export function usePwa() {
  return useSyncExternalStore(subscribePwa, pwaSnapshot, pwaServerSnapshot);
}

/** "3:42 PM" today, "Oct 18, 3:42 PM" before today (Manila time). */
export function formatCachedAt(at: number, now = Date.now()) {
  const zone = "Asia/Manila";
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(ms);
  const time = new Intl.DateTimeFormat("en-PH", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  if (day(at) === day(now)) return time;
  const date = new Intl.DateTimeFormat("en-PH", {
    timeZone: zone,
    month: "short",
    day: "numeric",
  }).format(at);
  return `${date}, ${time}`;
}

/** Starts the worker and shows the "new version" toast on every page. */
export function PwaRuntime() {
  useEffect(() => startPwa(), []);
  const { waiting } = usePwa();
  if (!waiting) return null;
  return (
    <div
      role="status"
      className="ck-noprint fixed inset-x-3 z-[60] mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl border border-border bg-foreground px-4 py-2.5 text-[14px] text-background shadow-lg bottom-[calc(var(--phone-tabbar-height,0px)+0.75rem)]"
    >
      <span>A new version is ready</span>
      <button
        type="button"
        onClick={applyUpdate}
        className="min-h-11 rounded-lg bg-background px-4 text-[14px] font-semibold text-foreground"
      >
        Reload
      </button>
    </div>
  );
}

/** Thin line over the page whenever any figure on screen came from the cache. */
export function OfflineDataBanner() {
  const since = useSyncExternalStore(
    subscribeDataSource,
    cachedSince,
    () => null,
  );
  if (since === null) return null;
  return (
    <div
      role="status"
      data-offline-banner=""
      className="ck-noprint mb-3 rounded-lg border border-border bg-surface-secondary px-3 py-2 text-[13px] text-foreground"
    >
      Offline. Showing figures from {formatCachedAt(since)}.
    </div>
  );
}
