import { ApiError, unauthenticated, forbidden } from "../../core/errors.js";
import { roleHas } from "../../core/capabilities.js";
import { takeOrThrow } from "../../core/rate.js";

/** SP-0162 Google address search proxy (legacy Place Autocomplete / Details / Geocoding).
 * Phones and the office web call these with their normal session; the key never leaves
 * the server. Responses and logs never contain the Google URL, key or raw Google body. */
const BASE = "https://maps.googleapis.com/maps/api";
export const PLACES_TIMEOUT_MS = 5000;
export const PLACES_POLICY = { limit: 60, windowMs: 60_000 };
const CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 5000;
const CAPS = ["outlet.enrol.propose", "outlet.manage", "outlet.verify"];

/** @typedef {(url: string, init?: any) => Promise<Response>} FetchLike */
/** @type {FetchLike} */
let placesFetch = (url, init) => fetch(url, init);
/** Test seam: inject a fetch stub. Pass null to restore the real fetch. @param {any} f */
export function setPlacesFetch(f) {
  placesFetch = f ?? ((url, init) => fetch(url, init));
  cache.clear();
}
/** @type {Map<string,{at:number,value:any}>} */
const cache = new Map();

/** Any one of outlet.enrol.propose, outlet.manage, outlet.verify. @param {any} ctx */
export async function requireAnyCapability(ctx) {
  const actor = ctx.actor;
  if (!actor) throw unauthenticated();
  if (!CAPS.some((c) => roleHas(actor.role, c)))
    throw forbidden("Insufficient permission");
  return actor;
}

/** @param {any} env */
export const placesConfigured = (env) =>
  Boolean((env ?? process.env).GOOGLE_MAPS_SERVER_KEY?.trim());

export class PlacesUnavailable extends ApiError {
  /** @param {boolean} [notSetUp] */
  constructor(notSetUp = false) {
    super(
      "places_unavailable",
      notSetUp ? 503 : 502,
      notSetUp
        ? "Address search is not set up."
        : "Address search is not available right now.",
      !notSetUp,
    );
  }
}

