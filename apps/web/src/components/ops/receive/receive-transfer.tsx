"use client";

import { Button } from "@heroui/react";
import { Card, Notice } from "@sunpride/ui";
import { useState } from "react";
import { useMutate } from "@/lib/api";
import { CasesPiecesStepper, QtyCasesPieces } from "../qty-cases-pieces";
import { ReasonSelect } from "../reason-select";
import {
  daysToExpiry,
  receivePayload,
  receiveProblems,
  receiveRows,
  rowExtra,
  rowMissing,
  type ReceiveRow,
  type Transfer,
} from "../transfers/transfer-model";
import { useIntent } from "../transfers/use-intent";
import { PhotoCount } from "./photo-count";

/**
 * The line grid for receiving a transfer (also used for van reloads and van load-ins): what was sent, what arrived
 * good, what arrived damaged. Anything missing is "short"; anything extra is "over". Nothing here edits the sender's numbers.
 */
export function ReceiveGrid({
  rows,
  onChange,
  final,
  onFinalChange,
  problems,
  pending,
  onReceive,
  error,
}: {
  rows: ReceiveRow[];
  onChange: (next: ReceiveRow[]) => void;
  final: boolean;
  onFinalChange: (v: boolean) => void;
  problems: string[];
  pending?: boolean;
  onReceive: () => void;
  error?: string | null;
}) {
  const set = (key: string, patch: Partial<ReceiveRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const missing = rows.reduce((n, r) => n + rowMissing(r), 0);
  const extra = rows.reduce((n, r) => n + rowExtra(r), 0);
  return (
    <div className="grid gap-4">
      {rows.map((r) => {
        const days = daysToExpiry(r.expiresAt);
        return (
          <div
            key={r.key}
            className="grid gap-3 rounded-2xl border border-border bg-surface p-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="text-base font-medium">{r.name}</p>
                {r.batch ? (
                  <p className="text-sm text-muted">
                    Batch {r.batch}
                    {days != null ? ` (${days} days)` : ""}
                    {r.held ? " · On hold: recalled or held" : ""}
                  </p>
                ) : null}
              </div>
              <p className="text-sm text-muted">
                Sent{" "}
                <QtyCasesPieces
                  base={r.dispatchedBase}
                  basePerCase={r.basePerCase}
                />
                {r.alreadyBase > 0 ? (
                  <>
                    {" "}
                    · already in{" "}
                    <QtyCasesPieces
                      base={r.alreadyBase}
                      basePerCase={r.basePerCase}
                    />
                  </>
                ) : null}
              </p>
            </div>
            {r.held ? (
              <Notice
                tone="warning"
                title="This batch goes On hold, it is not refused."
                meta="A supervisor releases it after the check."
              />
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1">
                <span className="text-xs font-medium uppercase text-muted">
                  Arrived good
                </span>
                <CasesPiecesStepper
                  value={r.good}
                  basePerCase={r.basePerCase}
                  onChange={(good) => set(r.key, { good })}
                />
              </div>
              <div className="grid gap-1">
                <span className="text-xs font-medium uppercase text-muted">
                  Arrived damaged
                </span>
                <CasesPiecesStepper
                  value={r.damaged}
                  basePerCase={r.basePerCase}
                  onChange={(damaged) => set(r.key, { damaged })}
                />
              </div>
            </div>
            {r.damaged.cases + r.damaged.pieces > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <ReasonSelect
                  direction="out"
                  category="damage"
                  label="Why damaged"
                  value={r.reason}
                  onChange={(code, reason) =>
                    set(r.key, {
                      reason: code,
                      reasonNeedsPhoto: Boolean(reason?.requiresPhoto),
                    })
                  }
                />
                {r.reasonNeedsPhoto ? (
                  <PhotoCount
                    count={r.photoCount}
                    onChange={(photoCount) => set(r.key, { photoCount })}
                  />
                ) : null}
              </div>
            ) : null}
            <p className="text-sm">
              {rowMissing(r) > 0 ? (
                <span className="font-medium text-danger">
                  Not here:{" "}
                  <QtyCasesPieces
                    base={rowMissing(r)}
                    basePerCase={r.basePerCase}
                  />
                </span>
              ) : rowExtra(r) > 0 ? (
                <span className="font-medium text-warning">
                  Extra:{" "}
                  <QtyCasesPieces
                    base={rowExtra(r)}
                    basePerCase={r.basePerCase}
                  />{" "}
                  (recorded as over)
                </span>
              ) : (
                <span className="text-success">All here</span>
              )}
            </p>
          </div>
        );
      })}
      {rows.length === 0 ? (
        <Notice
          tone="success"
          title="Everything that was sent is already in."
        />
      ) : null}
      {missing > 0 ? (
        <label className="flex min-h-12 items-center gap-3 text-base">
          <input
            type="checkbox"
            className="size-6"
            checked={final}
            onChange={(e) => onFinalChange(e.target.checked)}
          />
          That is everything. Count what did not arrive as short.
        </label>
      ) : null}
      {extra > 0 ? (
        <Notice
          tone="warning"
          title="Extra stock is recorded as over."
          meta="Inside the allowed difference it is added to your stock at once; a bigger difference waits for a supervisor."
        />
      ) : null}
      {problems.length ? (
        <ul className="grid gap-1 text-sm text-danger" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        variant="primary"
        className="min-h-12 text-base"
        isDisabled={problems.length > 0 || rows.length === 0}
        isPending={pending}
        onPress={onReceive}
      >
        {final && missing > 0 ? "Receive and close out" : "Receive"}
      </Button>
    </div>
  );
}

/** Container: posts POST /api/v1/inventory/transfers/receive for one transfer document. */
export function ReceiveTransfer({
  transfer,
  onDone,
}: {
  transfer: Transfer;
  onDone?: (result: { status: string; varianceStatus?: string }) => void;
}) {
  const [rows, setRows] = useState(() => receiveRows(transfer));
  const [final, setFinal] = useState(false);
  const intent = useIntent();
  const write = useMutate();
  const problems = receiveProblems(rows);
  return (
    <Card label={`Receive ${transfer.number}`}>
      <ReceiveGrid
        rows={rows}
        onChange={setRows}
        final={final}
        onFinalChange={setFinal}
        problems={problems}
        pending={write.pending}
        error={write.error?.message ?? null}
        onReceive={async () => {
          const path = "/api/v1/inventory/transfers/receive";
          const body = receivePayload(transfer.id, rows, final);
          try {
            const result = await write.mutate<{
              status: string;
              varianceStatus?: string;
            }>(path, intent.withKey(path, body), {
              invalidate: [["inventory"]],
            });
            intent.done(path, body);
            onDone?.(result);
          } catch {
            // The error is shown under the grid; the same request can be tried again safely.
          }
        }}
      />
    </Card>
  );
}
