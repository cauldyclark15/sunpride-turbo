"use client";

import { useState } from "react";
import { Card, Notice } from "@sunpride/ui";
import { apiFetch, useApi } from "../../lib/api";
import { SearchBox } from "../list-page/list-page";
import { coverageLine } from "./model";

export type LocationRow = {
  id: string;
  code: string;
  name: string;
  address: string;
  located: boolean;
};
export type Locations = {
  total: number;
  located: number;
  rows: LocationRow[];
  truncated: boolean;
};

const button =
  "inline-flex h-8 items-center rounded-lg border border-border bg-surface px-3 text-[13px] font-medium text-foreground hover:bg-default-soft";
const on =
  "inline-flex h-8 items-center rounded-lg border border-foreground bg-foreground px-3 text-[13px] font-medium text-background";

/** Pure view: coverage line, "No location yet" filter and the store list. */
export function LocationCoverageView({
  data,
  missingOnly,
  onMissingOnly,
  term = "",
  storeHref = (id) => `/customers/customer?storeId=${encodeURIComponent(id)}`,
}: {
  data: Locations;
  missingOnly: boolean;
  onMissingOnly: (v: boolean) => void;
  /** The search text, so an empty result names it (L7). */
  term?: string;
  storeHref?: (id: string) => string;
}) {
  const pct = data.total ? (100 * data.located) / data.total : 0;
  return (
    <div className="grid gap-3">
      <div>
        <p className="text-sm font-medium">
          {coverageLine(data.located, data.total)}
        </p>
        <div
          className="mt-2 h-2 overflow-hidden rounded-full bg-default-soft"
          role="meter"
          aria-label="Stores with a verified location"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <div className="h-full bg-foreground" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div role="tablist" aria-label="Location filter" className="flex gap-2">
        <button
          type="button"
          role="tab"
          aria-selected={!missingOnly}
          className={!missingOnly ? on : button}
          onClick={() => onMissingOnly(false)}
        >
          All stores
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={missingOnly}
          className={missingOnly ? on : button}
          onClick={() => onMissingOnly(true)}
        >
          No location yet ({(data.total - data.located).toLocaleString("en-PH")}
          )
        </button>
      </div>
      {data.rows.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data.rows.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <a className="min-w-0" href={storeHref(r.id)}>
                <span className="block truncate text-sm font-medium">
                  {r.name}
                </span>
                <span className="block truncate text-xs text-muted">
                  {r.address || "No address"}
                </span>
              </a>
              <span
                className={`shrink-0 text-xs ${r.located ? "text-muted" : "font-medium text-foreground"}`}
              >
                {r.located ? "Location verified" : "No location yet"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          {term
            ? `No store named “${term}”.`
            : missingOnly
              ? "Every store has a verified location."
              : "No stores yet."}
        </p>
      )}
      {data.truncated ? (
        <p className="text-xs text-muted">
          Showing the first {data.rows.length}. Search to narrow.
        </p>
      ) : null}
    </div>
  );
}

export function LocationCoverage() {
  const [missingOnly, setMissingOnly] = useState(false);
  const [term, setTerm] = useState("");
  const result = useApi<Locations>(
    ["masters", "store-locations", missingOnly, term],
    ({ signal }) =>
      apiFetch<Locations>("/api/v1/masters/store-locations", {
        query: { missing: missingOnly ? 1 : null, q: term || null, limit: 25 },
        signal,
      }),
  );
  return (
    <Card label="Store locations">
      {/* WEB-160: filters as you type (L2), like every other list. */}
      <div className="mb-3">
        <SearchBox q={term} placeholder="Find a store" onSearch={setTerm} />
      </div>
      {result.error ? (
        <Notice title={result.error.message} tone="danger" />
      ) : null}
      {result.data ? (
        <LocationCoverageView
          data={result.data}
          missingOnly={missingOnly}
          onMissingOnly={setMissingOnly}
          term={term}
        />
      ) : (
        <p className="text-sm text-muted">Loading…</p>
      )}
    </Card>
  );
}
