import { ApiError } from "../../core/errors.js";
import { requireAnyCapability, PLACES_POLICY } from "./places.js";
import { takeOrThrow } from "../../core/rate.js";
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

/** SP-0175: the name with case, accents, punctuation and spaces removed, stop words dropped
 * (words kept in order). `all` keeps the stop words. @param {string|null|undefined} name */
export function compactName(name, all = false) {
  const words = String(name ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const kept = all ? words : words.filter((w) => !STOPWORDS.has(w));
  return (kept.length ? kept : words).join("");
}

/** Levenshtein distance, stopping early above `max`. @param {string} a @param {string} b @param {number} max */
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Typos allowed in a word of this length: none under 4 letters, 1 up to 7, 2 from 8. @param {number} n */
const typos = (n) => (n >= 8 ? 2 : n >= 4 ? 1 : 0);

/**
 * SP-0175: near-miss store names ("Aling Nina Store" ~ "Aling Nena Sari-sari", "alingnena" ~
 * "Aling Nena", "sari sari 1" ~ "Sari-sari 1"). Case, spaces, punctuation and common words
 * (store, sari-sari, mini mart…) are ignored and each word may carry a small typo.
 * @param {string} a @param {string} b */
export function nearName(a, b) {
  const fa = compactName(a, true),
    fb = compactName(b, true);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  const ca = compactName(a),
    cb = compactName(b);
  if (ca.length < 4 || cb.length < 4) return false;
  if (ca === cb) return true;
  if (editDistance(ca, cb, 2) <= typos(Math.min(ca.length, cb.length)))
    return true;
  const ta = nameTokens(a),
    tb = nameTokens(b);
  if (ta.length < 2 || ta.length !== tb.length) return false;
  const free = [...tb];
  for (const t of ta) {
    const i = free.findIndex(
      (u) => editDistance(t, u, 2) <= typos(Math.min(t.length, u.length)),
    );
    if (i < 0) return false;
    free.splice(i, 1);
  }
  return true;
}

/** Same place in words: barangay when both know it, else municipality, else unknown (true).
 * @param {{municipality?:string|null, barangay?:string|null}} q @param {{municipality?:string|null, barangay?:string|null}} e */
export function sameLocality(q, e) {
  const k = (/** @type {any} */ v) => compactName(v ?? "", true);
  if (k(q.barangay) && k(e.barangay)) {
    if (k(q.barangay) !== k(e.barangay)) return false;
    return !k(q.municipality) || !k(e.municipality)
      ? true
      : k(q.municipality) === k(e.municipality);
  }
  if (k(q.municipality) && k(e.municipality))
    return k(q.municipality) === k(e.municipality);
  return true;
}

/** SQL regex alternatives that find a near-miss name in a compacted (a-z0-9 only) name: each
 * word, the whole compact name, and one-letter substitutions of longer words. @param {string} name */
export function nearNamePattern(name) {
  /** @type {Set<string>} */ const alts = new Set();
  const compact = compactName(name);
  const words = nameTokens(name);
  for (const w of [...words, compact]) {
    if (!w) continue;
    alts.add(w);
    if (w.length >= 4 && w.length <= 30)
      for (let i = 0; i < w.length; i++) {
        alts.add(w.slice(0, i) + "." + w.slice(i + 1));
        alts.add(w.slice(0, i) + w.slice(i + 1));
      }
  }
  return alts.size ? `(${[...alts].join("|")})` : null;
}

/** SP-0175 office search: one regex per typed word, each tolerating one typo in words of 4+
 * letters; a name matches when every word matches its compacted (a-z0-9) form. Empty when
 * nothing searchable was typed. @param {string} text @returns {string[]} */
export function searchWordPatterns(text) {
  const words = [
    ...new Set(
      String(text ?? "")
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean),
    ),
  ].slice(0, 8);
  return words.map((w) => {
    /** @type {Set<string>} */ const alts = new Set([w]);
    if (w.length >= 4 && w.length <= 30)
      for (let i = 0; i <= w.length; i++) {
        if (i < w.length) {
          alts.add(w.slice(0, i) + "." + w.slice(i + 1));
          alts.add(w.slice(0, i) + w.slice(i + 1));
        }
        alts.add(w.slice(0, i) + "." + w.slice(i));
      }
    return `(${[...alts].join("|")})`;
  });
}

