import { Dataset, persist, plusDays, BATCH, rowId } from "./store.js";
import { company } from "./company.js";

/** F-601–F-608 clearly fictional source replicas; no operational orders/inventory overwritten.
 * @param {import('./store.js').Dataset} d @param {import('./company.js').Company} c */
export function towerSamples(d, c) {
  for (const unit of c.units)
    d.add("analytics_cockpit_policies", `tower-policy-${unit.id}`, {
      org_unit_id: unit.id,
      freshness_days: 7,
      effective_from: d.epoch,
      source_ref: "SAMPLE: provisional seven-day observation freshness",
    });
  for (const o of c.stores)
    d.add("analytics_turnover_weights", `tower-weight-${o.id}`, {
      outlet_id: o.id,
      turnover_centavos: 1000000 + (o.index % 4) * 250000,
      effective_from: d.epoch,
      source_ref:
        "SAMPLE: estimated outlet total turnover, not Sunpride purchases",
    });
  for (let n = 0; n < Math.min(d.days, 56); n++) {
    const date = plusDays(d.anchorDate, -n),
      at = `${date}T12:00:00+08:00`;
    for (let dist = 0; dist < 2; dist++)
      for (const [i, p] of c.products.slice(0, 4).entries()) {
        const o = c.stores[dist * 75 + 1];
        for (const kind of [
          "primary",
          "secondary",
          "stock",
          "promotion_plan",
        ]) {
          if (kind === "promotion_plan" && n % 7 !== 0) continue;
          const key = `tower-${dist}-${p.id}-${date}-${kind}`;
          const qty =
            kind === "stock"
              ? 240
              : kind === "primary"
                ? 36 + i * 12
                : kind === "promotion_plan"
                  ? 60
                  : 24 + i * 6;
          d.add(
            "analytics_trade_inputs",
            key,
            {
              kind,
              source_system: "sample-commercial",
              source_key: key,
              source_revision: "1",
              source_received_at: at,
              source_effective_at: at,
              source_type: "sample",
              org_unit_id: o.custodian_org_unit_id,
              distributor_key: `SAMPLE-D${dist + 1}`,
              distributor_name: `Sample ${dist ? "South" : "North"} Distributor`,
              outlet_id: kind === "secondary" ? o.id : null,
              product_id: p.id,
              service_date: date,
              quantity_base: qty,
              amount_centavos: kind === "stock" ? null : qty * 12500,
              campaign_ref: kind === "promotion_plan" ? "SAMPLE-LAUNCH" : null,
              channel: o.channel,
              account_name: `Sample distributor account ${dist + 1}`,
              lineage: JSON.stringify({
                source: "invented_sample",
                feature: "F-603",
                invoiceLine: key,
                notSap: true,
              }),
            },
            at,
          );
        }
      }
  }
  for (const o of c.stores.slice(0, 8)) {
    for (const [kind, payload] of Object.entries({
      class: { label: "Sample class B", potential: "Sample medium potential" },
      asset: {
        label: "Sample display rack",
        serial: `SAMPLE-RACK-${o.index}`,
        condition: "Needs service",
        service: "Sample service due",
        history: "Sample placement; not client equipment",
      },
      issue: {
        label: "Sample missing display",
        status: "open",
        nextAction: "Review execution evidence",
      },
      execution_score: {
        label: "Sample perfect-store score",
        value: 75,
        components: {
          availability: 80,
          planogram: 70,
          posm: 75,
          price: 100,
          purity: 50,
          promotion: 75,
        },
        definition:
          "SAMPLE: equal component weights; upstream governed score required",
      },
    }))
      d.add("analytics_outlet_context", `tower-${o.id}-${kind}`, {
        outlet_id: o.id,
        org_unit_id: o.custodian_org_unit_id,
        kind,
        source_system: "sample-programme",
        source_key: `${o.id}-${kind}`,
        source_revision: "1",
        source_type: "sample",
        effective_from: d.epoch,
        payload: JSON.stringify(payload),
      });
    d.add("analytics_integrity_findings", `tower-integrity-${o.id}`, {
      org_unit_id: o.custodian_org_unit_id,
      outlet_id: o.id,
      source_system: "sample-integrity",
      source_key: `signal-${o.id}`,
      source_revision: "1",
      source_type: "sample",
      rule_code: "SAMPLE_REPEAT_PHOTO",
      rule_version: "sample/1",
      severity: "medium",
      title: "Sample repeated-photo signal",
      detail: "Fictional review case; not a detector result or accusation.",
      status: "open",
      occurred_at: `${d.anchorDate}T10:00:00+08:00`,
      evidence: JSON.stringify({ sample: true, source: "invented_case" }),
      review_href: "/decide",
    });
  }
}
/** Idempotently extend an already seeded sample company; never resets/updates existing records.
 * Caller holds the demo transaction lock. @param {any} db @param {string} date @param {number} [days] */
export async function extendTowerSamples(db, date, days = 56) {
  const template = new Dataset(date, Math.min(days, 56)),
    c = company(template, []),
    d = new Dataset(date, Math.min(days, 56));
  const owned =
    await db`select row_id from sample_data_rows where batch=${BATCH} and table_name='outlets'`;
  const ids = new Set(owned.map((/** @type {any} */ r) => r.row_id));
  if (!ids.has(c.stores[1].id) || !ids.has(c.stores[76].id))
    return { added: 0 };
  towerSamples(d, c);
  const existing = new Set(
    (await db`select row_id from sample_data_rows where batch=${BATCH}`).map(
      (/** @type {any} */ r) => r.row_id,
    ),
  );
  for (const [table, rows] of d.tables)
    d.tables.set(
      table,
      rows.filter((r) => !existing.has(r.id)),
    );
  d.markers = d.markers.filter((r) => !existing.has(r.row_id));
  if (d.markers.length) await persist(db, d);
  return { added: d.markers.length };
}
