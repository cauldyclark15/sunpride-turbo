"use client";

import { Card, Notice, PageHeader } from "@sunpride/ui";
import { useRef, useState } from "react";
import { apiFetch, useApi, useLive, useMutate } from "@/lib/api";
import { Peso, QtyCasesPieces } from "../index";
import { expiryLabel, expiryTone } from "./helpers";
import type { ExpiryBoardData, ExpiryRow } from "./types";

type Action = "hold" | "bad_order" | "prioritise" | "unprioritise";
const TONE = { danger: "bg-red-50 text-red-700", warning: "bg-amber-50 text-amber-700", neutral: "bg-gray-100 text-gray-700" } as const;

/** Expiry board (SPEC 4.6): batches by days to expiry, with hold, bad order and prioritise. */
export function ExpiryBoard({ locationId }: { locationId?: string }) {
  const [days, setDays] = useState(90);
  const query = { days, ...(locationId ? { locationId } : {}) };
  const data = useApi<ExpiryBoardData>(["inventory", "expiry-board", query], ({ signal }) =>
    apiFetch<ExpiryBoardData>("/api/v1/inventory/expiry-board", { signal, query }),
  );
  useLive(["inventory"], [["inventory", "expiry-board"]]);
  const write = useMutate();
  const keys = useRef(new Map<string, string>());
  const [notice, setNotice] = useState<string | null>(null);
  async function act(row: ExpiryRow, action: Action) {
    if (write.pending) return;
    const body = { action, lotId: row.lotId, locationId: row.locationId, note: action === "bad_order" ? "Will not sell in time" : undefined, reasonCode: action === "bad_order" ? "EXP" : undefined };
    const fingerprint = JSON.stringify(body);
    let key = keys.current.get(fingerprint);
    if (!key) keys.current.set(fingerprint, (key = crypto.randomUUID()));
    try {
      await write.mutate("/api/v1/inventory/expiry/act", { ...body, idempotencyKey: key }, { invalidate: [["inventory"]] });
      keys.current.delete(fingerprint);
      setNotice(null);
    } catch (error) {
      setNotice((error as { message?: string }).message ?? "That did not work. Try again.");
    }
  }
  return (
    <div className="space-y-4" data-screen="expiry-board">
      <PageHeader title="Expiry board" description="Frozen stock by how long it has left." />
      {notice ? <Notice title={notice} tone="danger" /> : null}
      {data.error ? <Notice title={data.error.message} tone="danger" /> : null}
      <div className="flex gap-1" role="group" aria-label="Look ahead">
        {[30, 60, 90].map((d) => (
          <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}
            className={`min-h-12 rounded-xl border px-4 text-sm ${days === d ? "border-blue-600 bg-blue-50 text-blue-700" : "border-gray-300"}`}>
            Next {d} days
          </button>
        ))}
      </div>
      {data.data?.buckets.map((b) => (
        <Card key={b.key} label={`${b.label} · ${b.count} ${b.count === 1 ? "batch" : "batches"}`}>
          <p className="mb-2 text-sm text-gray-500">Worth <Peso centavos={b.valueCentavos} /> at cost</p>
          {b.rows.length ? (
            <ul className="divide-y divide-gray-100">
              {b.rows.map((r) => (
                <li key={`${r.lotId}:${r.locationId}:${r.status}`} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-gray-500">{r.code} · Batch {r.lotNumber} · {r.locationName}</div>
                    <div className="text-sm">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${TONE[expiryTone(r.daysLeft)]}`}>{expiryLabel(r.expiresAt, r.daysLeft)}</span>
                      {r.status !== "available" ? <span className="ml-2 text-xs text-amber-700">On hold</span> : null}
                      {r.onRecall ? <span className="ml-2 text-xs text-red-700">Recalled</span> : null}
                      {r.prioritised ? <span className="ml-2 text-xs text-blue-700">Ship first</span> : null}
                    </div>
                  </div>
                  <div className="text-right">
                    <QtyCasesPieces base={r.quantity.base} />
                    <div className="text-sm text-gray-500"><Peso centavos={r.valueCentavos} /></div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {r.status === "available" && r.availableToMove.base > 0 ? (
                      <>
                        <button type="button" disabled={write.pending} className="min-h-12 rounded-xl border border-gray-300 px-4 text-sm" onClick={() => act(r, "hold")}>Hold</button>
                        <button type="button" disabled={write.pending} className="min-h-12 rounded-xl border border-gray-300 px-4 text-sm" onClick={() => act(r, "bad_order")}>Move to bad order</button>
                      </>
                    ) : null}
                    <button type="button" disabled={write.pending} className="min-h-12 rounded-xl bg-orange-600 px-4 text-sm font-medium text-white" onClick={() => act(r, r.prioritised ? "unprioritise" : "prioritise")}>
                      {r.prioritised ? "Stop shipping first" : "Ship first"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-4 text-center text-gray-500">Nothing here.</p>
          )}
        </Card>
      ))}
      {!data.data ? <p className="py-6 text-center text-gray-500">{data.isLoading ? "Loading…" : ""}</p> : null}
    </div>
  );
}