/** Near-miss name candidate: score just below a strong name match. */
const NEAR_NAME_SCORE = 24;

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

/** SP-0175: add the near-miss "name" reason on top of the shared (fixture-frozen) pair rule
 * when the names are near misses and the stores are close (2 km) or in the same barangay /
 * municipality (or that is unknown). The phone shows the reasons the server sends, so this
 * reaches the field app without a new APK.
 * @param {{name:string}} query @param {ReturnType<typeof evaluatePair>} e @param {string} name
 * @param {{municipality?:string|null, barangay?:string|null}} qPlace @param {{municipality?:string|null, barangay?:string|null}} ePlace */
export function withNearName(query, e, name, qPlace, ePlace) {
  if (e.reasons.includes("name")) return e;
  const close =
    e.distanceMeters === null
      ? sameLocality(qPlace, ePlace)
      : e.distanceMeters <= 2000;
  if (!close || !nearName(query.name, name)) return e;
  return {
    ...e,
    isCandidate: true,
    reasons: [...e.reasons, "name"],
    score: e.score + NEAR_NAME_SCORE,
  };
}

/** ~2.1 km bounding box prefilter (wider than every distance rule). */
const BOX_M = 2100;

/**
 * Candidates from the caller's scope: active outlets (current verified pin, contact phones)
 * and census captures not yet reviewed.
 * @param {any} ctx @param {{name:string, phone?:string|null, latitude?:number|null, longitude?:number|null, placeId?:string|null, excludeCaptureId?:string|null, municipality?:string|null, barangay?:string|null}} q
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
  // SP-0175: near-miss names (typos, joined words) on the compacted name.
  const nearPattern = nearNamePattern(q.name);
  const outlets = await db`
    select o.id, o.code, o.name, o.address, o.place_id,
      p.latitude, p.longitude, cp.municipality_name, cp.barangay_name,
      coalesce((select array_agg(c.phone) from outlet_contacts c where c.outlet_id = o.id and c.phone is not null), '{}')
        || array_remove(array[cp.mobile_no, cp.tel_no], null)
        || coalesce((select array_agg(st.mobile_no) from customer_ship_tos st where st.outlet_id = o.id and st.mobile_no is not null), '{}') phones
    from outlets o
    left join customer_profiles cp on cp.outlet_id = o.id and cp.deleted_at is null
    left join lateral (
      select latitude, longitude from outlet_pins
      where outlet_id = o.id and status = 'verified' and deleted_at is null
        and effective_from <= now() and (effective_to is null or effective_to > now())
      order by effective_from desc limit 1
    ) p on true
    where o.status in ('active', 'prospect') and o.deleted_at is null -- SP-0175: office prospects count too
      and (${nationwide} or o.custodian_org_unit_id::text = any(${units}))
      and (
        (${hasPoint} and p.latitude between ${(lat ?? 0) - dLat} and ${(lat ?? 0) + dLat}
          and p.longitude between ${(lng ?? 0) - dLng} and ${(lng ?? 0) + dLng})
        or (${q.placeId ?? null}::text is not null and o.place_id = ${q.placeId ?? null})
        or (${key}::text is not null and exists (select 1 from outlet_contacts c where c.outlet_id = o.id
              and right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = ${key}))
        or (${key}::text is not null and (right(regexp_replace(coalesce(cp.mobile_no, ''), '\\D', '', 'g'), 10) = ${key}
              or right(regexp_replace(coalesce(cp.tel_no, ''), '\\D', '', 'g'), 10) = ${key}
              or exists (select 1 from customer_ship_tos st where st.outlet_id = o.id
                and right(regexp_replace(st.mobile_no, '\\D', '', 'g'), 10) = ${key})))
        or (${tokenPattern}::text is not null and (not ${hasPoint} or p.latitude is null)
              and lower(o.name) ~ ${tokenPattern})
        or (${nearPattern}::text is not null and (not ${hasPoint} or p.latitude is null)
              and regexp_replace(lower(o.name), '[^a-z0-9]+', '', 'g') ~ ${nearPattern})
      )
    limit 2000`;
  const captures = await db`
    select c.id, c.name, c.address, c.place_id, c.latitude, c.longitude, c.owner_phone,
      c.address_components->>'city' as municipality_name, c.address_components->>'barangay' as barangay_name
    from census_captures c join census_batches b on b.id = c.batch_id
    left join census_reviews r on r.capture_id = c.id
    where r.id is null and c.kind = 'new'
      and (${q.excludeCaptureId ?? null}::uuid is null or c.id <> ${q.excludeCaptureId ?? null}::uuid)
      and (${nationwide} or b.org_unit_id::text = any(${units}))
      and (
        (${hasPoint} and c.latitude between ${(lat ?? 0) - dLat} and ${(lat ?? 0) + dLat}
          and c.longitude between ${(lng ?? 0) - dLng} and ${(lng ?? 0) + dLng})
        or (${q.placeId ?? null}::text is not null and c.place_id = ${q.placeId ?? null})
        or (${key}::text is not null and right(regexp_replace(c.owner_phone, '\\D', '', 'g'), 10) = ${key})
        or (${tokenPattern}::text is not null and not ${hasPoint} and lower(c.name) ~ ${tokenPattern})
        or (${nearPattern}::text is not null and not ${hasPoint} and regexp_replace(lower(c.name), '[^a-z0-9]+', '', 'g') ~ ${nearPattern})
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
  const place = { municipality: q.municipality, barangay: q.barangay };
  for (const o of outlets) {
    const e = withNearName(
      query,
      evaluatePair(query, {
        name: o.name,
        phones: o.phones ?? [],
        latitude: o.latitude,
        longitude: o.longitude,
        placeId: o.place_id,
      }),
      o.name,
      place,
      { municipality: o.municipality_name, barangay: o.barangay_name },
    );
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
    const e = withNearName(
      query,
      evaluatePair(query, {
        name: c.name,
        phone: c.owner_phone,
        latitude: c.latitude,
        longitude: c.longitude,
        placeId: c.place_id,
      }),
      c.name,
      place,
      { municipality: c.municipality_name, barangay: c.barangay_name },
    );
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
    municipality: text(b.municipality, 120),
    barangay: text(b.barangay, 120),
  };
}

/** POST /api/v1/masters/census/duplicate-check @param {any} ctx */
export async function duplicateCheck(ctx) {
  const actor = await requireAnyCapability(ctx);
  // Same per-person budget as the address search proxy (SP-0162 SF3).
  await takeOrThrow(
    ctx.db,
    `dupcheck:${actor.subject ?? actor.userId}`,
    PLACES_POLICY,
  );
  const q = readDuplicateQuery(ctx.body);
  const { unitIds } = await scopeFilterForActor(ctx.db, actor);
  return findDuplicates(ctx, q, unitIds);
}

