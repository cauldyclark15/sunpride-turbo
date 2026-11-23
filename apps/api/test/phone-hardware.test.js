import { afterAll, beforeAll, expect, test } from "bun:test";
import { install as installOrg } from "../src/domains/org/index.js";
import { install as installIntegrity } from "../src/domains/integrity/index.js";
import { registerOp } from "../src/core/sync.js";
import { phoneHardware, phoneModelLabel } from "../src/core/phone-hardware.js";
import {
  bind,
  createUser,
  deviceKey,
  signedPost,
  startHarness,
} from "./harness.js";

/** Sample accounts and hardware only; real HTTP, P-256 proofs and PostgreSQL writes. */
/** @type {import("./harness.js").Harness} */ let h;
/** @type {string} */ let cookie;
/** @type {string} */ let root;
const password = "test-only-phone-hardware";
const hardware = {
  "x-device-manufacturer": "Xiaomi",
  "x-device-model": "Redmi%20Note%2013",
};
beforeAll(async () => {
  h = await startHarness({ installers: [installOrg, installIntegrity] });
  await createUser(h, "boss@example.com", password);
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "boss@example.com", password }),
  });
  expect(login.status).toBe(200);
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const me = await h.fetch("/api/me", { headers: { cookie } });
  root = (await me.json()).profile.orgUnitId;
  registerOp("test.hardware", () => ({ entityId: null }));
});
afterAll(async () => {
  await h?.close();
});

/** @param {string} app @param {Record<string,string>} [headers] */
async function phone(app, headers = {}) {
  const email = `${crypto.randomUUID()}@example.test`;
  const userId = await createUser(h, email, password);
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,effective_from)
    values(${userId},${userId},'SAMPLE phone',${email},'sales','active',${root},now()-interval '1 day') returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)
    values(${p.id},${root},'sales',now()-interval '1 day','SAMPLE','SAMPLE')`;
  const key = await deviceKey();
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      version: 2,
      app,
      email,
      password,
      deviceKey: { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
      integrity: { rooted: false, tampered: false, source: "TEST fixture" },
    }),
  });
  expect(login.status).toBe(200);
  const access = (await login.json()).accessToken;
  const [waiting] =
    await h.db`select * from phone_registration_requests where profile_id=${p.id} and status='waiting'`;
  expect(waiting).toBeTruthy();
  const registered = await h.fetch(
    "/api/v1/integrity/devices/waiting/register",
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ requestId: waiting.id }),
    },
  );
  expect(registered.status).toBe(200);
  const deviceId = (await registered.json()).deviceId;
  // The app's first challenge sends its integrity report after office approval.
  const assessed = await h.fetch("/api/devices/challenge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${access}`,
    },
    body: JSON.stringify({
      version: 2,
      deviceId,
      integrity: { rooted: false, tampered: false, source: "TEST fixture" },
    }),
  });
  expect(assessed.status).toBe(200);
  const bound = await bind(h, access, deviceId, key);
  expect(bound.body.bindingStatus).toBe("bound");
  return { app, access, deviceId, key, waiting };
}
/** @param {Awaited<ReturnType<typeof phone>>} d @param {string} expected */
async function readLabel(d, expected) {
  const list = await h.fetch("/api/v1/people/devices/list", {
    headers: { cookie },
  });
  expect(list.status).toBe(200);
  const listed = (await list.json()).page.find(
    (/** @type {any} */ r) => r.deviceId === d.deviceId,
  );
  expect(listed.platform).toBe("android");
  expect(listed.model).toBe(expected);
  const report = await h.fetch(
    `/api/v1/people/devices/report?deviceId=${d.deviceId}`,
    { headers: { cookie } },
  );
  expect(report.status).toBe(200);
  expect((await report.json()).device.model).toBe(expected);
}
/** @param {Awaited<ReturnType<typeof phone>>} d @param {Record<string,string>} [headers]
 * @param {Parameters<typeof signedPost>[4]} [overrides] */
async function checkIn(d, headers = {}, overrides = {}) {
  return signedPost(
    h,
    d,
    "/api/sync/push",
    {
      version: 2,
      app: d.app,
      deviceId: d.deviceId,
      scopeId: root,
      operations: [
        {
          clientOpId: crypto.randomUUID(),
          opType: "test.hardware",
          clientTime: Date.now(),
          dependsOn: [],
          payload: {},
        },
      ],
    },
    { headers, ...overrides },
  );
}
for (const app of ["field-android", "van-android"]) {
  test(`SP-0233 ${app}: first registration preserves maker and model`, async () => {
    const d = await phone(app, hardware);
    expect(d.waiting.manufacturer).toBe("Xiaomi");
    expect(d.waiting.model).toBe("Redmi Note 13");
    await readLabel(d, "Xiaomi Redmi Note 13");
    const [saved] =
      await h.db`select manufacturer,model from registered_devices where id=${d.deviceId}`;
    expect(saved).toMatchObject({
      manufacturer: "Xiaomi",
      model: "Redmi Note 13",
    });
  });
  test(`SP-0233 ${app}: existing phone fills hardware at next verified check-in, older apps remain usable`, async () => {
    const d = await phone(app);
    await readLabel(d, "Model not sent yet");
    expect((await checkIn(d)).res.status).toBe(200);
    const bad = await checkIn(d, hardware, { signedBody: "tampered" });
    expect(bad.res.status).toBe(401);
    await readLabel(d, "Model not sent yet");
    expect(
      (
        await checkIn(d, {
          ...hardware,
          "x-app-version-code": "42",
          "x-app-version-name": "0.1.0-beta.42",
        })
      ).res.status,
    ).toBe(200);
    await readLabel(d, "Xiaomi Redmi Note 13");
    const [saved] =
      await h.db`select manufacturer,model,app_version_code,app_version_name,last_seen_at from registered_devices where id=${d.deviceId}`;
    expect(saved).toMatchObject({
      manufacturer: "Xiaomi",
      model: "Redmi Note 13",
      app_version_code: 42,
      app_version_name: "0.1.0-beta.42",
    });
    expect(saved.last_seen_at).toBeTruthy();
    expect((await checkIn(d)).res.status).toBe(200);
    expect(
      (
        await checkIn(d, {
          "x-device-manufacturer": "%",
          "x-device-model": "x".repeat(121),
        })
      ).res.status,
    ).toBe(200);
    await readLabel(d, "Xiaomi Redmi Note 13");
    const [after] =
      await h.db`select app_version_code from registered_devices where id=${d.deviceId}`;
    expect(after.app_version_code).toBe(42);
  });
}
test("SP-0233 optional hardware is bounded, decoded and labelled without doubling the maker", () => {
  expect(phoneHardware(new Headers())).toEqual({
    manufacturer: null,
    model: null,
  });
  expect(
    phoneHardware(
      new Headers({ "x-device-manufacturer": "%", "x-device-model": "%00bad" }),
    ),
  ).toEqual({ manufacturer: null, model: null });
  expect(
    phoneHardware(new Headers({ "x-device-model": "%E6%89%8B%E6%9C%BA" }))
      .model,
  ).toBe("手机");
  expect(
    phoneModelLabel({ manufacturer: "Samsung", model: "Samsung Galaxy A55" }),
  ).toBe("Samsung Galaxy A55");
  expect(phoneModelLabel({ manufacturer: "Xiaomi", model: null })).toBe(
    "Model not sent yet",
  );
  expect(phoneModelLabel({ model: "Redmi Note 13" })).toBe("Redmi Note 13");
});
