// SP-0242: real PostgreSQL + authenticated routes, with one sample customer and two
// sample users. This is isolated local proof, not a live-system or phone proof.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  GEOGRAPHY_FILE,
  POSTAL_REPAIRS_FILE,
  geographyRelease,
  loadPhGeography,
  readGeographyJson,
  withPostalRepairs,
} from "@sunpride/db/ph-geography";
import { startHarness, createUser } from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as masters } from "../src/domains/masters/index.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let baseline;
/** @type {any} */ let repaired;
/** @type {any} */ let repairs;
let repairSql = "";
let unitId = "";
const cookies = /** @type {Record<string,string>} */ ({});

/** @param {string} role @param {string} path @param {any} [body] */
async function call(role, path, body) {
  const response = await h.fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      cookie: cookies[role],
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    body: /** @type {any} */ (await response.json()),
  };
}
async function missingMunicipalities() {
  return h.db`select code from ph_municipalities m where not exists
    (select 1 from ph_postal_codes p where p.municipality_code=m.code) order by code`;
}
async function counts() {
  return (
    await h.db`select
    (select count(*)::int from ph_postal_codes) postal,
    (select count(distinct municipality_code)::int from ph_postal_codes) covered,
    (select count(*)::int from ph_geography_releases) releases,
    (select count(*)::int from audit_logs) audits,
    (select count(*)::int from outlets) customers`
  )[0];
}

