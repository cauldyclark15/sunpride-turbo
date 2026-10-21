"use client";
import { useState } from "react";
import { Button } from "@heroui/react";
import { apiFetch, useApi } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import { useVanCommand } from "./use-command";
import { routeBase, routeMoney, routeQuantity } from "./route-format";
import type { TripSettlement } from "./model";
type Change = {
  id: string;
  kind: string;
  reason: string;
  requestedBy: string;
  decidedBy: string | null;
  decision: string | null;
  facts: {
    newDeclaredMinor?: string;
    newReceivedMinor?: string | null;
    reference?: string;
    movementNumber?: string;
    lines?: Array<{
      quantityBase: string;
      product: {
        name: string;
        quantityScale: string;
        caseBase: string;
        uomCode: string;
      };
    }>;
    empties?: Array<{ label?: string; typeCode: string; quantity: string }>;
  };
};
export function CorrectionFacts({ change: c }: { change: Change }) {
  return (
    <div className="grid gap-1">
      <p>
        {c.kind.replaceAll("_", " ")} · {c.requestedBy} ·{" "}
        {c.decision ?? "Awaiting another reviewer"}
      </p>
      <p>{c.reason}</p>
      {c.facts.newDeclaredMinor !== undefined && (
        <p>
          Recounted cash {routeMoney(c.facts.newDeclaredMinor)} · corrected
          handover {routeMoney(c.facts.newReceivedMinor ?? null)} · evidence{" "}
          {c.facts.reference}
        </p>
      )}
      {c.facts.lines?.map((l, i) => (
        <p key={i}>
          {l.product.name} ·{" "}
          {routeQuantity(
            l.quantityBase,
            l.product.quantityScale,
            l.product.caseBase,
            l.product.uomCode,
          )}
        </p>
      ))}
      {c.facts.empties?.map((e) => (
        <p key={e.typeCode}>
          {e.label ?? e.typeCode}: {e.quantity}
        </p>
      ))}
      {c.facts.movementNumber && (
        <p>Existing approved stock adjustment: {c.facts.movementNumber}</p>
      )}
      {c.decidedBy && <p>Reviewed by {c.decidedBy}</p>}
    </div>
  );
}
/** F-116/F-117: corrections append evidence and versions; no editing original counts or receipts. */
export function ReconciliationCorrections({ trip }: { trip: TripSettlement }) {
  const p = usePermissions();
  const q = useApi<{ items: Change[] }>(
    p.can("van.read") ? ["van", "corrections", trip.tripId] : null,
    ({ signal }) =>
      apiFetch("/api/v1/van/corrections", {
        query: { tripId: trip.tripId },
        signal,
      }),
  );
  const propose = useVanCommand<Record<string, unknown>, unknown>(
      "/api/v1/van/corrections/request",
    ),
    decide = useVanCommand<Record<string, unknown>, unknown>(
      "/api/v1/van/corrections/decide",
    ),
    revise = useVanCommand<Record<string, unknown>, unknown>(
      "/api/v1/van/settlements/revise",
    );
  const [kind, setKind] = useState(
      p.can("van.stock.approve") ? "unload_remainder" : "cash_recount",
    ),
    [reason, setReason] = useState(""),
    [declared, setDeclared] = useState(""),
    [received, setReceived] = useState(""),
    [reference, setReference] = useState(""),
    [movementNumber, setMovement] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const latest = trip.vanOps?.versions[0];
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      setMessage(
        "Recorded. Original evidence remains unchanged; rebuild a rejected settlement after corrections are approved.",
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Could not record this correction",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!p.can("van.read")) return null;
  return (
    <section
      aria-label="Receipt and settlement corrections"
      className="grid gap-3 border border-separator rounded-lg p-4"
    >
      <h3 className="font-medium">Resolve receipt and cash differences</h3>
      <p>
        Keep the first count and receipt. Record a reason, have another
        authorized person verify the correction, then prepare a new version of a
        rejected settlement.
      </p>
      {(p.can("van.stock.approve") || p.can("van.cash.approve")) &&
        trip.status !== "closed" && (
          <>
            <label>
              Correction
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {p.can("van.stock.approve") && (
                  <>
                    <option value="unload_remainder">
                      Physically receive the remaining scanned stock / empties
                    </option>
                    <option value="adjustment_reference">
                      Match an existing approved shortage adjustment
                    </option>
                    <option value="empties_loss">
                      Record verified missing-container custody loss
                    </option>
                  </>
                )}
                {p.can("van.cash.approve") && (
                  <option value="cash_recount">
                    Independently correct a cash recount / handover
                  </option>
                )}
              </select>
            </label>
            {kind === "adjustment_reference" && (
              <label>
                Posted adjustment movement number
                <input
                  value={movementNumber}
                  onChange={(e) => setMovement(e.target.value)}
                  placeholder="MV-…"
                  maxLength={100}
                />
              </label>
            )}
            {kind === "cash_recount" && (
              <>
                <label>
                  Recounted cash (₱)
                  <input
                    inputMode="decimal"
                    value={declared}
                    onChange={(e) => setDeclared(e.target.value)}
                  />
                </label>
                {trip.cash.remittedCentavos !== null && (
                  <label>
                    Verified corrected handover total (₱)
                    <input
                      inputMode="decimal"
                      value={received}
                      onChange={(e) => setReceived(e.target.value)}
                    />
                  </label>
                )}
                <label>
                  Recount / receipt evidence reference
                  <input
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    maxLength={100}
                  />
                </label>
              </>
            )}
            <label>
              Reason and evidence
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={300}
              />
            </label>
            <Button
              isDisabled={busy || !reason.trim()}
              onPress={() =>
                void run(() =>
                  propose({
                    tripId: trip.tripId,
                    kind,
                    reason,
                    movementNumber,
                    reference,
                    ...(kind === "cash_recount"
                      ? {
                          newDeclaredMinor: routeBase(declared, "100"),
                          ...(trip.cash.remittedCentavos !== null
                            ? { newReceivedMinor: routeBase(received, "100") }
                            : {}),
                        }
                      : {}),
                  }),
                )
              }
            >
              Prepare correction for a second reviewer
            </Button>
            {latest?.decision === "rejected" && p.can("van.stock.approve") && (
              <Button
                isDisabled={busy || !reason.trim()}
                onPress={() =>
                  void run(() =>
                    revise({
                      tripId: trip.tripId,
                      contentHash: latest.contentHash,
                      reason,
                    }),
                  )
                }
              >
                Prepare new settlement version
              </Button>
            )}
          </>
        )}
      {q.error ? (
        <p role="alert">
          Corrections could not be read. Refresh before approval.
        </p>
      ) : !q.data ? (
        <p>Loading corrections…</p>
      ) : q.data.items.length === 0 ? (
        <p>No corrections recorded.</p>
      ) : (
        q.data.items.map((c) => (
          <section
            key={c.id}
            className="grid gap-2 border-t border-separator py-3"
          >
            <CorrectionFacts change={c} />
            {!c.decision &&
              p.can(
                c.kind === "cash_recount"
                  ? "van.cash.approve"
                  : "van.stock.approve",
              ) && (
                <div className="flex gap-2">
                  <Button
                    isDisabled={busy || !reason.trim()}
                    onPress={() =>
                      void run(() =>
                        decide({
                          changeId: c.id,
                          decision: "approved",
                          reason,
                        }),
                      )
                    }
                  >
                    Independently approve
                  </Button>
                  <Button
                    variant="outline"
                    isDisabled={busy || !reason.trim()}
                    onPress={() =>
                      void run(() =>
                        decide({
                          changeId: c.id,
                          decision: "rejected",
                          reason,
                        }),
                      )
                    }
                  >
                    Reject
                  </Button>
                </div>
              )}
          </section>
        ))
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
