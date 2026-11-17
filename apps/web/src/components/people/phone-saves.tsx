"use client";

/**
 * SP-0188 "Phone saves for the office": phone saves the system could not take as sent. Nothing a
 * salesman saves is lost; the office sees it here, finishes it by hand, and marks it Done.
 * Admin-only (the same access as People and Setup); the server decides.
 */
import { Button } from "@heroui/react";
import { useState } from "react";
import { apiFetch, mutate, normalizeError, useApi } from "../../lib/api";
import { formatManilaDateTime } from "../devices-admin";

export type PhoneSave = {
  id: string;
  createdAt: number;
  salesman: string;
  app: string;
  what: string;
  why: string;
  resolvedAt: number | null;
  resolvedBy: string | null;
  note: string | null;
};
export type PhoneSaveDetail = PhoneSave & {
  values: Record<string, unknown>;
  sent: unknown;
};

/** Field names in plain words for the details list (unknown keys are split into words). */
const LABELS: Record<string, string> = {
  name: "Store name",
  customerName: "Customer name",
  registeredName: "Registered name",
  address: "Address",
  ownerName: "Contact person",
  ownerPhone: "Mobile no.",
  mobileNo: "Mobile no.",
  deviceTime: "Saved on the phone",
  captureId: "Entry number",
  photoJpegBase64: "Photo",
  location: "Location",
  at: "Time",
  fixTime: "Location time",
};

export function plainKey(key: string) {
  if (LABELS[key]) return LABELS[key];
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/** Saved values as readable label/value lines (nested objects flattened one level deep). */
export function readableValues(
  values: Record<string, unknown>,
  prefix = "",
): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(values)) {
    const label = prefix ? `${prefix} · ${plainKey(key)}` : plainKey(key);
    if (value === null || value === undefined || value === "") continue;
    if (key === "photoJpegBase64") out.push([label, "Photo attached"]);
    else if (
      typeof value === "number" &&
      value > 1e12 &&
      /(^at$|time$|At$)/i.test(key)
    )
      out.push([label, formatManilaDateTime(value)]);
    else if (Array.isArray(value))
      value.forEach((item, i) =>
        item && typeof item === "object"
          ? out.push(
              ...readableValues(
                item as Record<string, unknown>,
                `${label} ${i + 1}`,
              ),
            )
          : out.push([`${label} ${i + 1}`, String(item)]),
      );
    else if (typeof value === "object")
      out.push(...readableValues(value as Record<string, unknown>, label));
    else out.push([label, String(value)]);
  }
  return out;
}

function Details({
  id,
  onClose,
  onDone,
}: {
  id: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const detail = useApi<PhoneSaveDetail>(["phone-saves", id], ({ signal }) =>
    apiFetch<PhoneSaveDetail>(`/api/v1/phone-saves/${id}`, { signal }),
  );
  const [raw, setRaw] = useState(false);
  const d = detail.data;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Phone save details"
        className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-lg"
      >
        <h2 className="text-lg font-semibold">
          {d ? `${d.what} from ${d.salesman}` : "Loading…"}
        </h2>
        {d ? (
          <>
            <p className="mt-1 text-sm text-muted">
              {formatManilaDateTime(d.createdAt)} · {d.app} · {d.why}
            </p>
            <dl className="mt-4 grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1 text-sm">
              {readableValues(d.values).map(([label, value], i) => (
                <div key={`${label}-${i}`} className="contents">
                  <dt className="text-muted">{label}</dt>
                  <dd className="break-words">{value}</dd>
                </div>
              ))}
            </dl>
            <button
              type="button"
              className="mt-4 text-sm text-accent underline"
              onClick={() => setRaw((v) => !v)}
            >
              {raw ? "Hide details" : "Show details"}
            </button>
            {raw ? (
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-default-soft p-3 text-[12px]">
                {JSON.stringify(
                  d.sent,
                  (k, v) =>
                    k === "photoJpegBase64" && typeof v === "string"
                      ? "(photo)"
                      : v,
                  2,
                )}
              </pre>
            ) : null}
          </>
        ) : detail.error ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            {normalizeError(detail.error).message}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onPress={onClose}>
            Close
          </Button>
          {d && !d.resolvedAt ? (
            <DoneButton id={d.id} onDone={onDone} />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function DoneButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      {error ? (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      ) : null}
      <Button
        size="sm"
        variant="primary"
        isPending={pending}
        onPress={async () => {
          setPending(true);
          setError(null);
          try {
            await mutate(`/api/v1/phone-saves/${id}/done`, {});
            onDone();
          } catch (cause) {
            setError(normalizeError(cause).message);
          } finally {
            setPending(false);
          }
        }}
      >
        Done
      </Button>
    </span>
  );
}

export function PhoneSavesAdmin() {
  const [show, setShow] = useState<"open" | "all">("open");
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useApi<{ rows: PhoneSave[] }>(
    ["phone-saves", "list", show],
    ({ signal }) =>
      apiFetch<{ rows: PhoneSave[] }>("/api/v1/phone-saves", {
        query: { show },
        signal,
      }),
  );
  const rows = list.data?.rows ?? [];
  const refresh = () => void list.refetch();
  return (
    <div className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold">Phone saves for the office</h2>
        <p className="text-sm text-muted">
          Work a salesman saved on a phone that could not be taken as sent.
          Nothing is lost: finish it here by hand, then mark it Done. Salesmen
          do not see this list.
        </p>
      </div>
      <label className="inline-flex items-center gap-2 text-sm">
        <span className="text-muted">Show</span>
        <select
          aria-label="Show"
          value={show}
          onChange={(e) => setShow(e.target.value as "open" | "all")}
          className="h-9 rounded-lg border border-border bg-surface px-2"
        >
          <option value="open">Still to do</option>
          <option value="all">All, including done</option>
        </select>
      </label>
      {list.error ? (
        <p role="alert" className="text-sm text-danger">
          {normalizeError(list.error).message}
        </p>
      ) : list.isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-border px-3 py-6 text-center text-sm text-muted">
          Nothing to do. Every phone save was taken as sent.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-default-soft text-[12px] text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Salesman</th>
                <th className="px-3 py-2 font-medium">App</th>
                <th className="px-3 py-2 font-medium">What it was</th>
                <th className="px-3 py-2 font-medium">Why</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="whitespace-nowrap px-3 py-2">
                    {formatManilaDateTime(r.createdAt)}
                  </td>
                  <td className="px-3 py-2">{r.salesman}</td>
                  <td className="px-3 py-2">{r.app}</td>
                  <td className="px-3 py-2 font-medium">{r.what}</td>
                  <td className="px-3 py-2 text-muted">{r.why}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <span className="inline-flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onPress={() => setOpenId(r.id)}
                      >
                        Details
                      </Button>
                      {r.resolvedAt ? (
                        <span className="self-center text-[12px] text-muted">
                          Done{r.resolvedBy ? ` by ${r.resolvedBy}` : ""}
                        </span>
                      ) : (
                        <DoneButton id={r.id} onDone={refresh} />
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId ? (
        <Details
          id={openId}
          onClose={() => setOpenId(null)}
          onDone={() => {
            setOpenId(null);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}
