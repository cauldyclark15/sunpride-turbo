// Store list search. Codes are typed many ways ("SMP-00069", "smp 69", "SMPOOO69", a pasted
// non-breaking hyphen), so each word matches name/owner/area/channel/address as text, and the
// store or customer code also as a compact code (no spaces/dashes, letter O read as zero,
// leading zeros of the number ignored).

const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D_]/g;

/** @param {unknown} v */
export function plain(v) {
  return String(v ?? "")
    .normalize("NFKC")
    .replace(DASHES, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Compact code form: letters + number without leading zeros, O read as 0 inside the number. */
/** @param {unknown} v */
export function compactCode(v) {
  const s = plain(v).replace(/[\s.\-/#]/g, "");
  const m = s.match(/^([a-z]*?)([0-9o]*[0-9][0-9o]*)$/);
  if (!m) return s;
  const n = m[2].replace(/o/g, "0").replace(/^0+(?=\d)/, "");
  return m[1] + n;
}

/**
 * Search relevance: 0 = the query is exactly this store's (or customer's) code, 1 = the name or
 * code starts with it, 2 = any other match. "SMP-O0001" also matches SMP-O0153 (compact codes
 * match by substring), so the exact store must sort first or Edit/open lands on the wrong row.
 * @param {{code?: string|null, customerCode?: string|null, name?: string|null}} row
 * @param {string} query
 */
export function storeRank(row, query) {
  const q = plain(query);
  if (!q) return 2;
  const whole = compactCode(q);
  const codes = [row.code, row.customerCode].filter(Boolean);
  if (codes.some((c) => plain(c) === q || compactCode(c) === whole)) return 0;
  if (
    plain(row.name).startsWith(q) ||
    codes.some((c) => compactCode(c).startsWith(whole))
  )
    return 1;
  return 2;
}

/**
 * @param {{code?: string|null, customerCode?: string|null, name?: string|null, territory?: string|null,
 *   channel?: string|null, address?: string|null, owner?: string|null}} row
 * @param {string} query
 */
export function storeMatches(row, query) {
  const q = plain(query);
  if (!q) return true;
  const text = plain(
    [
      row.code,
      row.customerCode,
      row.name,
      row.territory,
      row.channel,
      row.address,
      row.owner,
    ]
      .filter(Boolean)
      .join(" "),
  );
  if (text.includes(q)) return true;
  const codes = [row.code, row.customerCode].filter(Boolean).map(compactCode);
  const whole = compactCode(q);
  if (
    whole &&
    codes.some((c) => c === whole || (whole.length >= 3 && c.includes(whole)))
  )
    return true;
  // every word must match somewhere (text or code)
  return q.split(" ").every(
    (w) =>
      text.includes(w) ||
      codes.some((c) => {
        const cw = compactCode(w);
        return cw.length >= 2 && c.includes(cw);
      }),
  );
}
