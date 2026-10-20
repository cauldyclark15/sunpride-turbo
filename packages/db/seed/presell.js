import { tx } from "../src/client.js";
import { Dataset, persist } from "./store.js";

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
