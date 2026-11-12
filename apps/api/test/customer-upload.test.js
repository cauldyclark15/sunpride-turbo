// SP-0170 customer upload API (machinery from SP-0169): the client's template shape, the shared
// customer-master rules with PSGC geography, writes through the customer writer, parallel
// chunks, idempotent re-upload, interruption + resume, retry failed, 5,000 rows, scope.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadPhGeography } from "@sunpride/db/ph-geography";
import {
  CUSTOMER_HEADERS,
  EXAMPLE,
  LIST_SHEET_OF,
} from "@sunpride/import-templates/customers";
import {
  customerTemplateXlsx,
  readWorkbookSheets,
} from "@sunpride/import-templates/customers-xlsx";
import { startHarness, profileStore, createUser } from "./harness.js";
import { install } from "../src/domains/imports/index.js";
import { install as org } from "../src/domains/org/index.js";
import { install as masters } from "../src/domains/masters/index.js";
import {
  runtime,
  startRun,
  sweepStaleRuns,
} from "../src/domains/imports/customer-upload.js";
import { readCustomer } from "../src/domains/masters/customers.js";

/** @type {import('./harness.js').Harness} */
let h;
/** @type {Record<string,string>} */
const cookies = {};
/** @type {Record<string,string>} */
const ids = {};

/** @param {string} email */
async function signIn(email) {
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "test-upload-password" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).toContain("sp_session=");
  return cookie;
}
/** @param {string} who @param {string} path @param {any} [body] */
async function call(who, path, body) {
  const response = await h.fetch(`/api/v1/imports/customer-upload${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: cookies[who], "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: /** @type {any} */ (await response.json()),
  };
}
/** A complete General Trade row (the template's own example) with overrides.
 * @param {number} rowNumber @param {Record<string,string>} [over] */
function row(rowNumber, over = {}) {
  return {
    rowNumber,
    values: {
      ...Object.fromEntries(
        Object.entries(EXAMPLE).map(([k, v]) => [k, String(v)]),
      ),
      regionCode: "Central Visayas",
      provinceCode: "cebu",
      municipalityCode: "Cebu City",
      barangayCode: "apas",
      code: `CU-${rowNumber}`,
      customerName: `Customer ${rowNumber}`,
      ...over,
    },
  };
}
/** @param {any[]} rows @param {string} [fileName] */
const file = (rows, fileName = "customers.xlsx") => ({
  fileName,
  header: [...CUSTOMER_HEADERS],
  rows,
});
/** @param {string} prefix @param {number} n @param {Record<string,string>} [over] */
const many = (prefix, n, over = {}) =>
  Array.from({ length: n }, (_, i) =>
    row(i + 2, { code: `${prefix}-${i + 2}`, ...over }),
  );
/** @param {string} id */
async function finish(id) {
  await runtime.workers.get(id);
  const [run] = await h.db`select * from customer_upload_runs where id=${id}`;
  return run;
}
/** @param {string} code */
async function customerByCode(code) {
  const [o] = await h.db`select id from outlets where code=${code}`;
  return o ? readCustomer(h.db, o.id) : null;
}

beforeAll(async () => {
  h = await startHarness({ installers: [org, masters, install] });
  await loadPhGeography(h.db);
  const store = profileStore(h);
  const [root] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','SUNPRIDE','National','NATIONAL','active','2020-01-01') returning id`;
  const [cebu] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from,parent_id) values('sunpride','CEB-N','Cebu City North','BRANCH','active','2020-01-01',${root.id}) returning id`;
  const [davao] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from,parent_id) values('sunpride','DVO','Davao','BRANCH','active','2020-01-01',${root.id}) returning id`;
  Object.assign(ids, { root: root.id, cebu: cebu.id, davao: davao.id });
  h.setHooks({ rootUnitId: async () => root.id });
  for (const [who, role, unit] of [
    ["boss", "super_admin", root.id],
    ["ops", "operations", cebu.id],
    ["viewer", "viewer", cebu.id],
  ]) {
    const user = await createUser(
      h,
      `${who}@example.com`,
      "test-upload-password",
    );
    store.set(user, { role, orgUnitId: unit, name: `${who} person` });
    cookies[who] = await signIn(`${who}@example.com`);
  }
}, 240000);
afterAll(async () => {
  await Promise.all(runtime.workers.values());
  await h?.close();
});

