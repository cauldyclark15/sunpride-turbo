"use client";

import { apiFetch, buildApiUrl, mutate, useApi, useLive } from "@/lib/api";
import type {
  AnalyticsPage,
  AnalyticsResponses,
  TargetLevel,
  TargetsResponse,
  ValuationResponse,
} from "./types";

/**
 * Typed fetchers for the management-read contract (ANALYTICS_V2 §1). In a
 * development build, `?fixture=1` (or the `sp_fixture` cookie set by `/fixture`)
 * swaps them for contract-shaped demo fixtures so the pages can be reviewed
 * without the API. Production builds never read fixtures.
 */

export type AnalyticsQuery = Record<string, string | undefined>;

export const ANALYTICS_TOPIC = "analytics";

export function fixtureModeAllowed() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- NODE_ENV is set by Next itself, not deployment config.
  return process.env.NODE_ENV !== "production";
}

/** Dev only: fixture mode from the URL flag or the cookie set by `/fixture`. */
export function isFixtureMode(): boolean {
  if (!fixtureModeAllowed() || typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).get("fixture") === "1")
    return true;
  return document.cookie.split(/;\s*/).includes("sp_fixture=1");
}

/** Drops empty values so equal views share one cache key. */
export function cleanQuery(query: AnalyticsQuery): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value !== undefined && value !== "") clean[key] = value;
  }
  return clean;
}

export function analyticsKey(page: AnalyticsPage, query: AnalyticsQuery) {
  return ["analytics", page, cleanQuery(query)] as const;
}

export function analyticsPath(page: AnalyticsPage) {
  return `/api/v1/analytics/${page}`;
}

export async function fetchAnalytics<P extends AnalyticsPage>(
  page: P,
  query: AnalyticsQuery,
  signal?: AbortSignal,
): Promise<AnalyticsResponses[P]> {
  if (isFixtureMode()) {
    const { analyticsFixture, fixtureNow } = await import("./fixtures");
    return analyticsFixture(page, cleanQuery(query), fixtureNow());
  }
  return apiFetch<AnalyticsResponses[P]>(analyticsPath(page), {
    query: cleanQuery(query),
    signal,
  });
}

/** One page's data, kept fresh by the `analytics` topic. `null` query skips. */
export function useAnalytics<P extends AnalyticsPage>(
  page: P,
  query: AnalyticsQuery | null,
) {
  const key = query ? analyticsKey(page, query) : null;
  const result = useApi<AnalyticsResponses[P]>(key, ({ signal }) =>
    fetchAnalytics(page, query ?? {}, signal),
  );
  useLive(ANALYTICS_TOPIC, [["analytics"]]);
  return result;
}

/** F-601 real Excel export of the same authorized view; historical helper name retained for callers. */
export function csvHref(page: AnalyticsPage, query: AnalyticsQuery) {
  return buildApiUrl(analyticsPath(page), {
    ...cleanQuery(query),
    format: "xlsx",
  });
}

// ---------- stock valuation (IP-INT2: the stock page reads /inventory/valuation, cost value first) ----------

export const VALUATION_PATH = "/api/v1/inventory/valuation";

/** Only the scope the page can pass on: a branch/depot. Cost basis, one row per product and place. */
export function valuationQuery(query: AnalyticsQuery) {
  const out: Record<string, string> = { basis: "cost", groupBy: "product" };
  if (query.locationId) out.locationId = query.locationId;
  return out;
}

export async function fetchValuation(
  query: AnalyticsQuery,
  signal?: AbortSignal,
): Promise<ValuationResponse> {
  if (isFixtureMode()) {
    const { analyticsFixture, fixtureNow, valuationFromStock } =
      await import("./fixtures");
    return valuationFromStock(
      analyticsFixture("stock", cleanQuery(query), fixtureNow()),
    );
  }
  return apiFetch<ValuationResponse>(VALUATION_PATH, {
    query: valuationQuery(query),
    signal,
  });
}

