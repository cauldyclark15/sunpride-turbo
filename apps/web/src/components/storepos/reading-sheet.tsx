"use client";

import { DocNumber, Peso } from "../ops";
import { money, type PrintModel, type ZSummary } from "./store-day-model";

/**
 * The printed X or Z, on screen. It renders the SAME printer-neutral model the handheld prints, so what the
 * office reads is what the cashier's slip says. A reprint says so at the top.
 */
export function ReadingSheet({
  model,
  onPrint,
}: {
  model: PrintModel;
  onPrint?: () => void;
}) {
  return (
    <section
      aria-label={model.title}
      className="grid max-w-md gap-2 rounded-2xl border border-border bg-surface p-4"
    >
      <header className="grid gap-1 text-center">
        <h3 className="text-base font-semibold tracking-wide">{model.title}</h3>
        {model.reprint && (
          <p className="text-sm font-semibold uppercase text-danger">
            Reprint — copy of the original
          </p>
        )}
        <p className="text-sm">
          <DocNumber value={model.docNumber} />
        </p>
        {model.sample && (
          <p className="text-xs font-semibold uppercase text-warning">
            NOT FILED - SAMPLE
          </p>
        )}
      </header>
      <dl className="grid gap-1 text-sm">
        {model.lines.map((l, i) => (
          <div
            key={`${l.label}-${i}`}
            className={`flex items-baseline justify-between gap-3 border-b border-dashed border-separator py-1 ${l.strong ? "font-semibold" : ""}`}
          >
            <dt className="min-w-0">{l.label}</dt>
            <dd className="shrink-0 text-right tabular-nums">
              {l.value ?? "—"}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-center text-xs text-muted">{model.footer}</p>
      {onPrint && (
        <button
          type="button"
          onClick={onPrint}
          className="min-h-12 rounded-xl bg-[#EF5706] px-4 text-base font-semibold text-white"
        >
          {model.reprint ? "Print copy" : "Print"}
        </button>
      )}
    </section>
  );
}

/** Z history: newest first. Old (pre-typed) Z readings still show, marked as such. */
export function ZHistoryList({
  readings,
  onOpen,
}: {
  readings: ZSummary[];
  onOpen?: (z: ZSummary) => void;
}) {
  if (!readings.length)
    return (
      <p className="text-sm text-muted">
        No Z readings in this period. A Z reading closes a business day.
      </p>
    );
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Z reading history</caption>
      <thead className="text-left text-xs uppercase text-muted">
        <tr>
          <th className="py-2 pr-3">Day</th>
          <th className="py-2 pr-3">Z no.</th>
          <th className="py-2 pr-3 text-right">Net sales</th>
          <th className="py-2 pr-3 text-right">Grand total (net) after</th>
          <th className="py-2" />
        </tr>
      </thead>
      <tbody>
        {readings.map((z) => (
          <tr key={z.id} className="border-t border-separator">
            <td className="py-2 pr-3">{z.businessDate}</td>
            <td className="py-2 pr-3">
              {z.zCounter}
              {z.legacy && (
                <span className="ml-2 text-xs text-muted">Older record</span>
              )}
            </td>
            <td className="py-2 pr-3 text-right">
              <Peso centavos={money(z.netSalesCentavos)} />
            </td>
            <td className="py-2 pr-3 text-right">
              {z.legacy ? "—" : <Peso centavos={money(z.endingNetCentavos)} />}
            </td>
            <td className="py-2 text-right">
              {!z.legacy && onOpen && (
                <button
                  type="button"
                  className="min-h-12 rounded-lg border border-border px-3"
                  onClick={() => onOpen(z)}
                >
                  View and print
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
