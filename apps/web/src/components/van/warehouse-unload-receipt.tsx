"use client";
import { formatDate } from "../../lib/format";
import { useState } from "react";
import { Button } from "@heroui/react";
import { routeBase, routeQuantity } from "./route-format";
import type { RouteOperations } from "./route-operations";

type Observation = RouteOperations["observations"][number];
/** F-104/F-116 independent warehouse quantities preserve lot, quality and frozen sale-unit facts. */
export function WarehouseUnloadReceipt({
  observation: o,
  tripId,
  note,
  busy,
  reviewer,
  onReceive,
}: {
  observation: Observation;
  tripId: string;
  note: string;
  busy: boolean;
  reviewer: boolean;
  onReceive: (payload: Record<string, unknown>) => Promise<unknown>;
}) {
  const [counts, setCounts] = useState<Record<string, string>>({}),
    [empties, setEmpties] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const key = (l: NonNullable<Observation["facts"]["lines"]>[number]) =>
    `${l.productId}:${l.status}:${l.lotId ?? ""}`;
  const pieces = (l: NonNullable<Observation["facts"]["lines"]>[number]) =>
    routeQuantity(
      l.quantityBase,
      l.product?.quantityScale ?? "1",
      "0",
      "",
    ).trim();
  async function receive() {
    setError("");
    try {
      await onReceive({
        tripId,
        observationId: o.id,
        decision: "received",
        note,
        lines: o.facts.lines?.map((l) => ({
          productId: l.productId,
          lotId: l.lotId ?? null,
          status: l.status,
          receivedBase: routeBase(
            counts[key(l)] ?? pieces(l),
            l.product?.quantityScale ?? "1",
          ),
          reason: note,
        })),
        empties:
          o.facts.empties?.map((e) => ({
            typeCode: e.typeCode,
            quantity: empties[e.typeCode] ?? e.quantity,
          })) ?? [],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Receipt not saved");
    }
  }
  return (
    <section aria-label="Warehouse unload receipt" className="grid gap-2">
      <h4 className="font-medium">Receive unsold goods, returns and empties</h4>
      <p className="text-sm">
        {o.decision
          ? "Physical receipt recorded. Review its discrepancy result before sign-off."
          : "Count the physical goods independently. A difference requires a note and blocks sign-off; a manifest alone does not move stock."}
      </p>
      {error && <p role="alert">{error}</p>}
      {o.facts.lines?.map((l) => (
        <label key={key(l)} className="block text-sm">
          {l.product?.name ?? "Historical stock item"} ·{" "}
          {l.partition === "customer_return" ? "Customer return" : "Unsold"} ·{" "}
          {l.status === "available" ? "Sellable" : "Damaged"}
          {l.batch ? ` · batch ${l.batch}` : ""}
          <span className="block text-xs text-muted">
            Scanned back{" "}
            {l.product
              ? routeQuantity(
                  l.quantityBase,
                  l.product.quantityScale,
                  l.product.caseBase,
                  l.product.uomCode,
                )
              : "Original unit details unavailable"}
            {l.expiresAt ? ` · expires ${formatDate(l.expiresAt)}` : ""} ·{" "}
            {l.qualityStatus ?? "Untracked"}
          </span>
          <input
            aria-label={`Warehouse received ${l.product?.name ?? "stock"} ${l.batch ?? ""} ${l.status}`}
            inputMode="decimal"
            value={counts[key(l)] ?? pieces(l)}
            disabled={Boolean(o.decision) || !reviewer}
            onChange={(e) => setCounts({ ...counts, [key(l)]: e.target.value })}
          />
          {l.product?.uomCode ?? "Base units"}
        </label>
      ))}
      {o.facts.empties?.map((e) => (
        <label key={e.typeCode} className="text-sm">
          {e.label ?? e.typeCode} · seller counted {e.quantity}
          <input
            aria-label={`Warehouse received ${e.label ?? e.typeCode}`}
            inputMode="numeric"
            value={empties[e.typeCode] ?? e.quantity}
            disabled={Boolean(o.decision) || !reviewer}
            onChange={(event) =>
              setEmpties({ ...empties, [e.typeCode]: event.target.value })
            }
          />
        </label>
      ))}
      {o.decisionFacts && (
        <p className="text-sm">
          {o.decisionFacts.discrepancy
            ? "Receipt has a discrepancy. Reconcile it before sign-off."
            : "Physical receipt matched the seller's manifest."}
        </p>
      )}
      {reviewer && !o.decision && (
        <Button
          isDisabled={busy || !note.trim()}
          onPress={() => void receive()}
        >
          Confirm physical receipt
        </Button>
      )}
    </section>
  );
}
