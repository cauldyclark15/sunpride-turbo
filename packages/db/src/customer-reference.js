// SP-0170: Sunpride's SAP customer reference lists (Loren Muñoz, "Customer Information
// template", 2026-11-10) flattened into one row shape. The migration 0820 is generated from
// these rows (scripts/build-customer-reference-sql.js) and `loadCustomerReference` upserts the
// same rows idempotently when Sunpride sends an updated workbook. Codes are always text.

import { tx } from "./client.js";

/** @typedef {{list:string,salesOrgCode:string,channelCode:string,group1Code:string,code:string,name:string,sortOrder:number}} ReferenceRow */

export const REFERENCE_FILE = new URL(
  "../reference/sunpride-customer-master-2026-11-10.json",
  import.meta.url,
);
export const REFERENCE_SOURCE =
  "sunpride-customer-information-template-2026-11-10";

/** Every list key, in the client's field order. */
export const REFERENCE_LISTS = /** @type {const} */ ([
  "tax_classification",
  "country",
  "sales_organization",
  "sales_office",
  "distribution_channel",
  "customer_group_1",
  "customer_group_2",
  "customer_group",
  "type_of_business",
  "sales_partner",
  "payment_terms",
  "pricing_procedure",
  "delivering_plant",
]);

/** Flatten the client JSON into ordered reference rows.
 * @param {any} json @returns {ReferenceRow[]} */
export function referenceRows(json) {
  /** @type {ReferenceRow[]} */ const rows = [];
  /** @param {string} list @param {Partial<ReferenceRow>&{code:string,name:string}} r */
  const add = (list, r) =>
    rows.push({
      list,
      salesOrgCode: r.salesOrgCode ?? "",
      channelCode: r.channelCode ?? "",
      group1Code: r.group1Code ?? "",
      code: String(r.code),
      name: String(r.name).trim(),
      sortOrder: rows.filter((x) => x.list === list).length + 1,
    });
  for (const r of json.tax_classes) add("tax_classification", r);
  // Country is a dropdown in the sheet with no tab; the Philippines is the only country served.
  add("country", { code: "PH", name: "Philippines" });
  for (const r of json.sales_organizations) add("sales_organization", r);
  for (const r of json.sales_offices)
    add("sales_office", { ...r, salesOrgCode: r.sales_org_code });
  for (const r of json.distribution_channels)
    add("distribution_channel", { ...r, salesOrgCode: r.sales_org_code });
  const seen = new Set();
  for (const c of json.customer_group_chain) {
    if (!c.group1) continue;
    const k1 = `${c.sales_org}|${c.channel}|${c.group1.code}`;
    if (!seen.has(k1)) {
      seen.add(k1);
      add("customer_group_1", {
        salesOrgCode: c.sales_org,
        channelCode: c.channel,
        code: c.group1.code,
        name: c.group1.name,
      });
    }
    if (c.group2)
      add("customer_group_2", {
        salesOrgCode: c.sales_org,
        channelCode: c.channel,
        group1Code: c.group1.code,
        code: c.group2.code,
        name: c.group2.name,
      });
  }
  for (const r of json.customer_groups) add("customer_group", r);
  // The Type of Business tab has descriptions only; the description is its own code.
  for (const r of json.types_of_business)
    add("type_of_business", { code: r.code ?? r.name, name: r.name });
  for (const r of json.sales_partners ?? [])
    add("sales_partner", { code: r.code, name: r.name });
  for (const r of json.payment_terms) add("payment_terms", r);
  for (const r of json.pricing_procedures) add("pricing_procedure", r);
  for (const r of json.delivering_plants)
    add("delivering_plant", { ...r, salesOrgCode: r.sales_org_code });
  return rows;
}

/** Read the committed client JSON. */
export async function readReferenceJson() {
  return JSON.parse(await Bun.file(REFERENCE_FILE).text());
}

/** Idempotent upsert of the client's lists. Rows missing from the file are deactivated, never
 * deleted (customers may still carry the code). Returns counts; writes one audit row on change.
 * @param {any} db @param {{json?:any,actor?:string}} [opts] */
export async function loadCustomerReference(db, opts = {}) {
  const json = opts.json ?? (await readReferenceJson());
  const rows = referenceRows(json);
  const actor = opts.actor ?? "system:customer-master";
  let changed = 0;
  await tx(db, async (/** @type {any} */ t) => {
    for (const r of rows) {
      const result =
        await t`insert into customer_reference_values(list,sales_org_code,channel_code,group1_code,code,name,sort_order,active,source,updated_by)
        values(${r.list},${r.salesOrgCode},${r.channelCode},${r.group1Code},${r.code},${r.name},${r.sortOrder},true,${REFERENCE_SOURCE},${actor})
        on conflict(list,sales_org_code,channel_code,group1_code,code) do update set name=excluded.name,sort_order=excluded.sort_order,active=true,source=excluded.source,updated_by=excluded.updated_by
        where (customer_reference_values.name,customer_reference_values.sort_order,customer_reference_values.active) is distinct from (excluded.name,excluded.sort_order,true)
        returning id`;
      changed += result.length;
    }
    const keys = rows.map(
      (r) =>
        `${r.list}|${r.salesOrgCode}|${r.channelCode}|${r.group1Code}|${r.code}`,
    );
    const retired =
      await t`update customer_reference_values set active=false,updated_by=${actor}
      where active and list<>'sales_partner' and not (list||'|'||sales_org_code||'|'||channel_code||'|'||group1_code||'|'||code = any(${t.array(keys, "TEXT")})) returning id`;
    changed += retired.length;
    // Keep the names denormalized on customer profiles in step with the lists.
    await t`update customer_profiles p set distribution_channel_name=v.name from customer_reference_values v
      where v.list='distribution_channel' and v.sales_org_code=p.sales_org_code and v.code=p.distribution_channel_code and p.distribution_channel_name is distinct from v.name`;
    await t`update customer_profiles p set customer_group1_name=v.name from customer_reference_values v
      where v.list='customer_group_1' and v.sales_org_code=p.sales_org_code and v.channel_code=p.distribution_channel_code and v.code=p.customer_group1_code and p.customer_group1_name is distinct from v.name`;
    await t`update customer_profiles p set customer_group2_name=v.name from customer_reference_values v
      where v.list='customer_group_2' and v.sales_org_code=p.sales_org_code and v.channel_code=p.distribution_channel_code and v.group1_code=p.customer_group1_code and v.code=p.customer_group2_code and p.customer_group2_name is distinct from v.name`;
    await t`update customer_profiles p set customer_group_name=v.name from customer_reference_values v
      where v.list='customer_group' and v.code=p.customer_group_code and p.customer_group_name is distinct from v.name`;
    if (changed)
      await t`insert into audit_logs(subject,action,entity_type,entity_id,details)
        values(${actor},'customer_master.reference.load','customer_reference_values',${REFERENCE_SOURCE},${JSON.stringify({ changed, rows: rows.length })})`;
  });
  return { rows: rows.length, changed };
}