describe("SP-0170 customer upload — template", () => {
  test("list sheets are generated from the DB reference rows", async () => {
    const r = await call("boss", "/template");
    expect(r.status).toBe(200);
    const [{ n }] =
      await h.db`select count(*)::int n from customer_reference_values where active`;
    expect(r.body.reference.length).toBe(n);
    expect(r.body.sheets.map((/** @type {any} */ s) => s.name)).toEqual([
      "Cust. Grp. 1&2",
      "Sales Organization",
      "Customer Groups",
      "Distribution Channel",
      "Type of Business",
      "Sales Office",
      "List of Agents",
      "Delivering Plant",
      "Payment Terms",
      "Tax Class",
      "Pricing Procedure",
    ]);
    expect((await call("viewer", "/template")).status).toBe(403);
    // The generated .xlsx: every list sheet's "Dropdown value" column = the DB rows.
    const sheets = await readWorkbookSheets(
      await customerTemplateXlsx(r.body.reference),
    );
    const db =
      await h.db`select list,code,name from customer_reference_values where active order by list, sales_org_code, channel_code, group1_code, sort_order`;
    const label = (/** @type {any} */ x) =>
      x.code === x.name ? x.name : `${x.name} (${x.code})`;
    for (const [list, sheet] of Object.entries(LIST_SHEET_OF)) {
      if (list.startsWith("customer_group_")) continue;
      const got = /** @type {string[][]} */ (sheets[sheet])
        .slice(2)
        .map((row) => row.filter(Boolean).at(-1));
      expect(got).toEqual(
        db.filter((/** @type {any} */ x) => x.list === list).map(label),
      );
    }
    const chain = /** @type {string[][]} */ (sheets["Cust. Grp. 1&2"]).slice(2);
    const g1 = new Set(
      chain.filter((v) => v[2]).map((v) => `${v[0]}|${v[1]}|${v[2]}`),
    );
    const g2 = new Set(
      chain.filter((v) => v[3]).map((v) => `${v[0]}|${v[1]}|${v[2]}|${v[3]}`),
    );
    const [{ n1, n2 }] =
      await h.db`select count(*) filter (where list='customer_group_1')::int n1, count(*) filter (where list='customer_group_2')::int n2 from customer_reference_values where active`;
    expect(g1.size).toBe(n1);
    expect(g2.size).toBe(n2);
  });
});

