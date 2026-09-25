"use client";

import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useConvex, useQuery } from "convex/react";
import { useState } from "react";

type Row = {
  code: string;
  severity: "blocking" | "advisory";
  outletId?: Id<"outlets">;
  serviceDate?: string;
  message: string;
  remediation: string;
  signedHistorical: boolean;
};
export function groupExceptions(rows: Row[]) {
  return {
    blocking: rows.filter((r) => r.severity === "blocking"),
    advisory: rows.filter((r) => r.severity === "advisory"),
  };
}
export function CoverageExceptions({
  planId,
}: {
  planId: Id<"coveragePlans">;
}) {
  const convex = useConvex();
  const [pageState, setPageState] = useState<{
    planId: Id<"coveragePlans">;
    cursor: string | null;
  } | null>(null);
  const [fresh, setFresh] = useState<{
    planId: Id<"coveragePlans">;
    rows: Row[];
  } | null>(null);
  const cursor = pageState?.planId === planId ? pageState.cursor : null;
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const args = { planId, paginationOpts: { numItems: 20, cursor } };
  const result = useQuery(api.coverage.exceptions.forPlan, args);
  const rows = fresh?.planId === planId ? fresh.rows : (result?.page ?? []);
  const grouped = groupExceptions(rows);
  async function recheck() {
    setChecking(true);
    setError("");
    try {
      const page = await convex.query(api.coverage.exceptions.forPlan, args);
      setFresh({ planId, rows: page.page });
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Preflight unavailable",
      );
    } finally {
      setChecking(false);
    }
  }
  return (
    <section aria-label="Coverage pre-approval exceptions">
      <h3>Exception preflight</h3>
      <p>
        Provisional policy pending client sign-off: missing verified GPS,
        duplicate locations and territory-only visits are advisory. Existing
        approval validation remains blocking.
      </p>
      <button type="button" disabled={checking} onClick={recheck}>
        {checking ? "Checking…" : "Recheck before approval"}
      </button>
      {error && <p role="alert">{error}</p>}
      {result === undefined && <p>Loading scoped exceptions…</p>}
      {result && !rows.length && (
        <p>
          No exceptions on this page. Approval still validates every row
          atomically.
        </p>
      )}
      {(["blocking", "advisory"] as const).map((severity) => (
        <div key={severity}>
          <h4>{severity === "blocking" ? "Blocking" : "Advisory"}</h4>
          <ul>
            {grouped[severity].map((row, index) => (
              <li
                key={`${row.code}-${row.outletId ?? "plan"}-${row.serviceDate ?? ""}-${index}`}
              >
                <strong>{row.code}</strong>{" "}
                {row.signedHistorical ? "Historical signed issue: " : ""}
                {row.message} {row.serviceDate ?? ""} — {row.remediation}
                {row.outletId && (
                  <span>
                    {" "}
                    · Outlet {row.outletId}: open the existing outlet/assignment
                    editor or edit the draft visit.
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {result && !result.isDone && (
        <button
          type="button"
          onClick={() => {
            setFresh(null);
            setPageState({ planId, cursor: result.continueCursor });
          }}
        >
          Next exceptions
        </button>
      )}
    </section>
  );
}
