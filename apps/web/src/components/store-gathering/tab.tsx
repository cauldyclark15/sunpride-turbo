"use client";

import { useState } from "react";
import { usePermissions } from "../../lib/auth";
import { useApi } from "../../lib/api";
import { AddStore } from "./add-store";
import { LocationCoverage } from "./location-coverage";
import type { Queue } from "./model";
import { StoreGatheringReview } from "./review";

/** Stores page tab (SP-0162): location coverage, office Add store and the gathering review.
 * `adding`/`onAdding` let the Stores page header open the form without the user finding this tab. */
export function StoreGatheringTab({
  adding: controlled,
  onAdding,
}: { adding?: boolean; onAdding?: (open: boolean) => void } = {}) {
  const { can } = usePermissions();
  const [own, setOwn] = useState(false);
  const adding = controlled ?? own;
  const setAdding = onAdding ?? setOwn;
  return (
    <div className="grid gap-4">
      {can("outlet.manage") ? (
        <div>
          <button
            type="button"
            aria-expanded={adding}
            className="inline-flex h-9 items-center rounded-lg border border-foreground bg-foreground px-3 text-[13px] font-medium text-background hover:opacity-90"
            onClick={() => setAdding(!adding)}
          >
            {adding ? "Close Add store" : "Add store"}
          </button>
        </div>
      ) : null}
      {adding ? (
        <section
          aria-label="Add a store"
          id="add-store"
          className="scroll-mt-20"
        >
          <p className="mb-3 text-[13px] text-muted">
            A new store / customer. Another person confirms its map pin.
          </p>
          <AddStore />
        </section>
      ) : null}
      <StoreGatheringReview />
      <LocationCoverage />
    </div>
  );
}

/** How many gathered stores wait for review; null when the user may not review or it is loading. */
export function useWaitingCount(): number | null {
  const { can } = usePermissions();
  const allowed = can("outlet.verify");
  const queue = useApi<Queue>(
    allowed ? ["masters", "census"] : null,
    "/api/v1/masters/census-queue",
  );
  return allowed && queue.data ? queue.data.rows.length : null;
}

/** How many gathered stores wait for review, in words; null when the user may not review. */
export function useWaitingForReview(): string | null {
  const { can } = usePermissions();
  const allowed = can("outlet.verify");
  const queue = useApi<Queue>(
    allowed ? ["masters", "census"] : null,
    "/api/v1/masters/census-queue",
  );
  if (!allowed || !queue.data) return null;
  const n = queue.data.rows.length;
  if (n === 0) return "None waiting for review";
  return `${n}${queue.data.truncated ? "+" : ""} waiting for review`;
}

/** Stores page header actions: a primary Add store button (below lg it floats bottom-right, just above
 * the phone tab bar, so it never scrolls away or hides under the tabs)
 * and the review count. Both jump to the gathering tab. */
export function StoresHeaderActions({
  onAdd,
  onReview,
}: {
  onAdd: () => void;
  onReview: () => void;
}) {
  const { can } = usePermissions();
  const waiting = useWaitingForReview();
  return (
    <>
      {waiting ? (
        <button
          type="button"
          data-testid="stores-waiting"
          className="rounded-lg border border-border px-3 py-1 text-[13px] hover:bg-default-soft"
          onClick={onReview}
        >
          {waiting}
        </button>
      ) : null}
      {can("outlet.manage") ? (
        <button
          type="button"
          data-testid="stores-add-store"
          className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 inline-flex h-12 items-center gap-1.5 rounded-full bg-foreground px-5 text-[15px] font-semibold text-background shadow-lg hover:opacity-90 lg:static lg:h-9 lg:rounded-lg lg:px-3 lg:text-[13px] lg:font-medium lg:shadow-none"
          onClick={onAdd}
        >
          <span
            aria-hidden="true"
            className="text-[18px] leading-none lg:text-[15px]"
          >
            +
          </span>
          Add store
        </button>
      ) : null}
    </>
  );
}