describe("SP-0170 customer upload — validation", () => {
  test("the client's example row is valid; names and PSGC codes both resolve", async () => {
    const r = await call(
      "boss",
      "/preview",
      file([
        row(2),
        row(3, {
          regionCode: "0700000000",
          provinceCode: "0702200000",
          municipalityCode: "0730600000",
          barangayCode: "0730600003",
          salesOrgCode: "1000",
          distributionChannelCode: "General Trade",
          customerGroup1Code: "kas3",
          taxClassificationCode: "Liable for Taxes",
        }),
      ]),
    );
    expect(r.status).toBe(200);
    expect(r.body.errors).toEqual([]);
    expect(r.body.validCount).toBe(2);
    expect(r.body.newCount).toBe(2);
  });

  test("conditional and dependent rules: row + client label + value + message", async () => {
    const r = await call(
      "boss",
      "/preview",
      file([
        // ARI 2000 has no channel 30 (dependent list)
        row(2, { salesOrgCode: "ARI (2000)" }),
        // Services 50 has no Grp 1 / Grp 2: blank is fine
        row(3, {
          distributionChannelCode: "Services (50)",
          customerGroup1Code: "",
          customerGroup2Code: "",
        }),
        // Grp 2 not under the chosen Grp 1
        row(4, { customerGroup2Code: "Key Accts. National (KAN)" }),
        // Channel 40 needs the ADP block
        row(5, {
          distributionChannelCode: "Distributive Trade (40)",
          customerGroup1Code: "ADP",
          customerGroup2Code: "DGS",
        }),
        // Geography + formats + required
        row(6, {
          barangayCode: "Lahug",
          municipalityCode: "Mandaue City",
          postalCode: "6000",
          mobileNo: "12345",
          tin: "12",
          coordinates: "north pole",
          registeredName: "",
          creditLimit: "-5",
        }),
        // Duplicate code in the file, unknown list value
        row(7, { code: "CU-2", customerGroupCode: "Not a group" }),
        // Sales Office of another sales org
        row(8, { salesOfficeCode: "ARI Cebu" }),
      ]),
    );
    expect(r.status).toBe(200);
    const by = (/** @type {number} */ n) =>
      r.body.errors
        .filter((/** @type {any} */ e) => e.rowNumber === n)
        .map((/** @type {any} */ e) => `${e.label}:${e.code}`);
    expect(by(2)).toContain("Distribution Channel:not_for_sales_org");
    expect(
      r.body.errors.find(
        (/** @type {any} */ e) =>
          e.rowNumber === 2 && e.column === "distributionChannelCode",
      ),
    ).toMatchObject({
      column: "distributionChannelCode",
      value: "General Trade (30)",
    });
    expect(by(3)).toEqual([]);
    expect(by(4)).toEqual(["Customer Grp 2:not_for_group1"]);
    expect(by(5)).toContain("Distributor Code:required");
    expect(by(5).length).toBe(13);
    expect(by(6)).toEqual(
      expect.arrayContaining([
        "Registered Name:required",
        "Mobile No.:invalid_mobile",
        "TIN number:invalid_tin",
        "Barangay:geography_mismatch",
        "Postal Code:postal_code_mismatch",
        "Geographical Coordinates:invalid_coordinates",
        "Credit Limit:invalid_credit_limit",
      ]),
    );
    const mobile = r.body.errors.find(
      (/** @type {any} */ e) =>
        e.rowNumber === 6 && e.code === "invalid_mobile",
    );
    expect(mobile).toMatchObject({ column: "mobileNo", value: "12345" });
    expect(mobile.message).toContain("Mobile No.");
    expect(by(7)).toEqual(
      expect.arrayContaining([
        "Customer Code:duplicate_in_file",
        "Customer Group:invalid_option",
      ]),
    );
    expect(by(8).length).toBe(1);
    expect(r.body.validCount).toBe(1);
  });

  test("ship-to columns map to their own cells (the second Mobile No.)", async () => {
    const r = await call(
      "boss",
      "/preview",
      file([row(2, { "shipTo.mobileNo": "0917", "shipTo.contactPerson": "" })]),
    );
    const cells = r.body.errors.map(
      (/** @type {any} */ e) => `${e.column}:${e.code}`,
    );
    expect(cells).toEqual([
      "shipTo.contactPerson:required",
      "shipTo.mobileNo:invalid_mobile",
    ]);
  });

  test("a header with missing/unknown columns is refused with both lists", async () => {
    const header = [...CUSTOMER_HEADERS.slice(1), "Area"];
    const r = await call("boss", "/preview", { ...file([row(2)]), header });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("header_mismatch");
    expect(r.body.error.message).toContain("missing columns: Customer Code");
    expect(r.body.error.message).toContain("unknown columns: Area");
  });

  test("a full 5,000-row file (over the default 1 MB JSON cap) previews; 5,001 is refused", async () => {
    const big = file(many("BIG", 5000));
    expect(JSON.stringify(big).length).toBeGreaterThan(1024 * 1024);
    const t0 = Date.now();
    const r = await call("boss", "/preview", big);
    expect(r.status).toBe(200);
    expect(r.body.validCount).toBe(5000);
    console.log(`5,000-row preview ${Date.now() - t0} ms`);
    const over = await call("boss", "/preview", file(many("BIG", 5001)));
    expect(over.status).toBe(400);
    expect(JSON.stringify(over.body)).toContain("too_many_rows");
  }, 120000);

  test("viewer without masterdata.manage is denied", async () => {
    const r = await call("viewer", "/preview", file([row(2)]));
    expect(r.status).toBe(403);
  });
});

