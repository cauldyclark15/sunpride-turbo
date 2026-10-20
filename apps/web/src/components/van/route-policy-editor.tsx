"use client";
import { useState } from "react";
import { Button } from "@heroui/react";
import type { TripSettlement } from "./model";
import { useVanCommand } from "./use-command";
import { routeBase } from "./route-format";

type ListItem = { code: string; label: string };
type Band = {
  productId: string | null;
  label: string;
  minDeciC: number;
  maxDeciC: number;
};
/** F-113/F-114/F-115/F-118 each master is prospectively versioned, never edited behind captured evidence. */
export function VanPolicyEditor({ trip }: { trip: TripSettlement }) {
  const [kind, setKind] = useState("cold_chain");
  if (!trip.vanOps) return null;
  return (
    <details>
      <summary>Edit future van policies</summary>
      <p className="my-2 text-sm text-muted">
        Existing captures retain their original policy. Sample storage bands,
        reason lists, assets and tolerances require Sunpride approval.
      </p>
      <label>
        Policy
        <select
          aria-label="Policy"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="cold_chain">
            Product storage bands and reading interval
          </option>
          <option value="returnables">
            Crates, trays and other returnables
          </option>
          <option value="return_reasons">Shared return reason codes</option>
          <option value="variance">
            Variance tolerance and escalation deadline
          </option>
        </select>
      </label>
      <PolicyForm key={`${trip.tripId}:${kind}`} trip={trip} kind={kind} />
    </details>
  );
}
function PolicyForm({ trip, kind }: { trip: TripSettlement; kind: string }) {
  const route = trip.vanOps!;
  const command = useVanCommand<Record<string, unknown>, unknown>(
    "/api/v1/van/policies/set",
  );
  const [bands, setBands] = useState<Band[]>(() =>
    route.policies.cold_chain.bands.map((b) => ({ ...b })),
  );
  const [items, setItems] = useState<ListItem[]>(() =>
    kind === "returnables"
      ? route.policies.returnables.items.map((x) => ({ ...x }))
      : route.policies.return_reasons.items.map((x) => ({ ...x })),
  );
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function submit(form: HTMLFormElement) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const f = new FormData(form);
      let facts: unknown;
      if (kind === "cold_chain")
        facts = { intervalMinutes: Number(f.get("minutes")), bands };
      else if (kind === "variance")
        facts = {
          toleranceBasisPoints: Number(
            routeBase(String(f.get("percent")), "100"),
          ),
          escalateAfterHours: Number(f.get("hours")),
        };
      else facts = { items };
      await command({
        orgUnitId: trip.unitId,
        kind,
        effectiveFrom: new Date(String(f.get("from"))).toISOString(),
        sourceRef: String(f.get("source")),
        facts,
      });
      setMessage("Future policy saved. Captured evidence was not changed.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Policy not saved");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="mt-3 grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(e.currentTarget);
      }}
    >
      {message && <p role="status">{message}</p>}
      {kind === "cold_chain" && (
        <>
          <label>
            Minutes between temperature readings
            <input
              name="minutes"
              type="number"
              min="1"
              max="240"
              defaultValue={route.policies.cold_chain.intervalMinutes}
              required
            />
          </label>
          {bands.map((b, i) => (
            <fieldset
              key={i}
              className="grid gap-2 rounded-lg border border-separator p-3"
            >
              <legend>Storage band {i + 1}</legend>
              <label>
                Product
                <select
                  aria-label={`Product for storage band ${i + 1}`}
                  value={b.productId ?? ""}
                  onChange={(e) =>
                    setBands(
                      bands.map((x, n) =>
                        n === i
                          ? { ...x, productId: e.target.value || null }
                          : x,
                      ),
                    )
                  }
                >
                  <option value="">
                    Van default for products without their own band
                  </option>
                  {trip.stock.map((p) => (
                    <option key={p.productId} value={p.productId}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Band name
                <input
                  value={b.label}
                  maxLength={80}
                  required
                  onChange={(e) =>
                    setBands(
                      bands.map((x, n) =>
                        n === i ? { ...x, label: e.target.value } : x,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Minimum °C
                <input
                  type="number"
                  min="-100"
                  max="60"
                  step="0.1"
                  value={b.minDeciC / 10}
                  onChange={(e) =>
                    setBands(
                      bands.map((x, n) =>
                        n === i
                          ? {
                              ...x,
                              minDeciC: Math.round(Number(e.target.value) * 10),
                            }
                          : x,
                      ),
                    )
                  }
                  required
                />
              </label>
              <label>
                Maximum °C
                <input
                  type="number"
                  min="-100"
                  max="60"
                  step="0.1"
                  value={b.maxDeciC / 10}
                  onChange={(e) =>
                    setBands(
                      bands.map((x, n) =>
                        n === i
                          ? {
                              ...x,
                              maxDeciC: Math.round(Number(e.target.value) * 10),
                            }
                          : x,
                      ),
                    )
                  }
                  required
                />
              </label>
              <Button
                type="button"
                variant="outline"
                isDisabled={bands.length <= 1}
                onPress={() => setBands(bands.filter((_, n) => n !== i))}
              >
                Remove band
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            isDisabled={bands.length >= 500}
            onPress={() =>
              setBands([
                ...bands,
                { productId: null, label: "", minDeciC: -250, maxDeciC: -180 },
              ])
            }
          >
            Add storage band
          </Button>
        </>
      )}
      {kind === "variance" && (
        <>
          <label>
            Tolerance, % of van sales value
            <input
              name="percent"
              type="number"
              step="0.01"
              min="0"
              max="100"
              defaultValue={route.policies.variance.toleranceBasisPoints / 100}
              required
            />
          </label>
          <label>
            Hours to escalation deadline
            <input
              name="hours"
              type="number"
              min="1"
              max="168"
              defaultValue={route.policies.variance.escalateAfterHours}
              required
            />
          </label>
        </>
      )}
      {(kind === "returnables" || kind === "return_reasons") && (
        <>
          {kind === "return_reasons" && (
            <p className="text-xs text-muted">
              New reason codes route returned goods to warehouse bad stock.
              Existing safe reason/disposition rules remain; this is not
              permission to dispose or refund.
            </p>
          )}
          {items.map((r, i) => (
            <fieldset
              key={i}
              className="grid gap-2 rounded-lg border border-separator p-3"
            >
              <legend>Item {i + 1}</legend>
              <label>
                Code
                <input
                  value={r.code}
                  pattern="[a-z][a-z0-9_]{0,31}"
                  maxLength={32}
                  required
                  onChange={(e) =>
                    setItems(
                      items.map((x, n) =>
                        n === i ? { ...x, code: e.target.value } : x,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Name on the phone
                <input
                  value={r.label}
                  maxLength={80}
                  required
                  onChange={(e) =>
                    setItems(
                      items.map((x, n) =>
                        n === i ? { ...x, label: e.target.value } : x,
                      ),
                    )
                  }
                />
              </label>
              <Button
                type="button"
                variant="outline"
                isDisabled={items.length <= 1}
                onPress={() => setItems(items.filter((_, n) => n !== i))}
              >
                Remove item
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            isDisabled={items.length >= 30}
            onPress={() => setItems([...items, { code: "", label: "" }])}
          >
            Add item
          </Button>
        </>
      )}
      <label>
        Effective from
        <input name="from" type="datetime-local" required />
      </label>
      <label>
        Source or approval reference
        <input name="source" maxLength={200} required />
      </label>
      <Button type="submit" isDisabled={busy}>
        Save future version
      </Button>
    </form>
  );
}
