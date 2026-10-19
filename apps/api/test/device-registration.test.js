import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, deviceKey, nativeSignIn, bind } from "./harness.js";
import { install } from "../src/domains/org/index.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {string} */ let cookie;
/** @type {any} */ let root;
/** @type {any} */ let seller;
const password = "device-registration-test-only";
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  const signup = await h.fetch("/api/auth/sign-up", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "boss@example.com", password }),
  });
  cookie = signup.headers.get("set-cookie")?.split(";")[0] ?? "";
  const me = await h.fetch("/api/me", { headers: { cookie } });
  root = (await me.json()).profile.orgUnitId;
  const [u] = await h.db`insert into users(email,password_hash) values('phone-seller@example.com',${await Bun.password.hash(password)}) returning id`;
  [seller] = await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,effective_from)
    values(${u.id},${u.id},'Phone seller','phone-seller@example.com','sales','active',${root},now()-interval '1 day') returning *`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)
    values(${seller.id},${root},'sales',now()-interval '1 day','system:test','fixture')`;
});
afterAll(async () => { await h?.close(); });
/** @param {any} body @param {string} [authCookie] */
const register = (body, authCookie = cookie) => h.fetch("/api/v1/people/devices/register", {
  method: "POST", headers: { cookie: authCookie, "content-type": "application/json" }, body: JSON.stringify(body),
});

test("admin registers iOS public key, reads it back, employee binds and reads native me", async () => {
  const key = await deviceKey();
  const input = { profileId: seller.id, app: "field-ios", publicKeySpki: key.publicKeySpki, keyId: key.keyId, inventoryTag: "IOS-PROOF" };
  const response = await register(input);
  expect(response.status).toBe(200);
  const id = await response.json();
  const [stored] = await h.db`select * from registered_devices where id=${id}`;
  expect(stored.profile_id).toBe(seller.id);
  expect(stored.platform).toBe("ios");
  expect(stored.status).toBe("active");
  expect(stored.key_id).toBe(key.keyId);
  expect(stored.bound_subject).toBeNull();
  const replay = await register(input);
  expect(replay.status).toBe(200); expect(await replay.json()).toBe(id);
  const auth = await nativeSignIn(h, "phone-seller@example.com", password, "field-ios", { keyId: key.keyId, publicKeySpki: key.publicKeySpki });
  expect(auth.res.status).toBe(200);
  const bound = await bind(h, auth.body.accessToken, id, key);
  expect(bound.body.bindingStatus).toBe("bound");
  const me = await h.fetch("/api/me", { headers: { authorization: `Bearer ${auth.body.accessToken}`, "x-app": "field-ios", "x-device-key-id": key.keyId } });
  const native = await me.json();
  expect(native.device.id).toBe(id); expect(native.device.bound).toBe(true);
  const audits = await h.db`select action,details from audit_logs where entity_id=${id}`;
  expect(audits.some((/** @type {any} */ a) => a.action === "people.devices.register")).toBe(true);
  expect(JSON.stringify(audits)).not.toContain(key.publicKeySpki);
});

test("cannot overwrite an active key or reassign the registered key", async () => {
  const key = await deviceKey();
  const response = await register({ profileId: seller.id, app: "field-ios", publicKeySpki: key.publicKeySpki, inventoryTag: "REPLACEMENT" });
  expect(response.status).toBe(409);
  const rows = await h.db`select id from registered_devices where profile_id=${seller.id} and app='field-ios' and status='active'`;
  expect(rows.length).toBe(1);
});

test("one shared phone key can be registered for a second person without touching the first", async () => {
  const key = await deviceKey();
  const [u] = await h.db`insert into users(email,password_hash) values('shared-phone@example.com',${await Bun.password.hash(password)}) returning id`;
  const [other] = await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,effective_from)
    values(${u.id},${u.id},'Shared phone','shared-phone@example.com','sales','active',${root},now()-interval '1 day') returning *`;
  const first = await register({ profileId: seller.id, app: "van-android", publicKeySpki: key.publicKeySpki, inventoryTag: "SHARED-A" });
  const second = await register({ profileId: other.id, app: "van-android", publicKeySpki: key.publicKeySpki, inventoryTag: "SHARED-B" });
  expect(first.status).toBe(200); expect(second.status).toBe(200);
  const firstId = await first.json(), secondId = await second.json();
  expect(firstId).not.toBe(secondId);
  const rows = await h.db`select profile_id,status,bound_subject from registered_devices where key_id=${key.keyId} and app='van-android' order by inventory_tag`;
  expect(rows.map((/** @type {any} */ r) => r.profile_id)).toEqual([seller.id, other.id]);
  expect(rows.every((/** @type {any} */ r) => r.status === "active" && r.bound_subject === null)).toBe(true);
});

test("malformed SPKI, key digest mismatch and unsupported app are refused without rows", async () => {
  const key = await deviceKey();
  for (const override of [{ publicKeySpki: "not-a-key" }, { keyId: "a".repeat(64) }, { app: "IOS" }]) {
    const response = await register({ profileId: seller.id, app: "field-android", publicKeySpki: key.publicKeySpki, inventoryTag: "BAD-KEY", ...override });
    expect(response.status).toBe(422);
  }
  const rows = await h.db`select id from registered_devices where inventory_tag='BAD-KEY'`;
  expect(rows.length).toBe(0);
});

test("seller cannot administer their own registration", async () => {
  const signin = await h.fetch("/api/auth/sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "phone-seller@example.com", password }) });
  const ownCookie = signin.headers.get("set-cookie")?.split(";")[0] ?? "";
  const key = await deviceKey();
  const response = await register({ profileId: seller.id, app: "field-android", publicKeySpki: key.publicKeySpki, inventoryTag: "SELF" }, ownCookie);
  expect(response.status).toBe(403);
});
