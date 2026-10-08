import {
  clusterHtml,
  clusterPoints,
  DEFAULT_CENTER,
  markerHtml,
  positionMeta,
  STATUS_STYLE,
  stopHtml,
  stopLabel,
  storeHtml,
  type LatLng,
  type LivePosition,
  type StorePin,
  type Trail,
} from "./live-map-model";

/**
 * The two map engines behind the live map (SP-0135): Google Maps when
 * NEXT_PUBLIC_GOOGLE_MAPS_KEY is set, else Leaflet + OpenStreetMap (dev, tests, no key).
 * Both are created once and redrawn in place as the Convex subscription updates, so a
 * new ping moves a marker without rebuilding the map.
 */
export type MapLayers = {
  positions: LivePosition[];
  stores: StorePin[];
  trail: Trail | null;
  selectedId: string | null;
};
export type MapEngine = {
  render(layers: MapLayers): void;
  fit(points: LatLng[]): void;
  destroy(): void;
};
type Handlers = {
  onSelect: (position: LivePosition) => void;
  /** False once the canvas unmounted while the library was loading (React strict mode). */
  alive: () => boolean;
};

const CLUSTER_BELOW_ZOOM = 16;
const STORES_FROM_ZOOM = 11;
const TRAIL_COLOR = "#111827";
let googleConfigured = false;

function popupText(p: LivePosition) {
  return `${p.name} · ${STATUS_STYLE[p.status].label} · ${positionMeta(p)}`;
}

function element(html: string) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  return wrapper.firstElementChild as HTMLElement;
}

export async function createLeafletEngine(
  node: HTMLElement,
  handlers: Handlers,
  onTileError: () => void,
): Promise<MapEngine | null> {
  const L = await import("leaflet");
  if (!handlers.alive()) return null;
  const map = L.map(node).setView(
    [DEFAULT_CENTER.latitude, DEFAULT_CENTER.longitude],
    12,
  );
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  })
    .on("tileerror", onTileError)
    .addTo(map);
  const stores = L.layerGroup().addTo(map);
  const trail = L.layerGroup().addTo(map);
  const markers = L.layerGroup().addTo(map);
  let last: MapLayers | null = null;
  const draw = () => {
    if (!last) return;
    const layers = last;
    stores.clearLayers();
    trail.clearLayers();
    markers.clearLayers();
    const zoom = map.getZoom();
    if (zoom >= STORES_FROM_ZOOM)
      for (const store of layers.stores)
        L.marker([store.latitude, store.longitude], {
          icon: L.divIcon({ className: "", html: storeHtml(store.name) }),
          keyboard: false,
          zIndexOffset: -1000,
        })
          .bindTooltip(`${store.code} · ${store.name}`)
          .addTo(stores);
    if (layers.trail) {
      const path = layers.trail.pings.map(
        (p) => [p.latitude, p.longitude] as [number, number],
      );
      if (path.length > 1)
        L.polyline(path, {
          color: TRAIL_COLOR,
          weight: 3,
          opacity: 0.75,
        }).addTo(trail);
      layers.trail.stops.forEach((stop, index) => {
        if (stop.latitude === null || stop.longitude === null) return;
        L.marker([stop.latitude, stop.longitude], {
          icon: L.divIcon({ className: "", html: stopHtml(index + 1) }),
        })
          .bindTooltip(stopLabel(stop, index + 1))
          .addTo(trail);
      });
    }
    const groups =
      zoom >= CLUSTER_BELOW_ZOOM
        ? layers.positions.map((p) => ({ key: p.id, items: [p], ...p }))
        : clusterPoints(layers.positions, zoom);
    for (const group of groups) {
      if (group.items.length === 1) {
        const p = group.items[0]!;
        L.marker([p.latitude, p.longitude], {
          icon: L.divIcon({
            className: "",
            html: markerHtml(p, p.id === layers.selectedId),
          }),
          title: p.name,
          zIndexOffset: p.id === layers.selectedId ? 1000 : 0,
        })
          .bindTooltip(popupText(p))
          .on("click", () => handlers.onSelect(p))
          .addTo(markers);
      } else {
        L.marker([group.latitude, group.longitude], {
          icon: L.divIcon({
            className: "",
            html: clusterHtml(group.items.length),
          }),
          title: `${group.items.length} people and trucks`,
        })
          .on("click", () =>
            map.fitBounds(
              L.latLngBounds(group.items.map((p) => [p.latitude, p.longitude])),
              { padding: [48, 48], maxZoom: CLUSTER_BELOW_ZOOM },
            ),
          )
          .addTo(markers);
      }
    }
  };
  map.on("zoomend", draw);
  return {
    render(layers) {
      last = layers;
      draw();
    },
    fit(points) {
      if (!points.length) return;
      if (points.length === 1)
        map.setView([points[0]!.latitude, points[0]!.longitude], 15);
      else
        map.fitBounds(
          L.latLngBounds(points.map((p) => [p.latitude, p.longitude])),
          { padding: [32, 32], maxZoom: 15 },
        );
    },
    destroy() {
      map.remove();
    },
  };
}

