"use client";

import { Card, Notice } from "@sunpride/ui";
import { useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import { DocNumber } from "../doc-number";
import { Peso } from "../peso";
import { StatusPill } from "../status-pill";
import { FILTERS, type FilterId, type TransferSummary } from "./transfer-model";

/** Pure view of the transfer register: filter chips, one row per document, difference value in pesos. */
export function TransfersListView({
  transfers,
  filter,
  onFilter,
  onOpen,
}: {
  transfers: TransferSummary[];
  filter: FilterId;
  onFilter: (f: FilterId) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="grid gap-4">
      <div
        className="flex gap-2 overflow-x-auto pb-1"
        role="tablist"
        aria-label="Transfer filters"
      >
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={`min-h-12 shrink-0 rounded-full border px-4 text-base ${
              filter === f.id
                ? "border-accent bg-accent-soft font-medium"
                : "border-border bg-surface"
            }`}
            onClick={() => onFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <Card label="Transfers" count={transfers.length} flush>
        {transfers.length ? (
          <ul className="divide-y divide-separator">
            {transfers.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="grid min-h-16 w-full gap-1 px-4 py-3 text-left"
                  onClick={() => onOpen(t.id)}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <DocNumber value={t.number} />
                    <StatusPill state={t.status} />
                    <span className="text-sm text-muted">{t.typeLabel}</span>
                  </span>
                  <span className="text-base">
                    {t.source?.name ?? "?"} → {t.destination?.name ?? "?"}
                  </span>
                  <span className="text-sm text-muted">
                    {t.lineCount} line{t.lineCount === 1 ? "" : "s"}
                    {t.header.driverName
                      ? ` · driver ${t.header.driverName}`
                      : ""}
                    {t.header.vehiclePlate ? ` · ${t.header.vehiclePlate}` : ""}
                    {t.varianceStatus === "open" ? (
                      <>
                        {" · difference "}
                        <Peso
                          centavos={t.varianceValueCentavos}
                          className="font-medium text-danger"
                        />
                      </>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-4 text-sm text-muted">
            No transfers match. Try another filter.
          </p>
        )}
      </Card>
    </div>
  );
}

export function TransfersList({
  onOpen,
  initialFilter = "open",
}: {
  onOpen: (id: string) => void;
  initialFilter?: FilterId;
}) {
  const [filter, setFilter] = useState<FilterId>(initialFilter);
  const query = FILTERS.find((f) => f.id === filter)?.query ?? {};
  const list = useApi<{ transfers: TransferSummary[] }>(
    ["inventory", "transfers", "list", filter],
    ({ signal }) =>
      apiFetch<{ transfers: TransferSummary[] }>(
        "/api/v1/inventory/transfers/list",
        { query, signal },
      ),
  );
  if (list.error)
    return (
      <Notice
        tone="danger"
        title="Transfers could not load."
        meta="Check your connection and try again."
      />
    );
  return (
    <TransfersListView
      transfers={list.data?.transfers ?? []}
      filter={filter}
      onFilter={setFilter}
      onOpen={onOpen}
    />
  );
}
