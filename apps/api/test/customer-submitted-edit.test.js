import { afterAll, beforeAll, expect, test } from "bun:test";
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
import { SAMPLE_IMAGE } from "../src/domains/masters/catalogue.js";
import { readCustomer } from "../src/domains/masters/customers.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {Record<string,any>} */ const people = {};
let unit = "",
  id = "",
  photo = "";
/** @param {string} who @param {string} method @param {string} path @param {any} [body] @param {string} [key] */
async function call(who, method, path, body, key) {
  const res = await h.fetch(`/api/v1/customers${path}`, {
    method,
    headers: {
      cookie: people[who].cookie,
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} who @param {string} app */
async function phone(who, app) {
  if (people[who].phone) return people[who].phone;
  const key = await deviceKey();
  const deviceId = await registerDevice(h, {
    profileId: people[who].profile,
    orgUnitId: unit,
    key,
    app,
  });
  const { res: login, body: tokens } = await nativeSignIn(
    h,
    `${who}@example.com`,
    "sample-profile-password",
    app,
    { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
  );
  expect(
    login.status,
    login.status === 200 ? "native signed in" : JSON.stringify(tokens),
  ).toBe(200);
  const bound = await bind(h, tokens.accessToken, deviceId, key);
  expect(bound.res.status, JSON.stringify(bound.body)).toBe(200);
  return (people[who].phone = {
    async capture() {
      const payload = {
        captureId: crypto.randomUUID(),
        deviceTime: Date.now(),
        photoJpegBase64: photo,
        customer: {
          customerName: "Sample submitted customer",
          registeredName: "Sample store",
        },
        location: null,
      };
      const r = await signedPost(
        h,
        { access: tokens.accessToken, deviceId, key },
        "/api/sync/push",
        {
          version: 2,
          app,
          deviceId,
          scopeId: unit,
          operations: [
            {
              clientOpId: crypto.randomUUID(),
              opType: "census.capture",
              clientTime: payload.deviceTime,
              dependsOn: [],
              payload,
            },
          ],
        },
      );
      expect(r.body.results[0].status, JSON.stringify(r.body)).toBe("applied");
      return r.body.results[0].ack.entityId;
    },
    /** @param {string} path @param {any} [body] */
    async request(path, body) {
      const r = await h.fetch(`/api/v1/customers${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          "X-App": app,
          "X-Device-Key-Id": key.keyId,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: /** @type {any} */ (await r.json()) };
    },
  });
}
beforeAll(async () => {
  h = await startHarness({ installers: [org, masters], port: 5040 });
  const [u] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','SUNPRIDE','Sample profile proof','NATIONAL','active','2020-01-01') returning id`;
  unit = u.id;
  h.setHooks({ rootUnitId: async () => unit });
  for (const [who, role] of [
    ["owner", "sales"],
    ["other", "sales"],
    ["cdm", "manager"],
    ["office", "admin"],
    ["root", "super_admin"],
    ["ops", "operations"],
    ["viewer", "viewer"],
    ["ios", "sales"],
  ]) {
    const user = await createUser(
      h,
      `${who}@example.com`,
      "sample-profile-password",
    );
    const [p] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,org_unit_id,status) values(${user},${user},${who},${`${who}@example.com`},${role},${unit},'active') returning id`;
    await h.db`insert into employee_assignments(profile_id,role,org_unit_id,effective_from,actor_subject,reason) values(${p.id},${role},${unit},'2020-01-01',${user},'Sample SP-0250 proof')`;
    const r = await h.fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `${who}@example.com`,
        password: "sample-profile-password",
      }),
    });
    expect(r.status).toBe(200);
    people[who] = {
      user,
      profile: p.id,
      cookie: (r.headers.get("set-cookie") ?? "").split(";")[0],
    };
  }
  await h.db`insert into ph_regions(code,name) values('0700000000','Sample Region') on conflict do nothing`;
  await h.db`insert into ph_provinces(code,region_code,name,kind) values('0702200000','0700000000','Sample Province','province') on conflict do nothing`;
  await h.db`insert into ph_municipalities(code,province_code,region_code,name,kind) values('0730600000','0702200000','0700000000','Sample City','city') on conflict do nothing`;
  await h.db`insert into ph_barangays(code,municipality_code,name) values('0730600003','0730600000','Sample Barangay') on conflict do nothing`;
  await h.db`insert into ph_postal_codes(municipality_code,postal_code,source) values('0730600000','6000','Sample test') on conflict do nothing`;
  photo = Buffer.from(await Bun.file(SAMPLE_IMAGE).arrayBuffer()).toString(
    "base64",
  );
  id = await (await phone("owner", "field-android")).capture();
}, 180000);
afterAll(async () => {
  await h?.close();
});

test("SP-0250 original salesman and CDM save partial profiles without approving or duplicating them", async () => {
  const before = await readCustomer(h.db, id);
  for (const who of ["owner", "cdm"]) {
    const viewed = await call(who, "GET", `/${id}`);
    expect(viewed.status).toBe(200);
    expect(viewed.body.canEdit).toBe(true);
    expect(
      viewed.body.missingFields.some(
        (/** @type {any} */ e) => e.field === "street1",
      ),
    ).toBe(true);
    const saved = await call(who, "PUT", `/${id}`, {
      customer: { tradeName: `Sample completed by ${who}` },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.enrolmentStatus).toBe("provisional");
    expect(saved.body.code).toBe(before.code);
    expect(saved.body.id).toBe(id);
    expect(saved.body.accountingCustomerId).toBeNull();
    expect(saved.body.missingFields.length).toBeGreaterThan(0);
    expect(saved.body.history[0]).toMatchObject({
      actor: who,
      changes: expect.arrayContaining([
        expect.objectContaining({
          field: "tradeName",
          after: `Sample completed by ${who}`,
        }),
      ]),
    });
  }
  const [{ n }] =
    await h.db`select count(*)::int n from outlet_enrolments where outlet_id=${id} and status='pending'`;
  expect(n).toBe(1);
});

test("SP-0250 another salesman and read-only accounts cannot amend the submitted profile", async () => {
  for (const who of ["other", "viewer"]) {
    expect((await call(who, "GET", `/${id}`)).body.canEdit).toBe(false);
    for (const route of ["", "/amend"]) {
      const r = await call(
        who,
        route ? "POST" : "PUT",
        `/${id}${route}`,
        route
          ? { edits: { tradeName: "Not allowed" } }
          : { customer: { tradeName: "Not allowed" } },
      );
      expect(r.status).toBe(403);
    }
  }
});

test("SP-0250 the submitter can reopen and complete their waiting customer when its territory has another salesman", async () => {
  const [territory] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by) values('sunpride','SAMPLE250','Sample assigned territory','active','2020-01-01',${people.office.user}) returning id`;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${territory.id},${unit},'2020-01-01',${people.office.user},'Sample proof')`;
  await h.db`insert into territory_salespeople(territory_id,profile_id,kind,effective_from,actor_subject,reason) values(${territory.id},${people.other.profile},'primary','2020-01-01',${people.office.user},'Sample proof')`;
  const [assignment] =
    await h.db`insert into outlet_assignments(outlet_id,territory_id,effective_from,actor_subject,reason) values(${id},${territory.id},'2020-01-01',${people.office.user},'Sample proof') returning id`;
  try {
    expect((await call("owner", "GET", `/${id}`)).body.canEdit).toBe(true);
    expect((await call("owner", "GET", `/${id}/editor`)).status).toBe(200);
    const saved = await call("owner", "PUT", `/${id}`, {
      customer: { tradeName: "Sample owner completion" },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.enrolmentStatus).toBe("provisional");
    expect(
      (
        await call("other", "PUT", `/${id}`, {
          customer: { tradeName: "Not the submitter" },
        })
      ).status,
    ).toBe(403);
  } finally {
    await h.db`delete from outlet_assignments where id=${assignment.id}`;
  }
});

test("SP-0250 Android and iOS bearer requests reopen, preview dependent choices and save the same profile", async () => {
  for (const [who, app] of [
    ["owner", "field-android"],
    ["ios", "field-ios"],
  ]) {
    const native = await phone(who, app);
    const target = who === "owner" ? id : await native.capture();
    const opened = await native.request(`/${target}/editor`);
    expect(opened.status).toBe(200);
    expect(opened.body.customer.canEdit).toBe(true);
    const edits = { street1: "Sample new street", regionCode: "0700000000" };
    const preview = await native.request(`/${target}/editor`, {
      edits,
      expectedUpdatedAt: opened.body.customer.updatedAt,
    });
    expect(preview.status).toBe(200);
    expect(
      preview.body.fields.find(
        (/** @type {any} */ f) => f.key === "provinceCode",
      ).options,
    ).toContainEqual({
      code: "0702200000",
      name: "Sample Province (0702200000)",
    });
    expect((await readCustomer(h.db, target)).street1).toBeNull(); // preview is not a save
    const saved = await native.request(`/${target}/amend`, {
      edits,
      expectedUpdatedAt: opened.body.customer.updatedAt,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const reopened = await native.request(`/${target}/editor`);
    expect(reopened.body.customer.street1).toBe("Sample new street");
    expect(reopened.body.customer.enrolmentStatus).toBe("provisional");
    expect(reopened.body.customer.history[0].actor).toBe(who);
  }
});

test("SP-0250 invalid supplied fields, stale editing and forged status/number are refused without writes", async () => {
  const before = await readCustomer(h.db, id);
  for (const body of [
    { customer: { email: "not email" } },
    { customer: { tradeName: "Stale" }, expectedUpdatedAt: 0 },
  ]) {
    expect((await call("owner", "PUT", `/${id}`, body)).status).toBe(
      body.expectedUpdatedAt === 0 ? 409 : 422,
    );
  }
  expect(
    (
      await call("owner", "POST", `/${id}/amend`, {
        edits: { enrolmentStatus: "approved", code: "FAKE" },
      })
    ).status,
  ).toBe(400);
  expect(await readCustomer(h.db, id)).toEqual(before);
});

test("SP-0250 complete then approve: current admin-only permission applies to old editors and request replays", async () => {
  const customer = {
    registeredName: "Sample store",
    customerName: "Sample owner",
    mobileNo: "09171234567",
    taxClassificationCode: "1",
    countryCode: "PH",
    regionCode: "0700000000",
    provinceCode: "0702200000",
    municipalityCode: "0730600000",
    barangayCode: "0730600003",
    street1: "Sample Street",
    postalCode: "6000",
    latitude: 10.3,
    longitude: 123.9,
    salesOrgCode: "1000",
    salesOfficeCode: "100",
    distributionChannelCode: "50",
    customerGroupCode: "74",
    typeOfBusiness: "Sole Proprietor",
    paymentTermsCode: "0003",
    pricingProcedureCode: "2",
    deliveringPlantCode: "1000",
    shipTos: [{ sameAsCustomer: true, contactPerson: "Sample owner" }],
  };
  const done = await call("cdm", "PUT", `/${id}`, { customer });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  const key = crypto.randomUUID(),
    body = {
      customer: { tradeName: "Sample before approval" },
      expectedUpdatedAt: done.body.updatedAt,
    };
  expect((await call("owner", "PUT", `/${id}`, body, key)).status).toBe(200);
  // A successful pending save replays even though that save advanced its version.
  expect((await call("owner", "PUT", `/${id}`, body, key)).status).toBe(200);
  const approved = await call("cdm", "POST", `/${id}/approve`, {});
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const before = await readCustomer(h.db, id);
  for (const who of ["owner", "other", "cdm", "ops", "viewer"]) {
    expect((await call(who, "GET", `/${id}`)).body.canEdit).toBe(false);
    expect((await call(who, "PUT", `/${id}`, body, key)).status).toBe(403);
    expect(
      (await call(who, "POST", `/${id}/amend`, { edits: { tradeName: "No" } }))
        .status,
    ).toBe(403);
  }
  expect(await readCustomer(h.db, id)).toEqual(before);
  for (const who of ["office", "root"]) {
    const saved = await call(who, "PUT", `/${id}`, {
      customer: { tradeName: `Sample after approval ${who}` },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.canEdit).toBe(true);
    expect(saved.body.enrolmentStatus).toBe("approved");
  }
});
