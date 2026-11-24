// SP-0170: load the PSA PSGC 3Q-2026 geography + PHLPost postal codes (see migration 0821 for
// the dataset provenance). Idempotent: upserts by PSGC code; a repeat with the same release
// changes nothing. Bulk inserts go through unnest() arrays so 42k barangays load in one pass.
import { tx } from "./client.js";

export const GEOGRAPHY_FILE = new URL(
  "../reference/ph-geography-psgc-2026q3.json",
  import.meta.url,
);

export const POSTAL_REPAIRS_FILE = new URL(
  "../reference/ph-postal-repairs-sp242.json",
  import.meta.url,
);

/** Apply reviewed PSGC-keyed additions; never infer a town from its name or parent.
 * @param {any} geography @param {any} repairs */
export function withPostalRepairs(geography, repairs) {
  const municipalities = new Map(
    geography.municipalities.map((/** @type {any} */ m) => [m.code, m]),
  );
  const postal = new Map(
    geography.postalCodes.map((/** @type {any[]} */ r) => [
      `${r[0]}:${r[1]}`,
      r,
    ]),
  );
  const seen = new Set();
  for (const r of repairs.postalCodes) {
    const municipality = /** @type {any} */ (
      municipalities.get(r.municipalityCode)
    );
    const key = `${r.municipalityCode}:${r.postalCode}`;
    if (
      !municipality ||
      municipality.name !== r.municipality ||
      !/^[0-9]{4}$/.test(r.postalCode) ||
      !repairs.sources[r.source] ||
      seen.has(key)
    )
      throw new Error(`Invalid reviewed postal mapping: ${key}`);
    seen.add(key);
    // Existing published entries remain authoritative.
    if (!postal.has(key))
      postal.set(key, [r.municipalityCode, r.postalCode, r.area, r.source]);
  }
  const postalCodes = [...postal.values()].sort((a, b) =>
    `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`),
  );
  return {
    ...geography,
    source: {
      ...geography.source,
      postalRevision: repairs.revision,
      postalRepairs: {
        sources: repairs.sources,
        unresolved: repairs.unresolved,
      },
    },
    counts: {
      ...geography.counts,
      postalCodes: postalCodes.length,
      municipalitiesWithPostal: new Set(postalCodes.map((r) => r[0])).size,
    },
    postalCodes,
  };
}

/** @param {any} [json] */
export async function readGeographyJson(json) {
  if (json) return json;
  return withPostalRepairs(
    JSON.parse(await Bun.file(GEOGRAPHY_FILE).text()),
    JSON.parse(await Bun.file(POSTAL_REPAIRS_FILE).text()),
  );
}

/** @param {any} geography */
export function geographyRelease(geography) {
  const base = geography.source.psgc.release;
  return geography.source.postalRevision
    ? `${base} / ${geography.source.postalRevision}`
    : base;
}

/** @param {any} db @param {{json?:any,actor?:string}} [opts] */
export async function loadPhGeography(db, opts = {}) {
  const g = await readGeographyJson(opts.json);
  const release = geographyRelease(g);
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
    // Earlier loads sent missing values as the text "null" (driver array of nulls); repair them.
    await t`update ph_postal_codes set area=null where area='null'`;
    await t`update ph_municipalities set city_class=null where city_class='null'`;
    /** @param {any[]} rows @param {number} i */
    // Missing values travel as "" and become NULL in SQL (a null array element arrives as "null").
    const col = (rows, i) =>
      t.array(
        rows.map((r) => r[i] ?? ""),
        "TEXT",
      );
    if (done && n === barangays.length) {
      // A PSGC release/count alone says nothing about its separately sourced postal list.
      // Check keys, not just a count: another city's extra entry can hide a missing one.
      const [missing] =
        await t`select 1 from unnest(${col(g.postalCodes, 0)}::text[],${col(g.postalCodes, 1)}::text[]) as expected(m,c)
        where not exists (select 1 from ph_postal_codes p where p.municipality_code=expected.m and p.postal_code=expected.c) limit 1`;
      if (!missing) return { release, loaded: false, ...g.counts };
    }
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
    await t`insert into ph_municipalities(code,province_code,region_code,name,kind,city_class) select code,province_code,region_code,name,kind,nullif(city_class,'') from unnest(${col(municipalities, 0)}::text[],${col(municipalities, 1)}::text[],${col(municipalities, 2)}::text[],${col(municipalities, 3)}::text[],${col(municipalities, 4)}::text[],${col(municipalities, 5)}::text[]) as m(code,province_code,region_code,name,kind,city_class)
      on conflict(code) do update set province_code=excluded.province_code,region_code=excluded.region_code,name=excluded.name,kind=excluded.kind,city_class=excluded.city_class`;
    for (let i = 0; i < barangays.length; i += 10000) {
      const part = barangays.slice(i, i + 10000);
      await t`insert into ph_barangays(code,municipality_code,name) select * from unnest(${col(part, 0)}::text[],${col(part, 1)}::text[],${col(part, 2)}::text[])
        on conflict(code) do update set municipality_code=excluded.municipality_code,name=excluded.name`;
    }
    const postal = g.postalCodes;
    await t`insert into ph_postal_codes(municipality_code,postal_code,area,source) select m,c,nullif(a,''),s from unnest(${col(postal, 0)}::text[],${col(postal, 1)}::text[],${col(postal, 2)}::text[],${col(postal, 3)}::text[]) as x(m,c,a,s)
      on conflict(municipality_code,postal_code) do update set area=excluded.area,source=excluded.source`;
    await t`insert into ph_geography_releases(release,source,counts,loaded_by) values(${release},${g.source},${g.counts},${actor})
      on conflict(release) do update set counts=excluded.counts,loaded_by=excluded.loaded_by`;
    await t`insert into audit_logs(subject,action,entity_type,entity_id,details)
      values(${actor},'customer_master.geography.load','ph_geography_releases',${release},${JSON.stringify(g.counts)})`;
    return { release, loaded: true, ...g.counts };
  });
}
