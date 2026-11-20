// SP-0170 field app "Add customer": the census.capture op with the client's `customer` object
// becomes a prospect customer (field enrolment + draft profile); the offline setup and
// geography pack the phone caches.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import { loadPhGeography } from "@sunpride/db/ph-geography";
import {
  startHarness,
  createUser,
  deviceKey,
  registerDevice,
  nativeSignIn,
  bind,
  signedPost,
} from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as masters } from "../src/domains/masters/index.js";
import { readCustomer } from "../src/domains/masters/customers.js";
import { SAMPLE_IMAGE } from "../src/domains/masters/catalogue.js";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { seedSpecMasters } from "../../../packages/db/seed/spec-masters.js";
import {
  rowId,
  todayManila,
  plusDays,
} from "../../../packages/db/seed/store.js";

/** @type {import('./harness.js').Harness} */ let h;
let photo = "";
/** @type {any} */ let rep;

async function fieldRep(app = "field-android") {
  const unitId = rowId("org_units", "territory-0");
  const password = "customer-capture-test-only-password",
    email = `cfc-${crypto.randomUUID()}@example.com`;
  const userId = await createUser(h, email, password);
  const [profile] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${userId},${userId},'Capture rep',${email},'sales','active',${unitId}) returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${profile.id},${unitId},'sales',${new Date(0)},${userId},'SP-0170 field assignment')`;
  const key = await deviceKey(),
    deviceId = await registerDevice(h, {
      profileId: profile.id,
      orgUnitId: unitId,
      key,
      app,
    });
  const { body: tokens } = await nativeSignIn(h, email, password, app, {
    keyId: key.keyId,
    publicKeySpki: key.publicKeySpki,
  });
  expect((await bind(h, tokens.accessToken, deviceId, key)).res.status).toBe(
    200,
  );
  const who = { access: tokens.accessToken, deviceId, key };
  return {
    userId,
    /** @param {string} path @param {any} body */
    post: async (path, body) => {
      const r = await h.fetch(path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    },
    /** @param {string} path */
    get: async (path) => {
      const r = await h.fetch(path, {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
      return { status: r.status, body: /** @type {any} */ (await r.json()) };
    },
    /** @param {any} payload @param {string} [clientOpId] */
    push: async (payload, clientOpId = crypto.randomUUID()) => {
      const response = await signedPost(h, who, "/api/sync/push", {
        version: 2,
        app,
        deviceId,
        scopeId: unitId,
        operations: [
          {
            clientOpId,
            opType: "census.capture",
            clientTime: payload.deviceTime,
            dependsOn: [],
            payload,
          },
        ],
      });
      expect(response.res.status).toBe(200);
      return response.body.results[0];
    },
  };
}

/** The payload the Android app builds (CustomerCapture.payload). @param {any} [over] */
function capture(over = {}) {
  const at = Date.now();
  return {
    captureId: crypto.randomUUID(),
    name: "Aling Nena Store",
    address: "12 Gorordo Ave, Apas, City of Cebu, Cebu 6000",
    ownerName: "Nena Cruz",
    ownerPhone: "09175550101",
    deviceTime: at,
    locationSource: "gps",
    location: {
      latitude: 10.3312,
      longitude: 123.9056,
      accuracyMeters: 9,
      fixTime: at,
      mockSignal: false,
      provider: "gps",
    },
    photoJpegBase64: photo,
    customer: {
      registeredName: "Aling Nena Store Inc.",
      customerName: "Aling Nena Store",
      tradeName: "Nena's",
      mobileNo: "09175550101",
      regionCode: "0700000000",
      provinceCode: "0702200000",
      municipalityCode: "0730600000",
      barangayCode: "0730600003",
      houseNo: "12",
      street1: "Gorordo Ave",
      postalCode: "6000",
      salesOrgCode: "1000",
      distributionChannelCode: "41",
      customerGroup1Code: "RSF",
      customerGroup2Code: "RSS",
      customerGroupCode: "74",
      typeOfBusiness: "Sole Proprietor",
      taxClassificationCode: "1",
      salesOfficeCode: "100",
      paymentTermsCode: "0003",
      pricingProcedureCode: "2",
      deliveringPlantCode: "1000",
    },
    ...over,
  };
}

beforeAll(async () => {
  h = await startHarness({
    installers: [org, masters],
    port: Number(process.env.SP_TEST_PORT) || 5002,
  });
  await seedDemo(h.db, { days: 3, anchorDate: plusDays(todayManila(), 1) });
  await tx(h.db, seedSpecMasters);
  await loadPhGeography(h.db);
  photo = Buffer.from(await Bun.file(SAMPLE_IMAGE).arrayBuffer()).toString(
    "base64",
  );
  rep = await fieldRep();
}, 240000);
afterAll(async () => {
  await h?.close();
});

test("census-config carries the customer reference lists, default Sales Organization and area provinces", async () => {
  const r = await rep.get("/api/v1/masters/census-config");
  expect(r.status).toBe(200);
  const cm = r.body.customerMaster;
  expect(cm.salesOrgCode).toMatch(/^(1000|2000)$/);
  expect(Array.isArray(cm.provinceCodes)).toBe(true);
  const lists = new Set(cm.lists.map((/** @type {any} */ x) => x.list));
  for (const l of [
    "sales_organization",
    "distribution_channel",
    "customer_group_1",
    "customer_group_2",
    "customer_group",
    "type_of_business",
    "tax_classification",
    "country",
    "sales_office",
    "sales_partner",
    "payment_terms",
    "pricing_procedure",
    "delivering_plant",
  ])
    expect(lists.has(l)).toBe(true);
  // Old keys unchanged for current apps.
  expect(Array.isArray(r.body.channels)).toBe(true);
});

test("geography pack: national levels in one request, barangays per province", async () => {
  const pack = await rep.get("/api/v1/geography/pack");
  expect(pack.status).toBe(200);
  expect(pack.body.regions.length).toBe(18);
  expect(pack.body.provinces.length).toBeGreaterThan(80);
  expect(pack.body.municipalities.length).toBeGreaterThan(1600);
  expect(pack.body.municipalities[0]).toEqual({
    code: expect.any(String),
    name: expect.any(String),
    provinceCode: expect.any(String),
  });
  expect(
    pack.body.postalCodes.some(
      (/** @type {any} */ p) =>
        p.municipalityCode === "0730600000" && p.code === "6000",
    ),
  ).toBe(true);
  const b = await rep.get(
    "/api/v1/geography/pack/barangays?provinceCode=0702200000",
  );
  expect(b.status).toBe(200);
  expect(
    b.body.barangays.some(
      (/** @type {any} */ x) =>
        x.code === "0730600003" && x.municipalityCode === "0730600000",
    ),
  ).toBe(true);
  expect(
    (await rep.get("/api/v1/geography/pack/barangays?provinceCode=x")).status,
  ).toBe(400);
});

test("Add customer capture becomes a prospect customer with a complete pending profile; replay is idempotent", async () => {
  const p = capture();
  const opId = crypto.randomUUID();
  const first = await rep.push(p, opId);
  if (first.status !== "applied") console.log(JSON.stringify(first));
  expect(first.status).toBe("applied");
  const [enrolment] =
    await h.db`select outlet_id,status from outlet_enrolments where client_request_id=${p.captureId}`;
  expect(enrolment.status).toBe("pending");
  const c = await readCustomer(h.db, enrolment.outlet_id);
  expect(c).toMatchObject({
    customerName: "Aling Nena Store",
    tradeName: "Nena's",
    completeness: "complete",
    enrolmentStatus: "provisional",
    distributionChannelCode: "41",
    customerGroup1Code: "RSF",
    customerGroup2Code: "RSS",
    barangayName: "Apas",
    postalCode: "6000",
    pinStatus: "pending",
  });
  expect(c.shipTos[0]).toMatchObject({
    sameAsCustomer: true,
    contactPerson: "Nena Cruz",
  });
  // Sales Partner = the salesman who saved it (client form: "pre-determined based on who saved
  // the customer profile"), from the Sales Partner list (List of Agents, else sales employees).
  const [me] =
    await h.db`select coalesce(employee_code,id::text) as code from profiles where user_id=${rep.userId}`;
  const [agents] =
    await h.db`select count(*)::int n from customer_reference_values where list='sales_partner' and active`;
  expect(c.salesPartnerCode).toBe(agents.n ? null : me.code);
  if (!agents.n) expect(c.salesPartnerName).toBe("Capture rep");
  // No census review row: CDMs review it directly as a customer.
  expect(
    (await h.db`select 1 from census_captures where id=${p.captureId}`).length,
  ).toBe(0);
  const again = await rep.push(p, opId);
  expect(["applied", "duplicate"]).toContain(again.status);
  expect(
    (
      await h.db`select count(*)::int n from outlet_enrolments where client_request_id=${p.captureId}`
    )[0].n,
  ).toBe(1);
});

test("SP-0184 agents submit complete profiles directly for manager review, approval or rejection without Admin edits", async () => {
  const password = "sp184-reviewer-test-only-password";
  const email = `cdm-${crypto.randomUUID()}@example.com`;
  const userId = await createUser(h, email, password);
  const unitId = rowId("org_units", "territory-0");
  const [profile] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id)
    values(${userId},${userId},'Sample CDM',${email},'manager','active',${unitId}) returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)
    values(${profile.id},${unitId},'manager',${new Date(0)},${userId},'SP-0184 reviewer fixture')`;
  const signIn = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers.get("set-cookie")?.split(";")[0] ?? "";
  for (const decision of ["approve", "reject"]) {
    const p = capture();
    const adp = decision === "reject";
    const fields = {
      ...p.customer,
      registeredName: "Sample Enrollment Inc",
      tin: "123456789",
      taxClassificationCode: "1",
      countryCode: "PH",
      salesOfficeCode: "100",
      paymentTermsCode: "0003",
      creditLimit: "12345.67",
      pricingProcedureCode: "2",
      deliveringPlantCode: "1000",
      ...(adp
        ? {
            distributionChannelCode: "40",
            customerGroup1Code: "ADP",
            customerGroup2Code: "DAW",
            distributorCode: "SAMPLE-D",
            distributorName: "Sample Distributor",
            distributorCustomerCode: "SAMPLE-C",
            distributionMode: "Sample mode",
            subDistributorCode: "SAMPLE-S",
            subDistributorName: "Sample Sub Distributor",
            distributorSalesman: "Sample Rep",
            distributorSalesmanCode: "SAMPLE-R",
            truckServing: "Sample Truck",
            truckCode: "SAMPLE-T",
            distributorHub: "Sample Hub",
            clusterNo: "1",
            clusterName: "Sample Cluster",
          }
        : {}),
      shipTos: [
        {
          sameAsCustomer: false,
          shipToParty: "Sample Delivery Warehouse",
          shipToAddress: "99 Delivery Road",
          contactPerson: "Sample Receiver",
          mobileNo: "09175550202",
          email: "delivery@example.ph",
        },
      ],
    };
    p.customer = fields;
    expect((await rep.push(p)).status).toBe("applied");
    const [enrolment] =
      await h.db`select outlet_id,status from outlet_enrolments where client_request_id=${p.captureId}`;
    expect(enrolment.status).toBe("pending");
    const c = await readCustomer(h.db, enrolment.outlet_id);
    expect(c).toMatchObject({
      completeness: "complete",
      enrolmentStatus: "provisional",
      taxClassificationCode: "1",
      salesOfficeCode: "100",
      paymentTermsCode: "0003",
      creditLimit: 12345.67,
      pricingProcedureCode: "2",
      deliveringPlantCode: "1000",
    });
    expect(c.shipTos[0]).toMatchObject(fields.shipTos[0]);
    const visible = await h.fetch(`/api/v1/customers/${c.id}`, {
      headers: { cookie },
    });
    expect(visible.status).toBe(200);
    expect(await visible.json()).toMatchObject({
      ...fields,
      creditLimit: 12345.67,
      tin: "123-456-789",
    });
    if (adp)
      for (const [key, value] of Object.entries(fields).filter(
        ([key]) => key.startsWith("distributor") || key.startsWith("cluster"),
      ))
        expect(c[key]).toBe(value);
    expect(
      (await h.db`select 1 from outlet_customer_links where outlet_id=${c.id}`)
        .length,
    ).toBe(0);
    // Agents supply the details but cannot decide them, even when the profile is complete.
    for (const action of ["approve", "reject"])
      expect(
        (
          await rep.post(`/api/v1/customers/${c.id}/${action}`, {
            reason: "Sample review",
          })
        ).status,
      ).toBe(403);
    // The CDM does not perform a PUT/complete step: directly reviews the submitted record.
    const reviewed = await h.fetch(`/api/v1/customers/${c.id}/${decision}`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ reason: "Sample CDM verification" }),
    });
    const body = /** @type {any} */ (await reviewed.json());
    expect({ status: reviewed.status, code: body.code }).toMatchObject({
      status: 200,
    });
    expect(body.enrolmentStatus).toBe(
      decision === "approve" ? "approved" : "rejected",
    );
    const stored = await readCustomer(h.db, c.id);
    expect(stored.enrolmentStatus).toBe(body.enrolmentStatus);
    expect(stored.shipTos[0]).toMatchObject(fields.shipTos[0]);
    const [review] =
      await h.db`select decided_by from outlet_enrolments where outlet_id=${c.id}`;
    expect(review.decided_by).toBe(userId);
    expect(
      (await h.db`select 1 from outlet_customer_links where outlet_id=${c.id}`)
        .length,
    ).toBe(decision === "approve" ? 1 : 0);
  }
});

