"use client";

import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";

type PinRow = {
  outletId: Id<"outlets">;
  outletCode: string;
  outletName: string;
  latitude?: number;
  longitude?: number;
  pinStatus: "verified" | "unmapped";
  sequence?: number;
  inPlan: boolean;
  assigned: boolean;
};
export function plottedPins(rows: PinRow[]): PinRow[] {
  return rows.filter(
    (row) =>
      row.pinStatus === "verified" &&
      Number.isFinite(row.latitude) &&
      Number.isFinite(row.longitude),
  );
}
function TileMap({ rows }: { rows: PinRow[] }) {
  const node = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!node.current) return;
    let disposed = false;
    let map: import("leaflet").Map | undefined;
    import("leaflet")
      .then((L) => {
        if (disposed || !node.current) return;
        map = L.map(node.current).setView([14.6, 121], 10);
        const tiles = L.tileLayer(
          "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          {
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 19,
          },
        ).addTo(map);
        tiles.on("tileerror", () => setFailed(true));
        const pins = plottedPins(rows);
        for (const pin of pins) {
          L.marker([pin.latitude!, pin.longitude!], {
            icon: L.divIcon({
              className: "coverage-stop-marker",
              html: `<span style="display:inline-block;background:#174a78;color:white;border-radius:50%;padding:5px 9px">${pin.sequence ?? "•"}</span>`,
            }),
          })
            .bindPopup(() => {
              const label = document.createElement("span");
              label.textContent = `${pin.outletCode} · ${pin.outletName}`;
              return label;
            })
            .addTo(map);
        }
        if (pins.length)
          map.fitBounds(
            L.latLngBounds(pins.map((p) => [p.latitude!, p.longitude!])),
            { padding: [24, 24], maxZoom: 15 },
          );
      })
      .catch(() => setFailed(true));
    return () => {
      disposed = true;
      map?.remove();
    };
  }, [rows]);
  return (
    <div>
      <div
        ref={node}
        aria-label="Verified outlet pin map"
        style={{ height: 360 }}
      />
      {failed && (
        <p role="status">
          Map tiles unavailable; the outlet list remains available below.
        </p>
      )}
      <small>
        Map data © OpenStreetMap contributors · public tiles are best effort,
        not offline or production SLA.
      </small>
    </div>
  );
}
export function CoverageMapView({ planId }: { planId: Id<"coveragePlans"> }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [territoryId, setTerritoryId] = useState<
    Id<"territories"> | undefined
  >();
  const [routeId, setRouteId] = useState<Id<"routes"> | undefined>();
  const result = useQuery(api.coverage.map.forPlan, {
    planId,
    territoryId,
    routeId,
    paginationOpts: { numItems: 20, cursor },
  });
  const rows = result?.page ?? [];
  return (
    <section aria-label="Coverage outlet map">
      <h3>Verified outlet pins and route stops</h3>
      <label>
        Territory ID{" "}
        <input
          value={territoryId ?? ""}
          onChange={(event) => {
            setTerritoryId(
              (event.target.value as Id<"territories">) || undefined,
            );
            setCursor(null);
          }}
        />
      </label>
      <label>
        Route ID{" "}
        <input
          value={routeId ?? ""}
          onChange={(event) => {
            setRouteId((event.target.value as Id<"routes">) || undefined);
            setCursor(null);
          }}
        />
      </label>
      {result === undefined ? (
        <p>Loading scoped outlets…</p>
      ) : (
        <>
          <TileMap rows={rows} />
          <table>
            <caption>Outlet list (available even if tiles fail)</caption>
            <thead>
              <tr>
                <th>Stop</th>
                <th>Outlet</th>
                <th>Plan</th>
                <th>Assignment</th>
                <th>Pin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.outletId}>
                  <td>{row.sequence ?? "—"}</td>
                  <td>
                    {row.outletCode} · {row.outletName}
                  </td>
                  <td>{row.inPlan ? "Planned" : "Uncovered"}</td>
                  <td>{row.assigned ? "Assigned" : "Unassigned"}</td>
                  <td>
                    {row.pinStatus === "verified"
                      ? "Verified"
                      : "Unmapped (no verified pin)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p>No visible outlets on this page.</p>}
          {!result.isDone && (
            <button
              type="button"
              onClick={() => setCursor(result.continueCursor)}
            >
              Next outlets
            </button>
          )}
        </>
      )}
    </section>
  );
}
