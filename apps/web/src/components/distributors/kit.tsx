"use client";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { mutate, useApi, type ApiResult } from "../../lib/api";
import { manilaToday } from "../../lib/outside-calls";
import type { Command } from "./types";

export const fieldClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
export const buttonClass =
  "inline-flex min-h-10 items-center justify-center rounded-lg border border-border bg-surface px-4 text-sm font-medium text-foreground hover:bg-default-soft disabled:opacity-40";
export const money = (n: number | null | undefined) =>
  n == null
    ? "Unknown"
    : new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
      }).format(n / 100);
export const words = (s: string) =>
  s.replaceAll("_", " ").replace(/^./, (x) => x.toUpperCase());
export const when = (s: string | null | undefined) =>
  s
    ? new Intl.DateTimeFormat("en-PH", {
        dateStyle: "medium",
        timeZone: "Asia/Manila",
      }).format(new Date(s))
    : "Not yet confirmed";
export { manilaToday };
export function Panel({
  title,
  children,
  detail,
}: {
  title: string;
  children: ReactNode;
  detail?: string;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-surface p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {detail ? (
        <p className="mt-1 text-sm leading-6 text-muted">{detail}</p>
      ) : null}
      <div className="mt-4 grid gap-4">{children}</div>
    </section>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}
export function State<T>({
  query,
  children,
}: {
  query: ApiResult<T>;
  children: (value: T) => ReactNode;
}) {
  if (query.error)
    return (
      <p role="alert" className="rounded-lg border border-border p-4 text-sm">
        {query.error.message}{" "}
        <button onClick={() => void query.refetch()} className="underline">
          Try again
        </button>
      </p>
    );
  if (!query.data) return <p className="p-4 text-sm text-muted">Loading…</p>;
  return <>{children(query.data)}</>;
}
export function usePartnerQuery<T>(id: string, path: string, enabled = true) {
  return useApi<T>(
    enabled ? ["distributors", id, path] : null,
    `/api/v1/distributors/${path}${path.includes("?") ? "&" : "?"}distributorId=${encodeURIComponent(id)}`,
  );
}
export function usePartnerCommand(id: string): Command {
  const keys = useRef(new Map<string, string>());
  return async (path, body) => {
    const hash = JSON.stringify({ path, body });
    let key = keys.current.get(hash);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(hash, key);
    }
    const value = await mutate<Record<string, unknown>>(
      `/api/v1/distributors/${path}`,
      { ...body, distributorId: id, requestKey: key },
      {
        invalidate: [
          ["distributors", id],
          ["distributors", "list"],
        ],
      },
    );
    keys.current.delete(hash);
    return value;
  };
}
export function ActionForm({
  title,
  submitLabel,
  onSubmit,
  children,
  detail,
  successMessage = "Saved. The list has been refreshed.",
}: {
  title: string;
  submitLabel: string;
  successMessage?: string;
  onSubmit: (data: FormData) => Promise<unknown>;
  children: ReactNode;
  detail?: string;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null),
    // A string returned by onSubmit replaces the generic success message.
    [success, setSuccess] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const data = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await onSubmit(data);
      setSuccess(typeof result === "string" ? result : successMessage);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Action did not complete. Retry the same request.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <Panel title={title} detail={detail}>
      <form onSubmit={submit} className="grid gap-4">
        <fieldset disabled={pending} className="grid gap-4">
          {children}
        </fieldset>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        {success ? (
          <p role="status" className="text-sm text-muted">
            {success}
          </p>
        ) : null}
        <div>
          <button className={buttonClass} disabled={pending}>
            {pending ? "Saving…" : submitLabel}
          </button>
        </div>
      </form>
    </Panel>
  );
}
export function MiniMetric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-muted">
        {label}
      </p>
      <p className="mt-3 text-3xl font-semibold tracking-tight">{value}</p>
      <p className="mt-2 text-xs leading-5 text-muted">{note}</p>
    </div>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border p-5 text-sm text-muted">
      {children}
    </p>
  );
}
export function Table({
  headers,
  children,
}: {
  headers: string[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                className="border-b border-border px-3 py-3 text-xs font-medium text-muted"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
export function Cell({ children }: { children: ReactNode }) {
  return (
    <td className="border-b border-border px-3 py-3 align-top">{children}</td>
  );
}
export async function fileBase64(file: File) {
  if (file.size > 600000) throw new Error("Use a file below 600 KB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
export function fileInput(data: FormData, name = "file") {
  const file = data.get(name);
  if (!(file instanceof File) || !file.size)
    throw new Error("Choose a file first.");
  return file;
}
export const number = (data: FormData, name: string) => Number(data.get(name));
export const value = (data: FormData, name: string) =>
  String(data.get(name) ?? "");
