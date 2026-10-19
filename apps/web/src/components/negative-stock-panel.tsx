"use client";

import { Button, Input } from "@heroui/react";
import { Card, Notice, StatusPill } from "@sunpride/ui";
import { useRef, useState } from "react";
import {
  ApiError,
  apiFetch,
  useApi,
  useApiPages,
  useLive,
  useMutate,
} from "../lib/api";
import type { StockQuantity } from "./inventory-workspace";

export const NEGATIVE_STOCK_LOCATION_TYPES = new Set([
  "warehouse",
  "zone",
  "bin",
  "truck",
]);
const MAX_ALLOWANCE_LOCATIONS = 200;
type LocationOption = { _id: string; code: string; name: string; type: string };
type Allowance = {
  id: string;
  locationId: string;
  active: boolean;
  movementTypes: string[];
  limitBase: number | null;
  sourceRef: string;
};
type Flag = {
  id: string;
  number: string;
  code: string;
  name: string;
  locationName: string;
  shortfall: StockQuantity;
  current: StockQuantity;
  canResolve: boolean;
};
type Negative = {
  canManage: boolean;
  allowances: Allowance[];
  flags: { items: Flag[]; nextCursor: string | null };
};
export function negativeStockErrorMessage(error: unknown) {
  return error instanceof ApiError
    ? error.message
    : "Action failed. Try again.";
}
const money = (v: number | null) =>
  v == null
    ? "Unknown"
    : new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
      }).format(v / 100);

export function NegativeStockPanel({
  locations,
}: {
  locations: LocationOption[] | undefined;
}) {
  const eligible = (locations ?? []).filter((l) =>
      NEGATIVE_STOCK_LOCATION_TYPES.has(l.type),
    ),
    shown = eligible.slice(0, MAX_ALLOWANCE_LOCATIONS);
  const state = useApi<Negative>(
    locations
      ? ["inventory", "negative", "allowances", shown.map((l) => l._id)]
      : null,
    ({ signal }) =>
      apiFetch<Negative>("/api/v1/inventory/negative", {
        signal,
        query: { locationIds: shown.map((l) => l._id).join(",") },
      }),
  );
  const flags = useApiPages<Flag>(
    locations ? ["inventory", "negative", "flags"] : null,
    async (cursor, { signal }) => {
      const result = await apiFetch<Negative>("/api/v1/inventory/negative", {
        signal,
        query: { cursor: cursor ?? undefined, limit: 25 },
      });
      return result.flags;
    },
  );
  useLive(["inventory"], [["inventory", "negative"]]);
  const write = useMutate(),
    keys = useRef(new Map<string, string>());
  const [notes, setNotes] = useState<Record<string, string>>({}),
    [notice, setNotice] = useState<string | null>(null);
  async function run(action: string, body: Record<string, unknown>) {
    if (write.pending) return;
    const fingerprint = JSON.stringify([action, body]);
    let key = keys.current.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(fingerprint, key);
    }
    try {
      await write.mutate(
        `/api/v1/inventory/${action}`,
        { ...body, idempotencyKey: key },
        { invalidate: [["inventory"]] },
      );
      keys.current.delete(fingerprint);
      setNotice(null);
    } catch (error) {
      setNotice(negativeStockErrorMessage(error));
    }
  }
  const allowances = new Map(
    (state.data?.allowances ?? []).map((a) => [a.locationId, a]),
  );
  return (
    <Card label="Below-zero stock">
      {notice ? <Notice title={notice} tone="danger" /> : null}
      {state.error ? (
        <Notice title={state.error.message} tone="danger" />
      ) : null}
      {flags.error ? (
        <Notice title={flags.error.message} tone="danger" />
      ) : null}
      <div className="grid gap-6 xl:grid-cols-2">
        <section aria-label="Below-zero sales to settle">
          <h3 className="mb-3 text-sm font-medium">Sales to settle</h3>
          {flags.items?.map((f) => (
            <div
              key={f.id}
              className="grid gap-2 border-b border-separator py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <strong className="text-sm">
                    {f.name} · {f.locationName}
                  </strong>
                  <p className="text-xs text-muted">
                    {f.number} · short {f.shortfall.display} · now{" "}
                    {f.current.display}
                  </p>
                  <p className="text-xs text-muted">
                    Shortfall value {money(f.shortfall.valueCentavos)}
                  </p>
                </div>
                <StatusPill tone={f.current.base < 0 ? "warning" : "success"}>
                  {f.current.base < 0 ? "Below zero" : "Covered"}
                </StatusPill>
              </div>
              {f.canResolve ? (
                <div className="flex gap-2">
                  <Input
                    aria-label={`Settlement note for ${f.number}`}
                    placeholder="How it was covered"
                    value={notes[f.id] ?? ""}
                    onChange={(e) =>
                      setNotes({ ...notes, [f.id]: e.target.value })
                    }
                  />
                  <Button
                    variant="outline"
                    isDisabled={!notes[f.id]?.trim() || f.current.base < 0}
                    isPending={write.pending}
                    onPress={() =>
                      void run("negative/resolve", {
                        flagId: f.id,
                        note: notes[f.id],
                      })
                    }
                  >
                    Settle
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted">
                  A different authorized person must settle this posting.
                </p>
              )}
            </div>
          ))}
          {flags.isComplete && flags.items?.length === 0 ? (
            <p className="text-sm text-muted">Nothing below zero</p>
          ) : null}
          {flags.status === "canLoadMore" || flags.status === "loadingMore" ? (
            <div className="mt-3">
              {!flags.items?.length ? (
                <p className="text-sm text-muted">
                  None in the newest sales checked; older ones not checked yet
                </p>
              ) : null}
              <Button
                variant="outline"
                isPending={flags.status === "loadingMore"}
                onPress={() => void flags.loadMore()}
              >
                Show older
              </Button>
            </div>
          ) : null}
        </section>
        <section aria-label="Locations allowed below zero">
          <h3 className="mb-3 text-sm font-medium">Distributor locations</h3>
          {shown.map((l) => {
            const allowance = allowances.get(l._id),
              allowed = allowance?.active === true;
            return (
              <div
                key={l._id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-separator py-3"
              >
                <div>
                  <strong className="text-sm">{l.name}</strong>
                  <small className="block text-xs text-muted">{l.code}</small>
                </div>
                <StatusPill tone={allowed ? "warning" : "neutral"}>
                  {state.data
                    ? allowed
                      ? "Can sell below zero"
                      : "Stops at zero"
                    : "Loading allowance…"}
                </StatusPill>
                {state.data?.canManage ? (
                  <Button
                    variant="outline"
                    isPending={write.pending}
                    onPress={() =>
                      void run("negative/allow", {
                        locationId: l._id,
                        active: !allowed,
                        movementTypes: allowance?.movementTypes.length
                          ? allowance.movementTypes
                          : ["pos_sale", "inventory_issue"],
                        ...(allowance?.limitBase != null
                          ? { limitBase: allowance.limitBase }
                          : {}),
                        sourceRef:
                          allowance?.sourceRef ??
                          "Client call 2 Oct 2026: distributor operations",
                      })
                    }
                  >
                    {allowed ? "Stop" : "Allow"}
                  </Button>
                ) : null}
              </div>
            );
          })}
          {eligible.length > shown.length ? (
            <p className="mt-2 text-sm text-muted">
              Showing the first {shown.length} of {eligible.length} locations
            </p>
          ) : null}
          {locations && eligible.length === 0 ? (
            <p className="text-sm text-muted">No stock locations</p>
          ) : null}
        </section>
      </div>
    </Card>
  );
}
