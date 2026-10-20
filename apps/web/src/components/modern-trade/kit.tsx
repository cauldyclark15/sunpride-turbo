"use client";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { mutate } from "../../lib/api";
import { downloadCsv } from "../../lib/import-csv-export";
import { safeCsv } from "./export";

export function ExportActions({
  rows,
  name,
}: {
  rows: unknown[][];
  name: string;
}) {
  return (
    <div className="flex gap-2 print:hidden">
      <button
        className={action}
        onClick={() => downloadCsv(`${name}.csv`, safeCsv(rows))}
      >
        Export CSV
      </button>
      <button className={action} onClick={() => window.print()}>
        Print
      </button>
    </div>
  );
}
export const panel = "rounded-xl border border-border bg-surface p-5";
export const action =
  "min-h-10 rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-40";
export const inputClass =
  "min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm";
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1 text-sm text-muted">
      {label}
      {children}
    </label>
  );
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="rounded-lg border border-border p-3 text-sm">
      {children}
    </p>
  );
}
export function php(value: unknown) {
  return value === null || value === undefined
    ? "Not priced"
    : new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
      }).format(Number(value) / 100);
}
export function dateText(value: unknown) {
  return value
    ? new Intl.DateTimeFormat("en-PH", {
        timeZone: "Asia/Manila",
        dateStyle: "medium",
      }).format(new Date(String(value)))
    : "Not set";
}
export function label(value: string) {
  return value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}
/** Keep one key across an uncertain retry. Clear it only after success. */
export function useCommand() {
  const keys = useRef(new Map<string, string>()),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  async function run<T = { id: string }>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T | null> {
    const fingerprint = JSON.stringify([path, body]);
    if (!keys.current.has(fingerprint))
      keys.current.set(fingerprint, crypto.randomUUID());
    setPending(true);
    setError("");
    try {
      const result = await mutate<T>(
        path,
        { ...body, idempotencyKey: keys.current.get(fingerprint) },
        { invalidate: [["mt"], ["portal"]] },
      );
      keys.current.delete(fingerprint);
      return result;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The request could not be completed",
      );
      return null;
    } finally {
      setPending(false);
    }
  }
  return { run, pending, error };
}
export function Form({
  onSubmit,
  children,
}: {
  onSubmit: (data: FormData) => void | Promise<void>;
  children: ReactNode;
}) {
  return (
    <form
      className="grid gap-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void onSubmit(new FormData(event.currentTarget));
      }}
    >
      {children}
    </form>
  );
}
export function text(data: FormData, key: string) {
  return String(data.get(key) ?? "");
}
export function iso(data: FormData, key: string) {
  return `${text(data, key)}T00:00:00+08:00`;
}
