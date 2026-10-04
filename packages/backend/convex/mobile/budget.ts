/**
 * QSR-013 bootstrap working-set budget. Pure helpers shared by the day projection and the
 * bootstrap pager; docs/qa/MOBILE_BOOTSTRAP_BUDGET.md explains how the numbers were chosen.
 *
 * Representative pilot load (client call 2 Oct 2026, answer 1): Route Sales / PMOT 30 calls a
 * day, KAS/Booking 5. The phone snapshot covers HORIZON_DAYS (3) days, so a full route-sales
 * working set is about 90 visits.
 */

/** Planned visits across the whole horizon. More than 2x the 90-visit route-sales maximum. */
export const MAX_WORKING_SET_VISITS = 200;
/**
 * Distinct call-sheet products read for one snapshot. Each costs two Convex index ranges
 * (product + barcode), and a transaction may read at most 4,096 ranges.
 */
export const MAX_WORKING_SET_PRODUCTS = 600;
/** Uncompressed JSON bytes of one bootstrap page; every page stays at or below this. */
export const MAX_BOOTSTRAP_PAGE_BYTES = 256 * 1024;
/** Pages in one snapshot. The iOS client gives up after 50 pages, Android after 100. */
export const MAX_BOOTSTRAP_PAGES = 40;
/** Envelope outside the entry arrays: ids, appConfig, cursors and array punctuation. */
export const PAGE_ENVELOPE_RESERVE_BYTES = 4 * 1024;
/** Responses smaller than this go out uncompressed. */
export const GZIP_MIN_BYTES = 1024;

/** The bounded-working-set failure; mapped to HTTP 413 `invalid_request` at the gateway. */
export const WORKING_SET_TOO_LARGE = "working_set_too_large";

const encoder = new TextEncoder();
export const jsonBytes = (value: unknown): number =>
  encoder.encode(JSON.stringify(value)).length;

/**
 * End index (exclusive) of the page that starts at `start`: at most `limit` entries and at most
 * `budget` bytes. A page always takes at least one entry, so callers must reject any single entry
 * larger than `budget` beforehand.
 */
export function pageEnd(
  sizes: readonly number[],
  start: number,
  limit: number,
  budget: number,
): number {
  let end = start;
  let used = 0;
  while (end < sizes.length && end - start < limit) {
    // +1 for the separating comma inside the arrays.
    const next = used + sizes[end]! + 1;
    if (end > start && next > budget) break;
    used = next;
    end++;
  }
  return end;
}

/** Pages needed to send every entry from the start; an empty working set is one page. */
export function pageCount(
  sizes: readonly number[],
  limit: number,
  budget: number,
): number {
  let pages = 0;
  let start = 0;
  do {
    start = pageEnd(sizes, start, limit, budget);
    pages++;
  } while (start < sizes.length);
  return pages;
}

/** True when an Accept-Encoding header allows gzip (q=0 refuses it). */
export function acceptsGzip(header: string | null): boolean {
  if (!header) return false;
  const weights = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params
      .map((p) => p.trim())
      .find((p) => p.startsWith("q="))
      ?.slice(2);
    weights.set(name!.trim(), q === undefined ? 1 : Number(q));
  }
  // An explicit gzip entry wins over the wildcard.
  const weight = weights.get("gzip") ?? weights.get("*");
  return weight !== undefined && weight > 0;
}
