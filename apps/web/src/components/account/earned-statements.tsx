"use client";
import { useApi } from "../../lib/api";
import { peso, words } from "../tpm/model";
export type EarnedRow = {
  id: string;
  plan_name: string;
  plan_source: string;
  status: string;
  period_from: string;
  period_to: string;
  amountCentavos: number;
  result: {
    lines: {
      metric: string;
      actual: number | null;
      target: number | null;
      amountCentavos: number;
      excluded?: boolean;
    }[];
  };
};
export function EarnedStatementList({ rows }: { rows: EarnedRow[] }) {
  return (
    <div className="grid gap-3">
      {rows.length ? (
        rows.map((s) => (
          <article key={s.id} className="rounded-lg border border-border p-4">
            <h3 className="font-medium">
              {s.plan_name}
              {s.plan_source === "sample" ? " · Sample policy" : ""}
            </h3>
            <p className="text-sm">
              {s.period_from.slice(0, 10)} – {s.period_to.slice(0, 10)} ·{" "}
              {words(s.status)} · {peso(s.amountCentavos)}
            </p>
            <ul className="mt-2 grid gap-1 text-xs text-muted">
              {s.result.lines.map((l) => (
                <li key={l.metric}>
                  {words(l.metric)}:{" "}
                  {l.excluded
                    ? "Excluded by this effective plan"
                    : `${l.actual ?? "Unknown"} / ${l.target ?? "Unknown"}`}{" "}
                  · {peso(l.amountCentavos)}
                </li>
              ))}
            </ul>
          </article>
        ))
      ) : (
        <p className="text-sm text-muted">
          No earned statements have been calculated for your login yet.
        </p>
      )}
    </div>
  );
}
export function EarnedStatements({ partner }: { partner: boolean }) {
  const q = useApi<{ rows: EarnedRow[] }>(
    ["earned-statements", partner],
    partner ? "/api/v1/partners/incentives/mine" : "/api/v1/account/incentives",
  );
  return (
    <section className="grid gap-4 rounded-2xl border border-border bg-surface p-5 sm:p-6">
      <h2 className="text-lg font-semibold">Your earned incentives</h2>
      <p className="text-sm text-muted">
        Only your own governed statements appear here. Unknown evidence is not
        zero; zero-weight metrics are explicitly excluded. An approved statement
        is not proof of a bank payment. Ask Finance for a documented adjustment
        if a source needs correction.
      </p>
      {q.error ? (
        <p role="alert">
          Your statements could not be authorized. Sign in again or ask Finance
          to check your current access.
        </p>
      ) : q.data ? (
        <EarnedStatementList rows={q.data.rows} />
      ) : (
        <p>Loading your statements…</p>
      )}
    </section>
  );
}
