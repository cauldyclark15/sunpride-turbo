"use client";

import { Button } from "@heroui/react";
import { Card, Notice } from "@sunpride/ui";
import { useState } from "react";
import { apiFetch, useApi, useMutate } from "@/lib/api";
import { DocNumber } from "../doc-number";
import { Peso } from "../peso";
import { StatusPill } from "../status-pill";
import {
  actionRequest,
  approveAllRequest,
  attentionFor,
  byStage,
  cleanTripIds,
  LOAD_PILL,
  loadText,
  opens,
  type BoardRow,
  type DayBoard,
} from "./vanday-model";
import { useIntent } from "../transfers/use-intent";

/** One truck: who, load status, trip status, cash, and ONE button. */
export function BoardRowCard({
  row,
  pending,
  onAction,
}: {
  row: BoardRow;
  pending?: boolean;
  onAction: (row: BoardRow) => void;
}) {
  const pill = LOAD_PILL[row.load.state];
  const why = attentionFor(row);
  return (
    <li
      className={`grid gap-2 px-4 py-3 ${row.needsAttention ? "bg-warning-soft/30" : ""}`}
      data-trip={row.tripId ?? undefined}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-lg font-semibold">{row.vehicleCode}</span>
        <span className="text-sm text-muted">{row.plateNumber}</span>
        <span className="text-base">{row.routeName}</span>
        <StatusPill state={pill.state}>{pill.label}</StatusPill>
        <span className="text-sm text-muted">Trip: {row.trip.label}</span>
      </div>
      <div className="grid gap-1 text-base sm:grid-cols-2 lg:grid-cols-4">
        <span>
          <span className="text-sm text-muted">Seller </span>
          {row.sellerName ?? "Not set"}
          {row.crew.filter((c) => c.role !== "seller").length ? (
            <span className="text-sm text-muted">
              {" "}
              + {row.crew
                .filter((c) => c.role !== "seller")
                .map((c) => `${c.name} (${c.role})`)
                .join(", ")}
            </span>
          ) : null}
          {row.onPhone && row.onPhone.name !== row.sellerName ? (
            <span className="block text-sm text-muted">
              On the phone now: {row.onPhone.name}
            </span>
          ) : null}
        </span>
        <span>
          <span className="text-sm text-muted">Load </span>
          {row.load.products ? (
            <>
              {row.load.products} product{row.load.products === 1 ? "" : "s"},{" "}
              {loadText(row.load.cases, row.load.pieces)}
            </>
          ) : (
            "None"
          )}
          {row.load.number ? (
            <span className="block">
              <DocNumber value={row.load.number} />
            </span>
          ) : null}
        </span>
        <span>
          <span className="text-sm text-muted">Cash expected </span>
          <Peso centavos={row.cash.expectedCentavos} />
          {row.cash.remittedCentavos !== null ? (
            <span className="block text-sm text-muted">
              Handed in <Peso centavos={row.cash.remittedCentavos} />
            </span>
          ) : null}
        </span>
        <span>
          <span className="text-sm text-muted">Load-in </span>
          {row.loadIn ? <DocNumber value={row.loadIn.number} /> : "Not yet"}
          <span className="block text-sm text-muted">
            Settlement: {row.settlement.label}
          </span>
        </span>
      </div>
      {why.length ? (
        <ul className="text-sm text-warning" aria-label="Needs attention">
          {why.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      <div>
        <Button
          variant={row.primary.enabled ? "primary" : "secondary"}
          className="min-h-12 text-base"
          isDisabled={!row.primary.enabled}
          isPending={pending}
          onPress={() => onAction(row)}
        >
          {row.primary.label}
        </Button>
      </div>
    </li>
  );
}

/** The whole day for one depot. Pure: data in, callbacks out. */
export function VanDayBoardView({
  board,
  pendingTrip,
  bulkPending,
  error,
  onAction,
  onApproveClean,
  onCopyYesterday,
  onDate,
}: {
  board: DayBoard;
  pendingTrip?: string | null;
  bulkPending?: boolean;
  error?: string | null;
  onAction: (row: BoardRow) => void;
  onApproveClean: (tripIds: string[]) => void;
  onCopyYesterday: () => void;
  onDate?: (date: string) => void;
}) {
  const clean = cleanTripIds(board.rows);
  const stages = byStage(board.rows);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">Van day</h2>
        {onDate ? (
          <input
            type="date"
            aria-label="Day"
            className="min-h-12 rounded-[10px] border border-field-border bg-field-background px-3 text-base"
            value={board.date}
            onChange={(e) => onDate(e.target.value)}
          />
        ) : (
          <span className="text-base">{board.date}</span>
        )}
        <span className="text-base font-medium" role="status">
          {board.summary.text}
        </span>
        <span className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="secondary"
            className="min-h-12 text-base"
            onPress={onCopyYesterday}
          >
            Copy yesterday
          </Button>
          <Button
            variant="primary"
            className="min-h-12 text-base"
            isDisabled={!clean.length}
            isPending={bulkPending}
            onPress={() => onApproveClean(clean)}
          >
            {clean.length
              ? `Approve ${clean.length} clean load${clean.length === 1 ? "" : "s"}`
              : "No clean loads to approve"}
          </Button>
        </span>
      </div>
      {board.summary.lastRun ? (
        <p className="text-sm text-muted">
          Last plan: {board.summary.lastRun.planned} trip
          {board.summary.lastRun.planned === 1 ? "" : "s"} made,{" "}
          {board.summary.lastRun.needsAttention} need attention
        </p>
      ) : null}
      {error ? (
        <Notice tone="danger" title="That could not be done." meta={error} />
      ) : null}
      {stages.length ? (
        stages.map((s) => (
          <Card key={s.id} label={s.label} count={s.rows.length} flush>
            <ul className="divide-y divide-separator">
              {s.rows.map((r) => (
                <BoardRowCard
                  key={r.tripId ?? r.vehicleId}
                  row={r}
                  pending={pendingTrip === (r.tripId ?? r.vehicleId)}
                  onAction={onAction}
                />
              ))}
            </ul>
          </Card>
        ))
      ) : (
        <Notice
          tone="neutral"
          title="No trucks are rostered for this day."
          meta="Add them in the roster, then plan the day."
        />
      )}
    </div>
  );
}

/** Container: loads the board, posts the one button of a row, bulk-approves clean loads. */
export function VanDayBoard({
  date,
  unitId,
  onOpen,
}: {
  date: string;
  unitId?: string;
  /** Called for buttons that open a screen instead of posting. */
  onOpen: (what: "load" | "recount" | "decide" | "trip", row: BoardRow) => void;
}) {
  const [day, setDay] = useState(date);
  const [pendingTrip, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const write = useMutate();
  const intent = useIntent();
  const board = useApi<DayBoard>(
    ["van", "day-board", day, unitId ?? ""],
    ({ signal }) =>
      apiFetch<DayBoard>("/api/v1/van/day-board", {
        query: { date: day, ...(unitId ? { unitId } : {}) },
        signal,
      }),
  );
  if (board.error)
    return (
      <Notice
        tone="danger"
        title="The van day could not load."
        meta="Check your connection and try again."
      />
    );
  if (!board.data) return <p className="p-4 text-muted">Loading the van day…</p>;
  const post = async (path: string, body: Record<string, unknown>) => {
    setError(null);
    try {
      await write.mutate(path, intent.withKey(path, body), {
        invalidate: [["van"]],
      });
      intent.done(path, body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Try again");
    }
  };
  return (
    <VanDayBoardView
      board={board.data}
      pendingTrip={pendingTrip}
      bulkPending={write.pending && pendingTrip === "bulk"}
      error={error}
      onDate={setDay}
      onCopyYesterday={() => {
        const from = new Date(`${day}T00:00:00Z`);
        from.setUTCDate(from.getUTCDate() - 1);
        void post("/api/v1/van/trips/copy", {
          fromDate: from.toISOString().slice(0, 10),
          toDate: day,
          ...(unitId ? { unitId } : {}),
        });
      }}
      onApproveClean={async (ids) => {
        setPending("bulk");
        const r = approveAllRequest(ids);
        await post(r.path, r.body);
        setPending(null);
      }}
      onAction={async (row) => {
        const r = actionRequest(row, day);
        if (!r) {
          const what = opens(row.primary.kind);
          if (what) onOpen(what as "load" | "recount" | "decide" | "trip", row);
          return;
        }
        setPending(row.tripId ?? row.vehicleId);
        await post(r.path, r.body);
        setPending(null);
      }}
    />
  );
}
