"use client";

import { Card, Notice, PageHeader } from "@sunpride/ui";
import { useRef, useState } from "react";
import { apiFetch, useApi, useLive, useMutate } from "@/lib/api";
import { CasesPiecesStepper, DocNumber, Peso, QtyCasesPieces, ReasonSelect, StatusPill, formatPeso, reasonNeeds, toBaseQty } from "../index";
import type { ReasonCode } from "../index";
import { DECISION_CHOICES, approvalHint, missingForRequest } from "./helpers";
import type { DispositionDecision, DispositionQueue, DispositionRequest, WaitingStock } from "./types";

/** SHA-256 of a photo, hex. The server matches uploaded photos by this digest. */
export async function photoDigest(file: Blob): Promise<string> {
  const bytes = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Bad orders (SPEC 4.4): stock waiting for a decision, with its value and photos.
 * One main action per row: decide what happens to it; a second person approves.
 */
export function BadOrders({
  uploadPhoto,
}: {
  /** Uploads the photo bytes and returns its SHA-256. The media upload route is device-proved today,
   * so the NAV lane supplies this once the office upload purpose exists (see the VALUE report). */
  uploadPhoto?: (file: File) => Promise<string>;
}) {
  const [status, setStatus] = useState<"requested" | "posted" | "rejected" | "all">("requested");
  const data = useApi<DispositionQueue>(["inventory", "dispositions", { status }], ({ signal }) =>
    apiFetch<DispositionQueue>("/api/v1/inventory/dispositions", { signal, query: { status } }),
  );
  useLive(["inventory"], [["inventory", "dispositions"]]);
  const write = useMutate();
  const keys = useRef(new Map<string, string>());
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function run(action: string, body: Record<string, unknown>) {
    if (write.pending) return false;
    const fingerprint = JSON.stringify([action, body]);
    let key = keys.current.get(fingerprint);
    if (!key) keys.current.set(fingerprint, (key = crypto.randomUUID()));
    try {
      await write.mutate(`/api/v1/inventory/${action}`, { ...body, idempotencyKey: key }, { invalidate: [["inventory"]] });
      keys.current.delete(fingerprint);
      setNotice(null);
      return true;
    } catch (error) {
      setNotice((error as { message?: string }).message ?? "That did not work. Try again.");
      return false;
    }
  }
  const q = data.data;
  return (
    <div className="space-y-4" data-screen="bad-orders">
      <PageHeader title="Bad orders" description="Damaged, expired and held stock waiting for a decision." />
      {notice ? <Notice title={notice} tone="danger" /> : null}
      {data.error ? <Notice title={data.error.message} tone="danger" /> : null}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Waiting for a decision</p>
          <p className="text-2xl font-semibold tabular-nums"><Peso centavos={q?.summary.waitingValueCentavos ?? null} /></p>
          <p className="text-sm text-gray-500">{q?.summary.waitingCount ?? 0} lines</p>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Asked, waiting for approval</p>
          <p className="text-2xl font-semibold tabular-nums"><Peso centavos={q?.summary.requestedValueCentavos ?? null} /></p>
          <p className="text-sm text-gray-500">{q?.summary.requestedCount ?? 0} requests</p>
        </div>
      </div>

      <Card label="Needs approval">
        <div className="mb-3 flex gap-1" role="group" aria-label="Show">
          {(["requested", "posted", "rejected", "all"] as const).map((s) => (
            <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}
              className={`min-h-12 rounded-xl border px-4 text-sm ${status === s ? "border-blue-600 bg-blue-50 text-blue-700" : "border-gray-300"}`}>
              {{ requested: "Waiting", posted: "Done", rejected: "Declined", all: "All" }[s]}
            </button>
          ))}
        </div>
        {q?.requests.length ? (
          <ul className="divide-y divide-gray-100">
            {q.requests.map((r) => (
              <RequestRow key={r.id} r={r} pending={write.pending} onDecide={(verdict, note) => run("dispositions/decide", { dispositionId: r.id, verdict, note })} />
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-gray-500">{data.isLoading ? "Loading…" : "Nothing here."}</p>
        )}
      </Card>

      <Card label="Stock waiting">
        {q?.waiting.length ? (
          <ul className="divide-y divide-gray-100">
            {q.waiting.map((w) => {
              const id = `${w.productId}:${w.locationId}:${w.lotId ?? ""}:${w.status}`;
              return (
                <li key={id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="font-medium">{w.name}</div>
                      <div className="text-xs text-gray-500">
                        {w.code} · {w.locationName}
                        {w.lotNumber ? ` · Batch ${w.lotNumber}` : ""}
                      </div>
                    </div>
                    <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-700">{w.statusLabel}</span>
                    <div className="text-right">
                      <div><QtyCasesPieces base={w.quantity.base} basePerCase={w.units.basePerCase} /></div>
                      <div className="text-sm text-gray-500"><Peso centavos={w.valueCentavos} /></div>
                    </div>
                    <button type="button" className="min-h-12 rounded-xl bg-orange-600 px-5 font-medium text-white" onClick={() => setOpen(open === id ? null : id)}>
                      Decide
                    </button>
                  </div>
                  {open === id ? (
                    <RequestForm w={w} pending={write.pending} uploadPhoto={uploadPhoto}
                      onSend={async (body) => { if (await run("dispositions/request", body)) setOpen(null); }} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="py-6 text-center text-gray-500">{data.isLoading ? "Loading…" : "No bad stock is waiting. Nice."}</p>
        )}
      </Card>
    </div>
  );
}

function RequestRow({ r, pending, onDecide }: { r: DispositionRequest; pending: boolean; onDecide: (verdict: "approve" | "reject", note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-medium">{r.name} <span className="text-gray-500">· {r.decisionLabel}</span></div>
          <div className="text-xs text-gray-500">
            <DocNumber value={r.number} /> · {r.fromStatusLabel} · {r.locationName}
            {r.lotNumber ? ` · Batch ${r.lotNumber}` : ""}
          </div>
          <div className="text-xs text-gray-500">{approvalHint(r, formatPeso)}</div>
          {r.note ? <div className="text-sm">{r.note}</div> : null}
          {r.supplierRef ? <div className="text-sm">Return slip {r.supplierRef}</div> : null}
          {r.decisionNote ? <div className="text-sm text-gray-600">Decision: {r.decisionNote}</div> : null}
        </div>
        <div className="text-right">
          <div><QtyCasesPieces base={r.quantity.base} /></div>
          <div className="text-sm"><Peso centavos={r.valueCentavos} /></div>
        </div>
        <StatusPill state={r.status === "requested" ? "requested" : r.status === "posted" ? "posted" : r.status === "rejected" ? "rejected" : "approved"} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {r.photoUrls.map((u) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={u} src={u} alt="Photo of the stock" className="h-16 w-16 rounded-lg border border-gray-200 object-cover" />
        ))}
        {r.needsPhoto ? <span className="text-sm text-red-700">Needs a photo before it can be approved.</span> : null}
      </div>
      {r.canDecide ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input className="min-h-12 min-w-[14rem] flex-1 rounded-xl border border-gray-300 px-3" placeholder="Note (needed to decline)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" disabled={pending || r.needsPhoto} className="min-h-12 rounded-xl bg-orange-600 px-5 font-medium text-white disabled:opacity-50" onClick={() => onDecide("approve", note)}>Approve</button>
          <button type="button" disabled={pending || !note.trim()} className="min-h-12 rounded-xl border border-gray-300 px-5 disabled:opacity-50" onClick={() => onDecide("reject", note)}>Decline</button>
        </div>
      ) : null}
    </li>
  );
}

function RequestForm({ w, pending, uploadPhoto, onSend }: { w: WaitingStock; pending: boolean; uploadPhoto?: (file: File) => Promise<string>; onSend: (body: Record<string, unknown>) => void }) {
  const [decision, setDecision] = useState<DispositionDecision | null>(null);
  const [qty, setQty] = useState({ cases: 0, pieces: w.quantity.base });
  const [reason, setReason] = useState<ReasonCode | null>(null);
  const [note, setNote] = useState("");
  const [supplierRef, setSupplierRef] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const base = toBaseQty(qty, w.units.basePerCase);
  const missing = missingForRequest({
    decision, quantityBase: base, maxBase: w.quantity.base, reasonCode: reason?.code ?? null, note, supplierRef, photos: photos.length,
    reasonNeedsNote: reason?.requiresNote, reasonNeedsPhoto: reason?.requiresPhoto,
  });
  const choices = DECISION_CHOICES.filter((c) => c.value !== "release" || w.releasable);
  return (
    <div className="mt-3 space-y-3 rounded-2xl bg-gray-50 p-4">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="What to do">
        {choices.map((c) => (
          <button key={c.value} type="button" role="radio" aria-checked={decision === c.value} onClick={() => setDecision(c.value)}
            className={`min-h-12 rounded-xl border px-4 text-sm ${decision === c.value ? "border-orange-600 bg-orange-50 text-orange-700" : "border-gray-300 bg-white"}`}>
            {c.label}
          </button>
        ))}
      </div>
      {decision ? <p className="text-sm text-gray-600">{choices.find((c) => c.value === decision)?.hint}</p> : null}
      <CasesPiecesStepper value={qty} onChange={setQty} basePerCase={w.units.basePerCase ?? undefined} />
      {decision && decision !== "release" ? <ReasonSelect value={reason?.code ?? null} direction="out" onChange={(_code, r) => setReason(r)} /> : null}
      {reason && reasonNeeds(reason).length ? <p className="text-sm text-gray-600">This reason needs {reasonNeeds(reason).join(" and ")}.</p> : null}
      <input className="min-h-12 w-full rounded-xl border border-gray-300 px-3" placeholder={decision === "release" ? "Why is it fine to sell?" : "Note"} value={note} onChange={(e) => setNote(e.target.value)} />
      {decision === "return_to_supplier" ? (
        <input className="min-h-12 w-full rounded-xl border border-gray-300 px-3" placeholder="Supplier or return slip number" value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} />
      ) : null}
      {decision && decision !== "release" ? (
        <label className="block text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Photos ({photos.length})</span>
          <input type="file" accept="image/jpeg" capture="environment" disabled={!uploadPhoto}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file || !uploadPhoto) return;
              try { setProblem(null); setPhotos([...photos, await uploadPhoto(file)]); } catch (error) { setProblem((error as Error).message || "The photo did not upload. Try again."); }
            }} />
          {!uploadPhoto ? <span className="block text-xs text-gray-500">Photo upload is not switched on for this screen yet.</span> : null}
        </label>
      ) : null}
      {problem ? <Notice title={problem} tone="danger" /> : null}
      {missing.length && decision ? <ul className="text-sm text-red-700">{missing.map((m) => <li key={m}>{m}</li>)}</ul> : null}
      <button type="button" disabled={pending || !decision || missing.length > 0}
        className="min-h-12 rounded-xl bg-orange-600 px-6 font-medium text-white disabled:opacity-50"
        onClick={() => onSend({
          productId: w.productId, locationId: w.locationId, lotId: w.lotId ?? undefined, fromStatus: w.status,
          quantityBase: base, decision, reasonCode: reason?.code, note, supplierRef: supplierRef || undefined, photoDigests: photos,
        })}>
        Send for approval
      </button>
    </div>
  );
}
