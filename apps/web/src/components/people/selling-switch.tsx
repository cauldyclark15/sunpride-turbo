"use client";

import { useState } from "react";

/** SP-0191: Setup > People "Selling" switch. Admin-only; the server decides and audits. */

export const SELLING_LINE =
  "Lets this person sell from the truck in the Field app";
export const SELLING_SALES_ONLY = "Only Sales people can sell from the truck.";

export type SellingTarget = {
  profileId: string;
  role: string;
  status: string;
  selling?: boolean;
};

/** The switch can be turned on only for an active Sales person; it can always be turned off. */
export function canSwitchSelling(
  target: Pick<SellingTarget, "role" | "status" | "selling">,
  canManage: boolean,
) {
  if (!canManage) return false;
  if (target.selling) return true;
  return target.role === "sales" && target.status === "active";
}

export function SellingSwitch({
  target,
  canManage,
  save,
}: {
  target: SellingTarget;
  canManage: boolean;
  save: (args: { profileId: string; selling: boolean }) => Promise<unknown>;
}) {
  const on = target.selling === true;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const enabled = canSwitchSelling(target, canManage) && !pending;
  async function toggle() {
    if (!enabled) return;
    setPending(true);
    setError("");
    try {
      await save({ profileId: target.profileId, selling: !on });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save. Try again.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      aria-label="Selling"
      className="flex items-start justify-between gap-4 rounded-lg border border-border p-3"
    >
      <div className="grid gap-1">
        <span
          id={`selling-${target.profileId}`}
          className="text-sm font-semibold text-foreground"
        >
          Selling
        </span>
        <span className="text-sm text-muted">{SELLING_LINE}</span>
        {target.role !== "sales" && !on ? (
          <span className="text-xs text-muted">{SELLING_SALES_ONLY}</span>
        ) : null}
        {error ? (
          <span role="alert" className="text-sm text-danger">
            {error}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`selling-${target.profileId}`}
        disabled={!enabled}
        onClick={() => void toggle()}
        className={`relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${on ? "bg-accent" : "bg-default"}`}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0.5"}`}
        />
        <span className="sr-only">{on ? "On" : "Off"}</span>
      </button>
    </section>
  );
}
