import { afterAll, beforeAll, expect, test } from "bun:test";
import { loadPhGeography } from "@sunpride/db/ph-geography";
import {
  CUSTOMER_HEADERS,
  EXAMPLE,
  enrollmentHeader,
  customerTemplateCsv,
  parseCustomerCsv,
} from "@sunpride/import-templates/customers";
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
import { install as imports } from "../src/domains/imports/index.js";
import { runtime } from "../src/domains/imports/customer-upload.js";
import {
  PROFILE_COLUMNS,
  readCustomer,
} from "../src/domains/masters/customers.js";
import { SAMPLE_IMAGE } from "../src/domains/masters/catalogue.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {Record<string,string>} */ const cookies = {};
/** @type {Record<string,any>} */ const people = {};
let unit = "",
  customerId = "",
  photo = "";
const key = (/** @type {number} */ n) => `cf_${String(n).padStart(32, "0")}`;
const fields = ["text", "number", "date", "choice", "boolean", "photo"].map(
  (kind, i) => ({
    key: key(i + 1),
    label: `Sample ${kind}`,
    kind,
    choices: kind === "choice" ? ["Small", "Large"] : [],
    requiredChannels: i === 0 ? ["30"] : [],
    requiredTypes: i === 1 ? ["Sole Proprietor"] : [],
  }),
);
/** @type {Record<string,string>} */ let answers;
/** @param {string} who @param {string} path @param {any} [body] @param {string} [method] */
async function call(
  who,
  path,
  body = undefined,
  method = body === undefined ? "GET" : "POST",
) {
  const res = await h.fetch(`/api/v1/${path}`, {
    method,
    headers: {
      cookie: cookies[who],
      "content-type": "application/json",
      connection: "close",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}
/** @returns {Promise<{revision:number,fields:import("@sunpride/customer-master").EnrollmentField[]}>} */
async function form() {
  return (await call("office", "customers/enrollment-form")).body;
}
/** @param {import("@sunpride/customer-master").EnrollmentField[]} next @param {number} revision */
async function saveForm(next, revision) {
  return call(
    "office",
    "customers/enrollment-form",
    { revision, fields: next },
    "PUT",
  );
}
beforeAll(async () => {
  h = await startHarness({ installers: [org, masters, imports] });
  await loadPhGeography(h.db);
  const [root] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','SUNPRIDE','Sample national','NATIONAL','active','2020-01-01') returning id`;
  unit = root.id;
  h.setHooks({ rootUnitId: async () => unit });
  for (const [name, role] of [
    ["office", "admin"],
    ["agent", "sales"],
    ["head", "manager"],
  ]) {
    const user = await createUser(
      h,
      `${name}@example.com`,
      "sample-enrollment-password",
    );
    const [p] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,org_unit_id,status) values(${user},${user},${name},${`${name}@example.com`},${role},${unit},'active') returning id`;
    await h.db`insert into employee_assignments(profile_id,role,org_unit_id,effective_from,actor_subject,reason) values(${p.id},${role},${unit},'2020-01-01',${user},'Sample enrollment proof')`;
    people[name] = { user, profile: p.id };
    const res = await h.fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({
        email: `${name}@example.com`,
        password: "sample-enrollment-password",
      }),
    });
    expect(res.status).toBe(200);
    cookies[name] = (res.headers.get("set-cookie") ?? "").split(";")[0];
  }
  photo = Buffer.from(await Bun.file(SAMPLE_IMAGE).arrayBuffer()).toString(
    "base64",
  );
  answers = {
    [key(1)]: "North counter",
    [key(2)]: "0",
    [key(3)]: "2026-11-20",
    [key(4)]: "Small",
    [key(5)]: "false",
    [key(6)]: `data:image/jpeg;base64,${photo}`,
  };
}, 240000);
afterAll(async () => {
  await Promise.all(runtime.workers.values());
  await h?.close();
});

test("SP-0229 office adds all six types; readback, audit, required rules and stale saves", async () => {
  for (const who of ["agent", "head"])
    expect(
      (
        await call(
          who,
          "customers/enrollment-form",
          { revision: 0, fields },
          "PUT",
        )
      ).status,
    ).toBe(403);
  const saved = await saveForm(fields, 0);
  expect(saved.status).toBe(200);
  expect(saved.body.fields).toEqual(fields);
  expect((await form()).revision).toBe(1);
  expect((await saveForm(fields, 0)).status).toBe(409);
  const audit =
    await h.db`select details from audit_logs where action='enrollment_form.update'`;
  expect(audit.length).toBe(1);
  expect(JSON.parse(audit[0].details).after.fields).toEqual(fields);
  const reversed = [...fields]
    .reverse()
    .map((f) =>
      f.key === key(1) ? { ...f, label: "Sample counter detail" } : f,
    );
  expect((await saveForm(reversed, 1)).status).toBe(200);
  expect((await form()).fields.map((f) => f.key)).toEqual(
    reversed.map((f) => f.key),
  );
  expect((await saveForm(fields.slice(1), 2)).status).toBe(400);
  expect(
    (
      await saveForm(
        reversed.map((f) => (f.key === key(2) ? { ...f, kind: "text" } : f)),
        2,
      )
    ).status,
  ).toBe(400);
  expect((await saveForm([...reversed, reversed[0]], 2)).status).toBe(400);
  expect((await form()).revision).toBe(2);
});

test("SP-0229 customer upload saves all typed answers; list/detail and canonical office edits preserve them", async () => {
  const template = await call("office", "imports/customer-upload/template");
  expect(template.body.enrollmentForm.fields).toHaveLength(6);
  const extra = Object.fromEntries(
    Object.entries(answers).map(([k, v]) => [`customFields.${k}`, v]),
  );
  const upload = await call("office", "imports/customer-upload/runs", {
    fileName: "sample-enrollment.csv",
    header: [...CUSTOMER_HEADERS, ...fields.map(enrollmentHeader)],
    rows: [
      {
        rowNumber: 2,
        values: { ...EXAMPLE, code: "SAMPLE-ENROLLMENT", ...extra },
      },
    ],
  });
  expect(upload.status).toBe(200);
  await runtime.workers.get(upload.body.id);
  const [run] =
    await h.db`select status,failed_count from customer_upload_runs where id=${upload.body.id}`;
  expect(run).toEqual({ status: "completed", failed_count: 0 });
  const [record] =
    await h.db`select id from outlets where code='SAMPLE-ENROLLMENT'`;
  customerId = record.id;
  expect(
    (await call("office", `customers/${customerId}`)).body.customFields,
  ).toEqual(answers);
  const list = await call("office", "customers?q=SAMPLE-ENROLLMENT&offset=0");
  expect(list.body.rows[0].customFields).toEqual(answers);
  const changed = await call(
    "office",
    `customers/${customerId}`,
    { customer: { tradeName: "Sample edited" } },
    "PUT",
  );
  expect(changed.status).toBe(200);
  expect(changed.body.customFields).toEqual(answers);
  for (const custom of [
    { ...answers, [key(1)]: "" },
    { ...answers, [key(2)]: "-" },
    { ...answers, [key(3)]: "2026-02-30" },
    { ...answers, [key(4)]: "Unknown" },
    { ...answers, [key(5)]: "-" },
    { ...answers, [key(6)]: "https://foreign.test/photo.jpg" },
    { ...answers, [key(7)]: "Unknown field" },
  ]) {
    const failed = await call(
      "office",
      `customers/${customerId}`,
      { customer: { customFields: custom, tradeName: "Must not save" } },
      "PUT",
    );
    expect(failed.status).toBe(422);
  }
  expect((await readCustomer(h.db, customerId)).tradeName).toBe(
    "Sample edited",
  );
  expect((await readCustomer(h.db, customerId)).customFields).toEqual(answers);
  const preview = await call("office", "imports/customer-upload/preview", {
    header: [...CUSTOMER_HEADERS, ...fields.map(enrollmentHeader)],
    rows: [{ rowNumber: 2, values: { ...EXAMPLE, code: "SAMPLE-MISSING" } }],
  });
  expect(preview.status).toBe(200);
  expect(
    preview.body.errors.some(
      (/** @type {any} */ e) => e.column === `customFields.${key(1)}`,
    ),
  ).toBe(true);
  const csv = customerTemplateCsv(fields);
  expect(parseCustomerCsv(csv + Object.keys({}).join()).header.at(-1)).toBe(
    enrollmentHeader(fields[5]),
  );
});

test("SP-0229 required customers match any chosen channel or type, otherwise blank is allowed", async () => {
  const prior = await form();
  const optional = prior.fields.map((f) => ({
    ...f,
    requiredChannels: [],
    requiredTypes: [],
  }));
  expect((await saveForm(optional, prior.revision)).status).toBe(200);
  const saved = await call(
    "office",
    `customers/${customerId}`,
    { customer: { customFields: {} } },
    "PUT",
  );
  expect(saved.status).toBe(200);
  expect(saved.body.customFields).toEqual({});
  expect((await saveForm(prior.fields, prior.revision + 1)).status).toBe(200);
  expect(
    (await call("office", `customers/${customerId}/approve`, {})).status,
  ).toBe(422);
  expect(
    (
      await call(
        "office",
        `customers/${customerId}`,
        { customer: { customFields: answers } },
        "PUT",
      )
    ).status,
  ).toBe(200);
});

test("SP-0229 signed Field capture downloads ordered schema and persists answers through push and office approval", async () => {
  const k = await deviceKey();
  const device = await registerDevice(h, {
    profileId: people.agent.profile,
    orgUnitId: unit,
    key: k,
  });
  const { body: tokens } = await nativeSignIn(
    h,
    "agent@example.com",
    "sample-enrollment-password",
    "field-android",
    { keyId: k.keyId, publicKeySpki: k.publicKeySpki },
  );
  expect((await bind(h, tokens.accessToken, device, k)).res.status).toBe(200);
  const config = await call("agent", "masters/census-config");
  expect(config.status).toBe(200);
  expect(config.body.customerMaster.enrollmentForm.fields[0].key).toBe(key(6));
  const stored = await readCustomer(h.db, customerId);
  const customer = /** @type {Record<string,any>} */ ({});
  for (const [name] of PROFILE_COLUMNS) customer[name] = stored[name];
  Object.assign(customer, {
    customerName: "Sample Field Owner",
    registeredName: "Sample Field Store",
    customerAddress: stored.customerAddress,
    shipTos: stored.shipTos,
    customFields: answers,
  });
  const at = Date.now();
  const captureId = crypto.randomUUID();
  const payload = {
    captureId,
    name: "Sample Field Store",
    address: stored.customerAddress,
    ownerName: "Sample Owner",
    ownerPhone: stored.mobileNo,
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
    customer,
  };
  const response = await signedPost(
    h,
    { access: tokens.accessToken, deviceId: device, key: k },
    "/api/sync/push",
    {
      version: 2,
      app: "field-android",
      deviceId: device,
      scopeId: unit,
      operations: [
        {
          clientOpId: crypto.randomUUID(),
          opType: "census.capture",
          clientTime: at,
          dependsOn: [],
          payload,
        },
      ],
    },
  );
  expect(response.res.status).toBe(200);
  expect(response.body.results[0].status).toBe("applied");
  const [en] =
    await h.db`select outlet_id from outlet_enrolments where client_request_id=${captureId}`;
  expect((await readCustomer(h.db, en.outlet_id)).customFields).toEqual(
    answers,
  );
  const approved = await call("head", `customers/${en.outlet_id}/approve`, {});
  expect(approved.status).toBe(200);
  expect(approved.body.customFields).toEqual(answers);
  expect(approved.body.enrolmentStatus).toBe("approved");
});
