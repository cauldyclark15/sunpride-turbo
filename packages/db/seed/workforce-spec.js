import { BATCH, todayManila } from "./store.js";
import {
  formConfiguration,
  formPolicyHash,
} from "../../../apps/api/src/domains/coverage/workforce-policies.js";
/** F-209/F-222: invented, editable defaults only for sample-marked workforce units.
 * Existing client or future policies are never replaced. @param {any} db @param {string} [day] */
export async function seedWorkforceSpec(db, day = todayManila()) {
  return db.begin(async (/** @type {any} */ t) => {
    await t`select pg_advisory_xact_lock(hashtextextended('sample:workforce-policy',0))`;
    const people =
      await t`select p.* from profiles p join sample_data_rows m on m.table_name='profiles' and m.row_id=p.id::text and m.batch=${BATCH} where p.status='active' and p.deleted_at is null`;
    const author = people.find((/** @type {any} */ p) =>
      ["super_admin", "admin"].includes(p.role),
    );
    if (!author) return { policies: 0 };
    const units = [
      ...new Set(
        people
          .filter((/** @type {any} */ p) =>
            ["sales", "manager"].includes(p.role),
          )
          .map((/** @type {any} */ p) => p.org_unit_id)
          .filter(Boolean),
      ),
    ];
    const configuration = formConfiguration({
      fields: [
        {
          key: "address",
          label: "Store address",
          type: "text",
          required: true,
          maxLength: 500,
        },
        {
          key: "channel",
          label: "Proposed selling channel",
          type: "select",
          required: true,
          maxLength: 100,
          options: ["GT", "PMOT", "SM", "KAS"],
        },
        {
          key: "contactName",
          label: "Contact person",
          type: "text",
          required: true,
          maxLength: 100,
        },
        {
          key: "contactPhone",
          label: "Contact number",
          type: "text",
          required: false,
          maxLength: 40,
        },
        {
          key: "kycReference",
          label: "KYC reference",
          type: "text",
          required: false,
          maxLength: 100,
        },
      ],
      dayStartMinutes: 0,
      dayEndMinutes: 1440,
      maxAccuracyMeters: 250,
      maxFixAgeSeconds: 300,
      maxShiftHours: 18,
      dedupeRadiusMeters: 50,
    });
    let policies = 0;
    for (const unit of units) {
      const exists =
        await t`select 1 from workforce_form_policies where org_unit_id=${unit} limit 1`;
      if (exists.length) continue;
      const row = {
        org_unit_id: unit,
        version: 1,
        label: "SAMPLE field forms — not client-agreed",
        source_ref:
          "SAMPLE KYC choices, 24-hour capture window, 250 m review flag, 5-minute evidence freshness, 18-hour span and 50 m dedupe candidate radius; office may refine",
        configuration,
        effective_from: new Date(day + "T00:00:00+08:00"),
      };
      const [p] =
        await t`insert into workforce_form_policies(org_unit_id,version,label,source_ref,configuration,content_hash,effective_from,created_by)values(${unit},1,${row.label},${row.source_ref},${configuration},${formPolicyHash(row)},${row.effective_from},${author.id})returning id`;
      await t`insert into sample_data_rows(batch,table_name,row_id,key)values(${BATCH},'workforce_form_policies',${p.id},${"workforce-policy:" + unit})`;
      policies++;
    }
    return { policies };
  });
}