export async function createGoogleEngine(
  node: HTMLElement,
  key: string,
  mapId: string | undefined,
  handlers: Handlers,
): Promise<MapEngine | null> {
  const { setOptions, importLibrary } =
    await import("@googlemaps/js-api-loader");
  // The loader accepts its options once per page.
  if (!googleConfigured) {
    setOptions({ key, v: "weekly" });
    googleConfigured = true;
  }
  const { Map, Polyline } = await importLibrary("maps");
  const { LatLngBounds } = await importLibrary("core");
  const { AdvancedMarkerElement } = await importLibrary("marker");
  if (!handlers.alive()) return null;
  const map = new Map(node, {
    center: { lat: DEFAULT_CENTER.latitude, lng: DEFAULT_CENTER.longitude },
    zoom: 12,
    // Advanced markers need a map ID; Google's demo ID works without cloud styling.
    mapId: mapId || "DEMO_MAP_ID",
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: true,
  });
  let drawn: google.maps.marker.AdvancedMarkerElement[] = [];
  let lines: google.maps.Polyline[] = [];
  let last: MapLayers | null = null;
  const marker = (
    at: LatLng,
    html: string,
    title: string,
    onClick?: () => void,
    zIndex = 0,
  ) => {
    const m = new AdvancedMarkerElement({
      map,
      position: { lat: at.latitude, lng: at.longitude },
      content: element(html),
      title,
      zIndex,
    });
    if (onClick) m.addListener("click", onClick);
    drawn.push(m);
  };
  const draw = () => {
    if (!last) return;
    const layers = last;
    for (const m of drawn) m.map = null;
    for (const line of lines) line.setMap(null);
    drawn = [];
    lines = [];
    const zoom = map.getZoom() ?? 12;
    if (zoom >= STORES_FROM_ZOOM)
      for (const store of layers.stores)
        marker(store, storeHtml(store.name), `${store.code} · ${store.name}`);
    if (layers.trail) {
      lines.push(
        new Polyline({
          map,
          path: layers.trail.pings.map((p) => ({
            lat: p.latitude,
            lng: p.longitude,
          })),
          strokeColor: TRAIL_COLOR,
          strokeOpacity: 0.75,
          strokeWeight: 3,
        }),
      );
      layers.trail.stops.forEach((stop, index) => {
        if (stop.latitude === null || stop.longitude === null) return;
        marker(
          { latitude: stop.latitude, longitude: stop.longitude },
          stopHtml(index + 1),
          stopLabel(stop, index + 1),
        );
      });
    }
    const groups =
      zoom >= CLUSTER_BELOW_ZOOM
        ? layers.positions.map((p) => ({ key: p.id, items: [p], ...p }))
        : clusterPoints(layers.positions, zoom);
    for (const group of groups) {
      if (group.items.length === 1) {
        const p = group.items[0]!;
        marker(
          p,
          markerHtml(p, p.id === layers.selectedId),
          popupText(p),
          () => handlers.onSelect(p),
          p.id === layers.selectedId ? 1000 : 10,
        );
      } else
        marker(
          group,
          clusterHtml(group.items.length),
          `${group.items.length} people and trucks`,
          () => {
            const bounds = new LatLngBounds();
            for (const p of group.items)
              bounds.extend({ lat: p.latitude, lng: p.longitude });
            map.fitBounds(bounds, 48);
          },
          500,
        );
    }
  };
  const listener = map.addListener("zoom_changed", draw);
  return {
    render(layers) {
      last = layers;
      draw();
    },
    fit(points) {
      if (!points.length) return;
      if (points.length === 1) {
        map.setCenter({ lat: points[0]!.latitude, lng: points[0]!.longitude });
        map.setZoom(15);
        return;
      }
      const bounds = new LatLngBounds();
      for (const p of points)
        bounds.extend({ lat: p.latitude, lng: p.longitude });
      map.fitBounds(bounds, 32);
    },
    destroy() {
      listener.remove();
      for (const m of drawn) m.map = null;
      for (const line of lines) line.setMap(null);
    },
  };
}
