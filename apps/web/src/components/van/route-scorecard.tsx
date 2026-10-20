import { routeMoney } from "./route-format";

export type RouteScorecard = {
  salesCentavos: string;
  calls: number;
  plannedCalls: number;
  productiveCalls: number;
  strikeRateBasisPoints: number | null;
  dropSizeCentavos: string | null;
  returnDocuments: number;
  refundsCentavos: string;
  varianceCentavos: string | null;
  collectedCentavos: string;
  callFactsComplete: boolean;
  definitions: string;
  monthSalesCentavos: string;
  monthTargetCentavos: string | null;
  targetStatus: string;
  prior: { date: string; salesCentavos: string } | null;
  trend: Array<{ date: string; salesCentavos: string }>;
};

/** F-122 the same governed baseline carried on the handheld, with comparison and a next action. */
export function RouteScorecardView({ card }: { card: RouteScorecard }) {
  return (
    <section aria-label="Seller daily scorecard" className="grid gap-3">
      <h4 className="font-medium">Is this seller on track?</h4>
      <p className="text-sm">
        {!card.callFactsComplete
          ? "Record the missing actual stop facts before judging strike rate."
          : card.calls < card.plannedCalls
            ? "Complete the remaining planned stores."
            : "Review returns and differences, then complete the trip."}
      </p>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ["Sales before returns", routeMoney(card.salesCentavos)],
          ["Calls / planned", `${card.calls} / ${card.plannedCalls}`],
          [
            "Strike rate",
            card.strikeRateBasisPoints === null
              ? "Needs stop facts"
              : `${card.strikeRateBasisPoints / 100}%`,
          ],
          ["Average buying-store drop", routeMoney(card.dropSizeCentavos)],
          ["Return documents", String(card.returnDocuments)],
          ["Actual refunds", routeMoney(card.refundsCentavos)],
          ["Variance value", routeMoney(card.varianceCentavos)],
          [
            "Collected, excluding credit promises",
            routeMoney(card.collectedCentavos),
          ],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm">
        Month to date {routeMoney(card.monthSalesCentavos)} /{" "}
        {card.monthTargetCentavos === null
          ? "Set an unambiguous monthly target in Reports"
          : routeMoney(card.monthTargetCentavos)}
        .
      </p>
      <p className="text-sm">
        {card.prior
          ? `Previous trip ${card.prior.date}: ${routeMoney(card.prior.salesCentavos)}.`
          : "No earlier trip for comparison."}
      </p>
      <details>
        <summary className="text-sm">Last 14 days and definitions</summary>
        <ol className="grid gap-1 text-sm">
          {card.trend.map((p) => (
            <li key={p.date}>
              {p.date} · {routeMoney(p.salesCentavos)}
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-muted">{card.definitions}</p>
      </details>
    </section>
  );
}
