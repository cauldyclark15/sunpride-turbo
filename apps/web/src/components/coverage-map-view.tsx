"use client";

import { Button } from "@heroui/react";
import { Card, StatusPill, WorkspaceIcon } from "@sunpride/ui";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import {
  CoverageScopeSelect,
  useCoverageScopeOptions,
} from "./coverage-scope-filters";

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
  const options = useCoverageScopeOptions(planId);
  return (
    <Card label="Map" count={rows.length} icon={<WorkspaceIcon name="field" />}>
      <div className="grid gap-4">
        <div className="flex flex-wrap gap-3">
          <CoverageScopeSelect
            label="Territory"
            options={options?.territories ?? []}
            selected={territoryId ?? ""}
            onSelect={(id) => {
              setTerritoryId((id as Id<"territories">) || undefined);
              setCursor(null);
            }}
          />
          <CoverageScopeSelect
            label="Route"
            options={options?.routes ?? []}
            selected={routeId ?? ""}
            onSelect={(id) => {
              setRouteId((id as Id<"routes">) || undefined);
              setCursor(null);
            }}
          />
        </div>
        {result === undefined ? (
          <p>Loading outlets…</p>
        ) : (
          <>
            <TileMap rows={rows} />
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-left text-[13px]">
                <thead className="border-b border-separator text-[11px] uppercase tracking-wide text-muted">
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
                      <td>
                        <StatusPill tone={row.inPlan ? "success" : "neutral"}>
                          {row.inPlan ? "Planned" : "Uncovered"}
                        </StatusPill>
                      </td>
                      <td>
                        <StatusPill tone={row.assigned ? "success" : "neutral"}>
                          {row.assigned ? "Assigned" : "Unassigned"}
                        </StatusPill>
                      </td>
                      <td>
                        <StatusPill
                          tone={
                            row.pinStatus === "verified" ? "success" : "neutral"
                          }
                        >
                          {row.pinStatus === "verified"
                            ? "Verified"
                            : "Unmapped"}
                        </StatusPill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rows.length && <p>No outlets here</p>}
            {!result.isDone && (
              <Button
                variant="outline"
                className="h-10"
                onPress={() => setCursor(result.continueCursor)}
              >
                Next page
              </Button>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
