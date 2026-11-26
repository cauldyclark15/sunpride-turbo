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
    push: async (
      payload,
      clientOpId = crypto.randomUUID(),
      opType = "census.capture",
    ) => {
      const response = await signedPost(h, who, "/api/sync/push", {
        version: 2,
        app,
        deviceId,
        scopeId: unitId,
        operations: [
          {
            clientOpId,
            opType,
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

/** Authenticated office request against this disposable lane fixture.
 * @param {string} role @param {string} path @param {any} [body] @param {string} [key] */
async function locationOffice(role, path, body, key = crypto.randomUUID()) {
  const password = (
    await Bun.file(`${process.env.HOME}/.sunpride-keys/v2-test-password`).text()
  ).trim();
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${role}@sunpride.test`, password }),
  });
  expect(login.status).toBe(200);
  const response = await h.fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      cookie: (login.headers.get("set-cookie") ?? "").split(";")[0],
      "content-type": "application/json",
      "idempotency-key": key,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

test("SP-0251 save without signal, later GPS, best-reading replacement, replay and office move", async () => {
  const at = Date.now() - 3 * 86400000;
  const p = capture({
    location: null,
    deviceTime: at,
    name: "Delayed GPS Store",
    customer: { ...capture().customer, customerName: "Delayed GPS Store" },
  });
  expect((await rep.push(p)).status).toBe("applied");
  const [enrolment] =
    await h.db`select * from outlet_enrolments where client_request_id=${p.captureId}`;
  expect(enrolment.pin_id).toBeNull();
  const tag = {
    captureId: p.captureId,
    deviceTime: at + 60_000,
    location: {
      ...capture().location,
      accuracyMeters: 80,
      fixTime: at + 60_000,
    },
  };
  const id = crypto.randomUUID();
  expect((await rep.push(tag, id, "store.location")).status).toBe("applied");
  expect((await rep.push(tag, id, "store.location")).status).toBe("duplicate");
  expect(
    (
      await h.db`select count(*)::int n from store_location_tags where capture_id=${p.captureId}`
    )[0].n,
  ).toBe(1);
  const pending = async () =>
    await h.db`select * from outlet_pins where outlet_id=${enrolment.outlet_id} and source='field-gps' and status='pending'`;
  expect((await pending()).length).toBe(1);
  const firstPin = (await pending())[0].id;
  expect(
    (
      await rep.push(
        { ...tag, location: { ...tag.location, accuracyMeters: 150 } },
        crypto.randomUUID(),
        "store.location",
      )
    ).status,
  ).toBe("applied");
  expect((await pending())[0].id).toBe(firstPin);
  const better = {
    ...tag,
    location: {
      ...tag.location,
      accuracyMeters: 15,
      latitude: tag.location.latitude + 0.00001,
    },
  };
  expect(
    (await rep.push(better, crypto.randomUUID(), "store.location")).status,
  ).toBe("applied");
  const pins = await pending();
  expect(pins.length).toBe(1);
  expect(pins[0].latitude).toBe(better.location.latitude);
  expect(
    (
      await h.db`select pin_id,location_evidence from outlet_enrolments where id=${enrolment.id}`
    )[0],
  ).toMatchObject({ pin_id: pins[0].id, location_evidence: null });
  for (const location of [
    { ...tag.location, provider: "network" },
    { ...tag.location, mockSignal: true },
    { ...tag.location, fixTime: at - 120001 },
  ]) {
    expect(
      (
        await rep.push(
          { ...tag, location },
          crypto.randomUUID(),
          "store.location",
        )
      ).status,
    ).toBe("rejected");
  }
  const other = await fieldRep();
  expect(
    (await other.push(tag, crypto.randomUUID(), "store.location")).status,
  ).toBe("rejected");
  const office = {
    outletId: enrolment.outlet_id,
    latitude: 10.31,
    longitude: 123.91,
  };
  const saved = await locationOffice(
    "manager",
    "/api/v1/masters/stores/location",
    office,
    "location-once",
  );
  expect(saved.status).toBe(200);
  const again = await locationOffice(
    "manager",
    "/api/v1/masters/stores/location",
    office,
    "location-once",
  );
  expect(again.body.id).toBe(saved.body.id);
  expect(
    (await locationOffice("viewer", "/api/v1/masters/stores/location", office))
      .status,
  ).toBe(403);
  expect(
    (
      await locationOffice("admin", "/api/v1/masters/stores/location", {
        ...office,
        latitude: 10.32,
      })
    ).status,
  ).toBe(200);
  const verified =
    await h.db`select * from outlet_pins where outlet_id=${enrolment.outlet_id} and status='verified' order by effective_from`;
  expect(verified.length).toBe(2);
  expect(+verified[0].effective_to).toBe(+verified[1].effective_from);
  expect(verified[0].latitude).toBe(10.31);
  expect(verified[1].latitude).toBe(10.32);
  // Late field evidence must not move an office-confirmed pin.
  expect(
    (
      await rep.push(
        { ...tag, location: { ...tag.location, accuracyMeters: 1 } },
        crypto.randomUUID(),
        "store.location",
      )
    ).status,
  ).toBe("applied");
  expect(
    (
      await h.db`select count(*)::int n from outlet_pins where outlet_id=${enrolment.outlet_id} and status='verified'`
    )[0].n,
  ).toBe(2);
  const list = await locationOffice(
    "manager",
    "/api/v1/masters/store-locations?q=Delayed%20GPS",
  );
  expect(list.body.rows[0]).toMatchObject({
    located: true,
    latitude: 10.32,
    longitude: 123.91,
  });
  // A replay is not permission to read a store after its ownership is withdrawn.
  await h.db`update outlets set custodian_org_unit_id=${rowId("org_units", "territory-1")} where id=${enrolment.outlet_id}`;
  expect((await rep.push(tag, id, "store.location")).status).toBe("rejected");
}, 120000);

test("SP-0251 legacy Android capture keeps original bytes and receives its later reading before office approval", async () => {
  const legacy = await fieldRep();
  const config = (await legacy.get("/api/v1/masters/census-config")).body;
  const sub = config.subchannels[0];
  const p = capture({
    location: null,
    channelId: sub.data.channelId,
    subchannelId: sub.id,
    estimatedClass: "C",
  });
  delete p.customer;
  expect((await legacy.push(p)).status).toBe("applied");
  const tag = {
    captureId: p.captureId,
    deviceTime: Date.now(),
    location: capture().location,
  };
  expect(
    (await legacy.push(tag, crypto.randomUUID(), "store.location")).status,
  ).toBe("applied");
  expect(
    (
      await h.db`select latitude from census_captures where id=${p.captureId}`
    )[0].latitude,
  ).toBeNull();
  const queue = await locationOffice("manager", "/api/v1/masters/census-queue");
  expect(
    queue.body.rows.find((/** @type {any} */ r) => r.id === p.captureId),
  ).toMatchObject({
    latitude: tag.location.latitude,
    location_status: "verified",
  });
  const approved = await locationOffice(
    "manager",
    "/api/v1/masters/census/review",
    { captureId: p.captureId, decision: "accept", reason: "Store checked" },
  );
  expect(approved.status).toBe(200);
  expect(
    (
      await h.db`select latitude from outlet_pins where outlet_id=${approved.body.outletId} and status='verified'`
    )[0].latitude,
  ).toBe(tag.location.latitude);
}, 120000);

test("Add customer capture becomes a prospect customer with a complete pending profile; replay is idempotent", async () => {
  const p = capture();
  // SP-0240: the names entered separately on the phone reach the same canonical record.
  p.customer = {
    ...p.customer,
    firstName: "Aling Nena",
    middleName: "",
    lastName: "Store",
    salesPartnerCode: "SOMEONE-ELSE",
  };
  const opId = crypto.randomUUID();
  const first = await rep.push(p, opId);
  if (first.status !== "applied") console.log(JSON.stringify(first));
  expect(first.status).toBe("applied");
  const [enrolment] =
    await h.db`select outlet_id,status from outlet_enrolments where client_request_id=${p.captureId}`;
  expect(enrolment.status).toBe("pending");
  const c = await readCustomer(h.db, enrolment.outlet_id);
  expect(c).toMatchObject({
    firstName: "Aling Nena",
    middleName: null,
    lastName: "Store",
    customerName: "Store, Aling Nena",
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
  // SP-0252: Sales Partner = the salesman who added it, always; a value the phone sends is ignored.
  const [me] =
    await h.db`select coalesce(employee_code,id::text) as code from profiles where user_id=${rep.userId}`;
  expect(c.salesPartnerCode).toBe(me.code);
  expect(c.salesPartnerName).toBe("Capture rep");
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

test("SP-0256 customer profiling saves without a photo and replays without adding files", async () => {
  for (const photoJpegBase64 of [undefined, null, ""]) {
    const p = capture({ photoJpegBase64 });
    const op = crypto.randomUUID();
    const [{ n: before }] = await h.db`select count(*)::int n from files`;
    const saved = await rep.push(p, op);
    expect(saved.status).toBe("applied");
    const [e] =
      await h.db`select id,outlet_id,status,pin_id from outlet_enrolments where client_request_id=${p.captureId}`;
    expect(e.status).toBe("pending");
    expect(await readCustomer(h.db, e.outlet_id)).toMatchObject({
      customerName: p.customer.customerName,
      completeness: "complete",
    });
    expect(
      await h.db`select file_id from outlet_enrolment_photos where outlet_enrolment_id=${e.id}`,
    ).toHaveLength(0);
    const [pin] =
      await h.db`select evidence_storage_id from outlet_pins where id=${e.pin_id}`;
    expect(pin.evidence_storage_id).toBeNull();
    expect((await rep.push(p, op)).status).toBe("duplicate");
    // Also exercise the capture-level replay with a fresh operation identifier.
    expect((await rep.push(p)).status).toBe("applied");
    expect((await h.db`select count(*)::int n from files`)[0].n).toBe(before);
    expect(
      await h.db`select id from outlet_enrolments where client_request_id=${p.captureId}`,
    ).toHaveLength(1);
  }
});

test("SP-0256 supplied storefront photos still require a real bounded JPEG", async () => {
  for (const photoJpegBase64 of [
    false,
    "not-base64",
    Buffer.from([255, 216, 255, 217]).toString("base64"),
    Buffer.alloc(160 * 1024 + 1).toString("base64"),
  ]) {
    const p = capture({ photoJpegBase64 });
    expect((await rep.push(p)).status).toBe("rejected");
    expect(
      await h.db`select id from outlet_enrolments where client_request_id=${p.captureId}`,
    ).toHaveLength(0);
  }
});

test("SP-0243 weak, old and absent location save through signed sync, including delayed send and replay", async () => {
  const at = Date.now() - 3 * 86400000;
  const weak = {
    ...capture().location,
    accuracyMeters: 500,
    fixTime: at - 1800000,
  };
  for (const location of [
    weak,
    null,
    undefined,
    { ...weak, fixTime: at - 1800001 },
    { ...weak, accuracyMeters: 501 },
  ]) {
    const p = capture({ deviceTime: at, location });
    const opId = crypto.randomUUID();
    expect((await rep.push(p, opId)).status).toBe("applied");
    const [e] =
      await h.db`select * from outlet_enrolments where client_request_id=${p.captureId}`;
    const customer = await readCustomer(h.db, e.outlet_id);
    expect(customer.customerName).toBe(p.customer.customerName);
    if (location === weak) {
      expect(customer.latitude).toBe(weak.latitude);
      expect(customer.pinStatus).toBe("pending");
      expect(e.location_evidence).toEqual(weak);
    } else {
      expect(e.pin_id).toBeNull();
      expect(customer.latitude).toBeNull();
      expect(customer.longitude).toBeNull();
      expect(customer.pinStatus).toBeNull();
      expect(customer.completeness).toBe("draft");
      expect(
        (await h.db`select id from outlet_pins where outlet_id=${e.outlet_id}`)
          .length,
      ).toBe(0);
    }
    expect(["applied", "duplicate"]).toContain(
      (await rep.push(p, opId)).status,
    );
    expect(
      (
        await h.db`select count(*)::int n from outlet_enrolments where client_request_id=${p.captureId}`
      )[0].n,
    ).toBe(1);
  }
  for (const location of [
    { ...weak, latitude: 91 },
    { ...weak, mockSignal: true },
  ]) {
    expect((await rep.push(capture({ deviceTime: at, location }))).status).toBe(
      "rejected",
    );
  }
});

test("SP-0246 signed field captures keep a complete profile with blank or unlisted ZIPs in Laua-An", async () => {
  const own = await fieldRep();
  const [town] =
    await h.db`select m.code,m.region_code,m.province_code,b.code as barangay_code from ph_municipalities m join ph_barangays b on b.municipality_code=m.code where m.name='Laua-An' order by b.code limit 1`;
  for (const postalCode of ["", "9999", "0123"]) {
    const p = capture();
    Object.assign(p.customer, {
      regionCode: town.region_code,
      provinceCode: town.province_code,
      municipalityCode: town.code,
      barangayCode: town.barangay_code,
      postalCode,
    });
    const op = crypto.randomUUID();
    expect((await own.push(p, op)).status).toBe("applied");
    const [enrolment] =
      await h.db`select outlet_id from outlet_enrolments where client_request_id=${p.captureId}`;
    const stored = await readCustomer(h.db, enrolment.outlet_id);
    expect(stored).toMatchObject({
      postalCode: postalCode || null,
      completeness: "complete",
      fieldMissing: null,
    });
    expect((await own.push(p, op)).status).toBe("duplicate");
    expect((await readCustomer(h.db, enrolment.outlet_id)).postalCode).toBe(
      postalCode || null,
    );
  }
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
    const p = capture({
      photoJpegBase64: decision === "approve" ? undefined : photo,
    });
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

test("SP-0255 signed Android captures without Street 1 stay complete and retain coordinates", async () => {
  const phone = await fieldRep();
  for (const street1 of [undefined, null, "", " \t "]) {
    const p = capture();
    p.customer = { ...p.customer, street1 };
    const result = await phone.push(p);
    expect(result.status, JSON.stringify(result)).toBe("applied");
    const stored = await readCustomer(h.db, result.ack.entityId);
    expect(stored).toMatchObject({
      street1: null,
      completeness: "complete",
      enrolmentStatus: "provisional",
    });
    expect(stored.fieldMissing ?? []).toEqual([]);
    expect(stored.latitude).toBe(p.location.latitude);
    expect(stored.longitude).toBe(p.location.longitude);
    expect(stored.customerAddress).toContain("Apas");
  }
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
