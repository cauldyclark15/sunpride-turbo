"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { usePermissions } from "../../lib/auth";
import { useVanCommand } from "./use-command";
import type { TripSettlement } from "./model";
import { VanPolicyEditor } from "./route-policy-editor";
import { RouteScorecardView, type RouteScorecard } from "./route-scorecard";
import { WarehouseUnloadReceipt } from "./warehouse-unload-receipt";
import { routeMoney as money, routeQuantity } from "./route-format";

export type RouteOperations = {
  version: number;
  settlementState: string | null;
  policies: {
    cold_chain: {
      intervalMinutes: number;
      bands: Array<{
        productId: string | null;
        label: string;
        minDeciC: number;
        maxDeciC: number;
      }>;
    };
    variance: { toleranceBasisPoints: number; escalateAfterHours: number };
    returnables: { items: Array<{ code: string; label: string }> };
    return_reasons: { items: Array<{ code: string; label: string }> };
  };
  observations: Array<{
    id: string;
    kind: string;
    outletName: string | null;
    capturedAt: string;
    facts: {
      checkpoint?: string;
      deciC?: number;
      excursion?: boolean;
      lateFromPrior?: boolean;
      gapMinutes?: number;
      note?: string;
      phase?: string;
      stopId?: string;
      actualSequence?: number;
      plannedSequence?: number | null;
      durationSeconds?: number;
      lines?: Array<{
        productId: string;
        status: string;
        quantityBase: string;
        partition: string;
        lotId?: string | null;
        batch?: string | null;
        expiresAt?: number | null;
        qualityStatus?: string;
        product?: {
          name: string;
          quantityScale: string;
          caseBase: string;
          uomCode: string;
        };
      }>;
      empties?: Array<{ typeCode: string; label?: string; quantity: string }>;
    };
    decision: string | null;
    decisionFacts?: { discrepancy: boolean };
  }>;
  versions: Array<{
    id: string;
    version: number;
    contentHash: string;
    decision: string | null;
    decidedBy: string | null;
    facts: {
      salesCentavos: string;
      varianceCentavos: string | null;
      toleranceBasisPoints: number;
      equation: string;
      physicalExplanation: string;
    };
  }>;
  cases: Array<{
    id: string;
    level: string;
    varianceCentavos: string | null;
    dueAt: string;
  }>;
  containers: Array<{
    outletId: string | null;
    outletName?: string;
    typeCode: string;
    label: string;
    outstanding: string;
    lastCount: string | null;
  }>;
  scorecard: RouteScorecard;
  tripFacts: { startOdometerKm: number | null; endOdometerKm: number | null };
  reloads: Array<{
    id: string;
    facts: {
      lines: Array<{
        productId: string;
        quantityBase: string;
        product?: {
          name: string;
          quantityScale: string;
          caseBase: string;
          uomCode: string;
        };
      }>;
    };
    events: Array<{
      kind: string;
      facts: {
        lines: Array<{
          productId: string;
          quantityBase: string;
          lotId: string | null;
          batch: string | null;
        }>;
      };
    }>;
  }>;
};

