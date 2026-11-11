// SP-0170: load the PSA PSGC 3Q-2026 geography + PHLPost postal codes (see migration 0821 for
// the dataset provenance). Idempotent: upserts by PSGC code; a repeat with the same release
// changes nothing. Bulk inserts go through unnest() arrays so 42k barangays load in one pass.
import { tx } from "./client.js";

export const GEOGRAPHY_FILE = new URL(
  "../reference/ph-geography-psgc-2026q3.json",
  import.meta.url,
);

/** @param {any} [json] */
export async function readGeographyJson(json) {
  return json ?? JSON.parse(await Bun.file(GEOGRAPHY_FILE).text());
}

/** @param {any} db @param {{json?:any,actor?:string}} [opts] */
export async function loadPhGeography(db, opts = {}) {
  const g = await readGeographyJson(opts.json);
  const release = g.source.psgc.release;
  const actor = opts.actor ?? "system:geography";
  const barangays = Object.entries(
    /** @type {Record<string,[string,string][]>} */ (g.barangays),
  ).flatMap(([municipality, rows]) =>
    rows.map(([code, name]) => [code, municipality, name]),
  );
  return tx(db, async (/** @type {any} */ t) => {
    await t`select pg_advisory_xact_lock(4310170)`;
    const [done] =
      await t`select 1 from ph_geography_releases where release=${release}`;
    const [{ n }] = await t`select count(*)::int as n from ph_barangays`;
    if (done && n === barangays.length)
      return { release, loaded: false, ...g.counts };
    /** @param {any[]} rows @param {number} i */
    const col = (rows, i) =>
      t.array(
        rows.map((r) => r[i]),
        "TEXT",
      );
    const regions = g.regions.map((/** @type {any} */ r) => [r.code, r.name]);
    await t`insert into ph_regions(code,name) select * from unnest(${col(regions, 0)}::text[],${col(regions, 1)}::text[])
      on conflict(code) do update set name=excluded.name where ph_regions.name is distinct from excluded.name`;
    const provinces = g.provinces.map((/** @type {any} */ r) => [
      r.code,
      r.regionCode,
      r.name,
      r.kind,
    ]);
    await t`insert into ph_provinces(code,region_code,name,kind) select * from unnest(${col(provinces, 0)}::text[],${col(provinces, 1)}::text[],${col(provinces, 2)}::text[],${col(provinces, 3)}::text[])
      on conflict(code) do update set region_code=excluded.region_code,name=excluded.name,kind=excluded.kind`;
    const municipalities = g.municipalities.map((/** @type {any} */ r) => [
      r.code,
      r.provinceCode,
      r.regionCode,
      r.name,
      r.kind,
      r.cityClass ?? null,
    ]);
    await t`insert into ph_municipalities(code,province_code,region_code,name,kind,city_class) select * from unnest(${col(municipalities, 0)}::text[],${col(municipalities, 1)}::text[],${col(municipalities, 2)}::text[],${col(municipalities, 3)}::text[],${col(municipalities, 4)}::text[],${col(municipalities, 5)}::text[])
      on conflict(code) do update set province_code=excluded.province_code,region_code=excluded.region_code,name=excluded.name,kind=excluded.kind,city_class=excluded.city_class`;
    for (let i = 0; i < barangays.length; i += 10000) {
      const part = barangays.slice(i, i + 10000);
      await t`insert into ph_barangays(code,municipality_code,name) select * from unnest(${col(part, 0)}::text[],${col(part, 1)}::text[],${col(part, 2)}::text[])
        on conflict(code) do update set municipality_code=excluded.municipality_code,name=excluded.name`;
    }
    const postal = g.postalCodes;
    await t`insert into ph_postal_codes(municipality_code,postal_code,area,source) select * from unnest(${col(postal, 0)}::text[],${col(postal, 1)}::text[],${col(postal, 2)}::text[],${col(postal, 3)}::text[])
      on conflict(municipality_code,postal_code) do update set area=excluded.area,source=excluded.source`;
    await t`insert into ph_geography_releases(release,source,counts,loaded_by) values(${release},${g.source},${g.counts},${actor})
      on conflict(release) do update set counts=excluded.counts,loaded_by=excluded.loaded_by`;
    await t`insert into audit_logs(subject,action,entity_type,entity_id,details)
      values(${actor},'customer_master.geography.load','ph_geography_releases',${release},${JSON.stringify(g.counts)})`;
    return { release, loaded: true, ...g.counts };
  });
}
