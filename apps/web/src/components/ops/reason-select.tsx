"use client";

import { useId } from "react";
import { apiFetch, useApi } from "@/lib/api";

export type ReasonCode = {
  code: string;
  label: string;
  category: string;
  direction: "in" | "out" | "both";
  requiresNote: boolean;
  requiresPhoto: boolean;
  approvalThresholdCentavos: number | null;
  active: boolean;
};

/** What the person must add for this reason, in plain words. */
export function reasonNeeds(reason: ReasonCode | null | undefined): string[] {
  if (!reason) return [];
  return [
    ...(reason.requiresNote ? ["a short note"] : []),
    ...(reason.requiresPhoto ? ["a photo"] : []),
  ];
}

/**
 * Pick a reason from the shared list (GET /api/v1/inventory/reason-codes).
 * `direction` keeps only reasons valid for stock going in or out ("both" always shows).
 */
export function ReasonSelect({
  value,
  onChange,
  direction,
  category,
  label = "Reason",
  disabled,
}: {
  value: string | null | undefined;
  onChange: (code: string, reason: ReasonCode | null) => void;
  direction?: "in" | "out";
  category?: string;
  label?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const query = { direction, category };
  const reasons = useApi<ReasonCode[]>(
    ["inventory", "reason-codes", query],
    ({ signal }) =>
      apiFetch<ReasonCode[]>("/api/v1/inventory/reason-codes", {
        query,
        signal,
      }),
  );
  const list = reasons.data ?? [];
  const chosen = list.find((r) => r.code === value) ?? null;
  const needs = reasonNeeds(chosen);
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-medium uppercase text-muted">
        {label}
      </label>
      <select
        id={id}
        className="min-h-12 w-full rounded-[10px] border border-field-border bg-field-background px-3 text-base"
        disabled={disabled || reasons.isLoading}
        value={chosen ? chosen.code : ""}
        onChange={(e) =>
          onChange(
            e.target.value,
            list.find((r) => r.code === e.target.value) ?? null,
          )
        }
      >
        <option value="">
          {reasons.isLoading ? "Loading reasons…" : "Choose a reason"}
        </option>
        {list.map((r) => (
          <option key={r.code} value={r.code}>
            {r.label}
          </option>
        ))}
      </select>
      {reasons.error ? (
        <p className="text-sm text-danger" role="alert">
          Could not load the reasons. Check your connection and try again.
        </p>
      ) : needs.length ? (
        <p className="text-sm text-muted">Needs {needs.join(" and ")}.</p>
      ) : null}
    </div>
  );
}