test("SP-0188 missing agent fields are kept as an incomplete customer for the office, never refused", async () => {
  const keepRep = await fieldRep();
  for (const key of [
    "registeredName",
    "mobileNo",
    "regionCode",
    "street1",
    "postalCode",
    "distributionChannelCode",
    "customerGroupCode",
    "typeOfBusiness",
  ]) {
    for (const blank of [undefined, null, " "]) {
      const p = capture();
      const customer = { ...p.customer, [key]: blank };
      if (blank === undefined) delete customer[key];
      const r = await keepRep.push({ ...p, customer });
      expect(r).toMatchObject({ status: "applied" });
      const c = await readCustomer(h.db, r.ack.entityId);
      expect(c.completeness).toBe("draft");
      expect(c.enrolmentStatus).toBe("provisional");
      expect(c.fieldMissing.map((/** @type {any} */ m) => m.field)).toContain(
        key === "regionCode" ? "regionCode" : key,
      );
      expect(c.fieldSubmitted.customerName).toBe("Aling Nena Store");
    }
  }
  // A blank top-level contact is kept too.
  const r = await keepRep.push(capture({ ownerName: " " }));
  expect(r.status).toBe("applied");
}, 120000);

test("SP-0183 a valid Services customer needs no groups or optional fields; SP-0184 has no office completion", async () => {
  const p = capture();
  const customer = { ...p.customer, distributionChannelCode: "50" };
  delete customer.customerGroup1Code;
  delete customer.customerGroup2Code;
  delete customer.tradeName;
  const r = await rep.push({ ...p, customer });
  expect(r.status).toBe("applied");
  const c = await readCustomer(h.db, r.ack.entityId);
  expect(c).toMatchObject({
    registeredName: "Aling Nena Store Inc.",
    distributionChannelCode: "50",
    completeness: "complete",
  });
});