/** @param {any} env @param {string} path @param {Record<string,string>} params */
async function google(env, path, params) {
  const key = (env ?? process.env).GOOGLE_MAPS_SERVER_KEY?.trim();
  if (!key) throw new PlacesUnavailable(true);
  const url = `${BASE}/${path}?${new URLSearchParams({ ...params, key })}`;
  let body;
  try {
    const res = await placesFetch(url, {
      signal: AbortSignal.timeout(PLACES_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error("http");
    body = await res.json();
  } catch {
    // Never log or forward the URL (it carries the key) or the provider body.
    throw new PlacesUnavailable();
  }
  const status = body?.status;
  if (status === "OK") return body;
  if (status === "ZERO_RESULTS" || status === "NOT_FOUND") return null;
  throw new PlacesUnavailable();
}

/** @param {string} k @param {() => Promise<any>} load */
async function cached(k, load) {
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await load();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value ?? "");
  cache.set(k, { at: Date.now(), value });
  return value;
}

/** @param {any[]} parts */
export function addressComponents(parts) {
  /** @param {string} type */
  const find = (type) =>
    (parts ?? []).find((/** @type {any} */ p) => p.types?.includes(type))
      ?.long_name ?? null;
  const street =
    [find("street_number"), find("route")].filter(Boolean).join(" ") || null;
  return {
    street,
    barangay: find("sublocality_level_1") ?? find("neighborhood"),
    city: find("locality") ?? find("administrative_area_level_3"),
    province: find("administrative_area_level_2"),
    region: find("administrative_area_level_1"),
    postalCode: find("postal_code"),
  };
}

/** @param {any} v @param {number} min @param {number} max */
function coordinate(v, min, max) {
  const n = Number(v);
  if (v === null || v === "" || !Number.isFinite(n) || n < min || n > max)
    throw new ApiError("invalid_request", 400, "That location is not valid.");
  return n;
}
const SESSION = /^[0-9a-f-]{8,64}$/i;

/** @param {any} env @param {string} placeId @param {string} [session] */
export async function placeDetails(env, placeId, session) {
  return cached(`d:${placeId}`, async () => {
    const body = await google(env, "place/details/json", {
      place_id: placeId,
      fields: "formatted_address,geometry,address_component,place_id",
      language: "en",
      ...(session ? { sessiontoken: session } : {}),
    });
    const r = body?.result;
    const loc = r?.geometry?.location;
    if (!r || !Number.isFinite(loc?.lat) || !Number.isFinite(loc?.lng))
      return null;
    return {
      placeId: r.place_id ?? placeId,
      formattedAddress: r.formatted_address ?? "",
      latitude: loc.lat,
      longitude: loc.lng,
      components: addressComponents(r.address_components),
    };
  });
}

/** @param {any} ctx */
async function gate(ctx) {
  const actor = await requireAnyCapability(ctx);
  if (!placesConfigured(ctx.env)) throw new PlacesUnavailable(true);
  await takeOrThrow(
    ctx.db,
    `places:${actor.subject ?? actor.userId}`,
    PLACES_POLICY,
  );
  return actor;
}

/** GET /api/v1/places/autocomplete @param {any} ctx */
export async function autocomplete(ctx) {
  await gate(ctx);
  const q = ctx.url.searchParams;
  const input = (q.get("input") ?? "").trim();
  if (input.length < 3 || input.length > 120)
    throw new ApiError("invalid_request", 400, "Type 3 to 120 characters.");
  const session = q.get("session") ?? "";
  if (!SESSION.test(session))
    throw new ApiError("invalid_request", 400, "Start a new address search.");
  /** @type {Record<string,string>} */
  const params = {
    input,
    sessiontoken: session,
    components: "country:ph",
    language: "en",
  };
  if (q.get("lat") !== null || q.get("lng") !== null) {
    const lat = coordinate(q.get("lat"), -90, 90),
      lng = coordinate(q.get("lng"), -180, 180);
    params.location = `${lat},${lng}`;
    params.radius = "20000";
  }
  const body = await google(ctx.env, "place/autocomplete/json", params);
  return {
    predictions: (body?.predictions ?? [])
      .slice(0, 5)
      .map((/** @type {any} */ p) => ({
        placeId: String(p.place_id ?? ""),
        primary: String(
          p.structured_formatting?.main_text ?? p.description ?? "",
        ),
        secondary: String(p.structured_formatting?.secondary_text ?? ""),
        description: String(p.description ?? ""),
      })),
  };
}

/** GET /api/v1/places/details @param {any} ctx */
export async function details(ctx) {
  await gate(ctx);
  const q = ctx.url.searchParams;
  const placeId = (q.get("placeId") ?? "").trim();
  if (!placeId || placeId.length > 300 || /[\s\u0000-\u001f]/.test(placeId))
    throw new ApiError(
      "invalid_request",
      400,
      "Choose an address from the list.",
    );
  const session = q.get("session") ?? "";
  if (session && !SESSION.test(session))
    throw new ApiError("invalid_request", 400, "Start a new address search.");
  const found = await placeDetails(ctx.env, placeId, session || undefined);
  if (!found)
    throw new ApiError("not_found", 404, "We could not find that address.");
  return found;
}

/** GET /api/v1/places/reverse @param {any} ctx */
export async function reverse(ctx) {
  await gate(ctx);
  const q = ctx.url.searchParams;
  const lat = coordinate(q.get("lat"), -90, 90),
    lng = coordinate(q.get("lng"), -180, 180);
  // Cache on ~1 m grid so nearby repeat fixes reuse one lookup.
  const k = `r:${lat.toFixed(5)},${lng.toFixed(5)}`;
  const found = await cached(k, async () => {
    const body = await google(ctx.env, "geocode/json", {
      latlng: `${lat},${lng}`,
      language: "en",
    });
    const r = (body?.results ?? []).find(
      (/** @type {any} */ x) => !x.types?.includes("plus_code"),
    );
    if (!r) return null;
    return {
      formattedAddress: r.formatted_address ?? "",
      components: addressComponents(r.address_components),
    };
  });
  if (!found) throw new ApiError("not_found", 404, "No address found here.");
  return found;
}
