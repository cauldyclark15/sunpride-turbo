"use client";

import { useState } from "react";
import { useApi, useLive } from "../../lib/api";
import { Peso } from "../ops";
import {
  methodWords,
  money,
  OVERRIDE_WORDS,
  type OverrideRow,
} from "./store-day-model";

/** Counts per kind, for the chips (Itemcount pattern: category chips with counts). */
export function overrideCounts(rows: OverrideRow[]): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** Supervisor overrides, newest first: who approved what, why, and how (PIN at the till or the office). */
export function OverridesList({
  rows,
  kind = null,
}: {
  rows: OverrideRow[];
  kind?: string | null;
}) {
  const shown = kind ? rows.filter((r) => r.kind === kind) : rows;
  if (!shown.length)
    return (
      <p className="text-sm text-muted">
        No supervisor approvals in this period.
      </p>
    );
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Supervisor overrides</caption>
      <thead className="text-left text-xs uppercase text-muted">
        <tr>
          <th className="py-2 pr-3">When</th>
          <th className="py-2 pr-3">What</th>
          <th className="py-2 pr-3">Cashier</th>
          <th className="py-2 pr-3">Approved by</th>
          <th className="py-2 pr-3">Why</th>
          <th className="py-2 text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((o) => (
          <tr key={o.id} className="border-t border-separator">
            <td className="py-2 pr-3">
              {new Date(o.capturedAt).toLocaleString("en-PH", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
              <span className="block text-xs text-muted">{o.registerName}</span>
            </td>
            <td className="py-2 pr-3">{OVERRIDE_WORDS[o.kind] ?? o.label}</td>
            <td className="py-2 pr-3">{o.cashierName ?? "—"}</td>
            <td className="py-2 pr-3">
              {o.supervisorName}
              <span className="block text-xs text-muted">
                {methodWords(o.method)}
              </span>
            </td>
            <td className="py-2 pr-3">{o.reason ?? "—"}</td>
            <td className="py-2 text-right">
              {o.amountCentavos == null ? (
                "—"
              ) : (
                <Peso centavos={money(o.amountCentavos)} />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Review screen: filter chips with counts, then the list. Not mounted in navigation yet (NAV lane). */
export function OverridesScreen({ registerId }: { registerId?: string }) {
  const url = `/api/v1/storepos/overrides${registerId ? `?registerId=${registerId}` : ""}`;
  const key = ["storepos", "overrides", registerId ?? "all"] as const;
  const result = useApi<{ overrides: OverrideRow[] }>(key, url);
  useLive(["storepos"], [key]);
  const [kind, setKind] = useState<string | null>(null);
  if (result.error)
    return (
      <p role="alert" className="text-sm">
        Could not load supervisor approvals. Try again.
      </p>
    );
  if (!result.data)
    return <p className="text-sm">Loading supervisor approvals…</p>;
  const rows = result.data.overrides;
  return (
    <section aria-label="Supervisor approvals" className="grid gap-3">
      <h2 className="text-lg font-semibold">Supervisor approvals</h2>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Filter by kind"
      >
        <button
          type="button"
          onClick={() => setKind(null)}
          className={`min-h-12 rounded-full border px-4 ${kind === null ? "border-[#EF5706] text-[#EF5706]" : "border-border"}`}
        >
          All · {rows.length}
        </button>
        {overrideCounts(rows).map(([k, n]) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`min-h-12 rounded-full border px-4 ${kind === k ? "border-[#EF5706] text-[#EF5706]" : "border-border"}`}
          >
            {OVERRIDE_WORDS[k] ?? k} · {n}
          </button>
        ))}
      </div>
      <OverridesList rows={rows} kind={kind} />
    </section>
  );
}
