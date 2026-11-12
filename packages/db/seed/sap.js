import { BATCH } from "./store.js";
import { syncMasters } from "../../../apps/api/src/domains/integration/replicas.js";
import {
  canonical,
  payloadHash,
} from "../../integration-contracts/sap/v1/index.js";

/** F-001/F-015/F-016/F-101: publish the existing invented company through mock SAP,
 * then ingest its validated replicas. Values are copied exactly, never repriced/reseeded.
 * This is an additive bridge, not a reset or a claim about real Sunpride data.
 * @param {import('../src/client.js').Db} db
 * @param {Record<string,string|undefined>} [env]
 */
export async function seedSapDemo(db, env = process.env) {
  const origin = env.SAP_ORIGIN ?? "http://127.0.0.1:4435";
  const url = new URL(origin);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    (env.SAP_MODE ?? "mock") !== "mock"
  )
    throw new Error("Sample SAP seed requires the local mock");
  /** @param {string} path @param {any} body */
  async function post(path, body) {
    const r = await fetch(url.origin + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.SAP_TOKEN ? { authorization: `Bearer ${env.SAP_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok)
      throw new Error("Sample SAP feed failed; retained data was not reset");
  }
  const products =
    await db`select p.* from products p join sample_data_rows s on s.table_name='products' and s.row_id=p.id::text and s.batch=${BATCH} where p.deleted_at is null`;
  const conditions =
    await db`select l.*,p.code as product_code,pl.code as list_code,pl.channel_key,pl.currency from price_list_lines l join price_lists pl on pl.id=l.price_list_id join products p on p.id=l.product_id join sample_data_rows s on s.table_name='price_list_lines' and s.row_id=l.id::text and s.batch=${BATCH} where l.deleted_at is null and pl.deleted_at is null`;
  const customers =
    await db`select c.* from customers c join sample_data_rows s on s.table_name='customers' and s.row_id=c.id::text and s.batch=${BATCH} where c.deleted_at is null`;
  const outlets =
    await db`select o.*,c.code as customer_code from outlets o join sample_data_rows s on s.table_name='outlets' and s.row_id=o.id::text and s.batch=${BATCH} join outlet_customer_links l on l.outlet_id=o.id and l.deleted_at is null and l.effective_from<=now() and (l.effective_to is null or l.effective_to>now()) join customers c on c.id=l.customer_id and c.deleted_at is null where o.deleted_at is null`;
  const locations =
    await db`select l.* from inventory_locations l join sample_data_rows s on s.table_name='inventory_locations' and s.row_id=l.id::text and s.batch=${BATCH} where l.deleted_at is null`;
  const balances =
    await db`select b.*,p.code as product_code,p.quantity_scale,l.code as location_code from inventory_balances b join products p on p.id=b.product_id join inventory_locations l on l.id=b.location_id join sample_data_rows s on s.table_name='inventory_balances' and s.row_id=b.id::text and s.batch=${BATCH} where b.deleted_at is null`;
  const ar =
    await db`select r.* from admin_pack_records r join sample_data_rows s on s.table_name='admin_pack_records' and s.row_id=r.id::text and s.batch=${BATCH} where r.kind='ar_balance'`;
  const before =
    await db`select count(*)::integer as orders,coalesce(sum(total_centavos),0)::text as cents from orders`;
  const existing =
    await db`select distinct on(kind,sap_key) * from sap_replicas where source='sample' order by kind,sap_key,sap_version desc`;
  const heads = new Map(
    existing.map((/** @type {any} */ r) => [
      `${r.kind}:${r.sap_key}`,
      r.payload,
    ]),
  );
  /** @type {any[]} */ const items = [];
  /** @param {string} kind @param {string} key @param {any} data @param {any} from @param {any} [to] */
  function add(kind, key, data, from, to = null) {
    const head = heads.get(`${kind}:${key}`);
    const candidate = {
      schemaVersion: 1,
      organizationId: "sunpride",
      kind,
      key,
      source: "sample",
      effectiveFrom: new Date(from).getTime(),
      effectiveTo: to === null ? null : new Date(to).getTime(),
      deleted: false,
      data,
    };
    const same =
      head &&
      canonical({ ...head, version: 0 }) ===
        canonical({ ...candidate, version: 0 });
    items.push(
      same ? head : { ...candidate, version: head ? head.version + 1 : 1 },
    );
  }
  for (const p of products) {
    const conversions =
      await db`select u.code,c.numerator,c.denominator from uom_conversions c join units_of_measure u on u.id=c.from_uom_id where c.product_id=${p.id} and c.active and c.deleted_at is null and c.effective_from<=now() and (c.effective_to is null or c.effective_to>now())`;
    const barcodes =
      await db`select b.barcode,u.code from product_barcodes b join units_of_measure u on u.id=b.uom_id where b.product_id=${p.id} and b.active and b.deleted_at is null`;
    const packs = [
      {
        uom: p.uom,
        parentUom: null,
        numerator: 1,
        denominator: 1,
        barcode:
          barcodes.find((/** @type {any} */ b) => b.code === p.uom)?.barcode ??
          null,
      },
      ...conversions.map((/** @type {any} */ c) => ({
        uom: c.code,
        parentUom: p.uom,
        numerator: Number(c.numerator),
        denominator: Number(c.denominator),
        barcode:
          barcodes.find((/** @type {any} */ b) => b.code === c.code)?.barcode ??
          null,
      })),
    ];
    add(
      "material",
      p.code,
      {
        code: p.code,
        name: p.name,
        category: p.category,
        baseUom: p.uom,
        quantityScale: Number(p.quantity_scale ?? 1),
        tracking: p.tracking_mode ?? "none",
        shelfLifeDays: p.shelf_life_days ?? 365,
        storageCondition:
          p.storage_condition ??
          (p.category === "Frozen"
            ? "Frozen below -18°C (sample)"
            : "Ambient dry storage (sample)"),
        status: p.active ? "active" : "inactive",
        packs,
      },
      p.created_at,
    );
  }
  for (const l of conditions)
    add(
      "condition",
      `seed:${l.id}`,
      {
        productCode: l.product_code,
        uom: l.uom,
        customerCode: null,
        channelKey: l.channel_key,
        currency: l.currency,
        unitPriceCentavos: Number(l.unit_price_minor),
        taxCode: "SAMPLE-VAT12",
        taxBasisPoints: 1200,
        taxInclusive: true,
        precedence: 10,
        priceListCode: l.list_code,
      },
      l.effective_from,
      l.effective_to,
    );
  for (const c of customers) {
    add(
      "customer",
      c.code,
      {
        code: c.code,
        name: c.name,
        channel: c.channel,
        territory: c.territory,
        status: c.active ? "active" : "inactive",
      },
      c.created_at,
    );
    const records = ar
      .filter((/** @type {any} */ r) => r.details.customerCode === c.code)
      .sort(
        (/** @type {any} */ a, /** @type {any} */ b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    const d = records[0]?.details;
    const exposure = d
      ? [
          "currentMinor",
          "days1to30Minor",
          "days31to60Minor",
          "days61to90Minor",
          "over90Minor",
        ].reduce((n, k) => n + Number(d[k] ?? 0), 0)
      : 0;
    await post("/control/credit", {
      customerCode: c.code,
      limitCentavos: Math.round(Number(c.credit_limit) * 100) || null,
      exposureCentavos: exposure,
      ifAbsent: true,
    });
    if (d)
      for (const [k, days] of [
        ["currentMinor", 0],
        ["days1to30Minor", 15],
        ["days31to60Minor", 45],
        ["days61to90Minor", 75],
        ["over90Minor", 100],
      ]) {
        const amount = Number(d[k] ?? 0);
        if (!amount) continue;
        add(
          "ar",
          `${c.code}:${k}`,
          {
            customerCode: c.code,
            // Reads like an invoice number (WEB-062), still marked SAMPLE.
            documentNumber: `SAMPLE-SI-${c.code}-${String(days).padStart(3, "0")}`,
            dueAt:
              new Date(`${d.asOfDate}T00:00:00+08:00`).getTime() -
              Number(days) * 86400000,
            amountCentavos: amount,
            currency: "PHP",
          },
          records[0].created_at,
        );
      }
  }
  for (const o of outlets)
    add(
      "outlet",
      o.code,
      {
        code: o.code,
        name: o.name,
        customerCode: o.customer_code,
        address: o.address || "Sample address not supplied",
      },
      o.created_at,
    );
  for (const l of locations)
    add(
      "location",
      l.code,
      {
        locationCode: l.code,
        plant: "SAMPLE-CEBU",
        storageLocation: l.code,
        status: l.active ? "active" : "inactive",
      },
      l.created_at,
    );
  for (const b of balances)
    add(
      "stock",
      `${b.product_code}:${b.location_code}`,
      {
        productCode: b.product_code,
        locationCode: b.location_code,
        onHandBase: Number(b.physical_base),
        reservedBase: Number(b.reserved_base),
        valueCentavos: Number(b.inventory_value_minor),
        unitCostCentavos: Number(b.weighted_average_cost_minor),
        quantityScale: Number(b.quantity_scale ?? 1),
        currency: "PHP",
      },
      b.as_of,
    );
  for (let offset = 0; offset < items.length; offset += 1000)
    await post("/control/masters", {
      items: items.slice(offset, offset + 1000),
    });
  const received = await syncMasters(db, env);
  const after =
    await db`select count(*)::integer as orders,coalesce(sum(total_centavos),0)::text as cents from orders`;
  if (payloadHash(before) !== payloadHash(after))
    throw new Error("Sample SAP reconciliation failed");
  return {
    source: "sample",
    published: items.length,
    received,
    ordersUnchanged: true,
    orderCount: after[0].orders,
    salesCentavos: after[0].cents,
  };
}
