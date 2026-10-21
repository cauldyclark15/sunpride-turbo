"use client";
import { useState } from "react";
import Image from "next/image";
import { Button } from "@heroui/react";
import { apiFetch, useApi } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import { useVanCommand } from "./use-command";
type Pickup = {
  id: string;
  returnNumber: string;
  customerName: string;
  capture: {
    customerName?: string;
    originalSale?: { receiptNumber: string };
    lines: Array<{
      product: { name: string };
      uomQuantity: string;
      uomCode: string;
      reasonLabel: string;
      lotNumber: string;
      disposition: string;
    }>;
    photo?: { base64: string };
    customerAcknowledgement?: { name: string; strokes: number[][][] };
  };
  decisions: Array<{ kind: string; reason: string; by: string }>;
};
export function PickupFacts({ item }: { item: Pickup }) {
  return (
    <div className="grid gap-2">
      <p>
        {item.returnNumber} · {item.capture.customerName ?? item.customerName}
      </p>
      <p>Held custody only — not sellable stock, cash refund or SAP credit.</p>
      {item.capture.lines.map((l, i) => (
        <p key={i}>
          {l.product.name} · {l.uomQuantity} {l.uomCode} · {l.reasonLabel} ·
          Batch {l.lotNumber} · {l.disposition.replaceAll("_", " ")}
        </p>
      ))}
      {item.capture.photo && (
        <Image
          unoptimized
          width={320}
          height={180}
          src={`data:image/jpeg;base64,${item.capture.photo.base64}`}
          alt="Customer return evidence"
        />
      )}
      {item.capture.customerAcknowledgement && (
        <>
          <p>Acknowledged by {item.capture.customerAcknowledgement.name}</p>
          <svg
            role="img"
            aria-label="Captured customer signature"
            viewBox="0 0 10000 10000"
            className="h-24 w-64 border border-separator"
          >
            {item.capture.customerAcknowledgement.strokes.map((s, i) => (
              <polyline
                key={i}
                points={s.map((p) => p.join(",")).join(" ")}
                fill="none"
                stroke="currentColor"
                strokeWidth="60"
              />
            ))}
          </svg>
        </>
      )}
      {item.decisions.map((d) => (
        <p key={d.kind}>
          {d.kind.replaceAll("_", " ")} · {d.by} · {d.reason}
        </p>
      ))}
    </div>
  );
}
function PickupAction({ item }: { item: Pickup }) {
  const [decision, setDecision] = useState("warehouse_received"),
    [reason, setReason] = useState(""),
    [invoiceNumber, setInvoice] = useState(
      item.capture.originalSale?.receiptNumber ?? "",
    ),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const run = useVanCommand<Record<string, string>, unknown>(
    "/api/v1/van/pickups/decide",
  );
  const final = item.decisions.some((d) =>
    ["credit_requested", "returned_to_outlet", "disposal_verified"].includes(
      d.kind,
    ),
  );
  return (
    <section className="grid gap-3 border-t border-separator py-4">
      <PickupFacts item={item} />
      {!final && (
        <>
          <label>
            Disposition
            <select
              aria-label="Pickup disposition"
              value={decision}
              onChange={(e) => setDecision(e.target.value)}
            >
              {[
                [
                  "warehouse_received",
                  "Warehouse physically received the held goods",
                ],
                ["returned_to_outlet", "Returned to the customer"],
                ["disposal_verified", "Independently verified disposal"],
                [
                  "credit_requested",
                  "Request SAP credit against an original invoice",
                ],
              ].map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {decision === "credit_requested" && (
            <label>
              Original invoice number
              <input
                value={invoiceNumber}
                onChange={(e) => setInvoice(e.target.value)}
                maxLength={100}
              />
            </label>
          )}
          <label>
            Reason / receipt evidence
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
            />
          </label>
          <Button
            isDisabled={
              busy ||
              !reason.trim() ||
              (decision === "credit_requested" && !invoiceNumber.trim())
            }
            onPress={() => {
              setBusy(true);
              void run({ returnId: item.id, decision, reason, invoiceNumber })
                .then(() =>
                  setMessage(
                    "Recorded. SAP credit, if requested, remains pending its real acknowledgement.",
                  ),
                )
                .catch(() =>
                  setMessage(
                    "Not recorded. Check the current custody, original invoice and your approval role before retrying.",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            Record independent decision
          </Button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
/** F-113: one custody queue inside the existing trip, never a parallel returns app. */
export function ReturnPickupReview({ tripId }: { tripId: string }) {
  const p = usePermissions();
  const q = useApi<{ items: Pickup[] }>(
    p.can("van.read") ? ["van", "pickups", tripId] : null,
    ({ signal }) =>
      apiFetch("/api/v1/van/return-pickups", { query: { tripId }, signal }),
  );
  if (!p.can("van.read")) return null;
  return (
    <section aria-label="Held customer pickups" className="grid gap-3">
      <h3 className="font-medium">Held customer pickups</h3>
      <p>
        Confirm every physical bag separately from owned unload stock. A
        different authorized person records disposition; only SAP can confirm
        financial credit.
      </p>
      {q.error ? (
        <p>Pickup custody could not be loaded. Refresh before sign-off.</p>
      ) : !q.data ? (
        <p>Loading pickup custody…</p>
      ) : q.data.items.length === 0 ? (
        <p>No held pickup bags on this trip.</p>
      ) : (
        q.data.items.map((item) =>
          p.can("van.stock.approve") ? (
            <PickupAction key={item.id} item={item} />
          ) : (
            <PickupFacts key={item.id} item={item} />
          ),
        )
      )}
    </section>
  );
}