beforeAll(async () => {
  h = await startHarness({ installers: [org, masters] });
  baseline = JSON.parse(await Bun.file(GEOGRAPHY_FILE).text());
  repairs = JSON.parse(await Bun.file(POSTAL_REPAIRS_FILE).text());
  repaired = await readGeographyJson();
  repairSql = await Bun.file(
    new URL(
      "../../../packages/db/migrations/0849_ph_postal_repairs.sql",
      import.meta.url,
    ),
  ).text();
  // Rehearse an existing installation: migration initially met empty reference tables,
  // then the old release was loaded. The repair must work without a new sample seed.
  await loadPhGeography(h.db, { json: baseline });
  const [unit] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from)
    values('sunpride','SUNPRIDE','SP-0242 sample office','NATIONAL','active','2020-01-01') returning id`;
  unitId = unit.id;
  for (const role of ["admin", "sales"]) {
    const email = `postal-${role}@example.test`;
    const password = "sample-postal-password";
    const userId = await createUser(h, email, password);
    const [profile] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id)
      values(${userId},${userId},'SP-0242 sample user',${email},${role},'active',${unitId}) returning id`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)
      values(${profile.id},${unitId},${role},'2020-01-01',${userId},'SP-0242 sample')`;
    const login = await h.fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(login.status).toBe(200);
    cookies[role] = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  }
}, 120000);
afterAll(async () => {
  await h?.close();
});

test("reviewed mappings fill 152 missing municipalities without guessing the eight unpublished ZIPs", () => {
  const covered = new Set(
    baseline.postalCodes.map((/** @type {any[]} */ r) => r[0]),
  );
  expect(
    baseline.municipalities.filter(
      (/** @type {any} */ m) => !covered.has(m.code),
    ),
  ).toHaveLength(160);
  expect(repairs.postalCodes).toHaveLength(166);
  expect(
    new Set(
      repairs.postalCodes.map((/** @type {any} */ r) => r.municipalityCode),
    ).size,
  ).toBe(152);
  expect(repaired.counts).toMatchObject({
    postalCodes: 1869,
    municipalitiesWithPostal: 1647,
  });
  expect(repairs.unresolved).toHaveLength(8);
  const nowCovered = new Set(
    repaired.postalCodes.map((/** @type {any[]} */ r) => r[0]),
  );
  expect(
    repaired.municipalities
      .filter((/** @type {any} */ m) => !nowCovered.has(m.code))
      .map((/** @type {any} */ m) => m.code)
      .sort(),
  ).toEqual(
    repairs.unresolved.map((/** @type {any} */ r) => r.municipalityCode).sort(),
  );
  // The immutable original reference is not rewritten or reduced.
  const byKey = new Map(
    repaired.postalCodes.map((/** @type {any[]} */ r) => [
      `${r[0]}:${r[1]}`,
      r,
    ]),
  );
  for (const row of baseline.postalCodes)
    expect(byKey.get(`${row[0]}:${row[1]}`)).toEqual(row);
  const wrongTown = structuredClone(repairs);
  wrongTown.postalCodes[0].municipalityCode = "0000000000";
  expect(() => withPostalRepairs(baseline, wrongTown)).toThrow(
    "Invalid reviewed postal mapping",
  );
  const duplicate = structuredClone(repairs);
  duplicate.postalCodes.push(duplicate.postalCodes[0]);
  expect(() => withPostalRepairs(baseline, duplicate)).toThrow(
    "Invalid reviewed postal mapping",
  );
});

test("additive repair reaches an old populated installation and is safe to repeat", async () => {
  expect(await missingMunicipalities()).toHaveLength(160);
  await tx(h.db, async (t) => {
    await t.unsafe(repairSql);
  });
  expect(
    (await missingMunicipalities()).map((/** @type {any} */ r) => r.code),
  ).toEqual(
    repairs.unresolved.map((/** @type {any} */ r) => r.municipalityCode).sort(),
  );
  expect(await counts()).toMatchObject({
    postal: 1869,
    covered: 1647,
    releases: 2,
    customers: 0,
  });
  const [release] =
    await h.db`select release,counts,source from ph_geography_releases where release=${geographyRelease(repaired)}`;
  expect(release.counts).toMatchObject({
    postalCodes: 1869,
    municipalitiesWithPostal: 1647,
  });
  expect(release.source.postalRevision).toBe(repairs.revision);
  const before = await counts();
  await tx(h.db, async (t) => {
    await t.unsafe(repairSql);
  });
  expect(await counts()).toEqual(before);
  expect((await loadPhGeography(h.db)).loaded).toBe(false);
  expect(await counts()).toEqual(before);
});

test("office postal picker and field download include every reviewed mapping, scoped by municipality", async () => {
  const pack = await call("sales", "/api/v1/geography/pack");
  expect(pack.status).toBe(200);
  expect(pack.body.release).toBe(geographyRelease(repaired));
  const keys = new Set(
    pack.body.postalCodes.map(
      (/** @type {any} */ r) => `${r.municipalityCode}:${r.code}`,
    ),
  );
  expect(keys.size).toBe(1869);
  for (const r of repairs.postalCodes)
    expect(keys.has(`${r.municipalityCode}:${r.postalCode}`)).toBe(true);
  for (const [municipality, expected] of [
    ["0702210000", ["6036"]], // Barili, Cebu
    ["0702243000", ["6011"]], // San Remigio, Cebu
    ["0600614000", ["5714"]], // San Remigio, Antique
    ["0701216000", ["6341"]], // Cortes, Bohol
    ["1606808000", ["8313"]], // Cortes, Surigao del Sur
    ["0103311000", ["2511"]], // Naguilian, La Union
    ["0203120000", ["3302"]], // Naguilian, Isabela
    ["0301403000", ["3006"]], // Baliwag (PHLPost: Baliuag)
    ["1900708000", ["7307"]], // Akbar, Basilan
    ["1380700000", Array.from({ length: 12 }, (_, i) => String(1800 + i))],
  ]) {
    const options = await call(
      "admin",
      `/api/v1/geography/postal-codes?municipalityCode=${municipality}`,
    );
    expect(options.status).toBe(200);
    expect(options.body.options.map((/** @type {any} */ r) => r.code)).toEqual(
      expected,
    );
  }
});

test("a customer with a previously missing postal entry saves and reopens", async () => {
  const [barangay] =
    await h.db`select code from ph_barangays where municipality_code='0702210000' order by code limit 1`;
  const created = await call("admin", "/api/v1/customers", {
    custodianOrgUnitId: unitId,
    customer: {
      registeredName: "SP-0242 Sample Store",
      customerName: "Sample Store Owner",
      mobileNo: "09171234567",
      taxClassificationCode: "1",
      regionCode: "0700000000",
      provinceCode: "0702200000",
      municipalityCode: "0702210000",
      barangayCode: barangay.code,
      street1: "Sample Street",
      postalCode: "6036",
      latitude: 10.11,
      longitude: 123.5,
      salesOrgCode: "1000",
      salesOfficeCode: "100",
      distributionChannelCode: "50",
      customerGroupCode: "74",
      typeOfBusiness: "Sole Proprietor",
      paymentTermsCode: "0003",
      pricingProcedureCode: "2",
      deliveringPlantCode: "1000",
      shipTos: [{ sameAsCustomer: true, contactPerson: "Sample Contact" }],
    },
  });
  expect(created.status).toBe(200);
  const reopened = await call("admin", `/api/v1/customers/${created.body.id}`);
  expect(reopened.status).toBe(200);
  expect(reopened.body).toMatchObject({
    municipalityCode: "0702210000",
    postalCode: "6036",
    completeness: "complete",
  });
});

test("loader repairs a missing postal key even if another entry keeps the old row count", async () => {
  const before = await counts();
  await h.db`delete from ph_postal_codes where municipality_code='0702210000' and postal_code='6036'`;
  await h.db`insert into ph_postal_codes(municipality_code,postal_code,source) values('0702243000','9999','SP-0242 sample manual entry')`;
  expect((await counts()).postal).toBe(before.postal);
  expect((await loadPhGeography(h.db)).loaded).toBe(true);
  const restored =
    await h.db`select postal_code from ph_postal_codes where municipality_code='0702210000'`;
  expect(restored.map((/** @type {any} */ r) => r.postal_code)).toEqual([
    "6036",
  ]);
  // A legitimate installation-specific extra is never deleted by the loader/repair.
  expect(
    await h.db`select postal_code from ph_postal_codes where municipality_code='0702243000' and postal_code='9999'`,
  ).toHaveLength(1);
  const stable = await counts();
  expect((await loadPhGeography(h.db)).loaded).toBe(false);
  expect(await counts()).toEqual(stable);
});
