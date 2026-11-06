"use client";

import { Button, Input } from "@heroui/react";
import { Card, FormField, Notice } from "@sunpride/ui";
import { useState, type ReactNode } from "react";
import { apiFetch, useApi, useMutate } from "@/lib/api";
import { DocNumber } from "../doc-number";
import { Peso } from "../peso";
import { QtyCasesPieces } from "../qty-cases-pieces";
import { ReceiveTransfer } from "../receive/receive-transfer";
import { StatusPill } from "../status-pill";
import {
  daysToExpiry,
  nextStep,
  type Transfer,
  type TransferStatus,
} from "./transfer-model";
import { useIntent } from "./use-intent";
import { VarianceResolution } from "./variance-resolution";

const CANCELLABLE: TransferStatus[] = [
  "draft",
  "requested",
  "approved",
  "picking",
];

/** Pure view of one movement document: header, the one next step, every line with its batches. */
export function TransferDetailView({
  transfer,
  panel,
  pending,
  error,
  onCommand,
  dispatchHeader,
  onDispatchHeader,
}: {
  transfer: Transfer;
  /** Receive grid or difference form, shown under the header. */
  panel?: ReactNode;
  pending?: boolean;
  error?: string | null;
  onCommand: (command: string) => void;
  dispatchHeader: {
    driverName: string;
    vehiclePlate: string;
    receiverName: string;
  };
  onDispatchHeader: (h: {
    driverName: string;
    vehiclePlate: string;
    receiverName: string;
  }) => void;
}) {
  const step = nextStep(transfer.status);
  const field =
    "min-h-12 w-full rounded-[10px] border border-field-border bg-field-background px-3 text-base";
  const who = (p: { name: string | null } | null) => p?.name ?? "—";
  return (
    <div className="grid gap-4">
      <Card label={transfer.typeLabel}>
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <DocNumber value={transfer.number} className="text-lg" />
            <StatusPill state={transfer.status} />
          </div>
          <p className="text-lg">
            {transfer.source?.name} → {transfer.destination?.name}
          </p>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <Fact label="Driver" value={transfer.header.driverName} />
            <Fact label="Vehicle plate" value={transfer.header.vehiclePlate} />
            <Fact label="Receiver" value={transfer.header.receiverName} />
            <Fact label="Asked by" value={who(transfer.people.requestedBy)} />
            <Fact label="Approved by" value={who(transfer.people.approvedBy)} />
            <Fact label="Sent by" value={who(transfer.people.dispatchedBy)} />
            <Fact label="Received by" value={who(transfer.people.receivedBy)} />
            {transfer.header.note ? (
              <Fact label="Note" value={transfer.header.note} />
            ) : null}
          </dl>
          {transfer.varianceStatus === "open" ? (
            <Notice
              tone="danger"
              title="There is a difference waiting for a decision."
              meta={
                <>
                  Value <Peso centavos={transfer.varianceValueCentavos} />
                </>
              }
            />
          ) : null}
          {transfer.recountOpen ? (
            <Notice
              tone="warning"
              title="A supervisor asked for the count to be done again."
              meta={(() => {
                const last = transfer.recounts?.at(-1);
                return last
                  ? `${last.requestedBy.name ?? "A supervisor"}: ${last.reason}`
                  : "Count what arrived once more and receive it.";
              })()}
            />
          ) : null}
          {transfer.varianceStatus === "auto_accepted" ? (
            <Notice
              tone="success"
              title="A small difference was accepted automatically."
              meta="It was inside the allowed amount."
            />
          ) : null}
          {transfer.status === "approved" || transfer.status === "picking" ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField label="Driver">
                <Input
                  className={field}
                  value={dispatchHeader.driverName}
                  onChange={(e) =>
                    onDispatchHeader({
                      ...dispatchHeader,
                      driverName: e.target.value,
                    })
                  }
                />
              </FormField>
              <FormField label="Vehicle plate">
                <Input
                  className={field}
                  value={dispatchHeader.vehiclePlate}
                  onChange={(e) =>
                    onDispatchHeader({
                      ...dispatchHeader,
                      vehiclePlate: e.target.value,
                    })
                  }
                />
              </FormField>
              <FormField label="Receiver">
                <Input
                  className={field}
                  value={dispatchHeader.receiverName}
                  onChange={(e) =>
                    onDispatchHeader({
                      ...dispatchHeader,
                      receiverName: e.target.value,
                    })
                  }
                />
              </FormField>
            </div>
          ) : null}
          {error ? (
            <Notice tone="danger" title="That did not work." meta={error} />
          ) : null}
          <div className="flex flex-wrap gap-3">
            {step ? (
              <Button
                variant="primary"
                className="min-h-12 text-base"
                isPending={pending}
                onPress={() => onCommand(step.command)}
              >
                {step.label}
              </Button>
            ) : null}
            {CANCELLABLE.includes(transfer.status) ? (
              <Button
                variant="outline"
                className="min-h-12 text-base"
                isDisabled={pending}
                onPress={() => onCommand("cancel")}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </Card>

      {panel}

      <Card label="Lines" count={transfer.lines.length} flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2">Product</th>
                <Num>Asked</Num>
                <Num>Approved</Num>
                <Num>Sent</Num>
                <Num>Good</Num>
                <Num>On hold</Num>
                <Num>Damaged</Num>
                <Num>Short</Num>
                <Num>Over</Num>
              </tr>
            </thead>
            <tbody className="divide-y divide-separator">
              {transfer.lines.map((l) => (
                <LineRows key={l.id} l={l} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {transfer.resolutions?.length ? (
        <Card label="Decisions" count={transfer.resolutions.length}>
          <ul className="grid gap-2 text-sm">
            {transfer.resolutions.map((r) => (
              <li key={r.id}>
                {r.auto
                  ? "Accepted automatically"
                  : `Charged to ${r.chargeTo.replace("_", " ")}`}
                {r.shortBase ? ` · short ${r.shortBase} pc written off` : ""}
                {r.overBase ? ` · over ${r.overBase} pc added` : ""} ·{" "}
                <Peso centavos={r.valueCentavos} />
                {r.note ? ` · ${r.note}` : ""}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

const Num = ({ children }: { children: ReactNode }) => (
  <th className="px-2 py-2 text-right">{children}</th>
);
function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted">{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}
function LineRows({ l }: { l: Transfer["lines"][number] }) {
  const q = (n: number) => (
    <td className="px-2 py-2 text-right tabular-nums">
      {n ? <QtyCasesPieces base={n} basePerCase={l.basePerCase} /> : "—"}
    </td>
  );
  return (
    <>
      <tr>
        <td className="px-4 py-2 font-medium">{l.name}</td>
        {q(l.requestedBase)}
        {q(l.approvedBase)}
        {q(l.dispatchedBase)}
        {q(l.receivedGoodBase)}
        {q(l.receivedHoldBase)}
        {q(l.receivedDamagedBase)}
        <td className="px-2 py-2 text-right tabular-nums text-danger">
          {l.shortBase ? (
            <QtyCasesPieces base={l.shortBase} basePerCase={l.basePerCase} />
          ) : (
            "—"
          )}
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-warning">
          {l.overBase ? (
            <QtyCasesPieces base={l.overBase} basePerCase={l.basePerCase} />
          ) : (
            "—"
          )}
        </td>
      </tr>
      {l.allocations
        .filter((a) => a.batch)
        .map((a) => {
          const days = daysToExpiry(a.expiresAt);
          return (
            <tr key={a.id} className="text-xs text-muted">
              <td className="px-4 pb-2 pl-8">
                Batch {a.batch}
                {days != null ? ` (${days} days)` : ""}
                {a.held ? " · On hold" : ""}
              </td>
              <td />
              <td />
              <td className="px-2 pb-2 text-right">
                <QtyCasesPieces
                  base={a.dispatchedBase}
                  basePerCase={l.basePerCase}
                />
              </td>
              <td className="px-2 pb-2 text-right">
                <QtyCasesPieces
                  base={a.receivedGoodBase}
                  basePerCase={l.basePerCase}
                />
              </td>
              <td className="px-2 pb-2 text-right">
                <QtyCasesPieces
                  base={a.receivedHoldBase}
                  basePerCase={l.basePerCase}
                />
              </td>
              <td className="px-2 pb-2 text-right">
                <QtyCasesPieces
                  base={a.receivedDamagedBase}
                  basePerCase={l.basePerCase}
                />
              </td>
              <td />
              <td />
            </tr>
          );
        })}
    </>
  );
}

const SIMPLE = ["approve", "pick", "dispatch", "cancel"] as const;

/** Container: loads one document and runs its commands. Receive and decide open their own panels. */
export function TransferDetail({ transferId }: { transferId: string }) {
  const detail = useApi<Transfer>(
    ["inventory", "transfers", "detail", transferId],
    ({ signal }) =>
      apiFetch<Transfer>("/api/v1/inventory/transfers/detail", {
        query: { id: transferId },
        signal,
      }),
  );
  const [receiving, setReceiving] = useState(false);
  const [header, setHeader] = useState({
    driverName: "",
    vehiclePlate: "",
    receiverName: "",
  });
  const intent = useIntent();
  const write = useMutate();
  const t = detail.data;
  if (detail.error)
    return (
      <Notice
        tone="danger"
        title="This transfer could not load."
        meta="It may be outside your area."
      />
    );
  if (!t) return <p className="text-sm text-muted">Loading…</p>;
  const refresh = [["inventory"]] as const;
  const run = async (command: string) => {
    if (command === "receive") return setReceiving(true);
    if (!(SIMPLE as readonly string[]).includes(command)) return;
    const path = `/api/v1/inventory/transfers/${command}`;
    const body: Record<string, unknown> = {
      transferId: t.id,
      ...(command === "dispatch"
        ? Object.fromEntries(Object.entries(header).filter(([, v]) => v.trim()))
        : {}),
    };
    try {
      await write.mutate(path, intent.withKey(path, body), {
        invalidate: refresh,
      });
      intent.done(path, body);
    } catch {
      // shown in the header card
    }
  };
  const panel =
    receiving && ["dispatched", "partially_received"].includes(t.status) ? (
      <ReceiveTransfer transfer={t} onDone={() => setReceiving(false)} />
    ) : t.status === "review_needed" ? (
      <VarianceResolution transfer={t} />
    ) : null;
  return (
    <TransferDetailView
      transfer={t}
      panel={panel}
      pending={write.pending}
      error={write.error?.message ?? null}
      onCommand={run}
      dispatchHeader={{
        driverName: header.driverName || t.header.driverName || "",
        vehiclePlate: header.vehiclePlate || t.header.vehiclePlate || "",
        receiverName: header.receiverName || t.header.receiverName || "",
      }}
      onDispatchHeader={setHeader}
    />
  );
}
