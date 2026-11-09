/** SP-0162 store gathering: shared shapes and plain-word helpers for the office screens. */

export type AddressParts = {
  street?: string | null;
  barangay?: string | null;
  city?: string | null;
  province?: string | null;
  region?: string | null;
  postalCode?: string | null;
};

export type DuplicateReason = "place" | "phone" | "nearby" | "name";

export type Candidate = {
  kind: "outlet" | "capture";
  id: string;
  code: string | null;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  distanceMeters: number | null;
  reasons: DuplicateReason[];
  score: number;
};

export type LocationStatus = "pending" | "verified" | "mismatch";
export type PinChoice = "device" | "place";

/** Why Approve is not possible yet, or null when it is. Pending: still checking the
 * searched address. Mismatch: the reviewer must pick which pin is right. */
export function approveBlock(
  c: Pick<Capture, "location_status">,
  pinChoice: PinChoice | null,
): string | null {
  if (c.location_status === "pending") return "Checking the address…";
  if (c.location_status === "mismatch" && !pinChoice)
    return "Choose which pin is right before approving.";
  return null;
}

/** Great-circle distance in metres (same radius as the server rules). */
export function metersBetween(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const r = (x: number) => (x * Math.PI) / 180;
  const a =
    Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export type Capture = {
  id: string;
  name: string;
  address: string;
  accuracy_meters: number | null;
  captured_at: string;
  owner_name: string;
  owner_phone: string;
  estimated_class: string;
  agent: string;
  batch: string;
  latitude: number;
  longitude: number;
  location_source: "gps" | "places";
  /** Address-search pins are checked against Google after sync (SP-0162). */
  location_status?: LocationStatus;
  device_latitude?: number | null;
  device_longitude?: number | null;
  place_latitude?: number | null;
  place_longitude?: number | null;
  formatted_address: string | null;
  address_components: AddressParts | null;
  landmark: string | null;
  duplicate_flag: boolean;
  duplicate_candidates: Candidate[];
  acknowledged_duplicate_ids: string[];
  channel: string | null;
  subchannel: string | null;
  /** "change" = field Edit store: a change to an existing store (old -> new per field). */
  kind?: "new" | "change";
  target?: { id: string; code: string | null; name: string | null } | null;
  changes?: StoreChange[];
  has_photo?: boolean;
};

export type StoreChange = {
  field: string;
  label: string;
  old: string | null;
  new: string | null;
};

export function isChange(c: Pick<Capture, "kind">): boolean {
  return c.kind === "change";
}

/** Old -> new in plain words; an empty side reads "Not set". */
export function changeLine(c: StoreChange): string {
  return `${c.old ?? "Not set"} → ${c.new ?? "Not set"}`;
}

export type Batch = {
  id: string;
  name: string;
  expected_outlets: number;
  accepted: number;
  pending: number;
  coveragePct: number;
  targetPct: number;
};

export type Queue = { batches: Batch[]; rows: Capture[]; truncated: boolean };

export type Prediction = {
  placeId: string;
  primary: string;
  secondary: string;
  description: string;
};

export type PlaceDetails = {
  placeId: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
  components: AddressParts;
};

export type MapPoint = {
  id: string;
  latitude: number;
  longitude: number;
  label: string;
};

const REASON_WORDS: Record<DuplicateReason, string> = {
  place: "Same place on Google",
  phone: "Same phone number",
  nearby: "Very close by",
  name: "Same name nearby",
};

export function reasonWords(reasons: readonly DuplicateReason[]): string {
  return reasons.map((r) => REASON_WORDS[r] ?? r).join(" · ");
}

export function formatDistance(meters: number | null): string {
  if (meters === null || !Number.isFinite(meters)) return "Distance unknown";
  if (meters < 1) return "Same spot";
  if (meters < 1000) return `${Math.round(meters)} m away`;
  return `${(meters / 1000).toFixed(1)} km away`;
}

export function sourceBadge(c: {
  location_source: "gps" | "places";
  accuracy_meters: number | null;
}): string {
  if (c.location_source === "places") return "Address search";
  return c.accuracy_meters === null
    ? "GPS"
    : `GPS ±${Math.round(c.accuracy_meters)} m`;
}

export function addressLine(parts: AddressParts | null | undefined): string {
  if (!parts) return "";
  return [
    parts.street,
    parts.barangay,
    parts.city,
    parts.province,
    parts.postalCode,
  ]
    .filter((p) => typeof p === "string" && p.trim())
    .join(", ");
}

export function coverageLine(located: number, total: number): string {
  if (total === 0) return "No stores yet";
  const pct = Math.round((100 * located) / total);
  return `${located.toLocaleString("en-PH")} of ${total.toLocaleString("en-PH")} stores have a verified location (${pct}%)`;
}

/** Stored (at capture time) and live candidates, deduped by id; live wins. */
export function mergeCandidates(
  stored: readonly Candidate[],
  live: readonly Candidate[],
): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const c of stored) byId.set(c.id, c);
  for (const c of live) byId.set(c.id, c);
  return [...byId.values()].sort(
    (a, b) =>
      b.score - a.score ||
      (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity) ||
      a.name.localeCompare(b.name),
  );
}

export function capturedWhen(iso: string, now = Date.now()): string {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "";
  const minutes = Math.round((now - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    timeZone: "Asia/Manila",
  });
}

export function candidatePoints(list: readonly Candidate[]): MapPoint[] {
  return list
    .filter((c) => c.latitude !== null && c.longitude !== null)
    .map((c) => ({
      id: c.id,
      latitude: c.latitude as number,
      longitude: c.longitude as number,
      label: `${c.name} · ${formatDistance(c.distanceMeters)}`,
    }));
}
