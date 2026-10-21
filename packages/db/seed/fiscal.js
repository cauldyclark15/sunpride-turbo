import { tx } from "../src/client.js";
import { rowId } from "./store.js";
/** F-018/F-019/F-124/F-511. Idempotent additive fixtures; never reset client or issued facts.
 * Sample registrations CANNOT enable live tax-document issuance.
 * @param {import('../src/client.js').Db} db */
export async function seedFiscal(db) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(4300019)`;
    await t`select set_config('sunpride.actor','system:sample-fiscal',true)`;
    const [admin] =
      await t`select p.id from profiles p join sample_data_rows m on m.table_name='profiles' and m.row_id=p.id::text where p.role in ('super_admin','admin') and p.status='active' and p.deleted_at is null order by (p.role='super_admin') desc,p.id limit 1`;
    if (!admin)
      return { registrations: 0, reason: "Sample administrator missing" };
    const vehicles =
      await t`select distinct v.id,v.vehicle_code,v.org_unit_id,u.name from vehicles v join org_units u on u.id=v.org_unit_id join sample_data_rows m on m.table_name='vehicles' and m.row_id=v.id::text where v.deleted_at is null`;
    let count = 0;
    for (const v of vehicles) {
      const [marked] =
        await t`select 1 from sample_data_rows where table_name='org_units' and row_id=${v.org_unit_id} limit 1`;
      if (!marked) continue;
      for (const [type, code] of [
        ["sales_invoice", "SI"],
        ["official_receipt", "OR"],
        ["credit_memo", "CM"],
        ["delivery_receipt", "DR"],
      ]) {
        const id = rowId("fiscal_registrations", `${v.id}-${type}`),
          seriesId = rowId("fiscal_series", `${v.id}-${type}`);
        await t`insert into fiscal_registrations(id,org_unit_id,entity_name,branch_name,tin,address,document_type,status,effective_from,entered_by,sample,tax_basis_points)
     values(${id},${v.org_unit_id},'SAMPLE SUNPRIDE COMPANY - NOT REGISTERED',${v.name},'SAMPLE 000-000-000-000','Sample Cebu address - replace with registered address',${type},'sample_not_filed','2026-01-01',${admin.id},true,1200) on conflict(id) do nothing`;
        await t`insert into fiscal_series(id,registration_id,vehicle_id,prefix,first_serial,last_serial,next_allocate,effective_from)
     values(${seriesId},${id},${v.id},${`SAMPLE-${v.vehicle_code.toUpperCase().replace(/[^A-Z0-9-]/g, "-")}-${code}`},1,999999,1,'2026-01-01') on conflict(id) do nothing`;
        for (const [table, row] of [
          ["fiscal_registrations", id],
          ["fiscal_series", seriesId],
        ])
          await t`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-fiscal-sample',${table},${row},${`${table}:${row}`}) on conflict(batch,key) do nothing`;
        count++;
      }
      for (const method of [
        { code: "cash", label: "Cash", ref: null },
        { code: "gcash", label: "GCash", ref: "GCash reference" },
        { code: "maya", label: "Maya", ref: "Maya confirmation reference" },
        {
          code: "card",
          label: "Card",
          ref: "Terminal approval (never card number)",
        },
        { code: "check", label: "Cheque", ref: "Cheque number" },
        {
          code: "bank_transfer",
          label: "Bank transfer",
          ref: "Bank reference",
        },
        { code: "credit", label: "On account", ref: null },
      ]) {
        const id = rowId(
          "fiscal_tender_rules",
          `${v.org_unit_id}-${method.code}`,
        );
        await t`insert into fiscal_tender_rules(id,org_unit_id,method,label,reference_label,enabled,effective_from,sample,entered_by) values(${id},${v.org_unit_id},${method.code},${method.label},${method.ref},true,'2026-01-01',true,${admin.id}) on conflict(id) do nothing`;
        await t`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-fiscal-sample','fiscal_tender_rules',${id},${"fiscal_tender_rules:" + id}) on conflict(batch,key) do nothing`;
      }
      for (const kind of ["price", "credit", "stock", "discount", "void"])
        for (const role of [
          "sales",
          "manager",
          "super_admin",
          "admin",
          "operations",
          "approver",
        ]) {
          const id = rowId(
            "fiscal_authority_rules",
            `${v.org_unit_id}-${kind}-${role}`,
          );
          await t`insert into fiscal_authority_rules(id,org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample)
     values(${id},${v.org_unit_id},${kind},${role},'*',0,999999999,${kind === "discount" ? 500 : 0},${["manager", "approver", "super_admin"]},true,'2026-01-01',true) on conflict(id) do nothing`;
          await t`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-fiscal-sample','fiscal_authority_rules',${id},${`fiscal_authority_rules:${id}`}) on conflict(batch,key) do nothing`;
        }
    }
    // F-511: sample desk/field/partner actors also transact without a sample van.
    // Add explicit marked defaults, never infer policy for an unmarked client unit.
    const pairs =
      await t`select distinct p.org_unit_id,p.role from profiles p join sample_data_rows mp on mp.table_name='profiles' and mp.row_id=p.id::text join sample_data_rows mu on mu.table_name='org_units' and mu.row_id=p.org_unit_id::text where p.status='active' and p.deleted_at is null and p.role in ('sales','manager','super_admin','admin','operations','approver') union select d.org_unit_id,'distributor' as role from distributors d join sample_data_rows md on md.table_name='distributors' and md.row_id=d.id::text join sample_data_rows mu on mu.table_name='org_units' and mu.row_id=d.org_unit_id::text where d.status='accredited'`;
    for (const pair of pairs)
      for (const kind of pair.role === "distributor"
        ? ["price", "credit", "discount"]
        : ["price", "credit", "stock", "discount", "void"]) {
        const id = rowId(
          "fiscal_authority_rules",
          `${pair.org_unit_id}-${kind}-${pair.role}`,
        );
        await t`insert into fiscal_authority_rules(id,org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample) values(${id},${pair.org_unit_id},${kind},${pair.role},'*',0,999999999,${kind === "discount" ? 500 : 0},${["manager", "approver", "super_admin"]},true,'2026-01-01',true) on conflict(id) do nothing`;
        await t`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-fiscal-sample','fiscal_authority_rules',${id},${`fiscal_authority_rules:${id}`}) on conflict(batch,key) do nothing`;
      }
    return { registrations: count, status: "sample, not filed" };
  });
}