/** Drop stored duplicate candidates the reader cannot see in their CURRENT scope
 * (SP-0162 B1). Outlets by custodian unit, captures by batch unit — the same rules the
 * live check uses. Returns the rows with `duplicate_candidates` filtered.
 * @param {any} db @param {any[]} rows @param {string[]|null} unitIds null = national */
export async function candidatesInScope(db, rows, unitIds) {
  if (unitIds === null) return rows;
  /** @type {Set<string>} */ const outletIds = new Set(),
    captureIds = new Set();
  for (const r of rows)
    for (const c of r.duplicate_candidates ?? [])
      (c?.kind === "outlet" ? outletIds : captureIds).add(String(c?.id));
  const units = db.array(unitIds, "TEXT");
  const visible = new Set(
    [
      ...(outletIds.size
        ? await db`select id from outlets where id::text = any(${db.array([...outletIds], "TEXT")}) and custodian_org_unit_id::text = any(${units})`
        : []),
      ...(captureIds.size
        ? await db`select c.id from census_captures c join census_batches b on b.id = c.batch_id where c.id::text = any(${db.array([...captureIds], "TEXT")}) and b.org_unit_id::text = any(${units})`
        : []),
    ].map((/** @type {any} */ r) => String(r.id)),
  );
  return rows.map((r) => ({
    ...r,
    duplicate_candidates: (r.duplicate_candidates ?? []).filter(
      (/** @type {any} */ c) => visible.has(String(c?.id)),
    ),
  }));
}
