import { tx } from "../src/client.js";
import {
  BATCH,
  Dataset,
  persist,
  rowId,
  todayManila,
  plusDays,
} from "./store.js";
export const MERCH_STEPS = [
  ["check_in", "Check in", true],
  ["availability", "Availability", true],
  ["planogram", "Planogram", true],
  ["posm", "POSM", false],
  ["price_check", "Price check", true],
  ["competitor", "Competitor", true],
  ["issue_log", "Issue log", true],
  ["freezer", "Freezer audit", false],
  ["expiry", "Expiry audit", false],
  ["promotion", "Campaign compliance", false],
  ["check_out", "Check out", true],
];
/** F-310 F-311 F-313 F-314 F-315 F-316 F-320: additive marked defaults, never overwrite office versions.
 * @param {any} db @param {number} [from] */
export async function ensureRetailSamples(db, from = Date.now()) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(5400540)`;
    const data = new Dataset(todayManila(), 1),
      stamp = new Date(from).toISOString();
    const master = async (
      /** @type {string} */ kind,
      /** @type {string} */ code,
      /** @type {string} */ label,
      /** @type {any} */ facts,
    ) => {
      const [old] =
        await t`select id from retail_master_versions where kind=${kind} and code=${code} order by version desc limit 1`;
      return (
        old?.id ??
        data.add(
          "retail_master_versions",
          `${kind}:${code}`,
          {
            organization_id: "sunpride",
            kind,
            code,
            label,
            version: 1,
            outlet_class: "*",
            effective_from: new Date(from - 90 * 86400000).toISOString(),
            data: facts,
            source: "sample",
            actor_subject: "system:sample",
          },
          stamp,
        ).id
      );
    };
    const [sample] =
      await t`select 1 from sample_data_rows where batch=${BATCH} and table_name='profiles' limit 1`;
    if (!sample) return { added: 0, rows: {} };
    const products =
      await t`select p.* from products p join sample_data_rows s on s.row_id=p.id::text and s.table_name='products' and s.batch=${BATCH} where p.active and p.deleted_at is null order by p.code limit 3`;
    const stores =
      await t`select o.* from outlets o join sample_data_rows s on s.row_id=o.id::text and s.table_name='outlets' and s.batch=${BATCH} where o.status='active' and o.deleted_at is null order by o.code limit 3`;
    const cold = await master(
      "cold_policy",
      "SAMPLE-FROZEN",
      "Sample frozen agreement",
      {
        type: "freezer",
        minTemperatureDeciC: -250,
        maxTemperatureDeciC: -180,
        minOwnSharePercent: 90,
        followupHours: 4,
      },
    );
    await master("cold_policy", "SAMPLE-CHILLED", "Sample chilled agreement", {
      type: "chiller",
      minTemperatureDeciC: 0,
      maxTemperatureDeciC: 50,
      minOwnSharePercent: 90,
      followupHours: 4,
    });
    const score = await master(
      "scorecard",
      "SAMPLE-PERFECT",
      "Sample perfect store weights",
      {
        components: [
          ["availability", 25],
          ["planogram", 20],
          ["posm", 10],
          ["price", 15],
          ["freezer", 20],
          ["promotion", 10],
        ].map(([key, weight]) => ({
          key,
          weight,
          allowNotApplicable: ["freezer", "promotion", "posm"].includes(
            String(key),
          ),
        })),
        targetPercent: 90,
      },
    );
    await master(
      "incident_category",
      "SAMPLE-COLD",
      "Sample cold-chain incident",
      { severity: "high", slaHours: 4 },
    );
    const posm = await master(
      "posm",
      "SAMPLE-HEADER",
      "Sample freezer header",
      { material: "Freezer header board", auditEveryDays: 7 },
    );
    if (products.length)
      await master("planogram", "SAMPLE-LAYOUT", "Sample frozen shelf layout", {
        lines: products.map(
          (/** @type {any} */ p, /** @type {number} */ i) => ({
            productId: p.id,
            facings: 3,
            position: `Shelf ${i + 1}`,
          }),
        ),
        targetSharePercent: 50,
      });
    for (const p of products)
      await master(
        "expiry_policy",
        `SAMPLE-${p.code}`,
        `Sample ${p.name} expiry`,
        { productId: p.id, nearExpiryDays: 30, action: "pullout" },
      );
    if (
      !(
        await t`select 1 from call_flow_definitions where channel_profile='merchandiser' limit 1`
      ).length
    ) {
      data.add(
        "call_flow_definitions",
        "retail-merchandiser",
        {
          channel_profile: "merchandiser",
          version: 1,
          label: "Sample merchandising call",
          steps: MERCH_STEPS.map(([adapter, label, required]) => ({
            key: adapter,
            adapter,
            label,
            required,
            condition: "always",
          })),
          effective_from: stamp,
          published_by: "system:sample",
          source: "sample",
        },
        stamp,
      );
      data.add(
        "call_flow_policies",
        "retail-merchandiser",
        {
          channel_profile: "merchandiser",
          outlet_class: "*",
          version: 1,
          radius_meters: 100,
          max_accuracy_meters: 50,
          max_fix_age_ms: 60000,
          min_dwell_ms: 180000,
          effective_from: stamp,
          published_by: "system:sample",
          source: "sample",
        },
        stamp,
      );
    }
    // Opt-in channel binding, not a title/permission hack; existing GT/MT calls are unchanged.
    if (
      !(
        await t`select 1 from call_flow_channel_bindings where app='field-android' and channel_code='MERCH' limit 1`
      ).length
    )
      data.add(
        "call_flow_channel_bindings",
        "retail-merchandiser",
        {
          app: "field-android",
          channel_code: "MERCH",
          outlet_class: "*",
          channel_profile: "merchandiser",
          version: 1,
          effective_from: stamp,
          published_by: "system:sample",
          source: "sample",
        },
        stamp,
      );
    for (const [i, o] of stores.entries()) {
      const equipment = await master(
        "equipment",
        `SAMPLE-FREEZER-${i + 1}`,
        `Sample freezer at ${o.name}`,
        {
          serial: `SAMPLE-FR-${i + 1}`,
          model: "Sample 200 L chest freezer",
          sapFixedAssetId: `SAMPLE-FA-${1000 + i}`,
          custodian: "Sample store custodian",
          agreement: "Sample own-products agreement",
          location: o.address ?? "Cebu",
          type: "freezer",
          outletId: o.id,
          deployedAt: from - 60 * 86400000,
          policyVersionId: cold,
        },
      );
      if (
        !(
          await t`select 1 from equipment_service_events where equipment_version_id=${equipment} limit 1`
        ).length
      )
        data.add(
          "equipment_service_events",
          `sample-reconcile-${i}`,
          {
            equipment_version_id: equipment,
            kind: "reconcile",
            reference: `SAMPLE-SAP-EXTRACT-${i + 1}`,
            note: "Illustrative matching ledger entry; not a real SAP reconciliation",
            actor_subject: "system:sample",
            occurred_at: stamp,
          },
          stamp,
        );
      // Demonstrate historical component evidence as explicitly synthetic facts, never mutate existing visits.
      const visits =
        await t`select v.* from visit_executions v join sample_data_rows s on s.row_id=v.id::text and s.table_name='visit_executions' and s.batch=${BATCH} where v.outlet_id=${o.id} and v.checked_in_at is not null order by v.checked_in_at desc limit 14`;
      for (const v of visits)
        for (const kind of ["planogram", "freezer", "posm"]) {
          const key = `sample-${v.id}-${kind}`,
            id = rowId("retail_execution_audits", key);
          if (
            (await t`select 1 from retail_execution_audits where id=${id}`)
              .length
          )
            continue;
          data.add(
            "retail_execution_audits",
            key,
            {
              visit_id: v.id,
              outlet_id: o.id,
              profile_id: v.assignee_profile_id,
              org_unit_id: v.org_unit_id,
              kind,
              request_key: id,
              payload_hash: "sample-synthetic",
              master_version_id:
                kind === "freezer"
                  ? equipment
                  : kind === "posm"
                    ? posm
                    : rowId(
                        "retail_master_versions",
                        "planogram:SAMPLE-LAYOUT",
                      ),
              facts: {
                source: "sample",
                synthetic: true,
                note: "Illustrative retail observation",
                evidenceIds: [],
              },
              component_score: kind === "freezer" && i === 1 ? 0 : 90 + i * 3,
              captured_at: v.checked_in_at,
              actor_subject: "system:sample",
            },
            +new Date(v.checked_in_at),
          );
        }
    }
    const [lot] =
      await t`select l.* from inventory_lots l join sample_data_rows s on s.row_id=l.id::text and s.table_name='inventory_lots' and s.batch=${BATCH} order by l.id limit 1`;
    if (lot)
      for (const [i, o] of stores.entries())
        if (
          !(
            await t`select 1 from retail_batch_receipts where source_key=${`sample-merch-receipt-${i}`} limit 1`
          ).length
        )
          data.add(
            "retail_batch_receipts",
            `sample-merch-receipt-${i}`,
            {
              outlet_id: o.id,
              lot_id: lot.id,
              quantity_base: 24 * (i + 1),
              source_key: `sample-merch-receipt-${i}`,
              source_kind: "sample",
              source_version: "sample-v1",
              received_at: stamp,
              actor_subject: "system:sample",
            },
            stamp,
          );
    // The weekly snapshot remains explicitly incomplete when canonical availability/price/campaign evidence is absent.
    const day = todayManila(),
      dow = new Date(day).getUTCDay(),
      week = plusDays(day, -((dow + 6) % 7) - 7);
    for (const o of stores) {
      const [link] =
        await t`select customer_id from outlet_customer_links where outlet_id=${o.id} and deleted_at is null and effective_from<=${new Date(from)} and (effective_to is null or effective_to>${new Date(from)}) limit 1`;
      if (
        link &&
        !(
          await t`select 1 from perfect_store_publications where customer_id=${link.customer_id} and week_start=${week}`
        ).length
      )
        data.add(
          "perfect_store_publications",
          `sample-score-${week}-${link.customer_id}`,
          {
            week_start: week,
            customer_id: link.customer_id,
            scorecard_version_id: score,
            revision: 1,
            content_hash: "sample-illustration",
            snapshot: {
              source: "sample",
              synthetic: true,
              status: "incomplete",
              score: null,
              weekStart: week,
              branches: [
                {
                  outletId: o.id,
                  outletName: o.name,
                  status: "incomplete",
                  missing: ["availability", "price", "promotion"],
                  score: null,
                  target: 90,
                },
              ],
            },
            actor_subject: "system:sample",
          },
          stamp,
        );
    }
    if (data.tables.size) await persist(t, data);
    return {
      added: data.markers.length,
      rows: Object.fromEntries(
        [...data.tables.entries()].map(([table, rows]) => [table, rows.length]),
      ),
    };
  });
}
