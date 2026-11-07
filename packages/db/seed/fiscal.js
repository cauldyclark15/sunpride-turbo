import { tx } from "../src/client.js";
import { rowId } from "./store.js";
/** F-018/F-019/F-124/F-511. Idempotent additive fixtures; never reset client or issued facts.
 * Sample registrations CANNOT enable live tax-document issuance.
 * @param {import('../src/client.js').Db} db */
export async function seedFiscal(db) {
  const result = await tx(db, async (t) => {
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
  return {
    ...result,
    stores: await seedStoreFiscal(db),
    refundSeries: await seedRefundSeries(db),
  };
}

/** Store tills sell from the register's org unit with no vehicle. Give every marked-sample unit that has an active store
 * register the payment types the phone offers (cash, GCash, card) and one sales-invoice registration + series with no
 * vehicle (the only kind the store bundle can allocate). Additive only: a method or a vehicle-less invoice series the
 * unit already has (even a disabled or office-edited one) is left exactly as it is, so a second run adds nothing.
 * Sample registrations stay `sample_not_filed`, so they still cannot enable live tax-document issuance.
 * @param {import('../src/client.js').Db} db */
export async function seedStoreFiscal(db) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(4300019)`;
    await t`select set_config('sunpride.actor','system:sample-fiscal',true)`;
    const [admin] =
      await t`select p.id from profiles p join sample_data_rows m on m.table_name='profiles' and m.row_id=p.id::text where p.role in ('super_admin','admin') and p.status='active' and p.deleted_at is null order by (p.role='super_admin') desc,p.id limit 1`;
    if (!admin)
      return { tenders: 0, series: 0, reason: "Sample administrator missing" };
    const units =
      await t`select distinct u.id,u.code,u.name from org_units u join sample_data_rows m on m.table_name='org_units' and m.row_id=u.id::text join inventory_locations l on l.org_unit_id=u.id and l.type='store' and l.active and l.deleted_at is null join store_registers r on r.location_id=l.id where u.deleted_at is null order by u.id`;
    let tenders = 0,
      series = 0;
    for (const u of units) {
      for (const method of [
        { code: "cash", label: "Cash", ref: null },
        { code: "gcash", label: "GCash", ref: "GCash reference" },
        {
          code: "card",
          label: "Card",
          ref: "Terminal approval (never card number)",
        },
      ]) {
        const [have] =
          await t`select 1 from fiscal_tender_rules where org_unit_id=${u.id} and method=${method.code} limit 1`;
        if (have) continue;
        const id = rowId("fiscal_tender_rules", `${u.id}-${method.code}`);
        await t`insert into fiscal_tender_rules(id,org_unit_id,method,label,reference_label,enabled,effective_from,sample,entered_by) values(${id},${u.id},${method.code},${method.label},${method.ref},true,'2026-01-01',true,${admin.id}) on conflict(id) do nothing`;
        await t`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-fiscal-sample','fiscal_tender_rules',${id},${"fiscal_tender_rules:" + id}) on conflict(batch,key) do nothing`;
        tenders++;
      }
      const [open] =
        await t`select 1 from fiscal_series s join fiscal_registrations r on r.id=s.registration_id where r.org_unit_id=${u.id} and r.document_type='sales_invoice' and s.vehicle_id is null limit 1`;
      if (open) continue;
      const id = rowId("fiscal_registrations", `${u.id}-store-sales_invoice`),
        seriesId = rowId("fiscal_series", `${u.id}-store-sales_invoice`);
      await t`insert into fiscal_registrations(id,org_unit_id,entity_name,branch_name,tin,address,document_type,status,effective_from,entered_by,sample,tax_basis_points)
     values(${id},${u.id},'SAMPLE SUNPRIDE COMPANY - NOT REGISTERED',${u.name},'SAMPLE 000-000-000-000','Sample Cebu address - replace with registered address','sales_invoice','sample_not_filed','2026-01-01',${admin.id},true,1200) on conflict(id) do nothing`;
      await t`insert into fiscal_series(id,registration_id,vehicle_id,prefix,first_serial,last_serial,next_allocate,effective_from)
     values(${seriesId},${id},null,${`SAMPLE-${String(u.code)
       .toUpperCase()
       .replace(
         /[^A-Z0-9-]/g,
         "-",
       )}-STORE-SI`},1,999999,1,'2026-01-01') on conflict(id) do nothing`;
      for (const [table, row] of [
        ["fiscal_registrations", id],
        ["fiscal_series", seriesId],
      ])
        await t`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-fiscal-sample',${table},${row},${`${table}:${row}`}) on conflict(batch,key) do nothing`;
      series++;
    }
    return { tenders, series };
  });
}