test("SP-0188 a value that fails a format or list check is dropped from the record and kept in the agent's copy", async () => {
  const p = capture();
  p.customer = {
    ...p.customer,
    customerGroup1Code: "NOPE",
    mobileNo: "12345",
    shipTos: [
      {
        sameAsCustomer: false,
        shipToParty: "Sample Warehouse",
        shipToAddress: "99 Delivery Road",
        contactPerson: "Sample Receiver",
        mobileNo: "not a phone",
      },
    ],
  };
  const r = await rep.push(p);
  expect(r.status).toBe("applied");
  const c = await readCustomer(h.db, r.ack.entityId);
  expect(c).toMatchObject({
    completeness: "draft",
    customerGroup1Code: null,
    mobileNo: null,
    registeredName: "Aling Nena Store Inc.",
    distributionChannelCode: "41",
  });
  expect(c.shipTos[0]).toMatchObject({
    shipToParty: "Sample Warehouse",
    mobileNo: null,
  });
  expect(c.fieldSubmitted).toMatchObject({
    customerGroup1Code: "NOPE",
    mobileNo: "12345",
  });
  expect(c.fieldSubmitted.shipTos[0].mobileNo).toBe("not a phone");
  const missing = c.fieldMissing.map((/** @type {any} */ m) => m.field);
  expect(missing).toContain("customerGroup1Code");
  expect(missing).toContain("mobileNo");
});

