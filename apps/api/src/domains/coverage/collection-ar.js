import { conflict } from "../../core/errors.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { manilaDate } from "./model.js";
/** F-613: exact latest revisions, with tombstones/withdrawal applied before account filtering.
 * This is a read projection of SAP open items, not an AR balance or a live credit certificate.
 * @param {any} db @param {string[]} codes @param {number} [now] */
export async function sapCollectionItems(db, codes, now = Date.now()) {
  const [seen] = await db`select 1 from sap_replicas where kind='ar' limit 1`;
  if (!seen) return null;
  const rows = codes.length
    ? await db`select * from (select distinct on(master_id) * from sap_replicas where kind='ar' and effective_from<=${new Date(now)} order by master_id,sap_version desc) r where payload->'data'->>'customerCode' in ${db(codes)} and deleted_at is null and (effective_to is null or effective_to>${new Date(now)}) order by master_id limit 5001`
    : [];
  if (rows.length > 5000)
    throw conflict(
      "Narrow the collection account scope; more than 5,000 open items",
    );
  const result = new Map();
  for (const code of codes) {
    const own = rows.filter(
      (/** @type {any} */ r) => r.payload.data.customerCode === code,
    );
    if (!own.length) continue;
    let total = 0,
      overdue = 0,
      old = 0;
    const items = own
      .map((/** @type {any} */ r) => {
        const d = r.payload.data,
          amount = Number(d.amountCentavos),
          due = Number(d.dueAt);
        if (
          !Number.isSafeInteger(amount) ||
          amount < 0 ||
          !Number.isSafeInteger(due) ||
          d.currency !== "PHP"
        )
          throw conflict("The SAP open-item record needs reconciliation");
        total += amount;
        if (due < now) overdue += amount;
        if (due < now - 60 * 86400000) old += amount;
        return {
          ref: r.sap_key,
          documentNumber: d.documentNumber,
          invoiceDate: null,
          dueDate: manilaDate(due),
          remainingMinor: amount,
          replicaId: r.id,
          version: Number(r.sap_version),
          source: r.source,
          receivedAt: +new Date(r.received_at),
        };
      })
      .filter((/** @type {any} */ i) => i.remainingMinor > 0);
    if (!Number.isSafeInteger(total))
      throw conflict("AR projection exceeds the supported amount");
    const at = Math.min(
      ...own.map((/** @type {any} */ r) => +new Date(r.received_at)),
    );
    const reference = {
      kind: "sap_replicas",
      items: own.map((/** @type {any} */ r) => ({
        id: r.id,
        version: Number(r.sap_version),
        hash: r.payload_hash,
      })),
      receivedAt: at,
    };
    result.set(code, {
      snapshotId: null,
      asOfDate: manilaDate(at),
      totalMinor: total,
      overdueMinor: overdue,
      over60Minor: old,
      items,
      source: own.every((/** @type {any} */ r) => r.source === "sap")
        ? "SAP replicated open items — cached, not a live balance"
        : "SAMPLE SAP replicated open items — not real client AR",
      freshness: now - at > 86400000 ? "stale" : "cached",
      sourceReference: reference,
      sourceHash: sha256Hex(canonicalJson(reference)),
    });
  }
  return result;
}
