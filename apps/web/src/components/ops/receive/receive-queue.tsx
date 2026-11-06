"use client";

import { Button } from "@heroui/react";
import { Card, Notice } from "@sunpride/ui";
import { apiFetch, useApi } from "@/lib/api";
import { DocNumber } from "../doc-number";
import { QtyCasesPieces } from "../qty-cases-pieces";
import { StatusPill } from "../status-pill";

export type QueueTransfer = {
  id: string;
  number: string;
  type: string;
  status: string;
  from: string;
  to: string;
  toLocationId: string;
  driverName: string | null;
  vehiclePlate: string | null;
  dispatchedAt: string | null;
  lineCount: number;
  dispatchedBase: number;
  receivedBase: number;
  waitingForDecision: boolean;
};
export type QueueLoadIn = {
  observationId: string;
  tripId: string;
  tripNumber: string;
  truck: string;
  countedAt: string;
  status: "waiting_for_clerk";
};
export type ReceiveQueueData = {
  expectedDeliveries: Array<{
    id: string;
    supplier: string;
    reference: string | null;
  }>;
  expectedDeliveriesNote?: string;
  inboundTransfers: QueueTransfer[];
  vanLoadIns: Array<QueueTransfer | QueueLoadIn>;
  locations: Array<{ id: string; code: string; name: string; type: string }>;
};

const isCount = (x: QueueTransfer | QueueLoadIn): x is QueueLoadIn =>
  "observationId" in x;

/** Pure view of the clerk's Receive queue (SPEC 4.2): inbound transfers, van load-ins, expected deliveries. */
export function ReceiveQueueView({
  data,
  onOpenTransfer,
  onOpenLoadIn,
  onUnplanned,
}: {
  data: ReceiveQueueData;
  onOpenTransfer: (id: string) => void;
  onOpenLoadIn?: (tripId: string, observationId: string) => void;
  onUnplanned: () => void;
}) {
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          What is on its way to you, and what has come back.
        </p>
        <Button
          variant="primary"
          className="min-h-12 text-base"
          onPress={onUnplanned}
        >
          Unplanned delivery
        </Button>
      </div>
      <Card label="Expected deliveries" count={data.expectedDeliveries.length}>
        {data.expectedDeliveries.length ? (
          <ul className="grid gap-2">
            {data.expectedDeliveries.map((d) => (
              <li key={d.id}>
                {d.supplier} {d.reference ? `· ${d.reference}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            {data.expectedDeliveriesNote ??
              "No deliveries are expected. Use Unplanned delivery."}
          </p>
        )}
      </Card>
      <Card label="Inbound transfers" count={data.inboundTransfers.length}>
        {data.inboundTransfers.length ? (
          <ul className="grid gap-3">
            {data.inboundTransfers.map((t) => (
              <TransferRow key={t.id} t={t} onOpen={onOpenTransfer} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Nothing is on its way to you.</p>
        )}
      </Card>
      <Card label="Van load-ins" count={data.vanLoadIns.length}>
        {data.vanLoadIns.length ? (
          <ul className="grid gap-3">
            {data.vanLoadIns.map((x) =>
              isCount(x) ? (
                <li
                  key={x.observationId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3"
                >
                  <div>
                    <p className="font-medium">
                      {x.truck} is back · {x.tripNumber}
                    </p>
                    <p className="text-sm text-muted">
                      Seller counted the truck. Count it again, then receive.
                    </p>
                  </div>
                  <Button
                    variant="primary"
                    className="min-h-12"
                    onPress={() => onOpenLoadIn?.(x.tripId, x.observationId)}
                  >
                    Receive truck stock
                  </Button>
                </li>
              ) : (
                <TransferRow key={x.id} t={x} onOpen={onOpenTransfer} />
              ),
            )}
          </ul>
        ) : (
          <p className="text-sm text-muted">No trucks are waiting.</p>
        )}
      </Card>
      {data.inboundTransfers.some((t) => t.waitingForDecision) ? (
        <Notice
          tone="warning"
          title="Some deliveries have a difference waiting for a supervisor."
        />
      ) : null}
    </div>
  );
}

function TransferRow({
  t,
  onOpen,
}: {
  t: QueueTransfer;
  onOpen: (id: string) => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <DocNumber value={t.number} />
          <StatusPill state={t.status} />
        </div>
        <p className="text-sm">
          {t.from} → {t.to}
        </p>
        <p className="text-sm text-muted">
          {t.lineCount} line{t.lineCount === 1 ? "" : "s"} · sent{" "}
          <QtyCasesPieces base={t.dispatchedBase} />
          {t.driverName ? ` · driver ${t.driverName}` : ""}
          {t.vehiclePlate ? ` · ${t.vehiclePlate}` : ""}
        </p>
      </div>
      <Button
        variant={t.waitingForDecision ? "outline" : "primary"}
        className="min-h-12 text-base"
        onPress={() => onOpen(t.id)}
      >
        {t.waitingForDecision ? "See difference" : "Receive"}
      </Button>
    </li>
  );
}

/** Container for the Receive queue. */
export function ReceiveQueue(props: {
  onOpenTransfer: (id: string) => void;
  onOpenLoadIn?: (tripId: string, observationId: string) => void;
  onUnplanned: () => void;
}) {
  const queue = useApi<ReceiveQueueData>(
    ["inventory", "receive", "queue"],
    ({ signal }) =>
      apiFetch<ReceiveQueueData>("/api/v1/inventory/receive/queue", {
        signal,
      }),
  );
  if (queue.error)
    return (
      <Notice
        tone="danger"
        title="The Receive list could not load."
        meta="Check your connection and try again."
      />
    );
  if (!queue.data) return <p className="text-sm text-muted">Loading…</p>;
  return <ReceiveQueueView data={queue.data} {...props} />;
}
