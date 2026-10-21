import { enqueue } from "../../core/jobs.js";
import { writeAudit } from "../org/audit.js";
import { uuid } from "../orders/validation.js";

/** Daily bounded comparison against trusted SAP acknowledgement rows, never a local mark-paid writer.
 * @param {any} db @param {string|null} [after] */
export async function reconcileLiabilities(db, after = null) {
  const rows = await db`select e.id,e.amount_centavos,e.reversed_centavos,
    coalesce(sum(i.amount_centavos) filter(where i.kind='accrual' and i.status='acknowledged'),0) as accrued,
    coalesce(sum(i.amount_centavos) filter(where i.kind='reversal' and i.status='acknowledged'),0) as reversed,
    coalesce(sum(i.amount_centavos) filter(where i.kind='release' and i.status='acknowledged'),0) as released,
    count(i.id) filter(where i.status<>'acknowledged')::integer as outstanding
    from promotion_earnings e left join tpm_posting_instructions i on i.earning_id=e.id
    where (${after}::uuid is null or e.id>${after}::uuid)
    group by e.id order by e.id limit 100`;
  let exceptions = 0;
  for (const row of rows) {
    const mismatch =
      BigInt(row.accrued) !== BigInt(row.amount_centavos) ||
      BigInt(row.reversed) !== BigInt(row.reversed_centavos) ||
      BigInt(row.released) > BigInt(row.accrued) - BigInt(row.reversed) ||
      row.outstanding > 0;
    if (mismatch) {
      exceptions++;
      await writeAudit(db, {
        subject: "system:tpm-reconciliation",
        action: "tpm.liability.reconciliation_required",
        entityType: "promotion_earning",
        entityId: row.id,
        details: {
          accrued: String(row.accrued),
          reversed: String(row.reversed),
          released: String(row.released),
          outstandingInstructions: row.outstanding,
        },
      });
    }
  }
  if (rows.length === 100)
    await enqueue(db, {
      kind: "tpm.reconcile",
      key: rows.at(-1).id,
      payload: { after: rows.at(-1).id },
    });
  return { checked: rows.length, exceptions };
}
/** @param {any} ctx */
export function installReconciliation(ctx) {
  ctx.registerJob("tpm.reconcile", async (/** @type {any} */ job) => {
    await reconcileLiabilities(
      job.db,
      job.payload.after ? uuid(job.payload.after) : null,
    );
    await ctx.publish("tpm");
  });
  ctx.scheduler.daily(
    "03:30",
    "Asia/Manila",
    "tpm.liability-reconciliation",
    async (/** @type {any} */ job) => {
      await enqueue(job.db, {
        kind: "tpm.reconcile",
        key: "daily",
        payload: {},
      });
    },
  );
}
