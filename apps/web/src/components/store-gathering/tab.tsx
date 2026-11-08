"use client";

import { useState } from "react";
import { usePermissions } from "../../lib/auth";
import { AddStore } from "./add-store";
import { LocationCoverage } from "./location-coverage";
import { StoreGatheringReview } from "./review";

/** Stores page tab (SP-0162): location coverage, office Add store and the gathering review. */
export function StoreGatheringTab() {
  const { can } = usePermissions();
  const [adding, setAdding] = useState(false);
  return (
    <div className="grid gap-4">
      {can("outlet.manage") ? (
        <div>
          <button
            type="button"
            aria-expanded={adding}
            className="inline-flex h-9 items-center rounded-lg border border-foreground bg-foreground px-3 text-[13px] font-medium text-background hover:opacity-90"
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? "Close Add store" : "Add a store"}
          </button>
        </div>
      ) : null}
      {adding ? <AddStore /> : null}
      <StoreGatheringReview />
      <LocationCoverage />
    </div>
  );
}
