"use client";
import { useState } from "react";
import { Button } from "@heroui/react";
import { usePermissions } from "../../lib/auth";
import { useVanCommand } from "./use-command";
import type { TripSettlement } from "./model";
import { routeBase, routeQuantity } from "./route-format";

type Suggestion = {
  suggestionId: string;
  contentHash: string;
  routeOutletCount: number;
  classMix: Record<string, number>;
  sourceOrderCount: number;
  algorithm: string;
  capacity: string;
  cycles: Array<{ date: string }>;
  recommendations: Array<{
    productId: string;
    name: string;
    uomCode: string;
    quantityScale: string;
    caseBase: string;
    forecastBase: string;
    presellBase: string;
    depotAvailableBase: string;
    recommendedBase: string;
  }>;
};
const pieces = (q: string, scale: string) =>
  routeQuantity(q, scale, "0", "").trim();
/** F-102 explain inputs, review physical capacity, then invoke the existing load plan command. */
export function SuggestedLoad({ trip }: { trip: TripSettlement }) {
  const { can } = usePermissions();
  const suggest = useVanCommand<{ tripId: string }, Suggestion>(
    "/api/v1/van/loads/suggest",
  );
  const apply = useVanCommand<Record<string, unknown>, unknown>(
    "/api/v1/van/loads/apply-suggestion",
  );
  const [data, setData] = useState<Suggestion | null>(null),
    [counts, setCounts] = useState<Record<string, string>>({}),
    [note, setNote] = useState(""),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (trip.status !== "planned" || !can("van.manage")) return null;
  async function generate() {
    setBusy(true);
    setError("");
    try {
      const d = await suggest({ tripId: trip.tripId });
      setData(d);
      setReviewed(false);
      setNote("");
      setCounts(
        Object.fromEntries(
          d.recommendations.map((r) => [
            r.productId,
            String(pieces(r.recommendedBase, r.quantityScale)),
          ]),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load suggestion failed");
    } finally {
      setBusy(false);
    }
  }
  async function applyReviewed() {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    try {
      await apply({
        tripId: trip.tripId,
        suggestionId: data.suggestionId,
        contentHash: data.contentHash,
        capacityReviewed: reviewed,
        note,
        lines: data.recommendations.map((r) => ({
          productId: r.productId,
          quantityBase: routeBase(counts[r.productId] ?? "", r.quantityScale),
        })),
      });
      setData(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not apply load");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Suggested van load"
      className="grid gap-3 rounded-lg border border-separator p-4"
    >
      <h3 className="font-medium">What should this truck load?</h3>
      <Button
        variant="outline"
        isDisabled={busy}
        onPress={() => void generate()}
      >
        Generate suggested load
      </Button>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p className="text-sm">
            {data.routeOutletCount} planned stores ·{" "}
            {Object.entries(data.classMix)
              .map(([name, n]) => `${name}: ${n}`)
              .join(", ")}{" "}
            · {data.cycles.length} prior route cycles · {data.sourceOrderCount}{" "}
            open pre-sell orders.
          </p>
          <p className="text-xs text-muted">{data.algorithm}</p>
          {data.recommendations.map((r) => (
            <label key={r.productId} className="block text-sm">
              {r.name} · forecast{" "}
              {routeQuantity(
                r.forecastBase,
                r.quantityScale,
                r.caseBase,
                r.uomCode,
              )}{" "}
              · pre-sell{" "}
              {routeQuantity(
                r.presellBase,
                r.quantityScale,
                r.caseBase,
                r.uomCode,
              )}{" "}
              · depot{" "}
              {routeQuantity(
                r.depotAvailableBase,
                r.quantityScale,
                r.caseBase,
                r.uomCode,
              )}
              <input
                aria-label={`Load ${r.name} in ${r.uomCode}`}
                value={counts[r.productId] ?? ""}
                onChange={(e) => {
                  setCounts({ ...counts, [r.productId]: e.target.value });
                  setReviewed(false);
                }}
                inputMode="decimal"
              />
            </label>
          ))}
          <p className="text-xs">{data.capacity}</p>
          <label className="text-sm">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            I checked the truck's capacity and reviewed these quantities.
          </label>
          <label>
            Load review note
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
            />
          </label>
          <Button
            isDisabled={
              busy || !reviewed || !note.trim() || !data.recommendations.length
            }
            onPress={() => void applyReviewed()}
          >
            Apply reviewed load
          </Button>
        </>
      )}
    </section>
  );
}
