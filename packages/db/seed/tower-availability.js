import { createHash } from "node:crypto";
import { ACTOR, ORGANIZATION as org, plusDays } from "./store.js";

/** Invented physical observations attached only to owned sample calls, never real calls.
 * No stock balance, order, visit state, productivity result or real MSL is changed.
 * @param {import('./store.js').Dataset} d @param {any} c @param {any[]} visits @param {Set<string>} externalRanges */
export function availabilitySamples(d, c, visits, externalRanges) {
  const products = c.products.slice(0, 4),
    stores = new Map(
      c.stores.map((/** @type {any} */ o, /** @type {number} */ i) => [
        o.id,
        { o, i },
      ]),
    );
  /** @type {Map<string,any>} */ const ranges = new Map();
  for (const o of c.stores) {
    if (externalRanges.has(o.id)) continue;
    const range = d.add("outlet_assortments", `tower-msl-${o.id}`, {
      organization_id: org,
      outlet_id: o.id,
      effective_from: d.epoch,
      source_ref: "SAMPLE — fictional four-SKU shelf range",
      actor_subject: ACTOR,
    });
    ranges.set(o.id, range);
    for (const [ordinal, p] of products.entries())
      d.add("outlet_assortment_products", `tower-msl-${o.id}-${p.id}`, {
        outlet_assortment_id: range.id,
        ordinal,
        product_id: p.id,
      });
  }
  for (const v of visits) {
    const selected = stores.get(v.outlet_id),
      range = ranges.get(v.outlet_id),
      date = String(v.service_date);
    if (
      !selected ||
      !range ||
      v.state !== "completed" ||
      date < plusDays(d.anchorDate, -55) ||
      date > d.anchorDate
    )
      continue;
    const when = new Date(v.checked_out_at ?? v.last_server_time).toISOString(),
      day = Math.floor(Date.parse(date + "T00:00:00Z") / 86400000);
    const lines = products.map(
      (/** @type {any} */ p, /** @type {number} */ j) => ({
        productId: p.id,
        status:
          (selected.i + j + day) % 7 === 0
            ? "out_of_stock"
            : (selected.i + j + day) % 7 === 1
              ? "low_stock"
              : "available",
      }),
    );
    const missing = lines.filter(
      (/** @type {any} */ l) => l.status === "out_of_stock",
    );
    const audit = d.add(
      "merchandising_audits",
      `tower-availability-${v.id}`,
      {
        organization_id: org,
        org_unit_id: v.org_unit_id,
        visit_id: v.id,
        outlet_id: v.outlet_id,
        assignee_profile_id: v.assignee_profile_id,
        service_date: date,
        client_audit_id: `SAMPLE-TOWER-${v.id}`,
        payload_hash: createHash("sha256")
          .update(JSON.stringify({ sample: true, visitId: v.id, lines }))
          .digest("hex"),
        audit_version: "sample/tower-v1",
        assortment_id: range.id,
        required_count: lines.length,
        required_available_count: lines.length - missing.length,
        required_out_of_stock_count: missing.length,
        actor_subject: ACTOR,
        source: "web",
        device_time: when,
        server_time: when,
      },
      when,
    );
    for (const [ordinal, l] of lines.entries())
      d.add(
        "merchandising_availability",
        `tower-availability-${v.id}-${l.productId}`,
        {
          organization_id: org,
          org_unit_id: v.org_unit_id,
          audit_id: audit.id,
          outlet_id: v.outlet_id,
          product_id: l.productId,
          service_date: date,
          required: true,
          status: l.status,
          facings: l.status === "out_of_stock" ? 0 : 3 + ordinal,
          note: "SAMPLE — invented shelf observation, not actual field evidence",
        },
        when,
      );
    for (const [ordinal, l] of missing.entries())
      d.add(
        "merchandising_audit_missing_products",
        `tower-missing-${v.id}-${l.productId}`,
        { merchandising_audit_id: audit.id, ordinal, product_id: l.productId },
        when,
      );
  }
}
