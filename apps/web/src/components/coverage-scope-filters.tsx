"use client";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useQuery } from "convex/react";

export type ScopeOption = { id: string; code: string; name: string };
export type ScopeKind = "territories" | "routes";

/** HTML option values are local positions, so Convex IDs never appear in the page. */
export function selectedScopeId(
  options: ScopeOption[],
  position: string,
): string {
  if (!/^[0-9]+$/.test(position)) return "";
  return options[Number(position)]?.id ?? "";
}

export function useCoverageScopeOptions(planId?: Id<"coveragePlans">) {
  return useQuery(
    api.coverage.views.filterOptions,
    planId ? { planId } : "skip",
  );
}

export function CoverageScopeSelect({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: ScopeOption[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const position = options.findIndex((option) => option.id === selected);
  return (
    <label>
      {label}{" "}
      <select
        aria-label={label}
        value={position < 0 ? "" : String(position)}
        onChange={(event) =>
          onSelect(selectedScopeId(options, event.target.value))
        }
      >
        <option value="">All</option>
        {options.map((option, index) => (
          <option key={index} value={index}>
            {option.code} · {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}
