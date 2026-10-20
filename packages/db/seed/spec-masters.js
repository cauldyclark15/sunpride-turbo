#!/usr/bin/env bun
import { createDb, tx } from "../src/client.js";
import { BATCH, rowId } from "./store.js";
import { addTrialRow } from "./trial-wiring.js";

/** F-009/F-010/F-013/F-014/F-017/F-305: invented, editable beta defaults.
 * Does not replace existing revisions or reset any live dataset.
 * @param {import('../src/client.js').Db} db */
export async function seedSpecMasters(db) {
  await db`select pg_advisory_xact_lock(4310420)`;
  const [manifest] =
    await db`select created_at from audit_logs where id=${rowId("audit_logs", "manifest")}`;
  if (!manifest)
    throw new Error("Spec masters require the existing sample company");
  // F-013/F-616: the base demo may anchor its manifest at today's noon, which
  // is still future before noon. New editable setup must be usable immediately.
  const [clock] =
    await db`select least(${manifest.created_at}::timestamptz,now()) as at`;
  const effectiveFrom = new Date(clock.at);
  /** @param {string} table @param {string} key @param {Record<string,any>} values @returns {Promise<import('./store.js').Row>} */
  async function ensure(table, key, values) {
    const [marker] =
      await db`select row_id from sample_data_rows where batch=${BATCH} and key=${`${table}:trial-spec-${key}`}`;
    return marker
      ? { ...values, id: marker.row_id }
      : addTrialRow(db, table, `spec-${key}`, values);
  }
  /** @param {string} kind @param {string} code @param {string} label @param {any} data @param {string|null} [unit] */
  async function definition(kind, code, label, data, unit = null) {
    const entity = await ensure("master_definitions", code, {
      kind,
      code,
      org_unit_id: unit,
    });
    await ensure("master_versions", code, {
      master_id: entity.id,
      version: 1,
      label: `Sample ${label}`,
      status: "active",
      data,
      effective_from: effectiveFrom,
      reason: "Invented sample default; needs Sunpride confirmation",
    });
    return entity.id;
  }
  const channels = new Map(),
    subs = new Map();
  for (const [code, label, children] of [
    [
      "MT",
      "Modern trade",
      [
        ["SUPERMARKET", "Supermarkets"],
        ["MT_GROCERY", "Chain groceries"],
      ],
    ],
    [
      "GT",
      "General trade",
      [
        ["SARI_SARI", "Sari-sari"],
        ["GROCERY", "Independent groceries"],
        ["WET_MARKET", "Wet market"],
      ],
    ],
    ["FOOD_SERVICE", "Food service", [["CATERING", "Caterers and canteens"]]],
    [
      "HORECA",
      "Hotels, restaurants and cafes",
      [
        ["HOTEL", "Hotels"],
        ["RESTAURANT", "Restaurants and cafes"],
      ],
    ],
    ["INSTITUTIONAL", "Institutional", [["INSTITUTION", "Institutions"]]],
  ]) {
    const channel = await definition(
      "channel",
      String(code),
      String(label),
      {},
    );
    channels.set(code, channel);
    for (const [sub, label] of /** @type {string[][]} */ (children))
      subs.set(
        sub,
        await definition("subchannel", sub, label, { channelId: channel }),
      );
  }
  for (const [legacy, channel, sub] of [
    ["gt", "GT", "SARI_SARI"],
    ["pmot", "GT", "WET_MARKET"],
    ["supermarket", "MT", "SUPERMARKET"],
    ["kas", "MT", "MT_GROCERY"],
    ["mt", "MT", "SUPERMARKET"],
    ["food_service", "FOOD_SERVICE", "CATERING"],
    ["horeca", "HORECA", "RESTAURANT"],
    ["institutional", "INSTITUTIONAL", "INSTITUTION"],
  ])
    await ensure("master_channel_aliases", legacy, {
      legacy_key: legacy,
      channel_id: channels.get(channel),
      subchannel_id: subs.get(sub),
    });
  // Map owned records only. Real migration runs have their own reviewed staging.
  await db`update outlets o set channel_id=a.channel_id,subchannel_id=a.subchannel_id from master_channel_aliases a where lower(o.channel)=a.legacy_key and o.channel_id is null and exists(select 1 from sample_data_rows m where m.batch=${BATCH} and m.table_name='outlets' and m.row_id=o.id::text)`;
  await db`update customers c set channel_id=a.channel_id from master_channel_aliases a where lower(c.channel)=a.legacy_key and c.channel_id is null and exists(select 1 from sample_data_rows m where m.batch=${BATCH} and m.table_name='customers' and m.row_id=c.id::text)`;
  await definition("class_policy", "POTENTIAL", "Monthly revenue potential", {
    bands: [
      { class: "A", minPotentialCentavos: 50000000 },
      { class: "B", minPotentialCentavos: 20000000 },
      { class: "C", minPotentialCentavos: 5000000 },
      { class: "D", minPotentialCentavos: 0 },
    ],
  });
  const products =
    await db`select p.id from products p join sample_data_rows m on m.row_id=p.id::text and m.table_name='products' and m.batch=${BATCH} where p.active and p.deleted_at is null order by p.code limit 6`;
  for (const [channel, channelId] of channels)
    for (const [i, outletClass] of ["A", "B", "C", "D"].entries())
      await definition(
        "msl",
        `MSL-${channel}-${outletClass}`,
        `${channel} class ${outletClass} MSL`,
        {
          channelId,
          subchannelId: null,
          outletClass,
          productIds: products
            .slice(0, Math.max(1, 6 - i))
            .map((/** @type {any} */ p) => p.id),
        },
      );
  /** @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 */
  const box = (x1, y1, x2, y2) => ({
    type: "Polygon",
    coordinates: [
      [
        [x1, y1],
        [x2, y1],
        [x2, y2],
        [x1, y2],
        [x1, y1],
      ],
    ],
  });
  const regionUnit = rowId("org_units", "visayas");
  const region = await definition(
    "geography",
    "GEO-VIS",
    "Visayas training boundary",
    {
      type: "region",
      parentId: null,
      polygon: box(123.5, 10, 124.3, 10.8),
      territoryId: null,
    },
    regionUnit,
  );
  const area = await definition(
    "geography",
    "GEO-CEBU",
    "Cebu training area",
    {
      type: "area",
      parentId: region,
      polygon: box(123.6, 10.1, 124.1, 10.6),
      territoryId: null,
    },
    regionUnit,
  );
  const territories =
    await db`select t.*,o.org_unit_id from territories t join territory_ownerships o on o.territory_id=t.id where t.code like 'SMP-%' and o.effective_to is null and o.deleted_at is null order by t.code`;
  const geos = new Map();
  for (const t of territories) {
    const [bounds] =
      await db`select min(p.longitude) x1,max(p.longitude) x2,min(p.latitude) y1,max(p.latitude) y2 from outlet_assignments a join outlet_pins p on p.outlet_id=a.outlet_id where a.territory_id=${t.id} and a.effective_to is null and a.deleted_at is null and p.status='verified' and p.effective_to is null and p.deleted_at is null`;
    const geometry = box(
      Number(bounds.x1) - 0.005,
      Number(bounds.y1) - 0.005,
      Number(bounds.x2) + 0.005,
      Number(bounds.y2) + 0.005,
    );
    const id = await definition(
      "geography",
      `GEO-${t.code}`,
      `${t.name} territory`,
      {
        type: "territory",
        parentId: area,
        polygon: geometry,
        territoryId: t.id,
      },
      t.org_unit_id,
    );
    geos.set(t.id, id);
    await ensure("census_batches", `CENSUS-${t.code}`, {
      code: `CENSUS-${t.code}`,
      name: `Sample ${t.name} census`,
      org_unit_id: t.org_unit_id,
      expected_outlets: 75,
      effective_from: effectiveFrom,
    });
    await db`update territories set geography_id=${id} where id=${t.id} and geography_id is null`;
    await db`update outlets o set geography_id=${id} from outlet_assignments a where a.outlet_id=o.id and a.territory_id=${t.id} and a.deleted_at is null and a.effective_to is null and o.geography_id is null and exists(select 1 from sample_data_rows m where m.batch=${BATCH} and m.table_name='outlets' and m.row_id=o.id::text)`;
    await definition(
      "geography",
      `ZONE-${t.code}`,
      `${t.name} zone`,
      {
        type: "zone",
        parentId: id,
        polygon: geometry,
        territoryId: null,
      },
      t.org_unit_id,
    );
  }
  const routes =
    await db`select r.*,rt.territory_id,rs.profile_id,o.org_unit_id from routes r join route_territories rt on rt.route_id=r.id and rt.effective_to is null join route_salespeople rs on rs.route_id=r.id and rs.is_primary and rs.effective_to is null join territory_ownerships o on o.territory_id=rt.territory_id and o.effective_to is null where r.code like 'SMP-%' and r.deleted_at is null order by r.code`;
  for (const r of routes)
    if (geos.has(r.territory_id))
      await definition(
        "beat",
        `BEAT-${r.code}`,
        r.name,
        {
          routeId: r.id,
          geographyId: geos.get(r.territory_id),
          weekdays: r.weekday_template?.length
            ? Array.from(r.weekday_template)
            : [1, 2, 3, 4, 5, 6],
          cycleWeeks: 1,
          start: { label: "Sample depot", latitude: 10.32, longitude: 123.9 },
          end: { label: "Sample depot", latitude: 10.32, longitude: 123.9 },
          expectedOutlets: 25,
          distanceMeters: 24000,
          repId: r.profile_id,
          vanId: null,
        },
        r.org_unit_id,
      );
  const chain = await definition(
    "chain",
    "SAMPLE-CHAIN",
    "Training retail chain",
    {},
    regionUnit,
  );
  const banner = await definition(
    "banner",
    "SAMPLE-BANNER",
    "Training grocery banner",
    { chainId: chain },
    regionUnit,
  );
  const branches =
    await db`select o.*,l.customer_id from outlets o join outlet_customer_links l on l.outlet_id=o.id and l.effective_to is null where o.channel_id=${channels.get("MT")} and exists(select 1 from sample_data_rows m where m.batch=${BATCH} and m.table_name='outlets' and m.row_id=o.id::text) order by o.code limit 3`;
  for (const b of branches)
    await definition(
      "branch",
      `BRANCH-${b.code}`,
      b.name,
      { bannerId: banner, outletId: b.id, sapCustomerId: b.customer_id },
      b.custodian_org_unit_id,
    );
  // F-616: invented editable content, marked through the existing sample manifest.
  const image = new Uint8Array(
    await Bun.file(
      new URL("../../../apps/api/assets/sample-catalogue.jpg", import.meta.url),
    ).arrayBuffer(),
  );
  const imageSha = new Bun.CryptoHasher("sha256").update(image).digest("hex");
  const catalogueProducts =
    await db`select p.*,coalesce(ip.shelf_life_days,180) shelf_life from products p left join product_inventory_policies ip on ip.product_id=p.id where exists(select 1 from sample_data_rows m where m.batch=${BATCH} and m.table_name='products' and m.row_id=p.id::text) order by p.code`;
  for (const p of catalogueProducts)
    await ensure("product_catalogue_versions", `catalogue-${p.code}`, {
      product_id: p.id,
      revision: 1,
      source: "sample",
      source_reference: "SAMPLE-CATALOGUE-V1",
      description: `SAMPLE: ${p.name}. Invented training description; not an official product claim.`,
      ingredients: sampleCatalogueIngredients(p.name),
      allergens:
        "SAMPLE ONLY: may contain soy, milk and wheat. Not an allergen declaration.",
      storage:
        "SAMPLE ONLY: follow the marked storage instructions on the actual pack and lot.",
      shelf_life_days: Number(p.shelf_life),
      case_specifications:
        "SAMPLE ONLY: outer case 400 × 300 × 220 mm. Pack counts below use governed UOM conversions.",
      image_sha256: imageSha,
      image_bytes: image.length,
      effective_from: effectiveFrom,
    });
  return {
    channels: channels.size,
    subchannels: subs.size,
    mslProfiles: channels.size * 4,
    branches: branches.length,
  };
}
/** F-616 invented ingredient families must not contradict the example product name.
 * @param {string} name */
export function sampleCatalogueIngredients(name) {
  const ingredient = /beef/i.test(name)
    ? "beef, water, salt and seasonings"
    : /chicken/i.test(name)
      ? "chicken, water, salt and seasonings"
      : /juice|drink|calamansi|mango|pineapple|orange/i.test(name)
        ? "water, fruit juice and sugar"
        : /pork|ham|bacon|tocino|longganisa|sausage|hotdog|chorizo/i.test(name)
          ? "pork, water, salt and seasonings"
          : /fish|tuna|sardine|bangus|tilapia/i.test(name)
            ? "fish, water, salt and seasonings"
            : "illustrative base ingredients and seasonings";
  return `SAMPLE ONLY: ${ingredient}. Replace with the verified food label; not an ingredient declaration.`;
}
if (import.meta.main) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const db = createDb(process.env.DATABASE_URL, { max: 2 });
  try {
    console.log(JSON.stringify(await tx(db, seedSpecMasters)));
  } catch {
    console.error(
      "Spec master seed failed; no credentials or SQL values printed.",
    );
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
