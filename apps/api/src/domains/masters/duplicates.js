import { ApiError } from "../../core/errors.js";
import { requireAnyCapability } from "./places.js";
import { scopeFilterForActor } from "../org/scope.js";

/** SP-0162 shared duplicate rules. Single source:
 * packages/domain-contracts/fixtures/mobile-v1/census-duplicates.json (Android and iOS
 * implement the same rules; every vector is checked in test/census-duplicates.test.js). */
export const STOPWORDS = new Set([
  "and",
  "co",
  "corp",
  "enterprise",
  "enterprises",
  "general",
  "groceries",
  "grocery",
  "inc",
  "mart",
  "merchandise",
  "mini",
  "minimart",
  "ng",
  "sari",
  "sarisari",
  "shop",
  "store",
  "stores",
  "the",
  "trading",
]);
export const MAX_CANDIDATES = 10;
const EARTH_RADIUS_M = 6371008.8;

/** @param {string|null|undefined} name @returns {string[]} sorted token set */
export function nameTokens(name) {
  const words = String(name ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const kept = words.filter((w) => !STOPWORDS.has(w));
  return [...new Set(kept.length ? kept : words)].sort();
}

/** @param {string} a @param {string} b */
export function nameSimilarity(a, b) {
  const x = new Set(nameTokens(a)),
    y = new Set(nameTokens(b));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  const union = x.size + y.size - both;
  return Math.round((both / union) * 10000) / 10000;
}

/** @param {string|null|undefined} phone @returns {string|null} */
export function phoneKey(phone) {
  let digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("63"))
    digits = "0" + digits.slice(-10);
  return digits.length < 10 ? null : digits.slice(-10);
}

/** @param {any} v */
const num = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? null
    : Number(v);

/** Haversine in metres rounded to 0.1; null when either side lacks coordinates.
 * @param {number|null|undefined} lat1 @param {number|null|undefined} lng1 @param {number|null|undefined} lat2 @param {number|null|undefined} lng2 */
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const a = num(lat1),
    b = num(lng1),
    c = num(lat2),
    d = num(lng2);
  if (a === null || b === null || c === null || d === null) return null;
  const rad = Math.PI / 180;
  const dLat = (c - a) * rad,
    dLng = (d - b) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLng / 2) ** 2;
  const m = 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.round(m * 10) / 10;
}

/**
 * @typedef {{name:string, phone?:string|null, phones?:(string|null)[], latitude?:number|null, longitude?:number|null, placeId?:string|null}} Party
 * @param {Party} query @param {Party} existing
 */
export function evaluatePair(query, existing) {
  const distance = distanceMeters(
    query.latitude,
    query.longitude,
    existing.latitude,
    existing.longitude,
  );
  const similarity = nameSimilarity(query.name, existing.name);
  /** @type {string[]} */ const reasons = [];
  if (query.placeId && existing.placeId && query.placeId === existing.placeId)
    reasons.push("place");
  const qKey = phoneKey(query.phone);
  const keys = [existing.phone, ...(existing.phones ?? [])]
    .map(phoneKey)
    .filter(Boolean);
  if (qKey && keys.includes(qKey)) reasons.push("phone");
  if (distance !== null && distance <= 75) reasons.push("nearby");
  if (similarity >= 0.8 && (distance === null || distance <= 2000))
    reasons.push("name");
  let score = 0;
  if (reasons.includes("place")) score += 100;
  if (reasons.includes("phone")) score += 90;
  if (reasons.includes("nearby"))
    score += /** @type {number} */ (distance) <= 25 ? 80 : 60;
  if (reasons.includes("name")) score += Math.round(30 * similarity);
  return {
    isCandidate: reasons.length > 0,
    reasons,
    distanceMeters: distance,
    nameSimilarity: similarity,
    score,
  };
}

/** Sort by score desc, distance asc (unknown last), then name; at most 10.
 * @template {{score:number, distanceMeters:number|null, name:string}} T @param {T[]} list */
