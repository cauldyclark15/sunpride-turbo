// SP-0197: the owner (super_admin) on the Field app, with the LIVE profile shape: a profile on the
// national root unit, no employee assignment row, no territory, route or plan. Real installers and
// real org hooks (no profile or scope mocks), the demo seed, the client's masters and geography.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import { loadPhGeography } from "@sunpride/db/ph-geography";
import {
  startHarness,
  createUser,
  deviceKey,
  nativeSignIn,
  bind,
  signedPost,
} from "./harness.js";
import { domainInstallers } from "../src/domains/index.js";
import { manilaDate } from "../src/domains/fieldsync/model.js";
import { SAMPLE_IMAGE } from "../src/domains/masters/catalogue.js";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { seedSpecMasters } from "../../../packages/db/seed/spec-masters.js";
import { rowId, todayManila } from "../../../packages/db/seed/store.js";

const PASSWORD = "test-only-sp197-password";
const OWNER_OUTLET_CAP = 100; // fieldsync/projections.js (kept literal so this file also runs on older code)
/** @type {Awaited<ReturnType<typeof startHarness>>} */ let h;
let photo = "";
/** @type {string} */ let ownerProfile;
/** @type {string} */ let viewerProfile;

/** A Field app phone: sign in (an owner phone registers itself, SP-0193), read /api/me, bind.
 * @param {string} email */
async function phone(email) {
  const key = await deviceKey();
  const r = await nativeSignIn(h, email, PASSWORD, "field-android", {
    keyId: key.keyId,
    publicKeySpki: key.publicKeySpki,
  });
  expect(r.res.status, JSON.stringify(r.body)).toBe(200);
  const access = /** @type {string} */ (r.body.accessToken);
  const me = await get(access, "/api/me", key.keyId);
  const deviceId = /** @type {string} */ (me.body.device?.id);
  expect(me.body.device?.status).toBe("active");
  expect((await bind(h, access, deviceId, key)).body.bindingStatus).toBe(
    "bound",
  );
  return { key, access, deviceId, me: (await get(access, "/api/me")).body };
}
/** @param {string} access @param {string} path @param {string} [keyId] */
async function get(access, path, keyId) {
  const r = await h.fetch(path, {
    headers: {
      authorization: `Bearer ${access}`,
      "x-app": "field-android",
      ...(keyId ? { "x-device-key-id": keyId } : {}),
    },
  });
  return { status: r.status, body: /** @type {any} */ (await r.json()) };
}
/** The phone's start-of-day download (V2Wire field.bundle), every page. @param {any} who */
async function download(who) {
  const params = {
    dayFrom: manilaDate(Date.now()),
    includeWorkforce: true,
    schemeEngine: 1,
  };
  /** @type {any[]} */ const outlets = [];
  /** @type {any} */ let first = null;
  /** @type {string|null} */ let page = null;
  for (let i = 0; i < 20; i++) {
    const r = await signedPost(h, who, "/api/sync/pull", {
      version: 2,
      app: "field-android",
      deviceId: who.deviceId,
      since: null,
      pageCursor: page,
      limit: 100,
      scopes: [
        { scopeId: who.me.scope.id, projection: "field.bundle", params },
      ],
    });
    if (r.res.status !== 200) return { status: r.res.status, body: r.body };
    const b = r.body.bundles[0];
    first ??= b;
    outlets.push(...b.data.outlets);
    page = r.body.nextPageCursor;
    if (!page) break;
  }
  return { status: 200, bundle: first, outlets };
}
/** The payload the Android app builds for Add customer (CustomerCapture.payload). */
function capture() {
  const at = Date.now();
  return {
    captureId: crypto.randomUUID(),
    name: "Owner Added Store",
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
      registeredName: "Owner Added Store Inc.",
      customerName: "Owner Added Store",
      tradeName: "Owner's",
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
  };
}

beforeAll(async () => {
  h = await startHarness({ installers: domainInstallers });
  await seedDemo(h.db, { days: 3, anchorDate: todayManila() });
  await tx(h.db, seedSpecMasters);
  await loadPhGeography(h.db);
  photo = Buffer.from(await Bun.file(SAMPLE_IMAGE).arrayBuffer()).toString(
    "base64",
  );
  const national = rowId("org_units", "national");
  // The owner as he is on live: national unit, Selling on, no employee assignment at all.
  const owner = await createUser(h, "owner@sp197.test", PASSWORD);
  [{ id: ownerProfile }] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,selling,app_mode) values(${owner},${owner},'Owner','owner@sp197.test','super_admin','active',${national},true,'selling') returning id`;
  // A viewer with the same missing assignment: nothing is created for other roles.
  const viewer = await createUser(h, "viewer@sp197.test", PASSWORD);
  [{ id: viewerProfile }] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${viewer},${viewer},'Viewer','viewer@sp197.test','viewer','active',${national}) returning id`;
}, 240000);
afterAll(async () => {
  await h?.close();
});