/** Stock value and quantity, kept fresh by the `inventory` topic. */
export function useValuation(query: AnalyticsQuery | null) {
  const result = useApi<ValuationResponse>(
    query ? ["inventory", "valuation", valuationQuery(query)] : null,
    ({ signal }) => fetchValuation(query ?? {}, signal),
  );
  useLive("inventory", [["inventory", "valuation"]]);
  return result;
}

/** Download of the same view in pesos (cost value column first). */
export function valuationCsvHref(query: AnalyticsQuery) {
  return buildApiUrl(VALUATION_PATH, {
    ...valuationQuery(query),
    format: "csv",
  });
}

// ---------- targets ----------

export function targetsKey(month: string, level: TargetLevel) {
  return ["targets", month, level] as const;
}

export async function fetchTargets(
  month: string,
  level: TargetLevel,
  signal?: AbortSignal,
): Promise<TargetsResponse> {
  if (isFixtureMode()) {
    const { targetsFixture } = await import("./fixtures");
    return targetsFixture(month, level);
  }
  return apiFetch<TargetsResponse>("/api/v1/targets", {
    query: { month, level },
    signal,
  });
}

export function useTargets(month: string, level: TargetLevel) {
  const result = useApi<TargetsResponse>(
    targetsKey(month, level),
    ({ signal }) => fetchTargets(month, level, signal),
  );
  useLive(ANALYTICS_TOPIC, [["targets"]]);
  return result;
}

export type SetTargetInput = {
  month: string;
  level: TargetLevel;
  key: string;
  amountCentavos: number;
};

export async function setTarget(
  input: SetTargetInput,
  idempotencyKey: string,
): Promise<unknown> {
  if (isFixtureMode()) return { ok: true };
  return mutate("/api/v1/targets/set", input, {
    idempotencyKey,
    invalidate: [["targets"], ["analytics"]],
  });
}

export type ImportTargetsInput = {
  month: string;
  rows: Array<{ level: TargetLevel; key: string; amountCentavos: number }>;
};

export type ImportTargetsResult = {
  imported?: number;
  errors?: Array<{ row: number; message: string }>;
};

export async function importTargets(
  input: ImportTargetsInput,
  idempotencyKey: string,
): Promise<ImportTargetsResult> {
  if (isFixtureMode()) return { imported: input.rows.length, errors: [] };
  return mutate<ImportTargetsResult>("/api/v1/targets/import", input, {
    idempotencyKey,
    invalidate: [["targets"], ["analytics"]],
  });
}

// ---------- unit picker ----------

export type UnitOption = { id: string; label: string; depth: number };

/**
 * Org units for the scope picker. ANALYTICS_V2 names no unit-list endpoint;
 * this reads the ORG lane's tree (`GET /api/v1/org/tree`, the port of
 * `org.queries.tree`). Any failure leaves the picker on the caller's scope.
 */
export async function fetchUnits(signal?: AbortSignal): Promise<UnitOption[]> {
  if (isFixtureMode()) {
    const { unitsFixture } = await import("./fixtures");
    return unitsFixture();
  }
  type Node = {
    id?: string;
    _id?: string;
    name?: string;
    label?: string;
    children?: Node[];
  };
  const raw = await apiFetch<Node[] | { units?: Node[]; nodes?: Node[] }>(
    "/api/v1/org/tree",
    { signal },
  );
  const roots = Array.isArray(raw) ? raw : (raw.units ?? raw.nodes ?? []);
  const out: UnitOption[] = [];
  const walk = (nodes: Node[], depth: number) => {
    for (const node of nodes) {
      const id = node.id ?? node._id;
      const label = node.label ?? node.name;
      if (id && label) out.push({ id, label, depth });
      if (node.children?.length && depth < 4) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

export function useUnits(enabled: boolean) {
  return useApi<UnitOption[]>(
    enabled ? ["org", "units", "picker"] : null,
    ({ signal }) => fetchUnits(signal),
  );
}