test("SP-0188 a pre-SP-0183 payload (name at the top level, few customer fields) is applied once as incomplete", async () => {
  const p = capture();
  // Older Field builds: `name` on the capture, a short customer object, an extra key.
  p.customer = { tradeName: "Nena's", salesOrgCode: "1000", oldBuildKey: "x" };
  const opId = crypto.randomUUID();
  const first = await rep.push(p, opId);
  expect(first.status).toBe("applied");
  const c = await readCustomer(h.db, first.ack.entityId);
  expect(c).toMatchObject({
    customerName: "Aling Nena Store",
    tradeName: "Nena's",
    completeness: "draft",
    enrolmentStatus: "provisional",
    pinStatus: "pending",
  });
  expect(c.fieldSubmitted).toMatchObject({ oldBuildKey: "x" });
  expect(c.fieldMissing.length).toBeGreaterThan(3);
  // The office list shows it as incomplete from the field app.
  const [enrol] =
    await h.db`select status from outlet_enrolments where client_request_id=${p.captureId}`;
  expect(enrol.status).toBe("pending");
  // Resent: duplicate, no second customer.
  const again = await rep.push(p, opId);
  expect(again.status).toBe("duplicate");
  const [n] =
    await h.db`select count(*)::int n from outlet_enrolments where client_request_id=${p.captureId}`;
  expect(n.n).toBe(1);
  // Same capture under a new op id (phone retried after a lost answer): still one customer.
  expect((await rep.push(p)).status).toBe("applied");
  const [m] =
    await h.db`select count(*)::int n from outlet_enrolments where client_request_id=${p.captureId}`;
  expect(m.n).toBe(1);
});

test("the old census payload (no customer) still works", async () => {
  const config = (await rep.get("/api/v1/masters/census-config")).body;
  const sub = config.subchannels[0];
  const old = capture({ channelId: sub.data.channelId, subchannelId: sub.id });
  delete (/** @type {any} */ (old).customer);
  old.estimatedClass = "C";
  const ok = await rep.push(old);
  expect(ok.status).toBe("applied");
  expect(
    (await h.db`select 1 from census_captures where id=${old.captureId}`)
      .length,
  ).toBe(1);
});
