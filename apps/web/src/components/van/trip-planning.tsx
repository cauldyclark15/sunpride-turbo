"use client";
import { useState } from "react";
import { Button } from "@heroui/react";
import { apiFetch, useApi } from "../../lib/api";
import { useVanCommand } from "./use-command";

type Choices = {
  vehicles: Array<{
    vehicleId: string;
    name: string;
    plateNumber: string;
    unitId: string;
    homeLocationId: string;
    busy: boolean;
  }>;
  sellers: Array<{ profileId: string; name: string; unitId: string }>;
  depots: Array<{ locationId: string; name: string; code: string }>;
  routes: Array<{ routeId: string; name: string; code: string }>;
};
/** F-102/F-105 office setup stays under Vans & cash; new routes opt into the complete cold-chain/offline contract. */
export function VanTripPlanning({
  date,
  onPlanned,
}: {
  date: string;
  onPlanned: (tripId: string) => void;
}) {
  const choices = useApi<Choices>(["van", "planning", date], ({ signal }) =>
    apiFetch("/api/v1/van/planning", { query: { date }, signal }),
  );
  const plan = useVanCommand<Record<string, unknown>, { tripId: string }>(
    "/api/v1/van/trips/plan",
  );
  const [vehicle, setVehicle] = useState(""),
    [seller, setSeller] = useState(""),
    [route, setRoute] = useState(""),
    [depot, setDepot] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const data = choices.data,
    selected = data?.vehicles.find((v) => v.vehicleId === vehicle);
  async function submit(form: HTMLFormElement) {
    if (busy || !selected) return;
    setBusy(true);
    setError("");
    try {
      const f = new FormData(form);
      const result = await plan({
        serviceDate: date,
        vehicleId: vehicle,
        salespersonProfileId: seller,
        routeId: route,
        sourceLocationId: depot || selected.homeLocationId,
        driverName: String(f.get("driver")),
        helperName: String(f.get("helper")),
        operationsVersion: 1,
      });
      onPlanned(result.tripId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Trip not planned");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rounded-xl border border-separator p-4 print:hidden">
      <summary>Plan a truck for this day</summary>
      <p className="my-2 text-sm text-muted">
        Plan its beat and seller, review a suggested load, then let the seller
        scan load-out. Current cold-chain, returnable, reason and tolerance
        policies must exist.
      </p>
      {choices.error && <p role="alert">{choices.error.message}</p>}
      {error && <p role="alert">{error}</p>}
      {!data ? (
        <p role="status">Loading authorized choices…</p>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(e.currentTarget);
          }}
        >
          <label>
            Truck
            <select
              required
              value={vehicle}
              onChange={(e) => {
                setVehicle(e.target.value);
                setSeller("");
                setDepot("");
              }}
            >
              <option value="">Choose a truck</option>
              {data.vehicles.map((v) => (
                <option key={v.vehicleId} value={v.vehicleId} disabled={v.busy}>
                  {v.name || v.plateNumber} · {v.plateNumber}
                  {v.busy ? " · already on a trip" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Seller
            <select
              required
              value={seller}
              onChange={(e) => setSeller(e.target.value)}
            >
              <option value="">Choose the seller</option>
              {data.sellers
                .filter((s) => !selected || s.unitId === selected.unitId)
                .map((s) => (
                  <option key={s.profileId} value={s.profileId}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Planned beat
            <select
              required
              value={route}
              onChange={(e) => setRoute(e.target.value)}
            >
              <option value="">Choose a beat</option>
              {data.routes.map((r) => (
                <option key={r.routeId} value={r.routeId}>
                  {r.name} · {r.code}
                </option>
              ))}
            </select>
          </label>
          <label>
            Load from
            <select
              value={depot || selected?.homeLocationId || ""}
              onChange={(e) => setDepot(e.target.value)}
            >
              <option value="">Truck's home depot</option>
              {data.depots.map((d) => (
                <option key={d.locationId} value={d.locationId}>
                  {d.name} · {d.code}
                </option>
              ))}
            </select>
          </label>
          <label>
            Driver
            <input name="driver" maxLength={80} />
          </label>
          <label>
            Helper
            <input name="helper" maxLength={80} />
          </label>
          <Button
            type="submit"
            isDisabled={busy || !selected || !seller || !route}
          >
            Plan cold-chain route
          </Button>
        </form>
      )}
    </details>
  );
}
