"use client";

import { useState } from "react";
import { useApi } from "@/lib/api";
import { Peso } from "../ops/peso";

export type TaxTotals = {
  documents: number;
  gross: string;
  vatable: string;
  vat: string;
  vat_exempt: string;
  zero_rated: string;
  promo_discount: string;
  privilege_discount: string;
  vat_removed: string;
  total_due: string;
};
export type TaxDay = TaxTotals & { date: string };
export type TaxPrivilegeRow = {
  type: string;
  label: string;
  documents: number;
  discount: string;
  vat_removed: string;
  gross: string;
};
export type TaxSummaryData = {
  days: TaxDay[];
  totals: TaxTotals;
  privilege: TaxPrivilegeRow[];
};

const c = (v: string | null | undefined) => Number(v ?? 0);

function Line({
  label,
  centavos,
  strong,
  minus,
  hint,
}: {
  label: string;
  centavos: number;
  strong?: boolean;
  minus?: boolean;
  hint?: string;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 py-1 ${strong ? "border-t border-field-border font-bold" : ""}`}
    >
      <span>
        {label}
        {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
      </span>
      <span>
        {minus ? "−" : ""}
        <Peso centavos={centavos} />
      </span>
    </div>
  );
}

/**
 * Tax summary for a period. Senior/PWD/solo-parent/athlete/uniformed discounts and the VAT removed on those
 * sales are separate lines per type, never folded into "discounts". Voided invoices are already left out.
 */
export function TaxPeriodSummary({ data }: { data: TaxSummaryData }) {
  const t = data.totals;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section aria-label="Sales" className="rounded-2xl bg-white p-4">
        <h2 className="mb-2 text-lg font-bold">Sales and discounts</h2>
        <Line label="Gross sales" centavos={c(t.gross)} />
        {c(t.promo_discount) > 0 ? (
          <Line label="Promo discounts" centavos={c(t.promo_discount)} minus />
        ) : null}
        {data.privilege.map((p) => (
          <Line
            key={p.type}
            label={`${p.label} discount`}
            hint={`${p.documents} ${p.documents === 1 ? "invoice" : "invoices"}`}
            centavos={c(p.discount)}
            minus
          />
        ))}
        {c(t.vat_removed) > 0 ? (
          <Line
            label="VAT removed on discounted sales"
            centavos={c(t.vat_removed)}
            minus
          />
        ) : null}
        <Line label="Amount collected" centavos={c(t.total_due)} strong />
        <p className="mt-1 text-xs text-muted">
          {t.documents} {t.documents === 1 ? "invoice" : "invoices"}, voided
          ones left out.
        </p>
      </section>
      <section aria-label="Tax" className="rounded-2xl bg-white p-4">
        <h2 className="mb-2 text-lg font-bold">Tax</h2>
        <Line label="VATable sales" centavos={c(t.vatable)} />
        <Line label="VAT" centavos={c(t.vat)} />
        <Line label="VAT-exempt sales" centavos={c(t.vat_exempt)} />
        <Line label="Zero-rated sales" centavos={c(t.zero_rated)} />
        <p className="mt-1 text-xs text-muted">
          These are shown before the senior/PWD discount, as BIR requires.
        </p>
      </section>
      <section
        aria-label="By day"
        className="rounded-2xl bg-white p-4 lg:col-span-2"
      >
        <h2 className="mb-2 text-lg font-bold">By day</h2>
        <table className="w-full text-right tabular-nums">
          <thead className="text-xs uppercase text-muted">
            <tr>
              <th className="text-left">Day</th>
              <th>Invoices</th>
              <th>Collected</th>
              <th>Senior/PWD discount</th>
              <th>VAT removed</th>
            </tr>
          </thead>
          <tbody>
            {data.days.map((d) => (
              <tr key={d.date} className="border-t border-field-border">
                <td className="py-1 text-left">{d.date}</td>
                <td>{d.documents}</td>
                <td>
                  <Peso centavos={c(d.total_due)} />
                </td>
                <td>
                  <Peso centavos={c(d.privilege_discount)} />
                </td>
                <td>
                  <Peso centavos={c(d.vat_removed)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/** Office screen: pick dates, see the summary. Exported, not mounted. */
export function TaxPeriodSummaryScreen({ unitId }: { unitId?: string }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (unitId) params.set("unitId", unitId);
  const q = params.toString();
  const result = useApi<TaxSummaryData>(
    ["fiscal", "tax-summary", { from, to, unitId }],
    `/api/v1/fiscal/tax-summary${q ? `?${q}` : ""}`,
  );
  return (
    <div className="grid gap-4 bg-[#F5F6F8] p-4">
      <div className="flex flex-wrap gap-3">
        <label className="grid gap-1">
          <span className="text-xs font-medium uppercase text-muted">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="min-h-12 rounded-[10px] border border-field-border bg-field-background px-3"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-xs font-medium uppercase text-muted">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="min-h-12 rounded-[10px] border border-field-border bg-field-background px-3"
          />
        </label>
      </div>
      {result.error ? (
        <p role="alert">Tax summary could not load. {result.error.message}</p>
      ) : !result.data ? (
        <p>Loading tax summary…</p>
      ) : (
        <TaxPeriodSummary data={result.data} />
      )}
    </div>
  );
}
