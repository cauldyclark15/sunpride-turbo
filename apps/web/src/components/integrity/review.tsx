"use client";

import { useState } from "react";
import { apiFetch, mutate, useApi, useLive } from "../../lib/api";
import { usePermissions } from "../../lib/auth";

export type IntegrityFinding = {
  id: string;
  rule: string;
  severity: string;
  person: string;
  outlet: string | null;
  occurredAt: number;
  evidence: Record<string, unknown>;
  disposition: { outcome: string; reasonCode: string } | null;
};
export type IntegrityQueue = {
  items: IntegrityFinding[];
  next: string | null;
  policySource: string;
  mockRate: {
    attempts: number;
    incidents: number;
    ratePct: number | null;
    targetBelowPct: number;
    priorPct: number | null;
    definition: string;
  };
};
export const integrityWords = (value: string) => value.replaceAll("_", " ");
const factLabel = (key: string) =>
  key === "varianceCentavos"
    ? "Cash difference"
    : integrityWords(
        key.replace(/Centavos$|Bps$/, " ").replace(/([a-z])([A-Z])/g, "$1 $2"),
      ).trim();
const factValue = (key: string, value: unknown) =>
  typeof value === "number" && key.endsWith("Centavos")
    ? new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
      }).format(value / 100)
    : typeof value === "number" && key.endsWith("Bps")
      ? `${new Intl.NumberFormat("en-PH", { maximumFractionDigits: 2 }).format(value / 100)}%`
      : String(value);
const panel = "grid gap-4 rounded-xl border border-border bg-surface p-5";
const button =
  "rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50";

/** F-221/F-606: real findings, not verdicts of guilt. Permission checks are repeated on the server. */
export function IntegrityReview() {
  const { can } = usePermissions();
  const [after, setAfter] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const result = useApi<IntegrityQueue>(
    can("integrity.read") ? ["integrity", "queue", after] : null,
    ({ signal }) =>
      apiFetch("/api/v1/integrity/queue", { query: { after }, signal }),
  );
  useLive(can("integrity.read") ? ["integrity"] : [], [["integrity"]]);
  if (!can("integrity.read")) return null;
  async function decide(findingId: string, outcome: string) {
    setBusy(true);
    setMessage("");
    try {
      await mutate(
        "/api/v1/integrity/dispose",
        {
          findingId,
          outcome,
          reasonCode:
            outcome === "needs_evidence"
              ? "request_supporting_evidence"
              : "investigator_review",
        },
        { invalidate: [["integrity"]], idempotencyKey: crypto.randomUUID() },
      );
      setMessage("Review saved. The original evidence is unchanged.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Review could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={panel} aria-label="Field integrity review">
      <div>
        <h2 className="text-lg font-semibold">
          Field integrity & unusual activity
        </h2>
        <p className="text-sm text-muted">
          What needs investigation? Signals are not proof of fraud.
        </p>
      </div>
      {result.error ? (
        <p role="alert">{result.error.message}</p>
      ) : !result.data ? (
        <p>Loading integrity checks…</p>
      ) : (
        <>
          <IntegrityRate rate={result.data.mockRate} />
          <p className="text-xs text-muted">
            Policy: {result.data.policySource}
          </p>
          {result.data.items.length === 0 ? (
            <p>
              {result.data.next
                ? "No visible findings on this page. Continue to the next page."
                : "No findings on this page."}
            </p>
          ) : null}
          {result.data.items.map((f) => (
            <article
              key={f.id}
              className="grid gap-2 border-t border-border pt-4"
            >
              <div className="flex flex-wrap justify-between gap-2">
                <h3 className="font-medium capitalize">
                  {integrityWords(f.rule)}
                </h3>
                <span className="text-xs capitalize">
                  {integrityWords(f.disposition?.outcome ?? "needs review")}
                </span>
              </div>
              <p className="text-sm">
                {f.person}
                {f.outlet ? ` · ${f.outlet}` : ""} ·{" "}
                {new Date(f.occurredAt).toLocaleString("en-PH", {
                  timeZone: "Asia/Manila",
                })}
              </p>
              <dl className="flex flex-wrap gap-4 text-sm">
                {Object.entries(f.evidence)
                  .filter(
                    ([key, value]) =>
                      !/id|observation|trip/i.test(key) &&
                      (typeof value === "number" ||
                        typeof value === "boolean" ||
                        (typeof value === "string" && value.length < 80)),
                  )
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt className="text-xs text-muted">{factLabel(key)}</dt>
                      <dd>{factValue(key, value)}</dd>
                    </div>
                  ))}
              </dl>
              {can("integrity.review") ? (
                <div className="flex flex-wrap gap-2">
                  {[
                    ["needs_evidence", "Request evidence"],
                    ["false_positive", "False alarm"],
                    ["confirmed", "Confirmed concern"],
                  ].map(([outcome, label]) => (
                    <button
                      key={outcome}
                      className={button}
                      disabled={busy}
                      onClick={() => void decide(f.id, outcome!)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
          <div className="flex gap-3">
            {after ? (
              <button className={button} onClick={() => setAfter(null)}>
                Back to first
              </button>
            ) : null}
            {result.data.next ? (
              <button
                className={button}
                onClick={() => setAfter(result.data!.next)}
              >
                Next findings
              </button>
            ) : null}
          </div>
        </>
      )}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </section>
  );
}

/** F-221: unknown is not zero; the client exit threshold is strictly less than 0.5%. */
export function IntegrityRate({ rate }: { rate: IntegrityQueue["mockRate"] }) {
  return (
    <div className="grid gap-2 rounded-lg bg-default-soft p-4">
      <h3 className="font-medium">Mock-location rate · last 7 days</h3>
      <p className="text-2xl tabular-nums">
        {rate.ratePct === null ? "Not measured" : `${rate.ratePct.toFixed(2)}%`}
      </p>
      <p className="text-sm">
        Exit target: below {rate.targetBelowPct}% · Previous 7 days:{" "}
        {rate.priorPct === null
          ? "not measured"
          : `${rate.priorPct.toFixed(2)}%`}
      </p>
      <p className="text-sm">
        {rate.incidents} flagged attempts out of {rate.attempts}.{" "}
        {rate.ratePct === null
          ? "Record signed check-in attempts before judging the exit gate."
          : rate.ratePct < rate.targetBelowPct
            ? "Within target for observed server attempts; this alone does not certify the route-level exit gate."
            : "Above target. Review flagged phones and their check-ins."}
      </p>
      <p className="text-xs text-muted">{rate.definition}</p>
    </div>
  );
}