describe("SP-0170 customer upload — import", () => {
  test("chunks run in parallel with bounded concurrency and every row goes through the customer writer", async () => {
    runtime.chunkSize = 100;
    runtime.concurrency = 3;
    let active = 0,
      peak = 0;
    runtime.hooks.beforeChunk = async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(40);
      active--;
    };
    const rows = many("PAR", 250);
    const adp = /** @type {any} */ (rows[0]).values;
    Object.assign(adp, {
      distributionChannelCode: "Distributive Trade (40)",
      customerGroup1Code: "Area Distr. Partner (ADP)",
      customerGroup2Code: "DT-Grocery Stores (DGS)",
      distributorCode: "D-1",
      distributorName: "Cebu Distributor",
      distributorCustomerCode: "DC-1",
      distributionMode: "Van",
      subDistributorCode: "SD-1",
      subDistributorName: "Sub One",
      distributorSalesman: "Juan",
      distributorSalesmanCode: "S-1",
      truckServing: "Truck 1",
      truckCode: "T-1",
      distributorHub: "Mandaue Hub",
      clusterNo: "C1",
      clusterName: "Cluster One",
    });
    const r = await call("boss", "/runs", file(rows, "parallel.xlsx"));
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(false);
    const run = await finish(r.body.id);
    runtime.hooks = {};
    expect(run.status).toBe("completed");
    expect(run.succeeded_count).toBe(250);
    expect(run.created_count).toBe(250);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    const c = /** @type {any} */ (await customerByCode("PAR-5"));
    expect(c).toMatchObject({
      status: "active",
      completeness: "complete",
      customerName: "Customer 5",
      registeredName: "Tindahan ni Aling Rosa Inc.",
      salesOrgCode: "1000",
      distributionChannelCode: "30",
      customerGroup1Code: "KAS3",
      customerGroup2Code: "GGS",
      customerGroupCode: "74",
      paymentTermsCode: "0003",
      regionCode: "0700000000",
      municipalityCode: "0730600000",
      barangayCode: "0730600003",
      postalCode: "6000",
      pinStatus: "pending",
      latitude: 10.3312,
      creditLimit: 15000,
      custodianOrgUnitId: ids.root,
    });
    expect(c.shipTos).toEqual([
      expect.objectContaining({
        shipToParty: "Aling Rosa Store",
        contactPerson: "Rosa Dela Cruz",
        mobileNo: "09171234567",
      }),
    ]);
    // 1:1 accounting customer with the same code.
    const [acct] =
      await h.db`select c.code from outlet_customer_links l join customers c on c.id=l.customer_id where l.outlet_id=${c.id} and l.effective_to is null and l.deleted_at is null`;
    expect(acct.code).toBe("PAR-5");
    expect(await customerByCode("PAR-2")).toMatchObject({
      distributionChannelCode: "40",
      distributorCode: "D-1",
      clusterName: "Cluster One",
    });
    const [audit] =
      await h.db`select count(*)::int n from audit_logs where action='SP-0170.customer.upload_new'`;
    expect(audit.n).toBe(250);
  }, 120000);

  test("existing codes update; blank optional cells keep current values", async () => {
    const before = /** @type {any} */ (await customerByCode("PAR-6"));
    expect(before.tradeName).toBe("Aling Rosa");
    const pre = await call(
      "boss",
      "/preview",
      file([row(2, { code: "par-6", customerName: "Renamed" })]),
    );
    expect(pre.body.rows[0].action).toBe("update");
    const r = await call(
      "boss",
      "/runs",
      file(
        [
          row(2, {
            code: "PAR-6",
            customerName: "Renamed",
            tradeName: "",
            email: "",
            creditLimit: "",
            tin: "",
            "shipTo.email": "",
            paymentTermsCode: "Cash upon delivery",
            distributionChannelCode: "Food Service (20)",
            customerGroup1Code: "Restaurant (FRT)",
            customerGroup2Code: "",
          }),
        ],
        "update.xlsx",
      ),
    );
    const run = await finish(r.body.id);
    expect(run.status).toBe("completed");
    expect(run.updated_count).toBe(1);
    const after = /** @type {any} */ (await customerByCode("PAR-6"));
    expect(after.id).toBe(before.id);
    expect(after).toMatchObject({
      customerName: "Renamed",
      tradeName: "Aling Rosa",
      email: "rosa@example.ph",
      creditLimit: 15000,
      tin: "123-456-789",
      paymentTermsCode: "ZC03",
      distributionChannelCode: "20",
      customerGroup1Code: "FRT",
      customerGroup2Code: null,
    });
    // Same coordinates: no second pin.
    const pins =
      await h.db`select id from outlet_pins where outlet_id=${after.id}`;
    expect(pins.length).toBe(1);
  }, 30000);

  test("re-uploading the identical file returns the same run and writes nothing", async () => {
    const rows = many("IDEM", 3);
    const first = await call("boss", "/runs", file(rows, "idem.xlsx"));
    await finish(first.body.id);
    const [before] =
      await h.db`select max(change_seq)::text seq, (select count(*)::int from audit_logs) audits, (select count(*)::int from customer_profiles) profiles from outlets`;
    const again = await call("boss", "/runs", file(rows, "idem-copy.csv"));
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.id).toBe(first.body.id);
    expect(runtime.workers.has(first.body.id)).toBe(false);
    const [after] =
      await h.db`select max(change_seq)::text seq, (select count(*)::int from audit_logs) audits, (select count(*)::int from customer_profiles) profiles from outlets`;
    expect(after).toEqual(before);
  }, 30000);
});

