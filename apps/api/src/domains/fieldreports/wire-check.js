/** Test-only structural wire check. The shapes freeze the web's HTTP DTOs, not a mock response.
 * @param {any} s @param {any} value @param {string} [path] @returns {string|null}
 */
export function wireError(s, value, path = "$") {
  if (!s) return null;
  if (s.anyOf)
    return s.anyOf.some(
      (/** @type {any} */ branch) => wireError(branch, value, path) === null,
    )
      ? null
      : `${path}: no allowed shape (${s.anyOf.map((/** @type {any} */ b) => wireError(b, value, path)).join("; ")})`;
  if (Object.hasOwn(s, "const"))
    return s.const === value
      ? null
      : `${path}: expected ${JSON.stringify(s.const)}`;
  if (s.type === "null")
    return value === null ? null : path + ": expected null";
  if (s.type === "array") {
    if (!Array.isArray(value)) return path + ": expected array";
    for (const [i, v] of value.entries()) {
      const error = wireError(s.items, v, `${path}[${i}]`);
      if (error) return error;
    }
    return null;
  }
  if (s.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return path + ": expected object";
    for (const key of s.required ?? [])
      if (value[key] === undefined) return path + "." + key + ": required";
    for (const [k, v] of Object.entries(s.properties ?? {})) {
      if (value[k] === undefined && !(s.required ?? []).includes(k)) continue;
      const error = wireError(v, value[k], path + "." + k);
      if (error) return error;
    }
    return null;
  }
  return !s.type || typeof value === s.type
    ? null
    : `${path}: expected ${s.type}, received ${typeof value}`;
}
