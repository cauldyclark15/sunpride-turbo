import { Dataset, persist } from "./store.js";
import { tx } from "../src/client.js";

/** F-006 F-107: sample configurations, not Sunpride-approved operating policy. */
export const SAMPLE_FLOWS = [
  {
    profile: "distributor_rep",
    label: "Sample distributor representative",
    adapters: [
      "check_in",
      "stock_check",
      "order_build",
      "evidence",
      "check_out",
    ],
  },
  {
    profile: "field_selling",
    label: "Sample field selling",
    adapters: [
      "check_in",
      "stock_check",
      "order_build",
      "evidence",
      "note",
      "check_out",
    ],
  },
  {
    profile: "van_selling",
    label: "Sample van selling",
    adapters: [
      "check_in",
      "stock_check",
      "order_build",
      "discount",
      "invoice",
      "payment",
      "return_pickup",
      "evidence",
      "check_out",
    ],
  },
];
const labels = /** @type {Record<string,string>} */ ({
  check_in: "Check in",
  stock_check: "Stock check / call sheet",
  order_build: "Build order",
  discount: "Discount",
  invoice: "Invoice",
  payment: "Payment",
  return_pickup: "Return pickup",
  evidence: "Photo and evidence",
  note: "Note",
  check_out: "Check out",
});
/** F-006 F-107: deterministic initial seed companion, included in the normal sample ownership manifest.
 * @param {import('./store.js').Dataset} data */
export function addCallflowSamples(data) {
  for (const f of SAMPLE_FLOWS) {
    data.add("call_flow_definitions", f.profile, {
      channel_profile: f.profile,
      version: 1,
      label: f.label,
      steps: f.adapters.map((adapter) => ({
        key: adapter,
        adapter,
        label: labels[adapter],
        required: ["check_in", "check_out"].includes(adapter),
        condition: ["discount", "invoice", "payment"].includes(adapter)
          ? "has_order"
          : "always",
      })),
      effective_from: data.noon,
      published_by: "system:sample",
      source: "sample",
    });
    data.add("call_flow_policies", f.profile, {
      channel_profile: f.profile,
      outlet_class: "*",
      version: 1,
      radius_meters: 100,
      max_accuracy_meters: 50,
      max_fix_age_ms: 60000,
      min_dwell_ms: 180000,
      effective_from: data.noon,
      published_by: "system:sample",
      source: "sample",
    });
  }
  for (const [code, label] of [
    ["no_demand", "No demand today"],
    ["closed_store", "Store closed"],
    ["no_stock", "No stock available"],
    ["buyer_unavailable", "Buyer unavailable"],
    ["credit_hold", "Credit on hold"],
  ])
    data.add("no_order_reasons", code, {
      code,
      label,
      version: 1,
      effective_from: data.noon,
      published_by: "system:sample",
      source: "sample",
    });
}
/** Idempotent additive extension: never overwrites a published office configuration or resets data.
 * Effective now preserves all pre-engine queued calls. @param {any} db @param {number} [from] */
export async function ensureCallflowSamples(db, from = Date.now()) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(4310410)`;
    const data = new Dataset(
        new Date(from + 8 * 3600000).toISOString().slice(0, 10),
        1,
      ),
      stamp = new Date(from).toISOString();
    for (const f of SAMPLE_FLOWS) {
      if (
        !(
          await t`select 1 from call_flow_definitions where channel_profile=${f.profile} limit 1`
        ).length
      )
        data.add("call_flow_definitions", f.profile, {
          channel_profile: f.profile,
          version: 1,
          label: f.label,
          steps: f.adapters.map((adapter) => ({
            key: adapter,
            adapter,
            label: labels[adapter],
            required: ["check_in", "check_out"].includes(adapter),
            condition: ["discount", "invoice", "payment"].includes(adapter)
              ? "has_order"
              : "always",
          })),
          effective_from: stamp,
          published_by: "system:sample",
          source: "sample",
        });
      if (
        !(
          await t`select 1 from call_flow_policies where channel_profile=${f.profile} limit 1`
        ).length
      )
        data.add("call_flow_policies", f.profile, {
          channel_profile: f.profile,
          outlet_class: "*",
          version: 1,
          radius_meters: 100,
          max_accuracy_meters: 50,
          max_fix_age_ms: 60000,
          min_dwell_ms: 180000,
          effective_from: stamp,
          published_by: "system:sample",
          source: "sample",
        });
    }
    for (const [code, label] of [
      ["no_demand", "No demand today"],
      ["closed_store", "Store closed"],
      ["no_stock", "No stock available"],
      ["buyer_unavailable", "Buyer unavailable"],
      ["credit_hold", "Credit on hold"],
    ])
      if (
        !(await t`select 1 from no_order_reasons where code=${code} limit 1`)
          .length
      )
        data.add("no_order_reasons", code, {
          code,
          label,
          version: 1,
          effective_from: stamp,
          published_by: "system:sample",
          source: "sample",
        });
    if (data.tables.size) await persist(t, data);
    return { added: data.markers.length };
  });
}