describe("SP-0170 customer upload — interruption and resume", () => {
  test("a crash mid-run leaves an exact per-row report and resume processes only unprocessed rows", async () => {
    runtime.concurrency = 1;
    runtime.autoStart = false;
    const r = await call(
      "boss",
      "/runs",
      file(many("CRASH", 250), "crash.xlsx"),
    );
    expect(r.body.status).toBe("queued");
    let seen = 0;
    runtime.hooks.beforeChunk = () => {
      if (++seen === 2) throw new Error("simulated crash");
    };
    await startRun(r.body.id);
    runtime.hooks = {};
    const detail = await call("boss", `/runs/${r.body.id}`);
    expect(detail.body.run.status).toBe("interrupted");
    expect(detail.body.run.succeeded).toBe(100);
    expect(detail.body.run.pending).toBe(150);
    expect(detail.body.rows[0]).toMatchObject({
      rowNumber: 2,
      status: "succeeded",
      action: "new",
    });
    runtime.autoStart = true;
    runtime.concurrency = 4;
    const resumed = await call("boss", `/runs/${r.body.id}/resume`, {});
    expect(resumed.body.resumed).toBe(true);
    const run = await finish(r.body.id);
    expect(run.status).toBe("completed");
    expect(run.succeeded_count).toBe(250);
    expect(run.attempt).toBe(2);
    const [{ n }] =
      await h.db`select count(*)::int n from outlets where code like 'CRASH-%'`;
    expect(n).toBe(250);
    const [{ twice }] =
      await h.db`select count(*)::int twice from customer_upload_rows where run_id=${r.body.id} and attempts>1`;
    expect(twice).toBe(0);
  }, 120000);

  test("a run whose worker stopped heart-beating is detected as interrupted", async () => {
    runtime.autoStart = false;
    const r = await call("boss", "/runs", file(many("STALE", 2), "stale.xlsx"));
    runtime.autoStart = true;
    await h.db`update customer_upload_runs set status='running', lease_owner='dead-process', lease_expires_at=now()-interval '1 minute' where id=${r.body.id}`;
    const list = await call("boss", "/runs");
    const listed = list.body.rows.find(
      (/** @type {any} */ x) => x.id === r.body.id,
    );
    expect(listed.status).toBe("interrupted");
    expect(listed.pending).toBe(2);
    expect(await sweepStaleRuns(h.db)).toEqual([]);
    await call("boss", `/runs/${r.body.id}/resume`, {});
    expect((await finish(r.body.id)).status).toBe("completed");
  }, 30000);

  test("retry failed rows after the reference list is fixed", async () => {
    const r = await call(
      "boss",
      "/runs",
      file(
        [
          row(2, { code: "LATE-1", salesPartnerCode: "AG-9" }),
          row(3, { code: "LATE-2" }),
        ],
        "late.xlsx",
      ),
    );
    const run = await finish(r.body.id);
    expect(run.status).toBe("completed_with_errors");
    expect(run.failed_count).toBe(1);
    const detail = await call("boss", `/runs/${r.body.id}`);
    expect(detail.body.rows[0].errors[0]).toMatchObject({
      column: "salesPartnerCode",
      label: "Sales Partner",
      code: "invalid_option",
      value: "AG-9",
    });
    await h.db`insert into customer_reference_values(list,sales_org_code,channel_code,group1_code,code,name,sort_order,source) values('sales_partner','','','','AG-9','Agent Nine',1,'test')`;
    const retry = await call("boss", `/runs/${r.body.id}/resume`, {
      retryFailed: true,
    });
    expect(retry.body.resumed).toBe(true);
    const done = await finish(r.body.id);
    expect(done.status).toBe("completed");
    expect(done.succeeded_count).toBe(2);
    expect((await customerByCode("LATE-1"))?.salesPartnerCode).toBe("AG-9");
  }, 30000);
});

