import { tx } from "../src/client.js";
import { rowId, todayManila, plusDays } from "./store.js";

const BATCH = "sunpride-mt-v1";
/** Idempotent additive sample slice. Never deletes or updates existing business rows.
 * @param {import('../src/client.js').Db} db */
export async function seedModernTrade(db) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(4900001)`;
    const [requester] =
      await t`select p.* from profiles p join sample_data_rows m on m.table_name='profiles' and m.row_id=p.id::text where p.role in ('super_admin','admin') and p.user_id is not null and p.status='active' limit 1`;
    const [approver] =
      await t`select p.* from profiles p join sample_data_rows m on m.table_name='profiles' and m.row_id=p.id::text where p.role='manager' and p.user_id is not null and p.status='active' limit 1`;
    const stores =
      await t`select o.*,c.id as customer_id,c.code as customer_code from outlets o join outlet_customer_links l on l.outlet_id=o.id and l.deleted_at is null and l.effective_from<=now() and (l.effective_to is null or l.effective_to>now()) join customers c on c.id=l.customer_id join sample_data_rows m on m.table_name='outlets' and m.row_id=o.id::text where o.channel in ('kas','supermarket') and o.status='active' and o.deleted_at is null order by o.code limit 3`;
    if (!requester || !approver || stores.length < 3)
      return { created: 0, reason: "Seed the sample company first" };
    let created = 0;
    /** @param {string} table @param {string} key @param {()=>Promise<void>} insert */
    async function ensure(table, key, insert) {
      const marker = `${table}:mt:${key}`,
        id = rowId(table, `mt:${key}`);
      const [old] =
        await t`select id from sample_data_rows where batch=${BATCH} and key=${marker}`;
      if (!old) {
        await insert();
        await t`insert into sample_data_rows(batch,table_name,row_id,key) values(${BATCH},${table},${id},${marker})`;
        created++;
      }
      return id;
    }
    const from = new Date("2020-01-01T00:00:00Z"),
      today = todayManila();
    const [type] =
      await t`select * from mt_deduction_types where code='SAMPLE-DELIVERY' and effective_to is null`;
    const typeId =
      type?.id ??
      (await ensure("mt_deduction_types", "delivery", async () => {
        await t`insert into mt_deduction_types(id,code,label,sla_days,effective_from) values(${rowId("mt_deduction_types", "mt:delivery")},'SAMPLE-DELIVERY','Sample delivery shortage',7,${from})`;
      }));
    for (const [index, s] of stores.entries()) {
      const key = `branch-${index + 1}`,
        chain = index < 2 ? "SAMPLE-CHAIN-A" : "SAMPLE-CHAIN-B",
        banner = index < 2 ? "SAMPLE-BANNER-A" : "SAMPLE-BANNER-B";
      const bindingId = await ensure("mt_account_bindings", key, async () => {
        await t`insert into mt_account_bindings(id,customer_id,outlet_id,account_key,banner_key,branch_key,label,source,source_version,effective_from) values(${rowId("mt_account_bindings", `mt:${key}`)},${s.customer_id},${s.id},${chain},${banner},${`SAMPLE-BRANCH-${index + 1}`},${`Sample MT · ${s.name}`},'sample','sample-v1',${from})`;
      });
      const termId = await ensure("mt_trade_terms", key, async () => {
        await t`insert into mt_trade_terms(id,scope_kind,scope_key,name,status,source,sap_key,source_version,effective_from,requested_by,approved_by) values(${rowId("mt_trade_terms", `mt:${key}`)},'branch',${`SAMPLE-BRANCH-${index + 1}`},${`Sample agreement · ${s.name}`},'approved','sample',${`MOCK-SAP-MT-${index + 1}`},'sample-v1',${from},${requester.user_id},${approver.user_id})`;
      });
      const prices =
        await t`select distinct on (l.product_id,l.uom) l.product_id,l.uom,l.unit_price_minor from price_list_lines l join price_lists p on p.id=l.price_list_id where p.source='sample' and p.status='active' and p.deleted_at is null and l.deleted_at is null and (p.channel_key=${s.channel} or p.channel_key is null) and l.effective_from<=now() and (l.effective_to is null or l.effective_to>now()) order by l.product_id,l.uom,(p.channel_key is not null) desc,l.effective_from desc limit 100`;
      for (const [i, p] of prices.entries())
        await ensure(
          "mt_term_conditions",
          `${key}-price-${p.product_id}-${p.uom}`,
          async () => {
            await t`insert into mt_term_conditions(id,term_id,ordinal,kind,product_id,uom,amount_centavos) values(${rowId("mt_term_conditions", `mt:${key}-price-${p.product_id}-${p.uom}`)},${termId},${i},'price',${p.product_id},${p.uom},${p.unit_price_minor})`;
          },
        );
      for (const [i, kind] of [
        "listing_fee",
        "rebate",
        "logistics_allowance",
      ].entries())
        await ensure("mt_term_conditions", `${key}-${kind}`, async () => {
          await t`insert into mt_term_conditions(id,term_id,ordinal,kind,amount_centavos,rate_bps) values(${rowId("mt_term_conditions", `mt:${key}-${kind}`)},${termId},${100 + i},${kind},${i === 0 ? 250000 : null},${i === 0 ? null : i === 1 ? 200 : 100})`;
        });
      const orders =
        await t`select * from orders where outlet_id=${s.id} and deleted_at is null and status in ('approved','posted','sent_to_sap','fulfilled') and coalesce(total_centavos,0)>=0 order by created_at desc limit 6`;
      for (const [n, o] of orders.entries()) {
        const pk = `${key}-${o.id}`,
          po = `SAMPLE-PO-${o.order_number}`,
          source = `Sample supplier export for ${po}\nCanonical order ${o.order_number}`;
        const docId = await ensure("mt_po_documents", pk, async () => {
          await t`insert into mt_po_documents(id,binding_id,filename,format,sha256,content_base64,created_by,received_at) values(${rowId("mt_po_documents", `mt:${pk}`)},${bindingId},${`${po}.txt`},'email',${new Bun.CryptoHasher("sha256").update(source).digest("hex")},${Buffer.from(source).toString("base64")},${requester.user_id},${o.created_at})`;
        });
        const intakeId = await ensure(
          "inbound_purchase_orders",
          pk,
          async () => {
            await t`insert into inbound_purchase_orders(id,document_id,binding_id,po_number,service_date,status,order_id,confirmed_at,created_by,created_at) values(${rowId("inbound_purchase_orders", `mt:${pk}`)},${docId},${bindingId},${po},${o.service_date ? new Date(o.service_date).toISOString().slice(0, 10) : today},'confirmed',${o.id},${o.created_at},${requester.user_id},${o.created_at})`;
          },
        );
        const lines =
          await t`select l.*,p.uom as default_uom from order_lines l join products p on p.code=l.product_code where l.order_id=${o.id} and l.deleted_at is null order by l.ordinal,l.id`;
        for (const [i, l] of lines.entries())
          await ensure("mt_po_lines", `${pk}-${i}`, async () => {
            await t`insert into mt_po_lines(id,intake_id,ordinal,product_code,uom,quantity,requested_price_centavos,product_id) values(${rowId("mt_po_lines", `mt:${pk}-${i}`)},${intakeId},${i},${l.product_code},${l.uom ?? l.default_uom},${l.quantity},${l.unit_price_centavos},${l.product_id})`;
          });
        // Explicitly invented delivery-adapter fixtures, independent of the order's accounting stage.
        for (const [step, stage] of [
          "ready_for_delivery",
          ...(n % 3 !== 2 ? ["dispatched"] : []),
          ...(n % 3 === 0 ? ["delivered"] : []),
        ].entries()) {
          const eventKey = `${pk}-${stage}`;
          await ensure("mt_delivery_status_replicas", eventKey, async () => {
            await t`insert into mt_delivery_status_replicas(id,order_id,stage,occurred_at,source,upstream_key,source_version) values(${rowId("mt_delivery_status_replicas", `mt:${eventKey}`)},${o.id},${stage},${new Date(new Date(o.created_at).getTime() + (step + 1) * 15 * 60_000)},'sample',${`MOCK-DELIVERY-${eventKey}`},'sample-v1')`;
          });
        }
        const invoiceId = await ensure("mt_invoice_replicas", pk, async () => {
          await t`insert into mt_invoice_replicas(id,binding_id,order_id,invoice_number,amount_centavos,issued_on,due_on,source,sap_key,source_version) values(${rowId("mt_invoice_replicas", `mt:${pk}`)},${bindingId},${o.id},${`SAMPLE-INV-${o.order_number}`},${o.total_centavos ?? 100000},${plusDays(today, -n * 7)},${plusDays(today, 30 - n * 7)},'sample',${`MOCK-INV-${o.id}`},'sample-v1')`;
        });
        const remittanceId = await ensure("mt_remittances", pk, async () => {
          await t`insert into mt_remittances(id,binding_id,reference,received_on,gross_centavos,paid_centavos,created_by) values(${rowId("mt_remittances", `mt:${pk}`)},${bindingId},${`SAMPLE-REM-${o.order_number}`},${plusDays(today, -n * 7)},100000,90000,${requester.user_id})`;
        });
        await ensure("mt_deductions", pk, async () => {
          await t`insert into mt_deductions(id,remittance_id,binding_id,invoice_id,type_id,amount_centavos,claim_reference,owner_profile_id,due_on,status) values(${rowId("mt_deductions", `mt:${pk}`)},${remittanceId},${bindingId},${invoiceId},${typeId},10000,${n % 2 ? `SAMPLE-CLAIM-${n}` : null},${requester.id},${plusDays(today, 7 - n * 7)},${n === 5 ? "resolved" : "open"})`;
        });
      }
    }
    return { created, branches: stores.length, source: "sample" };
  });
}
