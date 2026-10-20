import { tx } from "../src/client.js";
import { BATCH, rowId } from "./store.js";

export const VANOPS_SAMPLE_POLICIES = {
  cold_chain: {
    intervalMinutes: 60,
    bands: [
      {
        productId: null,
        label: "SAMPLE frozen range — quality approval required",
        minDeciC: -250,
        maxDeciC: -180,
      },
    ],
  },
  variance: { toleranceBasisPoints: 50, escalateAfterHours: 24 },
  returnables: {
    items: [
      { code: "crate", label: "Sample crate" },
      { code: "tray", label: "Sample tray" },
      { code: "pallet", label: "Sample pallet" },
    ],
  },
  return_reasons: {
    items: [
      { code: "damaged", label: "Damaged" },
      { code: "expired", label: "Expired" },
      { code: "near_expiry", label: "Near expiry" },
      { code: "wrong_item", label: "Wrong item" },
      { code: "customer_rejected", label: "Customer rejected" },
    ],
  },
};

/** F-113/F-114/F-115/F-118 normal demo ownership and dependency-safe reset. @param {import('./store.js').Dataset} data */
export function appendVanOpsPolicies(data) {
  const author = data
    .rows("profiles")
    .find((p) => ["admin", "super_admin"].includes(p.role));
  if (!author) return;
  for (const unit of new Set(data.rows("vehicles").map((v) => v.org_unit_id)))
    for (const [kind, facts] of Object.entries(VANOPS_SAMPLE_POLICIES))
      data.add("van_policy_versions", `${unit}:${kind}`, {
        org_unit_id: unit,
        kind,
        effective_from: "2026-01-01T00:00:00Z",
        source_ref: "SAMPLE VANOPS — not Sunpride policy",
        facts,
        created_by: author.id,
      });
}

/** F-113/F-114/F-115/F-118 clearly marked defaults; additive and retry-safe, never resets existing policies.
 * @param {any} db
 */
export async function seedVanOps(db) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(4310090)`;
    await t`select pg_advisory_xact_lock(4400115)`;
    const [author] =
      await t`select p.id from profiles p join sample_data_rows m on m.row_id=p.id::text and m.table_name='profiles' and m.batch=${BATCH} where p.role in ('super_admin','admin') and p.status='active' and p.deleted_at is null order by p.id limit 1`;
    if (!author) return { added: 0 };
    const units =
      await t`select distinct v.org_unit_id from vehicles v join sample_data_rows m on m.row_id=v.id::text and m.table_name='vehicles' where v.status='active' and v.deleted_at is null`;

    let added = 0;
    for (const unit of units)
      for (const [kind, facts] of Object.entries(VANOPS_SAMPLE_POLICIES)) {
        if (
          (
            await t`select 1 from van_policy_versions where org_unit_id=${unit.org_unit_id} and kind=${kind}`
          ).length
        )
          continue;
        const identity = `${unit.org_unit_id}:${kind}`,
          key = `van_policy_versions:${identity}`;
        const [row] =
          await t`insert into van_policy_versions(id,org_unit_id,kind,effective_from,source_ref,facts,created_by) values(${rowId("van_policy_versions", identity)},${unit.org_unit_id},${kind},'2026-01-01T00:00:00Z','SAMPLE VANOPS — not Sunpride policy',${facts},${author.id}) returning id`;
        await t`insert into sample_data_rows(id,batch,table_name,row_id,key) values(${rowId("sample_data_rows", key)},${BATCH},'van_policy_versions',${row.id},${key}) on conflict(batch,key) do nothing`;
        added++;
      }
    return { added };
  });
}