describe("SP-0170 customer upload — scope", () => {
  test("a scoped user cannot update customers outside their areas; their new customers land in their area as prospects", async () => {
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values('sunpride','DVO-1','Davao store','active',${ids.davao},'fixture')`;
    const pre = await call(
      "ops",
      "/preview",
      file([row(2, { code: "OPS-1" }), row(3, { code: "DVO-1" })]),
    );
    expect(pre.status).toBe(200);
    expect(
      pre.body.errors.map((/** @type {any} */ e) => `${e.rowNumber}:${e.code}`),
    ).toEqual(["3:customer_out_of_scope"]);
    const r = await call(
      "ops",
      "/runs",
      file([row(2, { code: "OPS-1" }), row(3, { code: "DVO-1" })], "ops.xlsx"),
    );
    const run = await finish(r.body.id);
    expect(run.succeeded_count).toBe(1);
    expect(run.failed_count).toBe(1);
    const [dvo] = await h.db`select name from outlets where code='DVO-1'`;
    expect(dvo.name).toBe("Davao store");
    expect(await customerByCode("OPS-1")).toMatchObject({
      status: "prospect",
      completeness: "complete",
      custodianOrgUnitId: ids.cebu,
    });
    const mine = await call("ops", "/runs");
    expect(mine.body.rows.map((/** @type {any} */ x) => x.fileName)).toEqual([
      "ops.xlsx",
    ]);
    const other = await call(
      "ops",
      `/runs/${(await call("boss", "/runs")).body.rows.at(-1).id}`,
    );
    expect(other.status).toBe(404);
  }, 30000);

  test("scope follows the store's territory owner (as the Customers list), not only its custodian unit", async () => {
    // Custodian Cebu (the uploader's unit) but assigned to a Davao-owned territory: the
    // Customers list and PUT refuse it to the Cebu user, so the upload must refuse it too.
    const [t] =
      await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by) values('sunpride','DVO-T1','Davao territory','active','2020-01-01','fixture') returning id`;
    await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${t.id},${ids.davao},'2020-01-01','fixture','fixture')`;
    const [o] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values('sunpride','CEB-DVO-1','Cebu-held Davao store','active',${ids.cebu},'fixture') returning id`;
    await h.db`insert into outlet_assignments(outlet_id,territory_id,effective_from,actor_subject,reason) values(${o.id},${t.id},'2020-01-01','fixture','fixture')`;
    const pre = await call(
      "ops",
      "/preview",
      file([row(2, { code: "CEB-DVO-1" })]),
    );
    expect(pre.status).toBe(200);
    expect(
      pre.body.errors.map((/** @type {any} */ e) => `${e.rowNumber}:${e.code}`),
    ).toEqual(["2:customer_out_of_scope"]);
    const [same] = await h.db`select name from outlets where id=${o.id}`;
    expect(same.name).toBe("Cebu-held Davao store");
  }, 30000);
});
