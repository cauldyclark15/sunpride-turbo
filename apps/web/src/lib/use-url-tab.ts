"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";

/**
 * Tab / view / selection state kept in the URL (list rule L8: it survives reload
 * and Back/Forward). The default value is left out of the URL so the plain page
 * address stays clean.
 *
 *   const [tab, setTab] = useUrlTab(["claims", "liability"] as const, "claims");
 *   // /finance-claims?tab=liability  → "liability"; unknown values fall back.
 *
 * Use a different `key` when the page already uses `?tab=` for an outer tab
 * (e.g. `useUrlTab(VIEWS, "list", "view")`). Switching tab clears `clear`
 * params (by default `page`), because a page number belongs to one tab's list.
 *
 * It writes with `history.pushState`, which the Next app router syncs into
 * `useSearchParams` (no navigation, no refetch) and which also works where no
 * app router is mounted (component tests).
 */
export function readUrlTab<T extends string>(
  params: URLSearchParams | { get(key: string): string | null } | null,
  ids: readonly T[],
  fallback: T,
  key = "tab",
): T {
  const value = params?.get(key) ?? null;
  return value !== null && (ids as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** `pathname?…` with `key` set to `value` (or removed when it is the default). */
export function hrefForTab(
  pathname: string,
  params: URLSearchParams,
  key: string,
  value: string,
  fallback: string,
  clear: readonly string[] = ["page"],
): string {
  const next = new URLSearchParams(params);
  for (const c of clear) next.delete(c);
  if (value === fallback) next.delete(key);
  else next.set(key, value);
  const qs = next.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export function useUrlTab<T extends string>(
  ids: readonly T[],
  fallback: T,
  key = "tab",
  clear: readonly string[] = ["page"],
): [T, (value: T) => void] {
  const search = useSearchParams();
  const pathname = usePathname() ?? "/";
  // Without a mounted app router (component tests) search is null: keep a local copy.
  const [local, setLocal] = useState<T | null>(null);
  const current = search
    ? readUrlTab(search, ids, fallback, key)
    : (local ?? fallback);
  const clearKey = clear.join(",");
  const set = useCallback(
    (value: T) => {
      const drop = clearKey ? clearKey.split(",") : [];
      setLocal(value);
      if (typeof window === "undefined") return;
      const live = new URLSearchParams(window.location.search);
      window.history.pushState(
        null,
        "",
        hrefForTab(
          window.location.pathname || pathname,
          live,
          key,
          value,
          fallback,
          drop,
        ),
      );
    },
    [pathname, key, fallback, clearKey],
  );
  return [current, set];
}
