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
    /** @param {string} path */
    get: async (path) => {
      const r = await h.fetch(path, {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
      return { status: r.status, body: /** @type {any} */ (await r.json()) };
    },
    /** @param {any} payload @param {string} [clientOpId] */
    push: async (payload, clientOpId = crypto.randomUUID()) =>
      (
        await signedPost(h, who, "/api/sync/push", {
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
        })
      ).body.results[0],
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
    },
    ...over,
  };
}

beforeAll(async () => {
  h = await startHarness({ installers: [org, masters] });
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

test("Add customer capture becomes a prospect customer with a draft profile; replay is idempotent", async () => {
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
    completeness: "draft",
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
  // No census review row: the office completes and approves it as a customer.
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

test("an invalid customer (draft rules) is refused, the old census payload still works", async () => {
  const bad = capture({
    customer: { ...capture().customer, customerGroup1Code: "NOPE" },
  });
  const r = await rep.push(bad);
  expect(r.status).not.toBe("applied");
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
