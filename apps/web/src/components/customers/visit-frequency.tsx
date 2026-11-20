"use client";

import { useState } from "react";
import {
  parseVisitFrequency,
  visitFrequencySummary,
} from "@sunpride/customer-master";
import { mutate } from "../../lib/api";
import { buttonClass, inputClass, primaryClass } from "./customer-form";

export function VisitFrequencyPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const fixed = ["Weekly", "Every 2 weeks", "Monthly"];
  const custom = /^(.*) times? a month$/.exec(value);
  const selection = custom ? "custom" : value;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="grid gap-1 text-sm">
        Visit frequency
        <select
          className={`${inputClass} border-border`}
          value={selection}
          disabled={disabled}
          onChange={(e) =>
            onChange(
              e.target.value === "custom" ? "4 times a month" : e.target.value,
            )
          }
        >
          <option value="">Choose…</option>
          {!fixed.includes(value) && value && !custom ? (
            <option value={value}>{value}</option>
          ) : null}
          {fixed.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
          <option value="custom">N times a month</option>
        </select>
      </label>
      {custom ? (
        <label className="grid gap-1 text-sm">
          Required visits per month
          <input
            className={`${inputClass} border-border`}
            type="number"
            min={1}
            max={31}
            step={1}
            value={custom[1]}
            disabled={disabled}
            onChange={(e) => onChange(`${e.target.value} times a month`)}
          />
        </label>
      ) : null}
    </div>
  );
}

/** Shared single/bulk office operation. It does not save or overwrite enrollment fields. */
export function CustomerFrequencyEditor({
  customerIds,
  initialValue = "",
  summary,
  canManage,
  onDone,
  onCancel,
}: {
  customerIds: string[];
  initialValue?: string;
  summary?: string;
  canManage: boolean;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(
    initialValue === "Not set" ? "" : initialValue,
  );
  const [savedSummary, setSavedSummary] = useState(summary ?? "Not set");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function save() {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const parsed = parseVisitFrequency(value);
      await mutate(
        "/api/v1/customers/visit-frequency",
        { customerIds, visitFrequency: parsed.label },
        { invalidate: [["customers"], ["stores"], ["outlets"]] },
      );
      setSavedSummary(visitFrequencySummary(parsed.days, parsed.perMonth));
      setNotice(
        `Visit frequency saved for ${customerIds.length} ${customerIds.length === 1 ? "customer" : "customers"}.`,
      );
      onDone?.();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Visit frequency could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="grid gap-3 rounded-xl border border-border p-4"
      aria-label="Required customer visits"
    >
      <h3 className="font-semibold">Required visits</h3>
      {summary !== undefined ? (
        <p className="text-sm">{savedSummary}</p>
      ) : (
        <p className="text-sm">
          Set visit frequency for {customerIds.length} selected customers.
        </p>
      )}
      {canManage ? (
        <>
          <VisitFrequencyPicker
            value={value}
            onChange={setValue}
            disabled={busy}
          />
          <p className="text-xs text-muted">
            Set by the office or Sales Head. Weekly and every-two-week schedules
            follow the calendar; a monthly number is an exact requirement.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={primaryClass}
              disabled={busy || !value}
              onClick={save}
            >
              Save visit frequency
            </button>
            {onCancel ? (
              <button
                type="button"
                className={buttonClass}
                disabled={busy}
                onClick={onCancel}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
