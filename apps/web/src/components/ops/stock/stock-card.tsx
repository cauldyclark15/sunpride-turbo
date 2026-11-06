"use client";

import { Card, Notice, PageHeader } from "@sunpride/ui";
import { useState } from "react";
import { apiFetch, useApi, useLive } from "@/lib/api";
import { DocNumber, Peso, QtyCasesPieces } from "../index";
import type { StockCard as StockCardData } from "./types";

const day = (at: number) =>
  new Date(at).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });

/** Stock card (SPEC 4.6): one product at one place, every movement with its document number. */
export function StockCard({
  productId,
  locationId,
  documentHref,
  initialFrom,
  initialTo,
}: {
  productId: string;
  locationId: string;
  /** Link for a document row (type is the server's source type, e.g. "goods_receipt"). */
  documentHref?: (link: { type: string; id: string }) => string | null;
  initialFrom?: string;
  initialTo?: string;
}) {
  const [from, setFrom] = useState(initialFrom ?? "");
  const [to, setTo] = useState(initialTo ?? "");
  const query = { productId, locationId, ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const data = useApi<StockCardData>(["inventory", "stock-card", query], ({ signal }) =>
    apiFetch<StockCardData>("/api/v1/inventory/stock-card", { signal, query }),
  );
  useLive(["inventory"], [["inventory", "stock-card"]]);
  const c = data.data;
  const per = c?.product.units.basePerCase ?? null;
  return (
    <div className="space-y-4" data-screen="stock-card">
      <PageHeader
        title={c ? `Stock card: ${c.product.name}` : "Stock card"}
        description={c ? `${c.location.name} · ${c.from} to ${c.to}` : "Every movement of this product at this place."}
      />
      {data.error ? <Notice title={data.error.message} tone="danger" /> : null}
      {c && !c.reconcilesToday ? (
        <Notice
          tone="danger"
          title="This card does not match today's stock. Tell the office before you count or adjust."
        />
      ) : null}
      <Card label="Dates">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">From</span>
            <input type="date" className="min-h-12 rounded-xl border border-gray-300 px-3" value={from || c?.from || ""} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-gray-500">To</span>
            <input type="date" className="min-h-12 rounded-xl border border-gray-300 px-3" value={to || c?.to || ""} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
      </Card>
      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">When</th>
              <th className="px-3 py-2 text-left">Document</th>
              <th className="px-3 py-2 text-right">In</th>
              <th className="px-3 py-2 text-right">Out</th>
              <th className="px-3 py-2 text-right">Balance</th>
              <th className="px-3 py-2 text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {c ? (
              <tr className="border-t border-gray-100 bg-gray-50 font-medium">
                <td className="px-3 py-2" colSpan={4}>Opening balance</td>
                <td className="px-3 py-2 text-right"><QtyCasesPieces base={c.opening.quantity.base} basePerCase={per} /></td>
                <td className="px-3 py-2 text-right"><Peso centavos={c.opening.valueCentavos} /></td>
              </tr>
            ) : null}
            {c?.rows.map((r) => {
              const href = documentHref?.(r.link) ?? null;
              return (
                <tr key={r.movementId} className={`border-t border-gray-100 ${r.reversed ? "text-gray-400" : ""}`}>
                  <td className="px-3 py-2 whitespace-nowrap">{day(r.at)}</td>
                  <td className="px-3 py-2">
                    <div>{r.label}</div>
                    <div className="text-xs text-gray-500">
                      {r.documentLabel}{" "}
                      {href ? <a className="text-blue-700" href={href}><DocNumber value={r.documentNumber} /></a> : <DocNumber value={r.documentNumber} />}
                      {r.reversed ? " · reversed" : ""}
                    </div>
                    {r.statusMoves.length ? (
                      <div className="text-xs text-gray-500">
                        {r.statusMoves.map((m) => `${m.delta > 0 ? "+" : ""}${m.delta} ${m.status.replace("_", " ")}`).join(", ")}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right text-green-700">{r.in ? <QtyCasesPieces base={r.in.base} basePerCase={per} /> : ""}</td>
                  <td className="px-3 py-2 text-right text-red-700">{r.out ? <QtyCasesPieces base={r.out.base} basePerCase={per} /> : ""}</td>
                  <td className="px-3 py-2 text-right font-medium"><QtyCasesPieces base={r.balance.base} basePerCase={per} /></td>
                  <td className="px-3 py-2 text-right"><Peso centavos={r.valueBalanceCentavos} /></td>
                </tr>
              );
            })}
            {c ? (
              <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                <td className="px-3 py-2" colSpan={2}>Closing balance</td>
                <td className="px-3 py-2 text-right text-green-700"><QtyCasesPieces base={c.totals.in.base} basePerCase={per} /></td>
                <td className="px-3 py-2 text-right text-red-700"><QtyCasesPieces base={c.totals.out.base} basePerCase={per} /></td>
                <td className="px-3 py-2 text-right"><QtyCasesPieces base={c.closing.quantity.base} basePerCase={per} /></td>
                <td className="px-3 py-2 text-right"><Peso centavos={c.closing.valueCentavos} /></td>
              </tr>
            ) : (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-500">{data.isLoading ? "Loading…" : "No stock card yet."}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {c?.nextCursor ? <p className="text-sm text-gray-500">Showing the first {c.rows.length} of {c.rowCount} movements. Narrow the dates to see the rest.</p> : null}
    </div>
  );
}
