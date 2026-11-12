"use client";
import { formatStatus } from "../../../lib/format";
import { useState, type FormEvent } from "react";
import { mutate, useApi, useLive } from "../../../lib/api";
import { usePermissions } from "../../../lib/auth";

type Named = { id: string; name: string; code: string };
type Dataset = {
  id: string;
  purpose: string;
  source_reference: string;
  split: string;
  source_type: string;
};
type Model = {
  id: string;
  purpose: string;
  version: number;
  status: string;
  sample: boolean;
  metrics: { mae?: number; baselineMae?: number; accuracy?: number | null };
};
type Run = {
  id: string;
  purpose: string;
  status: string;
  reviews?: {
    decision: string;
    correction: unknown;
    reason: string;
    created_at: string;
  }[];
  input: { sample: boolean };
  result: {
    quantityBase?: number;
    planogramCompliancePct?: number | null;
    ruleQuantityBase?: number;
    reason?: string;
    rows?: {
      productCode: string;
      facingCount: number;
      shareOfShelfPct: number | null;
      compliant: boolean | null;
    }[];
  };
};
type Data = {
  outlets: Named[];
  products: Named[];
  models: Model[];
  datasets: Dataset[];
  runs: Run[];
  truncated: boolean;
};
const field = "rounded-md border border-border bg-surface p-2 text-sm";
const orderInputs = [
  ["historyDailyBase", "Prior purchase daily base units"],
  ["offtakeDailyBase", "Observed daily offtake"],
  ["seasonSin", "Season sine"],
  ["seasonCos", "Season cosine"],
  ["promotionUpliftPct", "Governed promotion uplift %"],
  ["stockBase", "Observed stock base units"],
  ["coverDays", "Days to cover"],
  ["nextOrderBase", "Actual next order base units"],
] as const;
export function ModelWorkbench() {
  const access = usePermissions(),
    canEdit = access.can("masterdata.manage");
  const query = useApi<Data>(
    ["analytics", "models"],
    "/api/v1/analytics/models",
  );
  useLive("analytics", [["analytics", "models"]]);
  const [purpose, setPurpose] = useState("order_backtest"),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function action(name: string, body: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      await mutate("/api/v1/analytics/models/" + name, {
        ...body,
        idempotencyKey: crypto.randomUUID(),
      });
      await query.refetch();
      setMessage("Saved. Review the refreshed result below.");
    } catch {
      setMessage(
        "Not saved. Check source permissions, required inputs and independent approval.",
      );
    } finally {
      setBusy(false);
    }
  }
  function saveDataset(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    let annotations: Record<string, unknown>;
    try {
      annotations =
        purpose === "order_backtest"
          ? Object.fromEntries(
              orderInputs.map(([key]) => [key, Number(d.get(key))]),
            )
          : JSON.parse(String(d.get("annotations")));
    } catch {
      setMessage("Enter valid detection JSON.");
      return;
    }
    void action("dataset", {
      purpose,
      outletId: d.get("outletId"),
      productId: d.get("productId") || null,
      observedAt: new Date(String(d.get("observedAt"))).toISOString(),
      retainUntil: new Date(String(d.get("retainUntil"))).toISOString(),
      sourceReference: d.get("sourceReference"),
      consentReference: d.get("consentReference"),
      sourceType: d.get("sourceType"),
      split: d.get("split"),
      annotations,
    });
  }
  if (query.error)
    return (
      <section role="alert">
        Model sources are unavailable. Existing rules and manual shelf checks
        remain in use.
      </section>
    );
  if (!query.data) return <p>Loading reviewed model sources…</p>;
  const data = query.data;
  return (
    <section className="grid gap-4 border-t border-border pt-5">
      <h2 className="text-lg">Reviewed shelf and ordering models</h2>
      <p className="text-sm text-muted">
        Use models only when they improve the existing rule. Compare temporal
        holdout error, then require independent approval. Missing inputs keep
        the rule; shelf predictions never replace a human-verified measurement
        automatically.
      </p>
      {data.truncated ? (
        <p role="status">
          Only the first available records are shown. Narrow the source set
          before preparing a model.
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      <div className="grid gap-2">
        {data.models.map((m) => (
          <article key={m.id} className="border-b border-border py-2">
            <p>
              {m.purpose === "shelf" ? "Shelf recognition" : "Suggested order"}{" "}
              · version {m.version} · {formatStatus(m.status)}
              {m.sample ? " · Sample" : ""}
            </p>
            <p className="text-sm text-muted">
              {m.purpose === "shelf"
                ? "Accuracy is not certified; validate representative images."
                : `Held-out error ${m.metrics.mae?.toFixed(2) ?? "Unknown"} versus rule ${m.metrics.baselineMae?.toFixed(2) ?? "Unknown"} base units.`}
            </p>
            {canEdit && m.status === "candidate" ? (
              <button
                disabled={busy}
                className={field}
                onClick={() => void action("approve", { modelId: m.id })}
              >
                Independently approve version {m.version}
              </button>
            ) : null}
          </article>
        ))}
      </div>
      {canEdit ? (
        <details>
          <summary>Prepare a governed training example</summary>
          <form
            onSubmit={saveDataset}
            className="mt-3 grid gap-3 md:grid-cols-2"
          >
            <label>
              Purpose
              <select
                className={field}
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
              >
                <option value="order_backtest">Next-order backtest</option>
                <option value="shelf_ground_truth">Reviewed shelf photo</option>
              </select>
            </label>
            <label>
              Store
              <select required name="outletId" className={field}>
                {data.outlets.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} · {o.code}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Product
              <select
                name="productId"
                className={field}
                required={purpose === "order_backtest"}
              >
                <option value="">Whole shelf</option>
                {data.products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.code}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Observed at
              <input
                name="observedAt"
                type="datetime-local"
                required
                className={field}
              />
            </label>
            <label>
              Retain until
              <input
                name="retainUntil"
                type="datetime-local"
                required
                className={field}
              />
            </label>
            <label>
              {purpose === "shelf_ground_truth"
                ? "Original field-photo reference"
                : "Purchase/offtake source reference"}
              <input name="sourceReference" required className={field} />
            </label>
            <label>
              Consent or source permission
              <input name="consentReference" required className={field} />
            </label>
            <label>
              Source
              <select name="sourceType" className={field}>
                <option value="sample">Clearly marked sample</option>
                <option value="real">Reviewed operational facts</option>
              </select>
            </label>
            <label>
              Partition
              <select name="split" className={field}>
                <option value="train">Earlier training period</option>
                <option value="temporal_holdout">
                  Later untouched holdout
                </option>
                <option value="validation">Shelf validation</option>
              </select>
            </label>
            {purpose === "order_backtest" ? (
              orderInputs.map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    className={field}
                    name={key}
                    type="number"
                    step="any"
                    required
                  />
                </label>
              ))
            ) : (
              <label>
                Reviewed detections and expected facings
                <textarea
                  name="annotations"
                  required
                  className={field}
                  placeholder={'{"detections":[],"expectedFacings":{}}'}
                />
              </label>
            )}
            <button disabled={busy} className={field}>
              Save reviewed example
            </button>
          </form>
        </details>
      ) : null}
      {canEdit ? (
        <details>
          <summary>Train or register a candidate version</summary>
          <form
            className="grid gap-3 mt-3"
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              void action("train", {
                purpose: d.get("purpose"),
                datasetIds: d.getAll("dataset"),
                adapterVersion: d.get("adapterVersion"),
              });
            }}
          >
            <label>
              Model
              <select name="purpose" className={field}>
                <option value="suggested_order">
                  Train local order regression
                </option>
                <option value="shelf">
                  Register configured shelf detector
                </option>
              </select>
            </label>
            <p className="text-sm">
              Choose one store/product. Ordering needs at least eight earlier
              examples and two later holdouts; do not put future outcomes in
              earlier input features.
            </p>
            <select
              aria-label="Training examples"
              name="dataset"
              multiple
              required
              className={field}
            >
              {data.datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.source_reference} · {d.split} · {d.source_type}
                </option>
              ))}
            </select>
            <label>
              Pinned shelf adapter artifact version
              <input name="adapterVersion" className={field} />
            </label>
            <button disabled={busy} className={field}>
              Save candidate version
            </button>
          </form>
        </details>
      ) : null}
      {canEdit ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            void action("predict", {
              modelId: d.get("model"),
              datasetId: d.get("dataset"),
            });
          }}
        >
          <select
            aria-label="Approved model"
            name="model"
            required
            className={field}
          >
            {data.models
              .filter((m) => m.status === "approved")
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.purpose} v{m.version}
                  {m.sample ? " · Sample" : ""}
                </option>
              ))}
          </select>
          <select
            aria-label="Inference source"
            name="dataset"
            required
            className={field}
          >
            {data.datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.source_reference}
              </option>
            ))}
          </select>
          <button disabled={busy} className={field}>
            Run reviewed source
          </button>
        </form>
      ) : null}
      {data.runs.map((r) => (
        <article key={r.id} className="grid gap-2 border-t border-border pt-3">
          <h3>
            {r.purpose === "shelf" ? "Shelf photo" : "Order suggestion"} ·{" "}
            {formatStatus(r.status)}
            {r.input.sample ? " · Sample" : ""}
          </h3>
          <p>
            {r.result.reason ??
              (r.result.quantityBase != null
                ? `Proposed ${r.result.quantityBase} base units; rule ${r.result.ruleQuantityBase ?? "Unknown"}.`
                : "Review each recognized facing.")}
          </p>
          {r.reviews?.map((review, i) => (
            <p key={review.created_at + i} className="text-sm">
              {i === 0 ? "Latest review" : "Earlier review"} · {review.decision}
              : {review.reason}
              {review.correction
                ? ` · Corrected facts: ${JSON.stringify(review.correction)}`
                : ""}
            </p>
          ))}
          {r.purpose === "shelf" ? (
            <p>
              Planogram slot match:{" "}
              {r.result.planogramCompliancePct == null
                ? "Unknown"
                : `${r.result.planogramCompliancePct}%`}
            </p>
          ) : null}
          {r.result.rows?.map((row) => (
            <p key={row.productCode}>
              {row.productCode}: {row.facingCount} facings · share{" "}
              {row.shareOfShelfPct ?? "Unknown"}% · target{" "}
              {row.compliant == null
                ? "Unknown"
                : row.compliant
                  ? "met"
                  : "missed"}
            </p>
          ))}
          {canEdit ? (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                try {
                  void action("review", {
                    runId: r.id,
                    decision: d.get("decision"),
                    reason: d.get("reason"),
                    correction: d.get("correction")
                      ? JSON.parse(String(d.get("correction")))
                      : null,
                  });
                } catch {
                  setMessage("Enter valid correction JSON.");
                }
              }}
            >
              <select
                aria-label="Review decision"
                name="decision"
                className={field}
              >
                <option value="accepted">Accept</option>
                <option value="corrected">Correct</option>
                <option value="rejected">Reject</option>
              </select>
              <input
                aria-label="Review reason"
                name="reason"
                required
                placeholder="Review reason"
                className={field}
              />
              <input
                aria-label="Correction JSON"
                name="correction"
                placeholder={
                  r.purpose === "shelf"
                    ? "Corrected detection JSON"
                    : '{"quantityBase":0}'
                }
                className={field}
              />
              <button disabled={busy} className={field}>
                Save independent review
              </button>
            </form>
          ) : null}
        </article>
      ))}
    </section>
  );
}
