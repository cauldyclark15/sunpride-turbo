import { BATCH, Dataset, persist, todayManila } from "./store.js";

/** F-R01/R03/R08 additive, ownership-marked samples. Never restock a used shop or overwrite office edits.
 * @param {any} db */
export async function completeStorePosSamples(db) {
  const stores =
    await db`select r.*,l.org_unit_id,l.organization_id,l.code,l.name as store_name from store_registers r join inventory_locations l on l.id=r.location_id join sample_data_rows m on m.table_name='inventory_locations' and m.row_id=l.id::text and m.batch=${BATCH} join sample_data_rows rm on rm.table_name='store_registers' and rm.row_id=r.id::text and rm.batch=${BATCH} where l.active and l.type='store' and l.code in ('SAMPLE-CEBU-COLON','SAMPLE-CEBU-MANDAUE')`;
  const data = new Dataset(todayManila(), 1);
  /** @type {any[]} */ const links = [];
  const products =
    await db`select p.*,u.code as base_code,coalesce(i.tracking_mode,p.tracking_mode,'none') as tracking from products p join sample_data_rows m on m.table_name='products' and m.row_id=p.id::text and m.batch=${BATCH} join units_of_measure u on u.id=p.base_uom_id left join product_inventory_policies i on i.product_id=p.id and i.deleted_at is null where p.active and p.deleted_at is null order by p.code limit 3`;
  for (const r of stores) {
    const key = `storepos-selling:${r.code}`;
    if (!r.outlet_id) {
      const customer = data.add("customers", key, {
        code: `${r.code}-CASH`,
        name: r.store_name,
        channel: "gt",
        territory: "SAMPLE Cebu store",
        credit_limit: 0,
        active: true,
      });
      const outlet = data.add("outlets", key, {
        organization_id: "sunpride",
        code: `${r.code}-OUTLET`,
        name: r.store_name,
        status: "active",
        custodian_org_unit_id: r.org_unit_id,
        channel: "gt",
        address: "Sample Cebu retail address",
        enrolment_status: "approved",
        created_by: "system:sample",
        visit_frequency_days: 1,
      });
      data.add("outlet_customer_links", key, {
        outlet_id: outlet.id,
        customer_id: customer.id,
        source: "sample",
        effective_from: data.epoch,
        actor_subject: "system:sample",
        reason: "Invented retail-store accounting link",
      });
      links.push({ id: r.id, outletId: outlet.id });
    }
    const [target] =
      await db`select 1 from store_daily_targets where register_id=${r.id}`;
    if (!target)
      data.add("store_daily_targets", key, {
        register_id: r.id,
        from_date: todayManila(),
        to_date: todayManila(),
        amount_centavos: 500000,
      });
    const [used] =
      await db`select 1 from inventory_movements where source_type='sample' and source_document_id=${key}`;
    const [hasStock] =
      await db`select 1 from inventory_balances where location_id=${r.location_id}`;
    if (used || hasStock || !products.length) continue;
    const time = Date.now(),
      stamp = new Date(time).toISOString();
    const movement = data.add(
      "inventory_movements",
      key,
      {
        organization_id: "sunpride",
        movement_number: `${r.code}-OPEN`,
        movement_type: "opening_balance",
        source_type: "sample",
        source_document_id: key,
        status: "posted",
        effective_at: stamp,
        posted_at: stamp,
        posted_by: "system:sample",
        idempotency_key: key,
        note: "Invented sample opening stock, not a live SAP posting",
        schema_version: 1,
      },
      time,
    );
    for (const p of products) {
      const k = `${key}:${p.id}`,
        qty = 30 * Number(p.quantity_scale),
        cost = 1000;
      const lot =
        p.tracking === "lot"
          ? data.add(
              "inventory_lots",
              k,
              {
                organization_id: "sunpride",
                product_id: p.id,
                lot_number: `${r.code}-LOT`,
                normalized_lot_number: `${r.code}-LOT`,
                source_type: "sample",
                source_document_id: key,
                received_at: stamp,
                expires_at: new Date(time + 180 * 86400000).toISOString(),
                quality_status: "released",
                unit_cost_minor: cost,
              },
              time,
            )
          : null;
      const line = data.add(
        "inventory_movement_lines",
        k,
        {
          organization_id: "sunpride",
          movement_id: movement.id,
          line_number: products.indexOf(p) + 1,
          product_id: p.id,
          base_uom_id: p.base_uom_id,
          quantity_base: qty,
          entered_quantity: "30",
          entered_uom_code: p.base_code,
          from_location_id: null,
          to_location_id: r.location_id,
          from_stock_status: null,
          to_stock_status: "available",
          unit_cost_minor: cost,
          total_cost_minor: qty * cost,
          effective_at: stamp,
        },
        time,
      );
      const allocation = data.add(
        "inventory_allocations",
        k,
        {
          organization_id: "sunpride",
          movement_id: movement.id,
          movement_line_id: line.id,
          product_id: p.id,
          lot_id: lot?.id ?? null,
          quantity_base: qty,
          from_location_id: null,
          to_location_id: r.location_id,
          to_stock_status: "available",
          allocation_sequence: 1,
          allocation_policy: lot ? "fefo" : "none",
          user_selected: false,
          effective_at: stamp,
        },
        time,
      );
      data.add(
        "inventory_ledger_entries",
        k,
        {
          organization_id: "sunpride",
          movement_id: movement.id,
          movement_line_id: line.id,
          allocation_id: allocation.id,
          product_id: p.id,
          lot_id: lot?.id ?? null,
          location_id: r.location_id,
          stock_status: "available",
          quantity_delta_base: qty,
          reserved_delta_base: 0,
          value_delta_minor: qty * cost,
          balance_version: 1,
          quantity_before_base: 0,
          quantity_after_base: qty,
          effective_at: stamp,
          posted_at: stamp,
        },
        time,
      );
      data.add(
        "inventory_balances",
        k,
        {
          organization_id: "sunpride",
          product_id: p.id,
          product_code: p.code,
          warehouse_code: r.code,
          location_id: r.location_id,
          on_hand: qty,
          reserved: 0,
          available: qty,
          as_of: stamp,
          physical_base: qty,
          available_stock_base: qty,
          reserved_base: 0,
          available_base: qty,
          quality_hold_base: 0,
          quarantine_base: 0,
          damaged_base: 0,
          expired_base: 0,
          rejected_base: 0,
          wip_base: 0,
          in_transit_base: 0,
          weighted_average_cost_minor: cost,
          inventory_value_minor: qty * cost,
          version: 1,
          last_movement_id: movement.id,
        },
        time,
      );
      if (lot)
        data.add(
          "inventory_lot_balances",
          k,
          {
            organization_id: "sunpride",
            product_id: p.id,
            lot_id: lot.id,
            location_id: r.location_id,
            stock_status: "available",
            physical_base: qty,
            reserved_base: 0,
            available_base: qty,
            expiry_sort_key: time + 180 * 86400000,
            receipt_sequence: 1,
            version: 1,
            last_movement_id: movement.id,
          },
          time,
        );
    }
    data.add(
      "inventory_commands",
      key,
      {
        organization_id: "sunpride",
        idempotency_key: key,
        command_type: "opening_balance",
        schema_version: 1,
        payload_hash: new Bun.CryptoHasher("sha256").update(key).digest("hex"),
        actor_subject: "system:sample",
        status: "posted",
        source_document_id: key,
        movement_id: movement.id,
        result: { movementId: movement.id, sample: true },
        committed_at: stamp,
      },
      time,
    );
  }
  await persist(db, data);
  for (const link of links)
    await db`update store_registers set outlet_id=${link.outletId} where id=${link.id} and outlet_id is null`;
  return { added: data.markers.length };
}
