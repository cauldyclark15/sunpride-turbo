"use client";

import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import {
  createGoogleEngine,
  createLeafletEngine,
  type MapEngine,
  type MapLayers,
} from "./map-engines";
import type { LatLng, LivePosition } from "./live-map-model";

/**
 * Client-only map canvas (mounted through next/dynamic with ssr: false). Google Maps when a
 * key is configured, otherwise — or if Google fails to load — Leaflet with OpenStreetMap.
 */
export function LiveMapCanvas({
  provider,
  googleKey,
  googleMapId,
  layers,
  fitPoints,
  fitKey,
  onSelect,
}: {
  provider: "google" | "osm";
  googleKey?: string;
  googleMapId?: string;
  layers: MapLayers;
  /** Points to fit when `fitKey` changes (first data, a new trail, a filter change). */
  fitPoints: LatLng[];
  fitKey: string;
  onSelect: (position: LivePosition) => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const engine = useRef<MapEngine | null>(null);
  const select = useRef(onSelect);
  const latest = useRef({ layers, fitPoints });
  const [ready, setReady] = useState(0);
  // Leaflet carries the OpenStreetMap attribution inside the map itself.
  const [engineKind, setEngineKind] = useState(provider);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    select.current = onSelect;
    latest.current = { layers, fitPoints };
  });
  useEffect(() => {
    if (!node.current) return;
    let disposed = false;
    const handlers = {
      onSelect: (p: LivePosition) => select.current(p),
      alive: () => !disposed,
    };
    const leaflet = () =>
      createLeafletEngine(node.current!, handlers, () =>
        setNotice("Map tiles unavailable. List below."),
      );
    const start =
      engineKind === "google" && googleKey
        ? createGoogleEngine(node.current, googleKey, googleMapId, handlers)
        : leaflet();
    start
      .then((created) => {
        if (!created) return;
        if (disposed) return created.destroy();
        engine.current = created;
        setReady((n) => n + 1);
      })
      .catch(() => {
        if (disposed) return;
        if (engineKind === "google") {
          setNotice("Google Maps unavailable; showing OpenStreetMap.");
          setEngineKind("osm");
        } else setNotice("Map unavailable. List below.");
      });
    return () => {
      disposed = true;
      engine.current?.destroy();
      engine.current = null;
    };
  }, [engineKind, googleKey, googleMapId]);
  useEffect(() => {
    engine.current?.render(layers);
  }, [layers, ready]);
  useEffect(() => {
    engine.current?.fit(latest.current.fitPoints);
  }, [fitKey, ready]);
  return (
    <div className="grid gap-2">
      <div
        ref={node}
        aria-label="Live map"
        className="h-[520px] overflow-hidden rounded-xl border border-border"
      />
      {notice ? (
        <p role="status" className="text-[13px] text-muted">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
