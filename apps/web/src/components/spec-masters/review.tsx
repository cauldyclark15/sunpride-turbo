"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import { Card, Notice } from "@sunpride/ui";
import { apiFetch, mutate, useApi } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import type { Choice } from "./model";
const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm";
/** F-011 census queue, rebuilt as the SP-0162 store gathering review. */
export { StoreGatheringReview as CensusReview } from "../store-gathering/review";
type Preview = {
  potentialCentavos: number;
  derivedClass: string;
  policyVersionId: string;
};
type Inputs = {
  transactionsPerDay: number;
  averageBasketCentavos: number;
  tradingDaysPerMonth: number;
  captureRatePct: number;
};
/** F-014 scoring preview and immutable per-store decision history. */
export function OutletClassification({ outlets }: { outlets: Choice[] }) {
  const { can } = usePermissions(),
    [outlet, setOutlet] = useState(""),
    [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null),
    [inputs, setInputs] = useState<Inputs | null>(null);
  const history = useApi<{
    decisions: {
      id: string;
      assignedClass: string;
      derivedClass: string;
      reason: string;
      actorName: string;
      potentialCentavos: number;
    }[];
  }>(
    outlet ? ["masters", "class-history", outlet] : null,
    `/api/v1/masters/outlets/${outlet}/history`,
  );
  async function score(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const input = {
      transactionsPerDay: Number(f.get("transactions")),
      averageBasketCentavos: Math.round(Number(f.get("basket")) * 100),
      tradingDaysPerMonth: Number(f.get("days")),
      captureRatePct: Number(f.get("capture")),
    };
    try {
      setPreview(
        await apiFetch<Preview>("/api/v1/masters/class-preview", {
          method: "POST",
          body: { inputs: input },
        }),
      );
      setInputs(input);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Preview failed.");
    }
  }
  async function assign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!preview || !inputs) return;
    const f = new FormData(e.currentTarget);
    try {
      await mutate(
        "/api/v1/masters/outlets/classify",
        {
          outletId: outlet,
          policyVersionId: preview.policyVersionId,
          inputs,
          overrideClass: String(f.get("class")) || null,
          reason: f.get("reason"),
        },
        { idempotencyKey: crypto.randomUUID(), invalidate: [["masters"]] },
      );
      setPreview(null);
      setMessage(
        "Potential class recorded with its inputs and policy version.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Classification failed.");
    }
  }
  if (!can("outlet.verify")) return null;
  return (
    <Card label="Classify a store by revenue potential">
      <label className="grid gap-1 text-xs">
        Store
        <select
          className={field}
          value={outlet}
          onChange={(e) => {
            setOutlet(e.target.value);
            setPreview(null);
          }}
        >
          <option value="">Choose…</option>
          {outlets.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      <form
        onSubmit={score}
        onChange={() => setPreview(null)}
        className="mt-3 grid gap-3"
      >
        <p className="text-sm text-muted">
          Estimate what the store could sell, not its recorded sales.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {[
            ["transactions", "Potential transactions per day", "100"],
            ["basket", "Average basket (₱)", "100"],
            ["days", "Trading days per month", "30"],
            ["capture", "Expected share captured (%)", "50"],
          ].map(([name, label, value]) => (
            <label key={name} className="grid gap-1 text-xs">
              {label}
              <input
                type="number"
                className={field}
                name={name}
                defaultValue={value}
                min="0"
                step={name === "basket" ? "0.01" : "1"}
                required
              />
            </label>
          ))}
        </div>
        <Button type="submit" variant="outline" isDisabled={!outlet}>
          Preview potential class
        </Button>
      </form>
      {preview ? (
        <form
          onSubmit={assign}
          className="mt-3 grid gap-3 rounded-lg border border-border p-3"
        >
          <p>
            Estimated monthly potential:{" "}
            {new Intl.NumberFormat("en-PH", {
              style: "currency",
              currency: "PHP",
            }).format(preview.potentialCentavos / 100)}{" "}
            · derived class {preview.derivedClass}
          </p>
          <label className="grid gap-1 text-xs">
            Assigned class (override requires a reason)
            <select
              className={field}
              name="class"
              defaultValue={preview.derivedClass}
            >
              {["A", "B", "C", "D"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            Decision reason
            <input className={field} name="reason" required />
          </label>
          <Button type="submit" variant="outline">
            Record class decision
          </Button>
        </form>
      ) : null}
      {history.error ? (
        <Notice title={history.error.message} tone="danger" />
      ) : null}
      {history.data?.decisions.map((d) => (
        <p key={d.id} className="mt-2 text-sm">
          Class {d.assignedClass}
          {d.assignedClass !== d.derivedClass
            ? ` (derived ${d.derivedClass})`
            : ""}{" "}
          · {d.actorName} · {d.reason}
        </p>
      ))}
      {message ? (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      ) : null}
    </Card>
  );
}
