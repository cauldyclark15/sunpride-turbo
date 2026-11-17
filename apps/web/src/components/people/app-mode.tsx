"use client";

import { useState } from "react";

/**
 * SP-0194: Setup > People "App mode" — which Field app the office gives each person.
 * The server decides, audits and keeps the old Selling switch in step; this only shows the choice.
 */

export type AppMode = "mapping" | "visits" | "selling";

export const APP_MODES: { value: AppMode; label: string; line: string }[] = [
  {
    value: "mapping",
    label: "Customer mapping",
    line: "Add and update customers. Home is one big Add customer button.",
  },
  {
    value: "visits",
    label: "Field visits",
    line: "Store visits, route and orders.",
  },
  {
    value: "selling",
    label: "Truck selling",
    line: "Sell from the truck and print receipts.",
  },
];
export const OWNER_MODES = "All modes (owner)";
export const SELLING_SALES_ONLY = "Only Sales people can use Truck selling.";
export const APP_MODE_BULK_MAX = 200;

export type AppModeTarget = {
  profileId: string;
  role: string;
  status: string;
  appMode?: string;
  selling?: boolean;
};

export const appModeLabel = (mode: AppMode) =>
  APP_MODES.find((m) => m.value === mode)?.label ?? "Customer mapping";

/** The mode the person's phone shows (same rule as the server): Truck selling only while they are Sales. */
export function currentAppMode(
  p: Pick<AppModeTarget, "role" | "appMode" | "selling">,
): AppMode {
  const stored =
    APP_MODES.find((m) => m.value === p.appMode)?.value ??
    (p.selling ? "selling" : "mapping");
  return stored === "selling" && p.role !== "sales" && p.role !== "super_admin"
    ? "visits"
    : stored;
}

/** The small list pill: the owner has every mode. */
export const appModePill = (
  p: Pick<AppModeTarget, "role" | "appMode" | "selling">,
) => (p.role === "super_admin" ? OWNER_MODES : appModeLabel(currentAppMode(p)));

/** Can this mode be picked for this person? Truck selling only for Sales; only active people change. */
export function canPickAppMode(
  target: Pick<AppModeTarget, "role" | "status">,
  mode: AppMode,
  canManage: boolean,
) {
  if (!canManage || target.role === "super_admin" || target.status !== "active")
    return false;
  return mode !== "selling" || target.role === "sales";
}

function ModeRows({
  name,
  value,
  disabled,
  onPick,
}: {
  name: string;
  value: AppMode | null;
  disabled: (mode: AppMode) => boolean;
  onPick: (mode: AppMode) => void;
}) {
  return (
    <div className="grid gap-2">
      {APP_MODES.map((mode) => {
        const off = disabled(mode.value);
        const on = value === mode.value;
        return (
          <label
            key={mode.value}
            className={`flex items-start gap-3 rounded-lg border p-3 ${on ? "border-foreground" : "border-border"} ${off ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-default-soft"}`}
          >
            <input
              type="radio"
              name={name}
              value={mode.value}
              checked={on}
              disabled={off}
              onChange={() => onPick(mode.value)}
              className="mt-1 h-4 w-4 accent-[var(--accent)]"
            />
            <span className="grid gap-0.5">
              <span className="text-sm font-semibold text-foreground">
                {mode.label}
              </span>
              <span className="text-sm text-muted">{mode.line}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** One person's App mode on their page. Picking a row saves it. */
export function AppModeChoice({
  target,
  canManage,
  save,
}: {
  target: AppModeTarget;
  canManage: boolean;
  save: (args: { profileId: string; mode: AppMode }) => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [shown, setShown] = useState<AppMode | null>(null);
  const owner = target.role === "super_admin";
  const value = shown ?? currentAppMode(target);
  async function pick(mode: AppMode) {
    if (pending || mode === value) return;
    setPending(true);
    setError("");
    setShown(mode);
    try {
      await save({ profileId: target.profileId, mode });
    } catch (cause) {
      setShown(null);
      setError(
        cause instanceof Error ? cause.message : "Could not save. Try again.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <section aria-label="App mode" className="grid gap-2">
      <span className="text-sm font-semibold text-foreground">App mode</span>
      {owner ? (
        <p className="rounded-lg border border-border p-3 text-sm text-muted">
          {OWNER_MODES}
        </p>
      ) : (
        <>
          <ModeRows
            name={`app-mode-${target.profileId}`}
            value={value}
            disabled={(mode) =>
              pending || !canPickAppMode(target, mode, canManage)
            }
            onPick={(mode) => void pick(mode)}
          />
          {target.role !== "sales" ? (
            <span className="text-xs text-muted">{SELLING_SALES_ONLY}</span>
          ) : null}
        </>
      )}
      {error ? (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      ) : null}
    </section>
  );
}

/** "Set app mode" for the people picked in the list. Owners are left out (they already have every mode). */
export function BulkAppMode({
  people,
  save,
  onDone,
  onCancel,
}: {
  people: (AppModeTarget & { name: string })[];
  save: (args: { profileIds: string[]; mode: AppMode }) => Promise<unknown>;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<AppMode | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const changeable = people.filter(
    (p) => p.role !== "super_admin" && p.status === "active",
  );
  const skipped = people.length - changeable.length;
  const notSales = changeable.filter((p) => p.role !== "sales").length;
  const blocked =
    !mode ||
    pending ||
    !changeable.length ||
    changeable.length > APP_MODE_BULK_MAX ||
    (mode === "selling" && notSales > 0);
  const count = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
  async function submit() {
    if (blocked || !mode) return;
    setPending(true);
    setError("");
    try {
      await save({ profileIds: changeable.map((p) => p.profileId), mode });
      onDone(`${count(changeable.length)} now on ${appModeLabel(mode)}.`);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save. Try again.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <section aria-label="Set app mode" className="grid gap-3">
      <p className="text-sm text-foreground">
        Pick the app mode for {count(changeable.length)}.
      </p>
      {skipped ? (
        <p className="text-xs text-muted">
          {count(skipped)} left out: the owner already has every mode, and
          people who are not active cannot change.
        </p>
      ) : null}
      <ModeRows
        name="bulk-app-mode"
        value={mode}
        disabled={() => pending}
        onPick={setMode}
      />
      {mode === "selling" && notSales ? (
        <p role="alert" className="text-sm text-danger">
          {SELLING_SALES_ONLY} {count(notSales)} picked{" "}
          {notSales === 1 ? "is" : "are"} not Sales.
        </p>
      ) : null}
      {changeable.length > APP_MODE_BULK_MAX ? (
        <p role="alert" className="text-sm text-danger">
          Pick up to {APP_MODE_BULK_MAX} people at a time.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={blocked}
          onClick={() => void submit()}
          className="h-10 rounded-xl bg-foreground px-4 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-10 rounded-xl border border-border px-4 text-sm font-medium text-foreground hover:bg-default-soft"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
