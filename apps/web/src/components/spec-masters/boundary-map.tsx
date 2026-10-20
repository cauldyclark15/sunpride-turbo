"use client";
import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import type { Polygon } from "./model";
const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";

/** F-009 click to draw; drag corners to edit. Native Google polygons, no retired
 * Drawing library. The existing Leaflet dependency supplies a free local fallback. */
export default function BoundaryMap({
  initial,
  onChange,
}: {
  initial: Polygon | null;
  onChange: (p: Polygon | null) => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const [reset, setReset] = useState(0);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const target = node.current;
    if (!target) return;
    let alive = true,
      cleanup = () => {};
    const ring: [number, number][] = reset
      ? []
      : (initial?.coordinates[0]?.slice(0, -1) ?? []);
    const emit = () =>
      onChange(
        ring.length >= 3
          ? { type: "Polygon", coordinates: [[...ring, ring[0]!]] }
          : null,
      );
    const start = async () => {
      if (GOOGLE_KEY) {
        try {
          const { setOptions, importLibrary } =
            await import("@googlemaps/js-api-loader");
          setOptions({ key: GOOGLE_KEY, v: "weekly" });
          const { Map, Polygon: GooglePolygon } = await importLibrary("maps");
          if (!alive) return;
          const map = new Map(target, {
            center: { lat: ring[0]?.[1] ?? 10.32, lng: ring[0]?.[0] ?? 123.9 },
            zoom: 12,
            streetViewControl: false,
            mapTypeControl: false,
          });
          const shape = new GooglePolygon({
            map,
            paths: ring.map((p) => ({ lat: p[1], lng: p[0] })),
            editable: true,
            strokeColor: "#202020",
            fillColor: "#666666",
            fillOpacity: 0.15,
          });
          const path = shape.getPath();
          const sync = () => {
            ring.splice(
              0,
              ring.length,
              ...path
                .getArray()
                .map((p) => [p.lng(), p.lat()] as [number, number]),
            );
            emit();
          };
          const click = map.addListener(
            "click",
            (e: google.maps.MapMouseEvent) => {
              if (e.latLng && path.getLength() < 100) path.push(e.latLng);
            },
          );
          const listeners = [
            path.addListener("set_at", sync),
            path.addListener("insert_at", sync),
            path.addListener("remove_at", sync),
          ];
          if (ring.length) {
            const { LatLngBounds } = await importLibrary("core");
            const bounds = new LatLngBounds();
            ring.forEach((p) => bounds.extend({ lat: p[1], lng: p[0] }));
            map.fitBounds(bounds);
          }
          cleanup = () => {
            click.remove();
            listeners.forEach((l) => l.remove());
            shape.setMap(null);
          };
          return;
        } catch {
          if (alive)
            setMessage("Google Maps unavailable. Editing on OpenStreetMap.");
        }
      }
      const L = await import("leaflet");
      if (!alive) return;
      const map = L.map(target, {
        center: [ring[0]?.[1] ?? 10.32, ring[0]?.[0] ?? 123.9],
        zoom: 12,
      });
      const tiles = L.tileLayer(
        "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
          attribution:
            '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 19,
        },
      ).addTo(map);
      tiles.on("tileerror", () => {
        if (alive)
          setMessage(
            "Map tiles are unavailable. Boundary editing still works; retry when online.",
          );
      });
      tiles.on("load", () => {
        if (alive && target.querySelector("img.leaflet-tile-loaded"))
          setMessage((value) => (value.startsWith("Map tiles") ? "" : value));
      });
      const shape = L.polygon(
        ring.map((p) => [p[1], p[0]]),
        { color: "#202020", fillOpacity: 0.15 },
      ).addTo(map);
      const handles = L.layerGroup().addTo(map);
      const redraw = () => {
        shape.setLatLngs(ring.map((p) => [p[1], p[0]]));
        handles.clearLayers();
        ring.forEach((p, i) =>
          L.marker([p[1], p[0]], {
            draggable: true,
            icon: L.divIcon({
              className: "",
              html: '<span style="display:block;width:16px;height:16px;border-radius:50%;background:white;border:2px solid #222"></span>',
              iconSize: [16, 16],
              iconAnchor: [8, 8],
            }),
          })
            .addTo(handles)
            .on("dragend", (e) => {
              const at = e.target.getLatLng();
              ring[i] = [at.lng, at.lat];
              redraw();
              emit();
            }),
        );
      };
      redraw();
      if (ring.length >= 3) map.fitBounds(shape.getBounds());
      map.on("click", (e) => {
        if (ring.length < 100) {
          ring.push([e.latlng.lng, e.latlng.lat]);
          redraw();
          emit();
        }
      });
      cleanup = () => map.remove();
    };
    void start().catch(() => {
      if (alive)
        setMessage("The map could not load. Check the connection and retry.");
    });
    return () => {
      alive = false;
      cleanup();
    };
  }, [initial, onChange, reset]);
  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted">
        Click the map to add corners. Drag a corner to adjust it. Boundaries
        close after three corners.
      </p>
      <div
        ref={node}
        className="h-80 w-full rounded-lg border border-border"
        aria-label="Editable geography boundary map"
      />
      <button
        type="button"
        className="justify-self-start text-sm underline"
        onClick={() => {
          onChange(null);
          setReset((n) => n + 1);
        }}
      >
        Clear boundary and redraw
      </button>
      {message ? (
        <p role="status" className="text-sm text-muted">
          {message}
        </p>
      ) : null}
    </div>
  );
}