test("SP-0197 owner phone downloads the day with every active store (capped), as himself", async () => {
  const owner = await phone("owner@sp197.test");
  const day = await download(owner);
  expect(day.status, JSON.stringify(day.body)).toBe(200);
  const all =
    await h.db`select id from outlets where organization_id='sunpride' and deleted_at is null and status='active' and (enrolment_status is null or enrolment_status='approved') order by name,id`;
  const got = /** @type {any[]} */ (day.outlets).map((o) => o.id);
  // The first stores by name, never more than the cap (the seed has 300; a phone gets 100 at most).
  expect(all.length).toBeGreaterThan(OWNER_OUTLET_CAP);
  expect(got.length).toBeGreaterThan(50);
  expect(got.length).toBeLessThanOrEqual(OWNER_OUTLET_CAP);
  expect(new Set(got)).toEqual(
    new Set(all.slice(0, got.length).map((/** @type {any} */ o) => o.id)),
  );
  expect(day.bundle.data.employee).toMatchObject({
    id: ownerProfile,
    role: "super_admin",
    selling: true,
    appMode: "selling",
  });
  expect(day.bundle.scopeFingerprint).toBe(owner.me.scope.fingerprint);
  // His profile now carries the assignment every provisioned profile has, once, audited.
  const rows =
    await h.db`select org_unit_id,role,effective_to from employee_assignments where profile_id=${ownerProfile} and deleted_at is null`;
  expect(rows).toEqual([
    {
      org_unit_id: rowId("org_units", "national"),
      role: "super_admin",
      effective_to: null,
    },
  ]);
  const audits =
    await h.db`select 1 from audit_logs where action='profile.assignment_repaired' and entity_id=${ownerProfile}`;
  expect(audits).toHaveLength(1);
  // A second download is the same and adds nothing.
  expect((await download(owner)).status).toBe(200);
  expect(
    await h.db`select 1 from employee_assignments where profile_id=${ownerProfile}`,
  ).toHaveLength(1);
}, 120000);

test("SP-0197 owner phone gets the customer setup lists and his added customer reaches the office as his", async () => {
  const owner = await phone("owner@sp197.test");
  // The phone opens Add customer only from the encrypted store the start-of-day download creates
  // (FieldController.withStore): without that download it shows "Customer setup is unavailable".
  expect((await download(owner)).status).toBe(200);
  const config = await get(owner.access, "/api/v1/masters/census-config");
  expect(config.status).toBe(200);
  const lists = new Set(
    config.body.customerMaster.lists.map((/** @type {any} */ l) => l.list),
  );
  for (const l of [
    "sales_organization",
    "distribution_channel",
    "customer_group_1",
    "payment_terms",
  ])
    expect(lists.has(l)).toBe(true);
  const p = capture();
  const sent = await signedPost(h, owner, "/api/sync/push", {
    version: 2,
    app: "field-android",
    deviceId: owner.deviceId,
    scopeId: owner.me.scope.id,
    operations: [
      {
        clientOpId: crypto.randomUUID(),
        opType: "census.capture",
        clientTime: p.deviceTime,
        dependsOn: [],
        payload: p,
      },
    ],
  });
  expect(sent.res.status).toBe(200);
  expect(sent.body.results[0].status, JSON.stringify(sent.body)).toBe(
    "applied",
  );
  const [enrolment] =
    await h.db`select status,proposed_by_profile_id from outlet_enrolments where client_request_id=${p.captureId}`;
  expect(enrolment).toEqual({
    status: "pending",
    proposed_by_profile_id: ownerProfile,
  });
  const mine = await get(owner.access, "/api/v1/masters/census/my-changes");
  expect(mine.status).toBe(200);
}, 120000);

test("SP-0197 nothing changes for other roles without an assignment", async () => {
  const signIn = await nativeSignIn(
    h,
    "viewer@sp197.test",
    PASSWORD,
    "field-android",
  );
  expect(signIn.res.status).toBe(200);
  expect((await get(signIn.body.accessToken, "/api/me")).status).toBe(200);
  expect(
    await h.db`select 1 from employee_assignments where profile_id=${viewerProfile}`,
  ).toHaveLength(0);
});
