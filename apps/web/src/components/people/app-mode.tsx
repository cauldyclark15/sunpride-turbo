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
  appModes?: string[];
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

/** Enabled modes, preserving old single-mode people. */
export function currentAppModes(
  p: Pick<AppModeTarget, "role" | "appMode" | "appModes" | "selling">,
): AppMode[] {
  if (p.role === "super_admin") return APP_MODES.map((m) => m.value);
  const modes = APP_MODES.filter(
    (m) =>
      p.appModes?.includes(m.value) &&
      (m.value !== "selling" || p.role === "sales"),
  ).map((m) => m.value);
  return modes.length ? modes : [currentAppMode(p)];
}
export const toggleAppMode = (modes: AppMode[], mode: AppMode) =>
  APP_MODES.filter((m) =>
    m.value === mode ? !modes.includes(mode) : modes.includes(m.value),
  ).map((m) => m.value);

/** The small list pill lists every enabled mode. */
export const appModePill = (
  p: Pick<AppModeTarget, "role" | "appMode" | "appModes" | "selling">,
) =>
  p.role === "super_admin"
    ? OWNER_MODES
    : currentAppModes(p).map(appModeLabel).join(", ");

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
  value: AppMode[];
  disabled: (mode: AppMode) => boolean;
  onPick: (mode: AppMode) => void;
}) {
  return (
    <div className="grid gap-2">
      {APP_MODES.map((mode) => {
        const off = disabled(mode.value);
        const on = value.includes(mode.value);
        return (
          <label
            key={mode.value}
            className={`flex items-start gap-3 rounded-lg border p-3 ${on ? "border-foreground" : "border-border"} ${off ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-default-soft"}`}
          >
            <input
              type="checkbox"
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

/** One person's enabled modes; Save applies the complete checkbox selection. */
export function AppModeChoice({
  target,
  canManage,
  save,
}: {
  target: AppModeTarget;
  canManage: boolean;
  save: (args: { profileId: string; modes: AppMode[] }) => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [shown, setShown] = useState<AppMode[] | null>(null);
  const owner = target.role === "super_admin";
  const value = shown ?? currentAppModes(target);
  async function submit() {
    if (pending || !value.length || !canManage) return;
    setPending(true);
    setError("");
    try {
      await save({ profileId: target.profileId, modes: value });
    } catch (cause) {
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
            onPick={(mode) => setShown(toggleAppMode(value, mode))}
          />
          <p className="text-xs text-muted">
            Choose one or more modes. They can switch between these on the
            phone.
          </p>
          <button
            type="button"
            disabled={
              pending ||
              !value.length ||
              !canManage ||
              target.status !== "active"
            }
            onClick={() => void submit()}
            className="h-10 rounded-xl bg-foreground px-4 text-sm font-semibold text-background disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save app modes"}
          </button>
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
  save: (args: { profileIds: string[]; modes: AppMode[] }) => Promise<unknown>;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [modes, setModes] = useState<AppMode[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const changeable = people.filter(
    (p) => p.role !== "super_admin" && p.status === "active",
  );
  const skipped = people.length - changeable.length;
  const notSales = changeable.filter((p) => p.role !== "sales").length;
  const blocked =
    !modes.length ||
    pending ||
    !changeable.length ||
    changeable.length > APP_MODE_BULK_MAX ||
    (modes.includes("selling") && notSales > 0);
  const count = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
  async function submit() {
    if (blocked) return;
    setPending(true);
    setError("");
    try {
      await save({ profileIds: changeable.map((p) => p.profileId), modes });
      onDone(
        `${count(changeable.length)} can now use ${modes.map(appModeLabel).join(", ")}.`,
      );
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
        Pick one or more app modes for {count(changeable.length)}. These replace
        their current modes.
      </p>
      {skipped ? (
        <p className="text-xs text-muted">
          {count(skipped)} left out: the owner already has every mode, and
          people who are not active cannot change.
        </p>
      ) : null}
      <ModeRows
        name="bulk-app-mode"
        value={modes}
        disabled={() => pending}
        onPick={(mode) => setModes(toggleAppMode(modes, mode))}
      />
      {modes.includes("selling") && notSales ? (
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
