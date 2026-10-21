/** Lazy so pure scalar/UUID imports also run in the isolated native scheme interpreter. */
/** @type {TextEncoder|undefined} */ let encoder;

/** @param {string|Uint8Array|ArrayBuffer} data */
export function sha256Hex(data) {
  const h = new Bun.CryptoHasher("sha256");
  h.update(
    typeof data === "string" ? data : new Uint8Array(/** @type {any} */ (data)),
  );
  return h.digest("hex");
}

/** @param {Uint8Array} bytes */
export function b64url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** @param {string} text */
export function unb64url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("encoding");
  return new Uint8Array(
    Buffer.from(text.replaceAll("-", "+").replaceAll("_", "/"), "base64"),
  );
}

/** Opaque random token with a type prefix (`sps_` session, `spa_` access, `spu_` upload). @param {string} prefix */
export function randomToken(prefix) {
  return `${prefix}${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** Canonical JSON: sorted object keys, no whitespace. @param {unknown} value @returns {string} */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = /** @type {Record<string, unknown>} */ (value);
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/** Constant-time string compare. @param {string} a @param {string} b */
export function safeEqual(a, b) {
  const enc = (encoder ??= new TextEncoder());
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++)
    diff |= /** @type {number} */ (x[i]) ^ /** @type {number} */ (y[i]);
  return diff === 0;
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;

/** @param {unknown} v @returns {v is string} */
export const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

/** @param {unknown} v @returns {v is Record<string, unknown>} */
export const isPlainObject = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v);