export function rankCandidates(list) {
  const sorted = [...list].sort(
    (a, b) =>
      b.score - a.score ||
      (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return {
    candidates: sorted.slice(0, MAX_CANDIDATES),
    truncated: sorted.length > MAX_CANDIDATES,
  };
}

/** ~2.1 km bounding box prefilter (wider than every distance rule). */
const BOX_M = 2100;

/**
 * Candidates from the caller's scope: active outlets (current verified pin, contact phones)
 * and census captures not yet reviewed.
 * @param {any} ctx @param {{name:string, phone?:string|null, latitude?:number|null, longitude?:number|null, placeId?:string|null, excludeCaptureId?:string|null}} q
 * @param {string[]|null} unitIds null = national scope
 */
export async function findDuplicates(ctx, q, unitIds) {
  const db = ctx.db;
  const lat = num(q.latitude),
    lng = num(q.longitude);
  const hasPoint = lat !== null && lng !== null;
  const dLat = BOX_M / 111320;
  const dLng = hasPoint
    ? BOX_M / (111320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)))
    : 0;
  const key = phoneKey(q.phone);
  const tokens = nameTokens(q.name);
  const nationwide = unitIds === null;
  const units = db.array(unitIds ?? [], "TEXT");
  // Name-only matches have no distance limit when the query has no point, so the
  // name prefilter is a token overlap; the rule itself is applied in JS below.
  const tokenPattern = tokens.length
    ? `(${tokens.map((t) => t.replace(/[^a-z0-9]/g, "")).join("|")})`
    : null;
  const outlets = await db`
    select o.id, o.code, o.name, o.address, o.place_id,
      p.latitude, p.longitude,
      coalesce((select array_agg(c.phone) from outlet_contacts c where c.outlet_id = o.id and c.phone is not null), '{}') phones
    from outlets o
    left join lateral (
      select latitude, longitude from outlet_pins
      where outlet_id = o.id and status = 'verified' and deleted_at is null
        and effective_from <= now() and (effective_to is null or effective_to > now())
      order by effective_from desc limit 1
    ) p on true
    where o.status = 'active' and o.deleted_at is null
      and (${nationwide} or o.custodian_org_unit_id::text = any(${units}))
      and (
        (${hasPoint} and p.latitude between ${(lat ?? 0) - dLat} and ${(lat ?? 0) + dLat}
          and p.longitude between ${(lng ?? 0) - dLng} and ${(lng ?? 0) + dLng})
        or (${q.placeId ?? null}::text is not null and o.place_id = ${q.placeId ?? null})
        or (${key}::text is not null and exists (select 1 from outlet_contacts c where c.outlet_id = o.id
              and right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = ${key}))
        or (${tokenPattern}::text is not null and (not ${hasPoint} or p.latitude is null)
              and lower(o.name) ~ ${tokenPattern})
      )
    limit 2000`;
  const captures = await db`
    select c.id, c.name, c.address, c.place_id, c.latitude, c.longitude, c.owner_phone
    from census_captures c join census_batches b on b.id = c.batch_id
    left join census_reviews r on r.capture_id = c.id
    where r.id is null
      and (${q.excludeCaptureId ?? null}::uuid is null or c.id <> ${q.excludeCaptureId ?? null}::uuid)
      and (${nationwide} or b.org_unit_id::text = any(${units}))
      and (
        (${hasPoint} and c.latitude between ${(lat ?? 0) - dLat} and ${(lat ?? 0) + dLat}
          and c.longitude between ${(lng ?? 0) - dLng} and ${(lng ?? 0) + dLng})
        or (${q.placeId ?? null}::text is not null and c.place_id = ${q.placeId ?? null})
        or (${key}::text is not null and right(regexp_replace(c.owner_phone, '\\D', '', 'g'), 10) = ${key})
        or (${tokenPattern}::text is not null and not ${hasPoint} and lower(c.name) ~ ${tokenPattern})
      )
    limit 2000`;
  const query = {
    name: q.name,
    phone: q.phone ?? null,
    latitude: lat,
    longitude: lng,
    placeId: q.placeId ?? null,
  };
  const found = [];
  for (const o of outlets) {
    const e = evaluatePair(query, {
      name: o.name,
      phones: o.phones ?? [],
      latitude: o.latitude,
      longitude: o.longitude,
      placeId: o.place_id,
    });
    if (e.isCandidate)
      found.push({
        kind: "outlet",
        id: o.id,
        code: o.code,
        name: o.name,
        address: o.address ?? "",
        latitude: num(o.latitude),
        longitude: num(o.longitude),
        distanceMeters: e.distanceMeters,
        reasons: e.reasons,
        score: e.score,
      });
  }
  for (const c of captures) {
    const e = evaluatePair(query, {
      name: c.name,
      phone: c.owner_phone,
      latitude: c.latitude,
      longitude: c.longitude,
      placeId: c.place_id,
    });
    if (e.isCandidate)
      found.push({
        kind: "capture",
        id: c.id,
        code: null,
        name: c.name,
        address: c.address,
        latitude: num(c.latitude),
        longitude: num(c.longitude),
        distanceMeters: e.distanceMeters,
        reasons: e.reasons,
        score: e.score,
      });
  }
  const ranked = rankCandidates(found);
  return {
    candidates: ranked.candidates,
    truncated:
      ranked.truncated || outlets.length >= 2000 || captures.length >= 2000,
  };
}

/** @param {any} b */
export function readDuplicateQuery(b) {
  if (!b || typeof b !== "object" || Array.isArray(b))
    throw new ApiError("invalid_request", 400, "Enter a store name.");
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 200)
    throw new ApiError("invalid_request", 400, "Enter a store name.");
  const lat = num(b.latitude),
    lng = num(b.longitude);
  if ((lat === null) !== (lng === null))
    throw new ApiError(
      "invalid_request",
      400,
      "Send both latitude and longitude.",
    );
  if (
    lat !== null &&
    (Math.abs(lat) > 90 || Math.abs(/** @type {number} */ (lng)) > 180)
  )
    throw new ApiError("invalid_request", 400, "That location is not valid.");
  const text = (/** @type {any} */ v, max = 200) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
  const exclude = text(b.excludeCaptureId, 40);
  if (exclude && !/^[0-9a-f-]{36}$/i.test(exclude))
    throw new ApiError("invalid_request", 400, "That capture is not valid.");
  return {
    name,
    phone: text(b.phone, 40),
    latitude: lat,
    longitude: lng,
    placeId: text(b.placeId, 300),
    excludeCaptureId: exclude,
  };
}

/** POST /api/v1/masters/census/duplicate-check @param {any} ctx */
export async function duplicateCheck(ctx) {
  const actor = await requireAnyCapability(ctx);
  const q = readDuplicateQuery(ctx.body);
  const { unitIds } = await scopeFilterForActor(ctx.db, actor);
  return findDuplicates(ctx, q, unitIds);
}
