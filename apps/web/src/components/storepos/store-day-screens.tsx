"use client";

import { useState } from "react";
import { OverridesScreen } from "./overrides-review";
import { TillDaysScreen, ZHistoryScreen } from "./till-days";

export const STORE_DAY_TABS = [
  { id: "days", label: "Till days" },
  { id: "z", label: "Z readings" },
  { id: "overrides", label: "Supervisor approvals" },
] as const;

/**
 * Stores POS day screens: registers, till days, sessions with expected/counted/variance, X/Z history with print,
 * cash movements and overrides review. Exported for the NAV lane; not mounted in navigation here.
 */
export function StoreDayScreens() {
  const [tab, setTab] = useState<(typeof STORE_DAY_TABS)[number]["id"]>("days");
  return (
    <div className="grid gap-4">
      <nav aria-label="Stores POS" className="flex flex-wrap gap-2">
        {STORE_DAY_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
            className={`min-h-12 rounded-full border px-4 ${tab === t.id ? "border-[#EF5706] text-[#EF5706]" : "border-border"}`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "days" && <TillDaysScreen />}
      {tab === "z" && <ZHistoryScreen />}
      {tab === "overrides" && <OverridesScreen />}
    </div>
  );
}
