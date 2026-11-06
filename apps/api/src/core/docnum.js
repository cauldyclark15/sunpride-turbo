/**
 * Human document numbers (SPEC 3.3): TYPE-LOC-YYMMDD-NNNN, e.g. TRF-CEB-261106-0012.
 * One counter per organization, type, location and Manila business day. Never shows a UUID.
 * Fiscal documents (invoice, official receipt, credit memo) keep their own BIR series.
 */
export const DOC_TYPES = Object.freeze([
  "TRF",
  "LOAD",
  "RLD",
  "LIN",
  "RCV",
  "CNT",
  "ADJ",
  "DSP",
  "REM",
  "SHF",
  "TILL",
  "Z",
]);
const LOCATION = /^[A-Z0-9][A-Z0-9-]{0,19}$/;

/** Manila business date for an instant, as YYYY-MM-DD.
 * @param {number|Date} [at] */
export function manilaBusinessDate(at = Date.now()) {
  const ms = at instanceof Date ? at.getTime() : at;
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
}

/** @param {string} type @param {string} locationCode @param {string} businessDate YYYY-MM-DD @param {number} n */
export function formatDocNumber(type, locationCode, businessDate, n) {
  const yymmdd = businessDate.replaceAll("-", "").slice(2);
  return `${type}-${locationCode}-${yymmdd}-${String(n).padStart(4, "0")}`;
}

/**
 * Issue the next number. One atomic upsert takes the row lock, so concurrent callers queue and get
 * consecutive values. Inside the caller's transaction the number rolls back with the document
 * (no gaps); outside one it is still issued atomically.
 * @param {any} db a Bun.sql handle or open transaction
 * @param {string} org organization id
 * @param {{ type: string, locationCode: string, at?: number|Date }} input
 * @returns {Promise<string>} e.g. "TRF-CEB-261106-0012"
 */
export async function nextDocNumber(db, org, { type, locationCode, at }) {
  if (!DOC_TYPES.includes(type))
    throw new Error(`Unknown document type: ${type}`);
  const loc = String(locationCode ?? "")
    .trim()
    .toUpperCase();
  if (!LOCATION.test(loc))
    throw new Error(
      "Document location code must be 1-20 letters, digits or dashes",
    );
  if (!org) throw new Error("Organization is required for document numbers");
  const date = manilaBusinessDate(at ?? Date.now());
  const [row] =
    await db`insert into document_sequences (organization_id,doc_type,location_code,business_date,last_value) values (${org},${type},${loc},${date}::date,1) on conflict (organization_id,doc_type,location_code,business_date) do update set last_value=document_sequences.last_value+1 returning last_value`;
  return formatDocNumber(type, loc, date, Number(row.last_value));
}
