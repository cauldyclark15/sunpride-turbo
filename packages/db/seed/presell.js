import { tx } from "../src/client.js";
import { Dataset, persist, BATCH } from "./store.js";

/** F-301 F-303 F-304: sample controls, not claimed client policy or SAP authority.
 * @param {any} db @param {number} [from] */
export async function ensurePresellSamples(db, from = Date.now()) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(5300301)`;
    const data = new Dataset(
        new Date(from + 8 * 3600000).toISOString().slice(0, 10),
        1,
      ),
      stamp = new Date(from).toISOString();
    if (!(await t`select 1 from presell_policies limit 1`).length)
      data.add("presell_policies", "default", {
        channel_profile: "pre_sell",
        version: 1,
        label: "Sample next-day delivery",
        cutoff_minute: 14 * 60,
        lead_days: 1,
        horizon_days: 30,
        sla_days: 2,
        epod_target_percent: 98,
        variance_reasons: [
          { code: "not_loaded", label: "Short loaded quantity" },
          { code: "buyer_rejected", label: "Buyer refused goods" },
          { code: "damaged_at_door", label: "Damage at delivery" },
        ],
        effective_from: stamp,
        source: "sample",
        published_by: "system:sample",
      });
    for (const [
      profile,
      label,
      app,
      adapters,
    ] of /** @type {Array<[string,string,string,string[]]>} */ ([
      [
        "pre_sell",
        "Sample pre-sell",
        "field-android",
        ["check_in", "order_build", "evidence", "note", "check_out"],
      ],
      [
        "driver_delivery",
        "Sample driver delivery",
        "van-android",
        ["check_in", "delivery_confirm", "check_out"],
      ],
    ])) {
      if (
        !(
          await t`select 1 from call_flow_definitions where channel_profile=${profile} limit 1`
        ).length
      )
        data.add("call_flow_definitions", profile, {
          channel_profile: profile,
          version: 1,
          label,
          steps: adapters.map((adapter) => ({
            key: adapter,
            adapter,
            label: /** @type {Record<string,string>} */ ({
              check_in: "Check in",
              order_build: "Order for delivery",
              evidence: "Call photo",
              note: "Note",
              delivery_confirm: "Signature, photo and delivered quantities",
              check_out: "Check out",
            })[adapter],
            required: ["check_in", "delivery_confirm", "check_out"].includes(
              adapter,
            ),
            condition: "always",
          })),
          effective_from: stamp,
          source: "sample",
          published_by: "system:sample",
        });
      if (
        !(
          await t`select 1 from call_flow_policies where channel_profile=${profile} limit 1`
        ).length
      )
        data.add("call_flow_policies", profile, {
          channel_profile: profile,
          outlet_class: "*",
          version: 1,
          radius_meters: 100,
          max_accuracy_meters: 50,
          max_fix_age_ms: 60000,
          min_dwell_ms: 0,
          effective_from: stamp,
          source: "sample",
          published_by: "system:sample",
        });
      if (
        !(
          await t`select 1 from call_flow_channel_bindings where app=${app} and channel_code='gt_presell' and outlet_class='*' limit 1`
        ).length
      )
        data.add("call_flow_channel_bindings", profile, {
          app,
          channel_code: "gt_presell",
          outlet_class: "*",
          channel_profile: profile,
          version: 1,
          effective_from: stamp,
          source: "sample",
          published_by: "system:sample",
        });
    }
    if (
      !(
        await t`select 1 from no_order_reasons where code='delivery_only' limit 1`
      ).length
    )
      data.add("no_order_reasons", "delivery_only", {
        code: "delivery_only",
        label: "Delivery only — no new sale at the door",
        version: 1,
        effective_from: stamp,
        source: "sample",
        published_by: "system:sample",
      });
    if (data.tables.size) await persist(t, data);
    return { added: data.markers.length };
  });
}

/** F-301 F-302 F-303: additive, marked logistics examples from existing sample orders.
 * No real rows are adopted, overwritten or reset. @param {any} db @param {string} [anchor] */
export async function ensurePresellDemo(
  db,
  anchor = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
) {
  await ensurePresellSamples(db);
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(5300302)`;
    const [prior] =
      await t`select 1 from sample_data_rows where batch=${BATCH} and key=${`orders:presell-${anchor}-0`}`;
    if (prior) return { added: 0 };
    const [policy] =
      await t`select * from presell_policies where effective_from<=now() and (effective_to is null or effective_to>now())`;
    const sources =
      await t`select o.* from orders o join sample_data_rows m on m.row_id=o.id::text and m.table_name='orders' and m.batch=${BATCH}
      where o.outlet_id is not null and o.org_unit_id is not null and o.amount_known and o.status in ('approved','posted','fulfilled') and o.deleted_at is null and o.order_number not like 'SAMPLE-PRESELL-%' order by o.service_date desc,o.id limit 4`;
    const data = new Dataset(anchor, 1);
    const clean = (/** @type {any} */ row) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([k]) =>
            !["id", "created_at", "updated_at", "change_seq"].includes(k),
        ),
      );
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i],
        key = `presell-${anchor}-${i}`;
      const lines =
        await t`select l.product_code,l.description,l.quantity,l.unit_price,l.line_total,p.id as product_id,'PC' as uom,(l.quantity*p.quantity_scale)::bigint as quantity_base,round(l.unit_price*100)::bigint as unit_price_centavos,round(l.line_total*100)::bigint as line_total_centavos from order_lines l join products p on p.code=l.product_code and p.active and p.deleted_at is null join units_of_measure u on u.id=p.base_uom_id and u.code='PC' and u.active where l.order_id=${source.id} and l.deleted_at is null and p.quantity_scale>0 order by l.ordinal,l.id`;
      if (!lines.length) continue;
      const order = data.add("orders", key, {
        ...clean(source),
        client_request_id: `sample:${key}`,
        order_number: `SAMPLE-PRESELL-${anchor}-${i + 1}`,
        status: "approved",
        source_activity_id: null,
        outside_call_id: null,
        sap_document_number: null,
        service_date: anchor,
      });
      const orderLines = lines.map(
        (/** @type {any} */ l, /** @type {number} */ n) =>
          data.add("order_lines", `${key}-${n}`, {
            ...clean(l),
            order_id: order.id,
            ordinal: n,
          }),
      );
      const requested = new Date(Date.parse(anchor) + (i % 2) * 86400000)
        .toISOString()
        .slice(0, 10);
      data.add("presell_order_promises", key, {
        order_id: order.id,
        requested_delivery_date: requested,
        confirmed_delivery_date: requested,
        policy_id: policy.id,
        policy_snapshot: policy,
        captured_at: new Date(Date.parse(anchor) - 86400000).toISOString(),
        confirmed_at: data.noon,
        confirmed_by: "system:sample",
        confirmation_reason: "Invented sample buyer confirmation",
      });
      const snapshot = {
        orderNumber: order.order_number,
        orderId: order.id,
        outletId: order.outlet_id,
        customerCode: order.customer_code,
        requestedDeliveryDate: requested,
        confirmedDeliveryDate: requested,
        policy,
        lines: orderLines.map((/** @type {any} */ l) => ({
          id: l.id,
          ordinal: l.ordinal,
          productId: l.product_id,
          productCode: l.product_code,
          description: l.description,
          uom: l.uom,
          quantity: Number(l.quantity),
          expectedBase: Number(l.quantity_base),
        })),
      };
      const hash = new Bun.CryptoHasher("sha256")
        .update(
          JSON.stringify(snapshot, (_key, value) =>
            value && typeof value === "object" && !Array.isArray(value)
              ? Object.fromEntries(
                  Object.keys(value)
                    .sort()
                    .map((k) => [k, value[k]]),
                )
              : value,
          ),
        )
        .digest("hex");
      // Demo fixture is already acknowledged; production release/retry always uses the API outbox worker.
      const handoff = data.add("delivery_handoffs", key, {
        order_id: order.id,
        outlet_id: order.outlet_id,
        org_unit_id: order.org_unit_id,
        status: "acknowledged",
        snapshot,
        payload_hash: hash,
        attempts: 1,
        sap_reference: `MOCK-SAMPLE-${key}`,
        source: "mock_sap",
      });
      const drop = data.add("delivery_drops", key, {
        handoff_id: handoff.id,
        status: "ready",
      });
      for (const l of orderLines)
        data.add("delivery_drop_lines", `${key}-${l.ordinal}`, {
          drop_id: drop.id,
          order_line_id: l.id,
          ordinal: l.ordinal,
          product_id: l.product_id,
          product_code: l.product_code,
          description: l.description,
          uom: l.uom,
          ordered_quantity: l.quantity,
          expected_base: l.quantity_base,
        });
    }
    if (data.tables.size) await persist(t, data);
    return { added: data.markers.length };
  });
}
