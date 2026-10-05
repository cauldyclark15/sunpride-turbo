"use client";

import { Button, Input } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { Card, Notice, StatusPill, WorkspaceIcon } from "@sunpride/ui";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";

/**
 * SP-0085: distributor operations may sell below zero at locations where it is
 * explicitly allowed; each below-zero sale waits here until stock covers it and
 * a second person closes it.
 */

export const NEGATIVE_STOCK_LOCATION_TYPES = new Set([
  "warehouse",
  "zone",
  "bin",
  "truck",
]);
const DEFAULT_MOVEMENT_TYPES = ["pos_sale", "inventory_issue"] as const;
const SOURCE_REF = "Client call 2 Oct 2026 (CALL-10): distributor operations";
const FLAG_PAGE = 25;
// Matches the server's per-request location limit for allowance lookups.
const MAX_ALLOWANCE_LOCATIONS = 200;

type LocationOption = { _id: string; code: string; name: string; type: string };

const rowClass =
  "grid min-h-14 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-separator px-4 last:border-b-0";
const inputClass =
  "h-10 w-full rounded-[10px] border border-field-border bg-field-background px-3 text-sm shadow-none";

export function negativeStockErrorMessage(error: unknown) {
  const data = (error as { data?: unknown } | null)?.data;
  return typeof data === "string" && data.trim()
    ? data.trim()
    : "Action failed. Try again.";
}

export function NegativeStockPanel({
  locations,
}: {
  locations: LocationOption[] | undefined;
}) {
  const eligible = (locations ?? []).filter((location) =>
    NEGATIVE_STOCK_LOCATION_TYPES.has(location.type),
  );
  const shown = eligible.slice(0, MAX_ALLOWANCE_LOCATIONS);
  const allowances = useQuery(
    api.inventory.negative_stock.allowances,
    locations
      ? {
          locationIds: shown.map(
            (location) => location._id as Id<"inventoryLocations">,
          ),
        }
      : "skip",
  );
  // Pages are filtered to the caller's locations on the server, so a page can
  // come back empty while older flags remain; keep offering "Show older"
  // until the server says the list is exhausted.
  const {
    results: flags,
    status: flagStatus,
    loadMore,
  } = usePaginatedQuery(
    api.inventory.negative_stock.flags,
    { status: "open" },
    { initialNumItems: FLAG_PAGE },
  );
  // Only national administrators may switch an allowance; everyone else sees
  // the state read-only rather than a control the server refuses.
  const canManage =
    useQuery(api.inventory.negative_stock.canManageAllowances, {}) === true;
  const setAllowance = useMutation(api.inventory.negative_stock.setAllowance);
  const resolveFlag = useMutation(api.inventory.negative_stock.resolveFlag);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const byLocation = new Map(
    (allowances ?? []).map((row) => [row.locationId as string, row]),
  );

  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    try {
      await action();
      setNotice(null);
    } catch (error) {
      console.error(error);
      setNotice(negativeStockErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card label="Below-zero stock" icon={<WorkspaceIcon name="inventory" />}>
      {notice ? <Notice title={notice} tone="danger" /> : null}
      <div className="grid gap-6 xl:grid-cols-2">
        <section aria-label="Below-zero sales to settle" className="grid gap-2">
          <h3 className="text-sm font-medium">Sales to settle</h3>
          {flags.map((flag) => (
            <div
              key={flag.id}
              className="grid gap-2 border-b border-separator px-4 pb-3 last:border-b-0"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                <div>
                  <strong className="font-mono text-sm font-medium">
                    {flag.productCode} · {flag.locationCode}
                  </strong>
                  <small className="block text-[13px] text-muted">
                    {flag.movementNumber} · short {flag.shortfall} · now{" "}
                    {flag.currentAvailable}
                  </small>
                </div>
                <StatusPill
                  tone={
                    Number(flag.currentAvailable) < 0 ? "warning" : "success"
                  }
                >
                  {Number(flag.currentAvailable) < 0 ? "Below zero" : "Covered"}
                </StatusPill>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <Input
                  className={inputClass}
                  aria-label={`Settlement note for ${flag.movementNumber}`}
                  placeholder="How it was covered"
                  value={notes[flag.id] ?? ""}
                  onChange={(event) =>
                    setNotes({ ...notes, [flag.id]: event.target.value })
                  }
                />
                <Button
                  variant="secondary"
                  isPending={busy === flag.id}
                  isDisabled={!notes[flag.id]?.trim()}
                  onPress={() =>
                    void run(flag.id, () =>
                      resolveFlag({
                        flagId: flag.id as Id<"negativeStockFlags">,
                        note: notes[flag.id] ?? "",
                      }),
                    )
                  }
                >
                  Settle
                </Button>
              </div>
            </div>
          ))}
          {flagStatus === "Exhausted" && flags.length === 0 ? (
            <p className="px-4 text-[13px] text-muted">Nothing below zero</p>
          ) : null}
          {flagStatus === "CanLoadMore" || flagStatus === "LoadingMore" ? (
            <div className="grid gap-2 px-4">
              {flags.length === 0 ? (
                <p className="text-[13px] text-muted">
                  None in the newest sales checked; older ones not checked yet
                </p>
              ) : null}
              <Button
                variant="secondary"
                isPending={flagStatus === "LoadingMore"}
                onPress={() => loadMore(FLAG_PAGE)}
              >
                Show older
              </Button>
            </div>
          ) : null}
        </section>
        <section
          aria-label="Locations allowed below zero"
          className="grid gap-2"
        >
          <h3 className="text-sm font-medium">Distributor locations</h3>
          {shown.map((location) => {
            const allowance = byLocation.get(location._id);
            const allowed = allowance?.active === true;
            return (
              <div key={location._id} className={rowClass}>
                <div>
                  <strong className="font-mono text-sm font-medium">
                    {location.code}
                  </strong>
                  <small className="block text-[13px] text-muted">
                    {location.name}
                  </small>
                </div>
                <StatusPill tone={allowed ? "warning" : "neutral"}>
                  {allowed ? "Can sell below zero" : "Stops at zero"}
                </StatusPill>
                {canManage ? (
                  <Button
                    variant="secondary"
                    isPending={busy === location._id}
                    onPress={() =>
                      void run(location._id, () =>
                        setAllowance({
                          locationId: location._id as Id<"inventoryLocations">,
                          active: !allowed,
                          movementTypes: allowance?.movementTypes.length
                            ? allowance.movementTypes
                            : [...DEFAULT_MOVEMENT_TYPES],
                          ...(allowance?.limitBase != null
                            ? { limitBase: allowance.limitBase }
                            : {}),
                          sourceRef: allowance?.sourceRef ?? SOURCE_REF,
                        }),
                      )
                    }
                  >
                    {allowed ? "Stop" : "Allow"}
                  </Button>
                ) : (
                  <span aria-hidden="true" />
                )}
              </div>
            );
          })}
          {eligible.length > shown.length ? (
            <p className="px-4 text-[13px] text-muted">
              Showing the first {shown.length} of {eligible.length} locations
            </p>
          ) : null}
          {locations && eligible.length === 0 ? (
            <p className="px-4 text-[13px] text-muted">No stock locations</p>
          ) : null}
        </section>
      </div>
    </Card>
  );
}
