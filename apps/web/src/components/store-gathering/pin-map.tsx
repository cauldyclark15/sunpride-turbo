"use client";

import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import type { MapPoint } from "./model";

/**
 * Small store map (SP-0162): one main pin (optionally draggable) and nearby candidate
 * stores. Google Maps JS when NEXT_PUBLIC_GOOGLE_MAPS_KEY is set, Leaflet + OSM otherwise
 * or when Google fails to load. Mount through next/dynamic with ssr: false.
 */
export type PinMapProps = {
  pin: { latitude: number; longitude: number } | null;
  others?: MapPoint[];
  draggable?: boolean;
  onMove?: (at: { latitude: number; longitude: number }) => void;
  label?: string;
  googleKey?: string;
};

type Engine = {
  draw(pin: PinMapProps["pin"], others: MapPoint[]): void;
  destroy(): void;
};

const CEBU = { latitude: 10.3157, longitude: 123.8854 };
const PIN = "#111827";
const OTHER = "#d97706";
let googleConfigured = false;

function dot(color: string, size: number) {
  return `<span style="display:block;width:${size}px;height:${size}px;border-radius:9999px;background:${color};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)"></span>`;
}

async function leafletEngine(
  node: HTMLElement,
  props: () => PinMapProps,
  alive: () => boolean,
): Promise<Engine | null> {
  const L = await import("leaflet");
  if (!alive()) return null;
  const map = L.map(node).setView([CEBU.latitude, CEBU.longitude], 13);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  return {
    draw(pin, others) {
      layer.clearLayers();
      for (const o of others)
        L.marker([o.latitude, o.longitude], {
          icon: L.divIcon({ className: "", html: dot(OTHER, 14) }),
          keyboard: false,
        })
          .bindTooltip(o.label)
          .addTo(layer);
      if (pin) {
        const m = L.marker([pin.latitude, pin.longitude], {
          icon: L.divIcon({ className: "", html: dot(PIN, 20) }),
          draggable: Boolean(props().draggable),
          title: props().label ?? "Store location",
          zIndexOffset: 1000,
        }).addTo(layer);
        m.on("dragend", () => {
          const at = m.getLatLng();
          props().onMove?.({ latitude: at.lat, longitude: at.lng });
        });
        const points = [
          [pin.latitude, pin.longitude],
          ...others.map((o) => [o.latitude, o.longitude]),
        ] as [number, number][];
        if (points.length > 1)
          map.fitBounds(L.latLngBounds(points), {
            padding: [32, 32],
            maxZoom: 18,
          });
        else map.setView([pin.latitude, pin.longitude], 17);
      }
    },
    destroy() {
      map.remove();
    },
  };
}

async function googleEngine(
  node: HTMLElement,
  key: string,
  props: () => PinMapProps,
  alive: () => boolean,
): Promise<Engine | null> {
  const { setOptions, importLibrary } =
    await import("@googlemaps/js-api-loader");
  if (!googleConfigured) {
    setOptions({ key, v: "weekly" });
    googleConfigured = true;
  }
  const { Map } = await importLibrary("maps");
  const { LatLngBounds } = await importLibrary("core");
  const { AdvancedMarkerElement } = await importLibrary("marker");
  if (!alive()) return null;
  const map = new Map(node, {
    center: { lat: CEBU.latitude, lng: CEBU.longitude },
    zoom: 13,
    mapId: process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID",
    streetViewControl: false,
    mapTypeControl: false,
  });
  let drawn: google.maps.marker.AdvancedMarkerElement[] = [];
  const el = (html: string) => {
    const w = document.createElement("div");
    w.innerHTML = html;
    return w.firstElementChild as HTMLElement;
  };
  return {
    draw(pin, others) {
      for (const m of drawn) m.map = null;
      drawn = [];
      for (const o of others)
        drawn.push(
          new AdvancedMarkerElement({
            map,
            position: { lat: o.latitude, lng: o.longitude },
            content: el(dot(OTHER, 14)),
            title: o.label,
          }),
        );
      if (pin) {
        const m = new AdvancedMarkerElement({
          map,
          position: { lat: pin.latitude, lng: pin.longitude },
          content: el(dot(PIN, 20)),
          title: props().label ?? "Store location",
          gmpDraggable: Boolean(props().draggable),
          zIndex: 1000,
        });
        m.addListener("dragend", () => {
          const at = m.position;
          if (!at) return;
          const live = at as google.maps.LatLng;
          const plain = at as google.maps.LatLngLiteral;
          props().onMove?.(
            typeof live.lat === "function"
              ? { latitude: live.lat(), longitude: live.lng() }
              : { latitude: plain.lat, longitude: plain.lng },
          );
        });
        drawn.push(m);
        if (others.length) {
          const bounds = new LatLngBounds();
          bounds.extend({ lat: pin.latitude, lng: pin.longitude });
          for (const o of others)
            bounds.extend({ lat: o.latitude, lng: o.longitude });
          map.fitBounds(bounds, 32);
        } else {
          map.setCenter({ lat: pin.latitude, lng: pin.longitude });
          map.setZoom(17);
        }
      }
    },
    destroy() {
      for (const m of drawn) m.map = null;
    },
  };
}

export function PinMap(props: PinMapProps) {
  const node = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const latest = useRef(props);
  const [kind, setKind] = useState<"google" | "osm">(
    props.googleKey ? "google" : "osm",
  );
  const [ready, setReady] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    latest.current = props;
  });
  useEffect(() => {
    if (!node.current) return;
    let disposed = false;
    const alive = () => !disposed;
    const get = () => latest.current;
    const start =
      kind === "google" && latest.current.googleKey
        ? googleEngine(node.current, latest.current.googleKey, get, alive)
        : leafletEngine(node.current, get, alive);
    start
      .then((made) => {
        if (!made) return;
        if (disposed) return made.destroy();
        engine.current = made;
        setReady((n) => n + 1);
      })
      .catch(() => {
        if (disposed) return;
        if (kind === "google") {
          setNotice("Google Maps unavailable; showing OpenStreetMap.");
          setKind("osm");
        } else setNotice("Map unavailable.");
      });
    return () => {
      disposed = true;
      engine.current?.destroy();
      engine.current = null;
    };
  }, [kind]);
  const pinKey = props.pin
    ? `${props.pin.latitude.toFixed(6)},${props.pin.longitude.toFixed(6)}`
    : "none";
  const othersKey = (props.others ?? []).map((o) => o.id).join("|");
  useEffect(() => {
    engine.current?.draw(latest.current.pin, latest.current.others ?? []);
  }, [pinKey, othersKey, ready]);
  return (
    <div className="grid gap-1">
      <div
        ref={node}
        aria-label={props.label ?? "Store location map"}
        className="h-72 overflow-hidden rounded-xl border border-border"
      />
      {notice ? (
        <p role="status" className="text-[13px] text-muted">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