/** IP-REFUND: a refund is a credit memo with its own number series. Give every marked-sample store register unit one vehicle-less
 * credit-memo registration + series, and every marked-sample vehicle one credit-memo series of its own, so a phone can number a
 * refund offline like it numbers an invoice. Additive only: a credit-memo series the unit or vehicle already has (even
 * office-edited or disabled) is left exactly as it is, so a second run adds nothing. Sample registrations stay
 * `sample_not_filed`. Never raw SQL on a live database: run this helper (packages/db/scripts/seed-store-fiscal.js).
 * @param {import('../src/client.js').Db} db */
export async function seedRefundSeries(db) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(4300019)`;
    await t`select set_config('sunpride.actor','system:sample-fiscal',true)`;
    const [admin] =
      await t`select p.id from profiles p join sample_data_rows m on m.table_name='profiles' and m.row_id=p.id::text where p.role in ('super_admin','admin') and p.status='active' and p.deleted_at is null order by (p.role='super_admin') desc,p.id limit 1`;
    if (!admin)
      return { stores: 0, vehicles: 0, reason: "Sample administrator missing" };
    const units =
      await t`select distinct u.id,u.code,u.name from org_units u join sample_data_rows m on m.table_name='org_units' and m.row_id=u.id::text join inventory_locations l on l.org_unit_id=u.id and l.type='store' and l.active and l.deleted_at is null join store_registers r on r.location_id=l.id where u.deleted_at is null order by u.id`;
    let stores = 0,
      vehiclesDone = 0;
    for (const u of units) {
      const [have] =
        await t`select 1 from fiscal_series s join fiscal_registrations r on r.id=s.registration_id where r.org_unit_id=${u.id} and r.document_type='credit_memo' and s.vehicle_id is null limit 1`;
      if (have) continue;
      const id = rowId("fiscal_registrations", `${u.id}-store-credit_memo`),
        seriesId = rowId("fiscal_series", `${u.id}-store-credit_memo`);
      await t`insert into fiscal_registrations(id,org_unit_id,entity_name,branch_name,tin,address,document_type,status,effective_from,entered_by,sample,tax_basis_points)
     values(${id},${u.id},'SAMPLE SUNPRIDE COMPANY - NOT REGISTERED',${u.name},'SAMPLE 000-000-000-000','Sample Cebu address - replace with registered address','credit_memo','sample_not_filed','2026-01-01',${admin.id},true,1200) on conflict(id) do nothing`;
      await t`insert into fiscal_series(id,registration_id,vehicle_id,prefix,first_serial,last_serial,next_allocate,effective_from)
     values(${seriesId},${id},null,${`SAMPLE-${String(u.code)
       .toUpperCase()
       .replace(
         /[^A-Z0-9-]/g,
         "-",
       )}-STORE-CM`},1,999999,1,'2026-01-01') on conflict(id) do nothing`;
      for (const [table, row] of [
        ["fiscal_registrations", id],
        ["fiscal_series", seriesId],
      ])
        await t`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-fiscal-sample',${table},${row},${`${table}:${row}`}) on conflict(batch,key) do nothing`;
      stores++;
    }
    const vehicles =
      await t`select distinct v.id,v.vehicle_code,v.org_unit_id,u.name from vehicles v join org_units u on u.id=v.org_unit_id join sample_data_rows m on m.table_name='vehicles' and m.row_id=v.id::text join sample_data_rows mu on mu.table_name='org_units' and mu.row_id=v.org_unit_id::text where v.deleted_at is null order by v.id`;
    for (const v of vehicles) {
      const [have] =
        await t`select 1 from fiscal_series s join fiscal_registrations r on r.id=s.registration_id where r.org_unit_id=${v.org_unit_id} and r.document_type='credit_memo' and s.vehicle_id=${v.id} limit 1`;
      if (have) continue;
      const id = rowId("fiscal_registrations", `${v.id}-credit_memo`),
        seriesId = rowId("fiscal_series", `${v.id}-credit_memo`);
      await t`insert into fiscal_registrations(id,org_unit_id,entity_name,branch_name,tin,address,document_type,status,effective_from,entered_by,sample,tax_basis_points)
     values(${id},${v.org_unit_id},'SAMPLE SUNPRIDE COMPANY - NOT REGISTERED',${v.name},'SAMPLE 000-000-000-000','Sample Cebu address - replace with registered address','credit_memo','sample_not_filed','2026-01-01',${admin.id},true,1200) on conflict(id) do nothing`;
      await t`insert into fiscal_series(id,registration_id,vehicle_id,prefix,first_serial,last_serial,next_allocate,effective_from)
     values(${seriesId},${id},${v.id},${`SAMPLE-${String(v.vehicle_code)
       .toUpperCase()
       .replace(
         /[^A-Z0-9-]/g,
         "-",
       )}-CM`},1,999999,1,'2026-01-01') on conflict(id) do nothing`;
      for (const [table, row] of [
        ["fiscal_registrations", id],
        ["fiscal_series", seriesId],
      ])
        await t`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-fiscal-sample',${table},${row},${`${table}:${row}`}) on conflict(batch,key) do nothing`;
      vehiclesDone++;
    }
    return { stores, vehicles: vehiclesDone };
  });
}
