import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { formatAddress, validateCustomer } from "@sunpride/customer-master";
import {
  loadCustomerReference,
  readReferenceJson,
  referenceRows as jsonRows,
} from "@sunpride/db/customer-reference";
import { loadPhGeography } from "@sunpride/db/ph-geography";
import { startHarness } from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as masters } from "../src/domains/masters/index.js";
import {
  readCustomer,
  referenceRows,
  resolveGeography,
} from "../src/domains/masters/customers.js";
import { seedDemo } from "../../../packages/db/seed/index.js";
import {
  rowId,
  todayManila,
  plusDays,
} from "../../../packages/db/seed/store.js";

/** @type {import('./harness.js').Harness} */ let h;
const cookies = /** @type {Record<string,string>} */ ({});
const UNIT = rowId("org_units", "territory-0");

/** @param {string} role */
async function signIn(role) {
  const password = (
    await Bun.file(`${process.env.HOME}/.sunpride-keys/v2-test-password`).text()
  ).trim();
  const r = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${role}@sunpride.test`, password }),
  });
  expect(r.status).toBe(200);
  cookies[role] = r.headers.get("set-cookie")?.split(";")[0] ?? "";
}
/** @param {string} role @param {string} method @param {string} path @param {any} [body] @param {string} [key] */
async function call(role, method, path, body, key) {
  const r = await h.fetch(path, {
    method,
    headers: {
      cookie: cookies[role],
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return {
    status: r.status,
    body: /** @type {any} */ (text ? JSON.parse(text) : null),
  };
}
/** @param {Record<string, any>} [over] */
const customer = (over = {}) => ({
  registeredName: "Tindahan ni Aling Rosa Inc.",
  customerName: "Aling Rosa Store",
  mobileNo: "+639171234567",
  email: "Rosa@Example.PH",
  tin: "123456789",
  taxClassificationCode: "1",
  regionCode: "0700000000",
  provinceCode: "0702200000",
  municipalityCode: "0730600000",
  barangayCode: "0730600003",
  houseNo: "12",
  street1: "Gorordo Ave",
  postalCode: "6000",
  latitude: 10.3312,
  longitude: 123.9056,
  salesOrgCode: "1000",
  salesOfficeCode: "100",
  distributionChannelCode: "41",
  customerGroup1Code: "RSF",
  customerGroup2Code: "RSS",
  customerGroupCode: "74",
  typeOfBusiness: "Sole Proprietor",
  paymentTermsCode: "0003",
  creditLimit: 15000,
  pricingProcedureCode: "2",
  deliveringPlantCode: "1000",
  ...over,
});
/** @param {string} id */
async function accounting(id) {
  return h.db`select c.code,c.name,c.active,c.credit_limit::float as credit from outlet_customer_links l join customers c on c.id=l.customer_id
    where l.outlet_id=${id} and l.deleted_at is null and l.effective_from<=now() and (l.effective_to is null or l.effective_to>now())`;
}

beforeAll(async () => {
  h = await startHarness({ installers: [org, masters] });
  await seedDemo(h.db, { days: 3, anchorDate: plusDays(todayManila(), 1) });
  await loadPhGeography(h.db);
  for (const role of ["admin", "manager", "viewer", "agent"])
    await signIn(role);
}, 240000);
afterAll(async () => {
  await h?.close();
});

describe("SP-0170 reference lists", () => {
  test("seeded counts equal the client JSON and the loader is idempotent", async () => {
    const expected = jsonRows(await readReferenceJson());
    const counts = Object.fromEntries(
      (
        await h.db`select list,count(*)::int n from customer_reference_values where active group by list`
      ).map((/** @type {any} */ r) => [r.list, r.n]),
    );
    /** @type {Record<string, number>} */ const want = {};
    for (const r of expected) want[r.list] = (want[r.list] ?? 0) + 1;
    expect(counts).toEqual(want);
    expect(want.customer_group).toBe(91);
    expect(want.distribution_channel).toBe(11);
    expect(await loadCustomerReference(h.db)).toEqual({
      rows: expected.length,
      changed: 0,
    });
  });
  test("chain is filtered per sales org: ARI only 20/70/80", async () => {
    const ari = await call(
      "viewer",
      "GET",
      "/api/v1/customers/reference/distribution_channel?salesOrgCode=2000",
    );
    expect(ari.status).toBe(200);
    expect(ari.body.options.map((/** @type {any} */ o) => o.code)).toEqual([
      "20",
      "70",
      "80",
    ]);
    expect(ari.body.options[0].label).toBe("Food Service (20)");
    const g1 = await call(
      "viewer",
      "GET",
      "/api/v1/customers/reference/customer_group_1?salesOrgCode=2000&distributionChannelCode=70",
    );
    expect(g1.body.options.map((/** @type {any} */ o) => o.code)).toEqual([
      "OSD",
    ]);
    const g2 = await call(
      "viewer",
      "GET",
      "/api/v1/customers/reference/customer_group_2?salesOrgCode=1000&distributionChannelCode=41&customerGroup1Code=RSF",
    );
    expect(g2.body.options.map((/** @type {any} */ o) => o.code)).toEqual([
      "RWM",
      "RMS",
      "RGS",
      "RSS",
    ]);
    expect(
      (await call("viewer", "GET", "/api/v1/customers/reference/sales_office"))
        .status,
    ).toBe(400);
    const terms = await call(
      "viewer",
      "GET",
      "/api/v1/customers/reference/payment_terms",
    );
    expect(terms.body.options.map((/** @type {any} */ o) => o.label)).toContain(
      "Due in 7 days (0003)",
    );
    const partners = await call(
      "viewer",
      "GET",
      "/api/v1/customers/reference/sales_partner",
    );
    expect(partners.body.options.length).toBeGreaterThan(0); // fallback: active field/van sales employees
  });
  test("field list follows the sheet", async () => {
    const r = await call("viewer", "GET", "/api/v1/customers/fields");
    const json = await readReferenceJson();
    expect(r.body.fields.map((/** @type {any} */ f) => f.label)).toEqual(
      json.fields.map((/** @type {any} */ f) => f.field),
    );
  });
});

describe("SP-0170 geography", () => {
  test("dependent PSGC lists and postal codes", async () => {
    const regions = await call("viewer", "GET", "/api/v1/geography/regions");
    expect(regions.body.options).toHaveLength(18);
    const provinces = await call(
      "viewer",
      "GET",
      "/api/v1/geography/provinces?regionCode=0700000000",
    );
    expect(
      provinces.body.options.map((/** @type {any} */ p) => p.name),
    ).toContain("Cebu");
    const towns = await call(
      "viewer",
      "GET",
      "/api/v1/geography/municipalities?provinceCode=0702200000",
    );
    expect(towns.body.options.map((/** @type {any} */ p) => p.name)).toContain(
      "City of Mandaue",
    );
    const brgys = await call(
      "viewer",
      "GET",
      "/api/v1/geography/barangays?municipalityCode=0731300000",
    );
    expect(brgys.body.options.map((/** @type {any} */ p) => p.name)).toContain(
      "Banilad",
    );
    const zips = await call(
      "viewer",
      "GET",
      "/api/v1/geography/postal-codes?municipalityCode=0731300000",
    );
    expect(zips.body.options.map((/** @type {any} */ p) => p.code)).toEqual([
      "6014",
    ]);
    expect(
      (await call("viewer", "GET", "/api/v1/geography/provinces")).status,
    ).toBe(400);
    const [{ n }] = await h.db`select count(*)::int n from ph_barangays`;
    expect(n).toBe(42010);
    expect((await loadPhGeography(h.db)).loaded).toBe(false);
    // Missing areas/city classes are NULL, never the text "null" (shown in dropdowns).
    const [bad] =
      await h.db`select (select count(*)::int from ph_postal_codes where area='null') as area,
        (select count(*)::int from ph_municipalities where city_class='null') as cls,
        (select count(*)::int from ph_postal_codes where area is null) as missing`;
    expect(bad).toMatchObject({ area: 0, cls: 0 });
    expect(bad.missing).toBeGreaterThan(0);
  });
  test("SQL and JS one-line address agree", async () => {
    const parts = {
      roomStallNo: "Stall 4",
      floor: "2F",
      houseNo: "12",
      street1: "Gorordo Ave",
      street2: null,
      barangayName: "Apas",
      municipalityName: "City of Cebu",
      provinceName: "Cebu",
      postalCode: "6000",
    };
    const [{ line }] =
      await h.db`select customer_address_line(${parts.roomStallNo},${parts.floor},${parts.houseNo},${parts.street1},${parts.street2},${parts.barangayName},${parts.municipalityName},${parts.provinceName},${parts.postalCode}) as line`;
    expect(line).toBe(formatAddress(parts));
  });
});

describe("SP-0170 sample migration", () => {
  test("every sample store has the customer shape, same code as its accounting customer", async () => {
    /** @type {any[]} */ const rows =
      await h.db`select o.code,o.name,o.channel,p.sales_org_code,p.distribution_channel_code dc,p.customer_group1_code g1,p.customer_group2_code g2,p.customer_group_code cg,p.registered_name,p.completeness,c.code as customer_code
      from outlets o join customer_profiles p on p.outlet_id=o.id
      left join outlet_customer_links l on l.outlet_id=o.id and l.deleted_at is null and (l.effective_to is null or l.effective_to>now())
      left join customers c on c.id=l.customer_id where o.code like 'SMP-%'`;
    const [{ n }] =
      await h.db`select count(*)::int n from outlets where code like 'SMP-%' and deleted_at is null`;
    expect(rows.length).toBe(n);
    expect(n).toBe(301);
    for (const r of rows) {
      expect(r.sales_org_code).toBe("1000");
      expect(r.registered_name).toMatch(/^Sample /);
      if (r.customer_code) expect(r.customer_code).toBe(r.code);
    }
    /** @param {string} ch */
    const shape = (ch) => [
      ...new Set(
        rows
          .filter((r) => r.channel === ch)
          .map((r) => `${r.dc}/${r.g1}/${r.g2}/${r.cg}`),
      ),
    ];
    const sari = rows.filter((r) => r.channel === "gt" && /sari/i.test(r.name));
    expect([
      ...new Set(sari.map((r) => `${r.dc}/${r.g1}/${r.g2}/${r.cg}`)),
    ]).toEqual(["41/RSF/RSS/74"]);
    expect([
      ...new Set(
        rows
          .filter((r) => r.channel === "gt" && !/sari/i.test(r.name))
          .map((r) => `${r.dc}/${r.g1}/${r.g2}`),
      ),
    ]).toEqual(["30/KAS3/GGS"]);
    expect(shape("pmot")).toEqual(["41/RSF/RWM/82"]);
    expect(shape("supermarket")).toEqual(["30/KAS3/GSS/74"]);
    expect(shape("kas")).toEqual(["10/KAS2/KAL/74"]);
    expect(rows.filter((r) => r.customer_code).length).toBe(300);
  });
  test("migrated samples pass the shared complete-level validation", async () => {
    const [o] = await h.db`select id from outlets where code='SMP-C0001'`;
    const c = await readCustomer(h.db, o.id);
    const result = validateCustomer(c, {
      level: "complete",
      lists: await referenceRows(h.db),
      geography: await resolveGeography(h.db, c),
    });
    expect(result.errors).toEqual([]);
    expect(c.completeness).toBe("complete");
    expect(c.shipTos).toHaveLength(1);
    expect(c.distributionChannelName).toBe("Route Sales");
  });
  test("analytics reads the Distribution Channel; channel targets follow it", async () => {
    const channels = (
      await h.db`select distinct channel from analytics_store_scope where code like 'SMP-%' order by 1`
    ).map((/** @type {any} */ r) => r.channel);
    expect(channels).toEqual(["General Trade", "Key Accounts", "Route Sales"]);
    const keys = (
      await h.db`select distinct target_key from sales_targets where level='channel' and deleted_at is null order by 1`
    ).map((/** @type {any} */ r) => r.target_key);
    expect(keys).toEqual(["General Trade", "Key Accounts", "Route Sales"]);
  });
});

describe("SP-0170 customer writer", () => {
  /** @type {string} */ let id;
  test("create: new shape, same-as-customer ship-to, accounting customer 1:1 with the same code", async () => {
    const r = await call(
      "admin",
      "POST",
      "/api/v1/customers",
      {
        custodianOrgUnitId: UNIT,
        customer: customer({ contactPerson: "Rosa" }),
        reason: "New account",
      },
      crypto.randomUUID(),
    );
    if (r.status !== 200) console.log(JSON.stringify(r.body));
    expect(r.status).toBe(200);
    id = r.body.id;
    expect(r.body).toMatchObject({
      status: "prospect",
      completeness: "complete",
      customerAddress: "12 Gorordo Ave, Apas, City of Cebu, Cebu 6000",
      mobileNo: "09171234567",
      email: "rosa@example.ph",
      tin: "123-456-789",
      distributionChannelName: "Route Sales",
      customerGroup2Name: "Sari-Sari Store",
      paymentTermsName: "Due in 7 days",
      pinStatus: "pending",
      legacyChannel: "41",
    });
    expect(r.body.shipTos).toEqual([
      expect.objectContaining({
        ordinal: 0,
        sameAsCustomer: true,
        contactPerson: "Rosa",
        shipToParty: "Aling Rosa Store",
        shipToAddress: "12 Gorordo Ave, Apas, City of Cebu, Cebu 6000",
        mobileNo: "09171234567",
      }),
    ]);
    expect(await accounting(id)).toEqual([
      {
        code: r.body.code,
        name: "Aling Rosa Store",
        active: true,
        credit: 15000,
      },
    ]);
  });
  test("update keeps the accounting customer in step; multiple ship-to; code change moves both", async () => {
    const r = await call("admin", "PUT", `/api/v1/customers/${id}`, {
      customer: {
        customerName: "Aling Rosa Mini Mart",
        creditLimit: 20000,
        shipTos: [
          { sameAsCustomer: true, contactPerson: "Rosa" },
          {
            shipToParty: "Rosa Warehouse",
            shipToAddress: "Lot 5, Banilad, City of Mandaue",
            contactPerson: "Ben",
            mobileNo: "09181234567",
            email: "ben@example.ph",
          },
        ],
      },
      code: "CM-ROSA-001",
    });
    expect(r.status).toBe(200);
    expect(r.body.code).toBe("CM-ROSA-001");
    expect(r.body.shipTos.map((/** @type {any} */ s) => s.shipToParty)).toEqual(
      ["Aling Rosa Mini Mart", "Rosa Warehouse"],
    );
    expect(await accounting(id)).toEqual([
      {
        code: "CM-ROSA-001",
        name: "Aling Rosa Mini Mart",
        active: true,
        credit: 20000,
      },
    ]);
    const [{ n }] =
      await h.db`select count(*)::int n from customers where code like 'CM-ROSA%' or name like 'Aling Rosa%'`;
    expect(n).toBe(1);
  });
  test("dependent-list and format errors use the client's labels", async () => {
    const r = await call("admin", "POST", "/api/v1/customers", {
      custodianOrgUnitId: UNIT,
      customer: customer({
        salesOrgCode: "2000",
        distributionChannelCode: "30",
        mobileNo: "12345",
        postalCode: "6014",
      }),
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("validation_failed");
    const errors = r.body.error.details.errors
      .map((/** @type {any} */ e) => `${e.label}:${e.code}`)
      .sort();
    expect(errors).toEqual([
      "Customer Grp 1:not_for_channel",
      "Customer Grp 2:not_for_group1",
      "Delivering Plant:not_for_sales_org",
      "Distribution Channel:not_for_sales_org",
      "Mobile No.:invalid_mobile",
      "Mobile No.:invalid_mobile",
      "Postal Code:postal_code_mismatch",
      "Sales Office:not_for_sales_org",
    ]);
  });
  test("draft saves; approval requires complete; then activates", async () => {
    const draft = await call("admin", "POST", "/api/v1/customers", {
      custodianOrgUnitId: UNIT,
      customer: { customerName: "Field draft store" },
    });
    if (draft.status !== 200) console.log(JSON.stringify(draft.body));
    expect(draft.status).toBe(200);
    expect(draft.body).toMatchObject({
      status: "prospect",
      completeness: "draft",
    });
    expect((await accounting(draft.body.id))[0].code).toBe(draft.body.code);
    const refused = await call(
      "manager",
      "POST",
      `/api/v1/customers/${draft.body.id}/approve`,
      { reason: "check" },
    );
    expect(refused.status).toBe(422);
    const labels = refused.body.error.details.errors.map(
      (/** @type {any} */ e) => e.label,
    );
    expect(labels).toContain("Registered Name");
    expect(labels).toContain("Terms of payment");
    expect(labels).toContain("Geographical Coordinates");
    const filled = await call(
      "admin",
      "PUT",
      `/api/v1/customers/${draft.body.id}`,
      {
        customer: customer({
          customerName: "Field draft store",
          distributionChannelCode: "20",
          customerGroup1Code: "FRT",
          customerGroup2Code: null,
          shipTos: [{ sameAsCustomer: true, contactPerson: "Owner" }],
        }),
      },
    );
    expect(filled.status).toBe(200);
    expect(filled.body.completeness).toBe("complete");
    const ok = await call(
      "manager",
      "POST",
      `/api/v1/customers/${draft.body.id}/approve`,
      { reason: "Complete" },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("active");
  });
  test("ADP block only for Distributive Trade", async () => {
    const missing = await call("admin", "POST", "/api/v1/customers", {
      custodianOrgUnitId: UNIT,
      customer: customer({
        distributionChannelCode: "40",
        customerGroup1Code: "ADP",
        customerGroup2Code: "DSS",
      }),
    });
    expect(missing.status).toBe(200);
    expect(missing.body.completeness).toBe("draft");
    const refused = await call(
      "manager",
      "POST",
      `/api/v1/customers/${missing.body.id}/approve`,
      {},
    );
    expect(
      refused.body.error.details.errors.map((/** @type {any} */ e) => e.label),
    ).toContain("Cluster #");
  });
  test("deactivate takes the accounting customer with it", async () => {
    const r = await call(
      "admin",
      "POST",
      `/api/v1/customers/${id}/deactivate`,
      { reason: "Closed" },
    );
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("inactive");
    expect((await accounting(id))[0].active).toBe(false);
  });
  test("list, filters and permissions", async () => {
    const list = await call(
      "viewer",
      "GET",
      "/api/v1/customers?distributionChannelCode=10&limit=5",
    );
    expect(list.status).toBe(200);
    expect(list.body.rows).toHaveLength(5);
    expect(
      list.body.rows.every(
        (/** @type {any} */ r) => r.distributionChannelName === "Key Accounts",
      ),
    ).toBe(true);
    expect(list.body.nextCursor).toBeTruthy();
    const paged = await call(
      "viewer",
      "GET",
      "/api/v1/customers?distributionChannelCode=10&limit=2&offset=2",
    );
    expect(paged.status).toBe(200);
    expect(paged.body.rows.map((/** @type {any} */ r) => r.code)).toEqual(
      list.body.rows.slice(2, 4).map((/** @type {any} */ r) => r.code),
    );
    expect(paged.body.total).toBeGreaterThanOrEqual(5);
    expect(paged.body.rows[0]).toHaveProperty("registeredName");
    const office = list.body.rows.find(
      (/** @type {any} */ r) => r.salesOfficeCode,
    )?.salesOfficeCode;
    if (office) {
      const byOffice = await call(
        "viewer",
        "GET",
        `/api/v1/customers?salesOfficeCode=${office}&limit=200`,
      );
      expect(
        byOffice.body.rows.every(
          (/** @type {any} */ r) => r.salesOfficeCode === office,
        ),
      ).toBe(true);
    }
    const none = await call(
      "viewer",
      "GET",
      "/api/v1/customers?customerGroup2Code=__none__&offset=0",
    );
    expect(none.body).toMatchObject({ rows: [], total: 0 });
    expect(
      (
        await call("viewer", "POST", "/api/v1/customers", {
          custodianOrgUnitId: UNIT,
          customer: customer(),
        })
      ).status,
    ).toBe(403);
    const v = await call("viewer", "POST", "/api/v1/customers/validate", {
      level: "complete",
      customer: customer({
        customerGroup2Code: null,
        shipTos: [{ sameAsCustomer: true, contactPerson: "Rosa" }],
      }),
    });
    expect(v.body).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({ code: "required", label: "Customer Grp 2" }),
      ],
    });
  });
  test("field capture: enrolment carries the client's fields; office completes; approval allocates the code for both records", async () => {
    const [agent] =
      await h.db`select p.user_id,p.org_unit_id from profiles p where p.email='agent@sunpride.test'`;
    const [file] =
      await h.db`insert into files(purpose,sha256,mime,size,status,created_by) values('outlet_photo',${"a".repeat(64)},'image/jpeg',100,'stored',${agent.user_id}) returning id`;
    const proposed = await call(
      "agent",
      "POST",
      "/api/v1/outlets/enrolment/propose",
      {
        name: "Field Sari-sari",
        address: "Near the chapel",
        contactName: "Owner Ana",
        contactPhone: "09170000001",
        latitude: 10.3,
        longitude: 123.9,
        photoStorageIds: [file.id],
        clientRequestId: crypto.randomUUID(),
        customer: {
          salesOrgCode: "1000",
          distributionChannelCode: "41",
          customerGroup1Code: "RSF",
          customerGroup2Code: "RSS",
          mobileNo: "09170000001",
          typeOfBusiness: "Sole Proprietor",
          regionCode: "0700000000",
          provinceCode: "0702200000",
          municipalityCode: "0730600000",
          barangayCode: "0730600003",
          postalCode: "6000",
        },
      },
    );
    if (proposed.status !== 200) console.log(JSON.stringify(proposed.body));
    expect(proposed.status).toBe(200);
    const outletId = proposed.body.outletId;
    const draft = await readCustomer(h.db, outletId);
    expect(draft).toMatchObject({
      completeness: "draft",
      distributionChannelName: "Route Sales",
      customerAddress: "Apas, City of Cebu, Cebu 6000",
      legacyChannel: "41",
    });
    expect(draft.shipTos).toEqual([
      expect.objectContaining({
        sameAsCustomer: true,
        contactPerson: "Owner Ana",
        mobileNo: "09170000001",
      }),
    ]);
    expect(await accounting(outletId)).toEqual([]);
    // The office approval queue lists the field capture (active under a provisional code so
    // the rep can visit it), which a plain status=prospect filter does not.
    const queue = async () =>
      (
        await call(
          "manager",
          "GET",
          "/api/v1/customers?awaitingApproval=true&limit=200&offset=0",
        )
      ).body.rows.map((/** @type {any} */ r) => r.id);
    expect(await queue()).toContain(outletId);
    expect(
      (
        await call(
          "manager",
          "GET",
          "/api/v1/customers?status=prospect&limit=200",
        )
      ).body.rows.map((/** @type {any} */ r) => r.id),
    ).not.toContain(outletId);
    const completed = await call(
      "admin",
      "PUT",
      `/api/v1/customers/${outletId}`,
      {
        customer: {
          registeredName: "Ana Santos",
          taxClassificationCode: "1",
          customerGroupCode: "74",
          paymentTermsCode: "ZC03",
          pricingProcedureCode: "2",
          deliveringPlantCode: "1000",
          salesOfficeCode: "100",
        },
      },
    );
    expect(completed.status).toBe(200);
    expect(completed.body.completeness).toBe("complete");
    // Completing it in the office does not yet make an accounting customer: its code is still
    // provisional and must never reach AR/SAP.
    expect(await accounting(outletId)).toEqual([]);
    const approved = await call(
      "manager",
      "POST",
      `/api/v1/customers/${outletId}/approve`,
      { reason: "Checked" },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.code).toMatch(/^SP\d{6}$/);
    expect(approved.body.enrolmentStatus).toBe("approved");
    expect((await accounting(outletId))[0]).toMatchObject({
      code: approved.body.code,
      active: true,
    });
    expect(await queue()).not.toContain(outletId);
  });
});
