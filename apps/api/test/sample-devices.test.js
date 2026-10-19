import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  startHarness,
  profileStore,
  createUser,
  deviceKey,
  nativeSignIn,
  bind,
} from "./harness.js";
/** @type {import("./harness.js").Harness} */
let h;
/** @type {ReturnType<typeof profileStore>} */
let profiles;
beforeAll(async () => {
  h = await startHarness();
  profiles = profileStore(h);
});
afterAll(async () => {
  await h?.close();
});
async function person(sample = true) {
  const email = `${crypto.randomUUID()}@example.com`,
    password = "sample test password";
  const userId = await createUser(h, email, password),
    profile = profiles.set(userId, { role: "sales" });
  if (sample)
    await h.db`insert into sample_data_rows(batch,key,table_name,row_id) values ('test',${profile.id},'profiles',${profile.id})`;
  return { email, password, profile };
}
/** @param {Awaited<ReturnType<typeof person>>} p @param {any} key @param {string} app */
const login = (p, key, app = "field-android") =>
  nativeSignIn(h, p.email, p.password, app, key);
test("sample first sign-in registers; normal possession bind and readback; audit; retry creates no second phone", async () => {
  const p = await person(),
    key = await deviceKey();
  const { res, body } = await login(p, key);
  expect(res.status).toBe(200);
  const [d] =
    await h.db`select * from registered_devices where profile_id=${p.profile.id}`;
  expect(d.key_id).toBe(key.keyId);
  expect(d.app).toBe("field-android");
  expect(d.bound_subject).toBeNull();
  expect((await bind(h, body.accessToken, d.id, key)).body.bindingStatus).toBe(
    "bound",
  );
  const me = await h.fetch("/api/me", {
    headers: {
      authorization: `Bearer ${body.accessToken}`,
      "x-app": d.app,
      "x-device-key-id": key.keyId,
    },
  });
  expect((await me.json()).device.bound).toBe(true);
  await login(p, key);
  expect(
    (
      await h.db`select * from registered_devices where profile_id=${p.profile.id}`
    ).length,
  ).toBe(1);
  const audits =
    await h.db`select action,details from audit_logs where entity_id=${d.id} order by created_at`;
  expect(audits.map((/** @type {any} */ a) => a.action)).toEqual([
    "device.sample_registered",
    "device.bound",
  ]);
  expect(JSON.stringify(audits)).not.toContain(key.publicKeySpki);
});
test("real accounts still need admin registration", async () => {
  const p = await person(false);
  expect((await login(p, await deviceKey())).res.status).toBe(200);
  expect(
    (
      await h.db`select * from registered_devices where profile_id=${p.profile.id}`
    ).length,
  ).toBe(0);
});
test("wrong password, inactive or unscoped profiles and incomplete keys cannot auto-register", async () => {
  for (const mode of ["password", "inactive", "scope", "key"]) {
    const p = await person(),
      key = await deviceKey();
    if (mode === "password") p.password = "incorrect password";
    if (mode === "inactive")
      profiles.set(p.profile.userId, { role: "sales", status: "inactive" });
    if (mode === "scope")
      profiles.set(p.profile.userId, { role: "sales", orgUnitId: null });
    await login(p, mode === "key" ? { keyId: key.keyId } : key);
    expect(
      (
        await h.db`select * from registered_devices where profile_id=${p.profile.id}`
      ).length,
    ).toBe(0);
  }
});
test("concurrent sign-ins register once; active, suspended and revoked keys are never replaced or restored", async () => {
  const p = await person(),
    key = await deviceKey();
  await Promise.all([login(p, key), login(p, key)]);
  expect(
    (
      await h.db`select * from registered_devices where profile_id=${p.profile.id}`
    ).length,
  ).toBe(1);
  await login(p, await deviceKey());
  expect(
    (
      await h.db`select * from registered_devices where profile_id=${p.profile.id}`
    ).length,
  ).toBe(1);
  for (const status of ["suspended", "revoked"]) {
    await h.db`update registered_devices set status=${status} where profile_id=${p.profile.id}`;
    await login(p, key);
    const rows =
      await h.db`select status from registered_devices where profile_id=${p.profile.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(status);
  }
});
test("all three apps are supported, with distinct app registration", async () => {
  const p = await person();
  for (const app of ["field-android", "field-ios", "van-android"]) {
    expect((await login(p, await deviceKey(), app)).res.status).toBe(200);
  }
  const rows =
    await h.db`select app,platform from registered_devices where profile_id=${p.profile.id}`;
  expect(rows).toHaveLength(3);
  expect(
    rows.find((/** @type {any} */ d) => d.app === "field-ios").platform,
  ).toBe("ios");
});
test("one shared demo phone can carry several sample accounts, each with its own row and its own bind", async () => {
  const key = await deviceKey();
  const a = await person(),
    b = await person(),
    real = await person(false);
  const ids = [];
  for (const p of [a, b]) {
    const { body } = await login(p, key);
    const [d] =
      await h.db`select * from registered_devices where profile_id=${p.profile.id}`;
    expect(d.key_id).toBe(key.keyId);
    expect(
      (await bind(h, body.accessToken, d.id, key)).body.bindingStatus,
    ).toBe("bound");
    ids.push(d.id);
  }
  expect(new Set(ids).size).toBe(2);
  await login(real, key);
  expect(
    (
      await h.db`select * from registered_devices where profile_id=${real.profile.id}`
    ).length,
  ).toBe(0);
});
