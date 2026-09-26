"use client";

import { Button } from "@heroui/react";
import { Card, ListRow, StatusPill, WorkspaceIcon } from "@sunpride/ui";
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
        failure instanceof Error ? failure.message : "Check unavailable",
      );
    } finally {
      setChecking(false);
    }
  }
  return (
    <Card
      label="Exceptions"
      icon={<WorkspaceIcon name="field" />}
      count={rows.length}
      actions={
        <Button
          variant="outline"
          className="h-8"
          isDisabled={checking}
          onPress={() => void recheck()}
        >
          {checking ? "Checking…" : "Recheck"}
        </Button>
      }
    >
      <div className="grid gap-4">
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        {result === undefined && (
          <p className="text-[13px] text-muted">Loading exceptions…</p>
        )}
        {result && !rows.length && (
          <p className="text-[13px] text-muted">No exceptions here</p>
        )}
        {(["blocking", "advisory"] as const).map((severity) =>
          grouped[severity].length ? (
            <section key={severity}>
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
                {severity}
              </h3>
              <ul className="overflow-hidden rounded-xl border border-border">
                {grouped[severity].map((row, index) => (
                  <li
                    key={`${row.code}-${row.outletId ?? "plan"}-${row.serviceDate ?? ""}-${index}`}
                  >
                    <ListRow
                      icon={<WorkspaceIcon name="field" />}
                      title={row.message}
                      meta={`${row.code}${row.serviceDate ? ` · ${row.serviceDate}` : ""}${row.signedHistorical ? " · Historical" : ""} · ${row.remediation}`}
                      value={
                        <StatusPill
                          tone={severity === "blocking" ? "danger" : "warning"}
                        >
                          {severity}
                        </StatusPill>
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null,
        )}
        {result && !result.isDone && (
          <Button
            variant="outline"
            className="h-10"
            onPress={() => {
              setFresh(null);
              setPageState({ planId, cursor: result.continueCursor });
            }}
          >
            Next page
          </Button>
        )}
      </div>
    </Card>
  );
}
