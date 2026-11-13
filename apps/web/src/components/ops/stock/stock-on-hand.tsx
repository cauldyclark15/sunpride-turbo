"use client";

import { Card, Notice, PageHeader } from "@sunpride/ui";
import { useState } from "react";
import { apiFetch, useApi, useLive } from "@/lib/api";
import { Peso, QtyCasesPieces } from "../index";
import { csvQuery, expiryLabel, shownTotals, stockFilters, type StockFilters } from "./helpers";
import type { StockRow, Valuation } from "./types";

type LocationOption = { id: string; name: string; type: string; code: string };
const STATUS_CHOICES = [
  ["", "Any status"],
  ["available", "Available"],
  ["reserved", "Reserved"],
  ["hold", "On hold"],
  ["damaged", "Damaged"],
  ["expired", "Expired"],
  ["in_transit", "In transit"],
] as const;

const COLUMNS: [keyof StockRow, string][] = [
  ["available", "Available"],
  ["reserved", "Reserved"],
  ["hold", "On hold"],
  ["damaged", "Damaged"],
  ["expired", "Expired"],
  ["inTransit", "In transit"],
];

/** Stock on hand (SPEC 4.6): cost value first, selling value as a labelled second column. */
export function StockOnHand({
  cardHref,
  onOpenCard,
  initialLocationId,
  params,
  onParams,
}: {
  /** Where a row's stock card lives (the NAV lane decides). */
  cardHref?: (productId: string, locationId: string) => string;
  onOpenCard?: (productId: string, locationId: string) => void;
  initialLocationId?: string;
  /** WEB-064: the page URL (search, place, status, grouping, basis survive reload). */
  params?: { get(name: string): string | null };
  onParams?: (patch: Partial<StockFilters>) => void;
}) {
  const start = stockFilters(params, initialLocationId);
  const [basis, setBasisState] = useState<"cost" | "selling">(start.basis);
  const [locationId, setLocationState] = useState(start.locationId);
  const [status, setStatusState] = useState(start.status);
  const [groupBy, setGroupState] = useState<"product" | "lot">(start.groupBy);
  const [search, setSearchState] = useState(start.q);
  const setBasis = (v: "cost" | "selling") => {
    setBasisState(v);
    onParams?.({ basis: v });
  };
  const setLocationId = (v: string) => {
    setLocationState(v);
    onParams?.({ locationId: v });
  };
  const setStatus = (v: string) => {
    setStatusState(v);
    onParams?.({ status: v });
  };
  const setGroupBy = (v: "product" | "lot") => {
    setGroupState(v);
    onParams?.({ groupBy: v });
  };
  const setSearch = (v: string) => {
    setSearchState(v);
    onParams?.({ q: v });
  };
  const query = {
    basis,
    groupBy,
    ...(locationId ? { locationId } : {}),
    ...(status ? { status } : {}),
  };
  const locations = useApi<LocationOption[]>(
    ["inventory", "locations"],
    "/api/v1/inventory/locations",
  );
  const data = useApi<Valuation>(["inventory", "valuation", query], ({ signal }) =>
    apiFetch<Valuation>("/api/v1/inventory/valuation", { signal, query }),
  );
  useLive(["inventory"], [["inventory", "valuation"]]);
  const v = data.data;
  const rows = (v?.rows ?? []).filter((r) =>
    `${r.name} ${r.code} ${r.lotNumber ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const costFirst = basis === "cost";
  const byBatch = groupBy === "lot";
  // WEB-064: the value cards add up exactly the rows shown (search included).
  const totals = shownTotals(rows, v?.totals, search.trim() !== "");
  return (
    <div className="space-y-4" data-screen="stock-on-hand">
      <PageHeader
        title="Stock on hand"
        description="What we have, where it is, and what it is worth."
      />
      {data.error ? <Notice title={data.error.message} tone="danger" /> : null}
      <div className="grid gap-3 md:grid-cols-3">
        <Total label="Stock value at cost" centavos={totals?.costValueCentavos} primary={costFirst} />
        <Total label="Stock value at selling price" centavos={totals?.sellingValueCentavos} primary={!costFirst} />
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{byBatch ? "Batches shown" : "Products shown"}</p>
          <p className="text-2xl font-semibold tabular-nums">{rows.length}</p>
        </div>
      </div>
      {v && v.totals.rowsWithoutCost > 0 ? (
        <Notice
          tone="warning"
          title={`${v.totals.rowsWithoutCost} ${v.totals.rowsWithoutCost === 1 ? "product has" : "products have"} no cost yet. Their cost value shows ₱0.00 until a delivery with a cost is received.`}
        />
      ) : null}
      {v && v.totals.rowsWithoutPrice > 0 ? (
        <Notice
          tone="warning"
          title={`${v.totals.rowsWithoutPrice} ${v.totals.rowsWithoutPrice === 1 ? "product has" : "products have"} no selling price, so the selling total is not shown.`}
        />
      ) : null}
      <Card label="Filters">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Search</span>
            <input
              className="min-h-12 rounded-xl border border-gray-300 px-3"
              placeholder="Product or code"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Place</span>
            <select
              className="min-h-12 rounded-xl border border-gray-300 px-3"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
            >
              <option value="">All places</option>
              {(locations.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Status</span>
            <select
              className="min-h-12 rounded-xl border border-gray-300 px-3"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {STATUS_CHOICES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-1" role="group" aria-label="Group by">
            {(["product", "lot"] as const).map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={groupBy === g}
                onClick={() => setGroupBy(g)}
                className={`min-h-12 rounded-xl border px-4 text-sm ${groupBy === g ? "border-blue-600 bg-blue-50 text-blue-700" : "border-gray-300"}`}
              >
                {g === "product" ? "By product" : "By batch"}
              </button>
            ))}
          </div>
          <div className="flex gap-1" role="group" aria-label="Show value as">
            {(["cost", "selling"] as const).map((b) => (
              <button
                key={b}
                type="button"
                aria-pressed={basis === b}
                onClick={() => setBasis(b)}
                className={`min-h-12 rounded-xl border px-4 text-sm ${basis === b ? "border-blue-600 bg-blue-50 text-blue-700" : "border-gray-300"}`}
              >
                {b === "cost" ? "Value at cost" : "Value at selling price"}
              </button>
            ))}
          </div>
          <a
            className="inline-flex min-h-12 items-center rounded-xl border border-gray-300 px-4 text-sm font-medium text-blue-700"
            href={csvQuery({ ...query, basis })}
            download
          >
            Download CSV
          </a>
        </div>
      </Card>
      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
        <table className="w-full min-w-[960px] text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">Product</th>
              {byBatch ? <th className="px-3 py-2 text-left">Batch</th> : null}
              {byBatch ? <th className="px-3 py-2 text-left">Expires</th> : null}
              <th className="px-3 py-2 text-left">Place</th>
              <th className="px-3 py-2 text-right">On hand</th>
              {COLUMNS.map(([, label]) => (
                <th key={label} className="px-3 py-2 text-right">{label}</th>
              ))}
              <th className="px-3 py-2 text-right">{costFirst ? "Value at cost" : "Value at selling price"}</th>
              <th className="px-3 py-2 text-right text-gray-400">{costFirst ? "At selling price" : "At cost"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.productId}:${r.locationId}:${r.lotId ?? ""}`} className="border-t border-gray-100">
                <td className="px-3 py-2">
                  <div className="font-medium">{r.name}</div>
                  <div className="text-xs text-gray-500">{r.code}</div>
                </td>
                {byBatch ? <td className="px-3 py-2">{r.lotNumber ?? "No batch"}</td> : null}
                {byBatch ? (
                  <td className="px-3 py-2 text-xs text-gray-600">
                    {r.expiresAt != null && r.daysToExpiry != null ? expiryLabel(r.expiresAt, r.daysToExpiry) : "No expiry"}
                  </td>
                ) : null}
                <td className="px-3 py-2">{r.locationName}</td>
                <td className="px-3 py-2 text-right font-medium">
                  <QtyCasesPieces base={r.onHand.base} basePerCase={r.units.basePerCase} />
                </td>
                {COLUMNS.map(([key]) => {
                  const q = r[key] as StockRow["onHand"];
                  return (
                    <td key={key} className={`px-3 py-2 text-right ${q.base ? "" : "text-gray-300"}`}>
                      <QtyCasesPieces base={q.base} basePerCase={r.units.basePerCase} />
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-right font-semibold">
                  <Peso centavos={costFirst ? r.costValueCentavos : r.sellingValueCentavos} />
                  {costFirst && !r.costKnown ? <div className="text-xs font-normal text-amber-700">No cost yet</div> : null}
                </td>
                <td className="px-3 py-2 text-right text-gray-500">
                  <Peso centavos={costFirst ? r.sellingValueCentavos : r.costValueCentavos} />
                </td>
                <td className="px-3 py-2 text-right">
                  {cardHref ? (
                    <a className="text-blue-700" href={cardHref(r.productId, r.locationId)}>Stock card</a>
                  ) : onOpenCard ? (
                    <button type="button" className="text-blue-700" onClick={() => onOpenCard(r.productId, r.locationId)}>
                      Stock card
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={COLUMNS.length + (byBatch ? 7 : 5)} className="px-3 py-8 text-center text-gray-500">
                  {data.isLoading ? "Loading stock…" : "No stock matches. Try another place or status."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Total({ label, centavos, primary }: { label: string; centavos: number | null | undefined; primary: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${primary ? "border-blue-900 bg-blue-950 text-white" : "border-gray-200 bg-white"}`}>
      <p className={`text-xs font-medium uppercase tracking-wide ${primary ? "text-blue-100" : "text-gray-500"}`}>{label}</p>
      <p className="text-2xl font-semibold tabular-nums">
        <Peso centavos={centavos ?? null} negativeClassName="" />
      </p>
    </div>
  );
}
