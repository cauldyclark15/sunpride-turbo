// SP-0246: postal lists are suggestions, never an exhaustive validation authority.
/** @typedef {{code:string,area?:string|null}} PostalOption */
/** Match explicit area names only, not substrings (San Jose is not San Jose East).
 * @param {string} name */
const areaKey = (name) =>
  name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/^(?:barangay|brgy)\.?\s+/u, "")
    .replace(/[^a-z0-9]/g, "");

/** A town's only ZIP, or a unique exact barangay/area match. Never guess among alternatives.
 * @param {PostalOption[]} options @param {string|null|undefined} barangayName
 * @returns {string|null} */
export function suggestPostalCode(options, barangayName) {
  const valid = options.filter((o) => /^[0-9]{4}$/.test(o.code));
  const codes = [...new Set(valid.map((o) => o.code))];
  if (codes.length === 1) return codes[0] ?? null;
  const key = areaKey(barangayName ?? "");
  if (!key) return null;
  const matches = new Set(
    valid
      .filter((o) =>
        (o.area ?? "").split(/[/&+,;]/u).some((name) => areaKey(name) === key),
      )
      .map((o) => o.code),
  );
  return matches.size === 1 ? ([...matches][0] ?? null) : null;
}
