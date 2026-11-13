import { test, expect } from "bun:test";
import {
  startHarness,
  profileStore,
  createUser,
  deviceKey,
  nativeSignIn,
} from "./harness.js";
import { install } from "../src/domains/integrity/index.js";

/** SP-0174: a first phone that signed in waits on Setup > Phones; the office registers it without a code. */
async function setup() {
  const h = await startHarness({ installers: [install] });
  const people = profileStore(h),
    root = crypto.randomUUID(),
    unit = crypto.randomUUID(),
    other = crypto.randomUUID();
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${root},'sunpride','SUNPRIDE','SUNPRIDE','national','active',now()-interval '1 day')`;
  for (const [id, code] of [
    [unit, "SAMPLE"],
    [other, "OTHER"],
  ])
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from,parent_id) values(${id},'sunpride',${code},${code},'region','active',now()-interval '1 day',${root})`;
  /** @param {string} email @param {string} role @param {string} at */
  const person = async (email, role, at = unit) => {
    const userId = await createUser(h, email, "test-only-waiting-password");
    const p = people.set(userId, { role, orgUnitId: at, name: email });
    await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${userId},${userId},${p.name},${email},${role},'active',${at})`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${at},${role},now()-interval '1 day','SAMPLE','SAMPLE')`;
    return { userId, email, profile: p };
  };
  const office = async (/** @type {string} */ email) => {
    const login = await h.fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "test-only-waiting-password" }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    return {
      fleet: async () => {
        const r = await h.fetch("/api/v1/integrity/fleet", {
          headers: { cookie },
        });
        expect(r.status).toBe(200);
        return /** @type {any} */ (await r.json());
      },
      post: (/** @type {string} */ path, /** @type {any} */ body) =>
        h.fetch(`/api/v1/integrity/devices/waiting/${path}`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    };
  };
  return { h, person, office, other };
}

test("SP-0174 office registers a waiting first phone from Setup > Phones; the phone then finds itself registered", async () => {
  const { h, person, office } = await setup();
  try {
    const salesman = await person("ws-sales@example.test", "sales");
    await person("ws-admin@example.test", "admin");
    const key = await deviceKey();
    const phone = await nativeSignIn(
      h,
      salesman.email,
      "test-only-waiting-password",
      "field-android",
      key,
    );
    expect(phone.res.status).toBe(200);
    const admin = await office("ws-admin@example.test");
    const listed = await admin.fleet();
    expect(listed.waiting).toHaveLength(1);
    const [w] = listed.waiting;
    expect(w.person).toBe(salesman.email);
    expect(w.app).toBe("field-android");
    expect(w.phoneCode.replaceAll(" ", "")).toBe(
      key.keyId.slice(0, 16).toUpperCase(),
    );
    const registered = await admin.post("register", { requestId: w.id });
    expect(registered.status).toBe(200);
    const [device] =
      await h.db`select * from registered_devices where profile_id=${salesman.profile.id}`;
    expect(device.key_id).toBe(key.keyId);
    expect(device.status).toBe("active");
    expect((await admin.fleet()).waiting).toHaveLength(0);
    const [log] =
      await h.db`select 1 from audit_logs where action='device.registered_from_waiting' and entity_id=${device.id}`;
    expect(log).toBeTruthy();
    // The phone's own periodic check (GET /api/me) now returns the device, so it binds by itself.
    const me = await h.fetch("/api/me", {
      headers: {
        authorization: `Bearer ${phone.body.accessToken}`,
        "x-app": "field-android",
        "x-device-key-id": key.keyId,
      },
    });
    const mine = await me.json();
    expect(mine.device?.id).toBe(device.id);
    // Second click does nothing new (one phone per person).
    expect((await admin.post("register", { requestId: w.id })).status).toBe(
      409,
    );
  } finally {
    await h.close();
  }
});

test("SP-0174 reject and second-phone rules", async () => {
  const { h, person, office, other } = await setup();
  try {
    const a = await person("wr-a@example.test", "sales");
    const far = await person("wr-far@example.test", "sales", other);
    await person("wr-admin@example.test", "admin");
    await nativeSignIn(
      h,
      a.email,
      "test-only-waiting-password",
      "van-android",
      await deviceKey(),
    );
    await nativeSignIn(
      h,
      far.email,
      "test-only-waiting-password",
      "field-android",
      await deviceKey(),
    );
    // An admin limited to one area sees only that area's phones.
    const [row] =
      await h.db`select id from phone_registration_requests where profile_id=${far.profile.id}`;
    expect(row).toBeTruthy();
    const admin = await office("wr-admin@example.test");
    const waiting = (await admin.fleet()).waiting;
    const mineA = waiting.find((/** @type {any} */ w) => w.person === a.email);
    expect(mineA?.app).toBe("van-android");
    const rejected = await admin.post("reject", { requestId: mineA.id });
    expect(rejected.status).toBe(200);
    expect(
      (await admin.fleet()).waiting.some(
        (/** @type {any} */ w) => w.id === mineA.id,
      ),
    ).toBe(false);
    expect((await admin.post("register", { requestId: mineA.id })).status).toBe(
      409,
    );
    // A person who already has a phone never waits here: replacing keeps the controlled handover.
    await h.db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,org_unit_id,status) values(${a.profile.id},'van-android','android','SAMPLE old','x',${"a".repeat(64)},${a.profile.orgUnitId},'active')`;
    await nativeSignIn(
      h,
      a.email,
      "test-only-waiting-password",
      "van-android",
      await deviceKey(),
    );
    const after =
      await h.db`select 1 from phone_registration_requests where profile_id=${a.profile.id} and status='waiting'`;
    expect(after).toHaveLength(0);
  } finally {
    await h.close();
  }
});
