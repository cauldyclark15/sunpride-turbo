"use client";

import { useRef, useSyncExternalStore } from "react";
import { apiFetch, useApi, useLive, useMutate } from "../../lib/api";
import type { Endpoints } from "./report-dto";

export type EndpointResult<K extends keyof Endpoints> = Endpoints[K]["result"];
export type EndpointArgs<K extends keyof Endpoints> = Endpoints[K]["args"];
export function reportPath(name: string) {
  // Location decisions remain VISITS-owned, never a second evidence writer here.
  if (name === "visits.location.decideLocationException")
    return "/api/v1/visits/location-exception/decide";
  return `/api/v1/fieldreports/${name.replaceAll(".", "/")}`;
}
export function useReport<K extends keyof Endpoints>(
  name: K,
  args: EndpointArgs<K> | "skip",
): EndpointResult<K> | undefined {
  const key = args === "skip" ? null : ["fieldreports", name, args];
  const result = useApi<EndpointResult<K>>(key, ({ signal }) =>
    apiFetch(reportPath(name), {
      query: { args: JSON.stringify(args) },
      signal,
    }),
  );
  const topic = name.startsWith("callSheets")
    ? "call_sheets"
    : name.startsWith("field_reports")
      ? "field_reports"
      : "supervision";
  useLive(args === "skip" ? null : [topic, "analytics"], [["fieldreports"]]);
  if (result.error) throw result.error;
  return result.data;
}
export function useReportCommand<K extends keyof Endpoints>(name: K) {
  const { mutate } = useMutate();
  const retries = useRef(new Map<string, string>());
  return async (args: EndpointArgs<K>): Promise<EndpointResult<K>> => {
    const fingerprint = JSON.stringify(args);
    let idempotencyKey = retries.current.get(fingerprint);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      retries.current.set(fingerprint, idempotencyKey);
    }
    const value = await mutate<EndpointResult<K>>(
      reportPath(name),
      { ...args, idempotencyKey },
      { idempotencyKey, invalidate: [["fieldreports"]] },
    );
    retries.current.delete(fingerprint);
    return value;
  };
}

const subscribeSearch = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  window.addEventListener("fieldreports:navigate", listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener("fieldreports:navigate", listener);
  };
};
/** Hydration-safe URL state: the server snapshot is empty, then the browser URL is observed. */
export function useReportSearch() {
  return useSyncExternalStore(
    subscribeSearch,
    () => window.location.search,
    () => "",
  );
}
export function replaceReportSearch(values: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event("fieldreports:navigate"));
}