/** F-115/F-116/F-117/F-118 decision adapters within the existing trip, never another ledger. */
export function RouteOperationsReview({ trip }: { trip: TripSettlement }) {
  const { can } = usePermissions();
  const command = useVanCommand<Record<string, unknown>, unknown>(
    "/api/v1/van/observations/decide",
  );
  const settle = useVanCommand<Record<string, unknown>, unknown>(
    "/api/v1/van/settlements/decide",
  );
  const variance = useVanCommand<Record<string, unknown>, unknown>(
    "/api/v1/van/variances/decide",
  );
  const reload = useVanCommand<Record<string, unknown>, unknown>(
    "/api/v1/van/reloads/action",
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const route = trip.vanOps;

  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the decision");
    } finally {
      setBusy(false);
    }
  }
  if (!route) return null;
  const reviewer = can("van.stock.approve"),
    latest = route.versions[0];
  return (
    <section
      aria-label="Route operations review"
      className="grid gap-5 rounded-lg border border-separator p-4"
    >
      <header>
        <h3 className="font-medium">Can this trip be signed off?</h3>
        <p className="text-sm text-muted">
          Seller completion is not warehouse receipt, supervisor approval or SAP
          posting.
        </p>
      </header>
      {route.scorecard && <RouteScorecardView card={route.scorecard} />}
      <section aria-label="Planned and actual stop sequence">
        <h4 className="font-medium">Beat versus actual stop sequence</h4>
        <p className="text-sm">
          Odometer{" "}
          {route.tripFacts?.startOdometerKm ?? "Opening reading missing"} →{" "}
          {route.tripFacts?.endOdometerKm ?? "Closing reading not received"} km
        </p>
        <ol>
          {route.observations
            .filter((o) => o.kind === "stop")
            .map((o) => (
              <li key={o.id} className="text-sm">
                {o.outletName ?? "Store"} · {o.facts.phase} · actual{" "}
                {o.facts.actualSequence ?? "Not captured"} / planned{" "}
                {o.facts.plannedSequence ?? "Off beat"} ·{" "}
                {new Date(o.capturedAt).toLocaleTimeString("en-PH")}
                {o.facts.durationSeconds !== undefined
                  ? ` · ${Math.floor(o.facts.durationSeconds / 60)} minutes`
                  : ""}
              </li>
            ))}
        </ol>
      </section>
      {error && <p role="alert">{error}</p>}
      {reviewer && (
        <label className="text-sm">
          Decision note
          <input
            aria-label="Route decision note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
          />
        </label>
      )}
      <section aria-label="Temperature review">
        <h4 className="font-medium">
          Cold chain · every {route.policies.cold_chain.intervalMinutes} minutes
        </h4>
        {route.observations
          .filter((o) => o.kind === "temperature")
          .map((o) => (
            <div key={o.id} className="border-b border-separator py-3 text-sm">
              <p>
                {(o.facts.deciC ?? 0) / 10} °C ·{" "}
                {o.facts.checkpoint?.replaceAll("_", " ")} ·{" "}
                {o.outletName ?? "Van"}
              </p>
              <p>
                {o.facts.excursion || o.facts.lateFromPrior
                  ? o.decision === "released"
                    ? "Cold-chain exception released by office"
                    : "Cold-chain exception — quality review required"
                  : "Within the captured storage bands"}
              </p>
              {o.facts.lateFromPrior && (
                <p>
                  Reading interval missed · {o.facts.gapMinutes} minutes since
                  the prior reading.
                </p>
              )}
              {reviewer &&
                (o.facts.excursion || o.facts.lateFromPrior) &&
                !o.decision && (
                  <div className="flex gap-2 print:hidden">
                    {["released", "quarantine"].map((decision) => (
                      <Button
                        key={decision}
                        variant="outline"
                        isDisabled={busy || !note.trim()}
                        onPress={() =>
                          void run(() =>
                            command({
                              tripId: trip.tripId,
                              observationId: o.id,
                              decision,
                              note,
                            }),
                          )
                        }
                      >
                        {decision === "released"
                          ? "Release with explanation"
                          : "Quarantine"}
                      </Button>
                    ))}
                  </div>
                )}
            </div>
          ))}
      </section>
      {route.observations
        .filter((o) => o.kind === "unload")
        .map((o) => (
          <WarehouseUnloadReceipt
            key={o.id}
            observation={o}
            tripId={trip.tripId}
            note={note}
            busy={busy}
            reviewer={reviewer}
            onReceive={(payload) => run(() => command(payload))}
          />
        ))}
      <section aria-label="Reload approvals">
        <h4 className="font-medium">En-route reloads</h4>
        {route.reloads?.map((r) => (
          <div key={r.id} className="grid gap-2 border-b border-separator py-2">
            <ul>
              {r.facts.lines.map((l, i) => (
                <li key={i} className="text-sm">
                  {l.product?.name ?? "Reload product"} ·{" "}
                  {l.product
                    ? routeQuantity(
                        l.quantityBase,
                        l.product.quantityScale,
                        l.product.caseBase,
                        l.product.uomCode,
                      )
                    : "Original unit details unavailable"}
                </li>
              ))}
            </ul>
            <p className="text-sm">
              {r.events.some((e) => e.kind === "received")
                ? "Seller received exact dispatched batches"
                : r.events.some((e) => e.kind === "dispatched")
                  ? "In transit — not sellable until seller receipt"
                  : r.events.some((e) => e.kind === "approved")
                    ? "Approved — warehouse must dispatch"
                    : trip.status === "active"
                      ? "Waiting for office approval"
                      : "Not fulfilled before trip completion — no reload stock added"}
            </p>
            {can("van.load.approve") &&
              trip.status === "active" &&
              !r.events.some((e) => e.kind === "dispatched") && (
                <Button
                  variant="outline"
                  isDisabled={busy || !note.trim()}
                  onPress={() =>
                    void run(() =>
                      reload({
                        tripId: trip.tripId,
                        requestId: r.id,
                        action: r.events.some((e) => e.kind === "approved")
                          ? "dispatched"
                          : "approved",
                        note,
                      }),
                    )
                  }
                >
                  {r.events.some((e) => e.kind === "approved")
                    ? "Dispatch governed FEFO batches"
                    : "Approve reload request"}
                </Button>
              )}
          </div>
        ))}
      </section>
      <section aria-label="Container custody">
        <h4 className="font-medium">Containers still owed to this van</h4>
        {route.containers.length ? (
          <ul>
            {route.containers.map((c) => (
              <li key={`${c.outletId}:${c.typeCode}`} className="text-sm">
                {c.label} · {c.outstanding} outstanding
                {c.lastCount !== null
                  ? ` · last physical count ${c.lastCount}`
                  : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">No container movements received.</p>
        )}
      </section>
      {route.cases.map((c) => (
        <section key={c.id} aria-label="Variance escalation">
          <h4 className="font-medium">Variance {money(c.varianceCentavos)}</h4>
          <p className="text-sm">
            {c.level === "supervisor"
              ? "Supervisor review, then area manager"
              : c.level === "area_manager"
                ? "A different area manager must record disposition"
                : "Disposition recorded"}{" "}
            · due {new Date(c.dueAt).toLocaleString("en-PH")}
          </p>
          {reviewer && c.level !== "disposed" && (
            <div className="flex gap-2">
              {(c.level === "supervisor"
                ? ["escalate"]
                : ["accept", "investigate", "recover"]
              ).map((action) => (
                <Button
                  key={action}
                  variant="outline"
                  isDisabled={busy || !note.trim()}
                  onPress={() =>
                    void run(() =>
                      variance({
                        tripId: trip.tripId,
                        caseId: c.id,
                        action,
                        note,
                      }),
                    )
                  }
                >
                  {action === "escalate"
                    ? "Send to area manager"
                    : action === "accept"
                      ? "Accept explained difference"
                      : action === "recover"
                        ? "Record recovery"
                        : "Record investigation"}
                </Button>
              ))}
            </div>
          )}
        </section>
      ))}
      {latest && (
        <section aria-label="Versioned settlement">
          <h4 className="font-medium">
            Settlement version {latest.version} ·{" "}
            {latest.decision === "approved"
              ? route.settlementState === "posted"
                ? "Posted to SAP"
                : "Approved — SAP pending"
              : latest.decision === "rejected"
                ? "Returned for correction"
                : "Pending supervisor"}
          </h4>
          <p className="text-sm">{latest.facts.equation}</p>
          <p className="text-xs text-muted">
            {latest.facts.physicalExplanation}
          </p>
          <p className="my-2">
            Sales {money(latest.facts.salesCentavos)} · variance{" "}
            {money(latest.facts.varianceCentavos)} · tolerance{" "}
            {latest.facts.toleranceBasisPoints / 100}%
          </p>
          {reviewer && !latest.decision && (
            <div className="flex gap-2">
              {["approved", "rejected"].map((decision) => (
                <Button
                  key={decision}
                  variant="outline"
                  isDisabled={busy || !note.trim()}
                  onPress={() =>
                    void run(() =>
                      settle({
                        tripId: trip.tripId,
                        settlementId: latest.id,
                        contentHash: latest.contentHash,
                        decision,
                        note,
                      }),
                    )
                  }
                >
                  {decision === "approved"
                    ? "Sign off this version"
                    : "Return for correction"}
                </Button>
              ))}
            </div>
          )}
        </section>
      )}
      {can("van.manage") && <VanPolicyEditor trip={trip} />}
    </section>
  );
}
