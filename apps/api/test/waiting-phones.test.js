import { test, expect } from "bun:test";
import {
  startHarness,
  profileStore,
  createUser,
  deviceKey,
  nativeSignIn,
  bind,
} from "./harness.js";
import { install } from "../src/domains/integrity/index.js";
import { install as org } from "../src/domains/org/index.js";

/** SP-0174: a first phone that signed in waits on Setup > Phones; the office registers it without a code. */
async function setup() {
  const h = await startHarness({ installers: [install, org] });
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
      cookie,
      fleet: async () => {
        const r = await h.fetch("/api/v1/integrity/fleet", {
          headers: { cookie },
        });
        expect(r.status).toBe(200);
        return /** @type {any} */ (await r.json());
      },
      request: (/** @type {string} */ path, /** @type {any} */ body) =>
        h.fetch(path, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      get: (/** @type {string} */ path) =>
        h.fetch(path, { headers: { cookie } }),
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

for (const app of ["field-android", "van-android"]) {
  test(`SP-0248 ${app} repairs a missing waiting request from the same session, refreshes it and registers from the list`, async () => {
    const { h, person, office } = await setup();
    try {
      const seller = await person("stuck-sales@example.test", "sales");
      await person("stuck-office@example.test", "admin");
      const admin = await office("stuck-office@example.test");
      const otherApp =
        app === "field-android" ? "van-android" : "field-android";
      const oldKey = await deviceKey();
      const old = await admin.request("/api/v1/people/devices/register", {
        profileId: seller.profile.id,
        app: otherApp,
        publicKeySpki: oldKey.publicKeySpki,
      });
      expect(old.status).toBe(200);
      const oldId = (await old.json()).deviceId;
      const key = await deviceKey();
      // An older installed build signed in without leaving a public key/request.
      const phone = await nativeSignIn(
        h,
        seller.email,
        "test-only-waiting-password",
        app,
        { keyId: key.keyId },
      );
      expect(phone.res.status).toBe(200);
      expect((await admin.fleet()).waiting).toHaveLength(0);
      const check = () =>
        h.fetch("/api/me", {
          headers: {
            authorization: `Bearer ${phone.body.accessToken}`,
            "x-app": app,
            "x-device-key-id": key.keyId,
            "x-device-public-key": key.publicKeySpki,
          },
        });
      const results = await Promise.all([check(), check(), check()]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      for (const response of results)
        expect((await response.json()).device).toBeNull();
      const [waiting] = (await admin.fleet()).waiting;
      expect(waiting.personId).toBe(seller.profile.id);
      expect(waiting.app).toBe(app);
      expect(
        await h.db`select id from phone_registration_requests where profile_id=${seller.profile.id} and status='waiting'`,
      ).toHaveLength(1);
      await h.db`update phone_registration_requests set last_seen_at=now()-interval '31 days' where id=${waiting.id}`;
      expect((await admin.fleet()).waiting).toHaveLength(0);
      expect((await check()).status).toBe(200);
      const refreshed = (await admin.fleet()).waiting;
      expect(refreshed).toHaveLength(1);
      expect(refreshed[0].id).toBe(waiting.id);
      expect(refreshed[0].lastSeenAt).toBeGreaterThan(Date.now() - 60_000);
      const registered = await admin.post("register", {
        requestId: waiting.id,
      });
      expect(registered.status).toBe(200);
      const deviceId = (await registered.json()).deviceId;
      expect((await (await check()).json()).device.id).toBe(deviceId);
      // Match both native clients: first challenge supplies the OS assessment
      // because no registered device existed when this session signed in.
      const assessed = await h.fetch("/api/devices/challenge", {
        method: "POST",
        headers: {
          authorization: `Bearer ${phone.body.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: 2,
          deviceId,
          integrity: { rooted: false, tampered: false },
        }),
      });
      expect(assessed.status).toBe(200);
      expect(
        (await bind(h, phone.body.accessToken, deviceId, key)).res.status,
      ).toBe(200);
      expect((await (await check()).json()).device.bound).toBe(true);
      expect((await admin.fleet()).waiting).toHaveLength(0);
      expect(
        (await h.db`select status from registered_devices where id=${oldId}`)[0]
          .status,
      ).toBe("active");
      expect(
        await h.db`select id from sessions where user_id=${seller.userId} and app=${app}`,
      ).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  test(`SP-0248 ${app} accepts short codes with or without spaces and refuses unknown/wrong-person/wrong-app codes plainly`, async () => {
    const { h, person, office, other } = await setup();
    try {
      const seller = await person("short-sales@example.test", "sales");
      const wrong = await person("short-other@example.test", "sales");
      const far = await person("short-far@example.test", "sales", other);
      await person("short-office@example.test", "admin");
      const admin = await office("short-office@example.test");
      const key = await deviceKey();
      await nativeSignIn(
        h,
        seller.email,
        "test-only-waiting-password",
        app,
        key,
      );
      const short = key.keyId.slice(0, 16).toUpperCase();
      const unknown =
        "This phone is not known yet. On the phone tap Check again, then it appears in the list above.";
      for (const body of [
        { profileId: seller.profile.id, app, phoneCode: "0000 0000 0000 0000" },
        { profileId: wrong.profile.id, app, phoneCode: short },
        {
          profileId: seller.profile.id,
          app: app === "field-android" ? "van-android" : "field-android",
          phoneCode: short,
        },
        { profileId: seller.profile.id, app, phoneCode: "not-a-phone-key" },
      ]) {
        const response = await admin.request(
          "/api/v1/people/devices/register",
          body,
        );
        expect(response.status).toBe(422);
        expect((await response.json()).error.message).toBe(unknown);
      }
      // Office roles may manage people across branches; a different person still
      // cannot claim this person's short code.
      const foreign = await admin.request("/api/v1/people/devices/register", {
        profileId: far.profile.id,
        app,
        phoneCode: short,
      });
      expect(foreign.status).toBe(422);
      expect((await foreign.json()).error.message).toBe(unknown);
      for (const spaced of [true, false]) {
        const next = spaced ? key : await deviceKey();
        if (!spaced)
          await nativeSignIn(
            h,
            seller.email,
            "test-only-waiting-password",
            app,
            next,
          );
        const code = next.keyId.slice(0, 16);
        const result = await admin.request("/api/v1/people/devices/register", {
          profileId: seller.profile.id,
          app,
          // Accept the old web payload too while it is being updated.
          ...(spaced
            ? {
                publicKeySpki: (code.toUpperCase().match(/.{4}/g) ?? []).join(
                  " ",
                ),
              }
            : { phoneCode: code }),
        });
        expect(result.status).toBe(200);
        const deviceId = (await result.json()).deviceId;
        expect(
          (
            await h.db`select key_id from registered_devices where id=${deviceId}`
          )[0].key_id,
        ).toBe(next.keyId);
        const [request] =
          await h.db`select status,device_id from phone_registration_requests where profile_id=${seller.profile.id} and key_id=${next.keyId}`;
        expect(request.status).toBe("registered");
        expect(request.device_id).toBe(deviceId);
        expect((await admin.fleet()).waiting).toHaveLength(0);
      }
    } finally {
      await h.close();
    }
  });
}

test("SP-0248 a registration check cannot advertise another session key or a mismatched public key", async () => {
  const { h, person } = await setup();
  try {
    const seller = await person("mismatch-sales@example.test", "sales");
    const key = await deviceKey(),
      foreign = await deviceKey();
    const phone = await nativeSignIn(
      h,
      seller.email,
      "test-only-waiting-password",
      "field-android",
      { keyId: key.keyId },
    );
    for (const [keyId, publicKey] of [
      [foreign.keyId, foreign.publicKeySpki],
      [key.keyId, foreign.publicKeySpki],
      [key.keyId, "AQID"],
    ]) {
      const response = await h.fetch("/api/me", {
        headers: {
          authorization: `Bearer ${phone.body.accessToken}`,
          "x-app": "field-android",
          "x-device-key-id": keyId,
          "x-device-public-key": publicKey,
        },
      });
      expect(response.status).toBe(400);
    }
    expect(
      await h.db`select id from phone_registration_requests where profile_id=${seller.profile.id}`,
    ).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test("SP-0248 a newly waiting phone refreshes an already-open office waiting list", async () => {
  const { h, person, office } = await setup();
  /** @type {WebSocket|undefined} */ let ws;
  try {
    await h.app.realtime.start();
    const seller = await person("live-waiting-sales@example.test", "sales");
    await person("live-waiting-office@example.test", "admin");
    const admin = await office("live-waiting-office@example.test");
    const key = await deviceKey();
    const phone = await nativeSignIn(
      h,
      seller.email,
      "test-only-waiting-password",
      "field-android",
      { keyId: key.keyId },
    );
    ws = new WebSocket(
      h.origin.replace("http", "ws") + "/ws",
      /** @type {any} */ ({ headers: { cookie: admin.cookie } }),
    );
    const socket = ws;
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(undefined), { once: true });
      socket.addEventListener(
        "error",
        () => reject(Error("WebSocket failed")),
        { once: true },
      );
    });
    /** @param {string} type */
    const next = (type) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.removeEventListener("message", onMessage);
          reject(Error(`No ${type} event`));
        }, 3000);
        /** @param {MessageEvent} event */
        const onMessage = (event) => {
          const data = JSON.parse(String(event.data));
          if (data.type !== type) return;
          clearTimeout(timeout);
          socket.removeEventListener("message", onMessage);
          resolve(data);
        };
        socket.addEventListener("message", onMessage);
      });
    const subscribed = next("subscribed");
    socket.send(JSON.stringify({ type: "subscribe", topics: ["integrity"] }));
    expect((await subscribed).topics).toEqual(["integrity"]);
    const changed = next("invalidate");
    const response = await h.fetch("/api/me", {
      headers: {
        authorization: `Bearer ${phone.body.accessToken}`,
        "x-app": "field-android",
        "x-device-key-id": key.keyId,
        "x-device-public-key": key.publicKeySpki,
      },
    });
    expect(response.status).toBe(200);
    expect(await changed).toMatchObject({
      type: "invalidate",
      topic: "integrity",
    });
    expect((await admin.fleet()).waiting).toHaveLength(1);
  } finally {
    ws?.close();
    await h.close();
  }
});

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

/** @param {any} h @param {any} phone @param {string} app @param {any} key */
async function me(h, phone, app, key) {
  const r = await h.fetch("/api/me", {
    headers: {
      authorization: `Bearer ${phone.body.accessToken}`,
      "x-app": app,
      "x-device-key-id": key.keyId,
    },
  });
  expect(r.status).toBe(200);
  return r.json();
}

for (const app of ["field-android", "van-android"]) {
  for (const role of ["admin", "operations"]) {
    test(`SP-0234 ${role} approves a waiting ${app} replacement, preserves work/history and can pause/resume`, async () => {
      const { h, person, office } = await setup();
      try {
        const seller = await person("replace-sales@example.test", "sales");
        await person("replace-office@example.test", role);
        const admin = await office("replace-office@example.test");
        const oldKey = await deviceKey(),
          nextKey = await deviceKey();
        const registered = await admin.request(
          "/api/v1/people/devices/register",
          {
            profileId: seller.profile.id,
            app,
            inventoryTag: "Old sales phone",
            publicKeySpki: oldKey.publicKeySpki,
          },
        );
        expect(registered.status).toBe(200);
        const oldId = (await registered.json()).deviceId;
        const old = await nativeSignIn(
          h,
          seller.email,
          "test-only-waiting-password",
          app,
          oldKey,
        );
        expect(
          (await bind(h, old.body.accessToken, oldId, oldKey)).res.status,
        ).toBe(200);
        // An older paused phone and a pending old-work control must not block replacement.
        const pausedKey = await deviceKey();
        const [paused] =
          await h.db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,org_unit_id,status)
          values(${seller.profile.id},${app},'android','Older paused phone',${pausedKey.publicKeySpki},${pausedKey.keyId},${seller.profile.orgUnitId},'suspended') returning id`;
        const [control] =
          await h.db`insert into device_controls(device_id,kind,requested_by,reason_code)
          values(${oldId},'handover',${seller.userId},'replacement') returning id`;
        const requestId = crypto.randomUUID();
        await h.db`insert into op_receipts(subject,device_id,client_op_id,payload_hash,op_type,status,ack)
          values(${seller.userId},${oldId},${requestId},${"a".repeat(64)},'visit.activity','applied',${{ kept: true }})`;
        // A registration in the other app stays on and a request in that app stays waiting.
        const otherApp =
          app === "field-android" ? "van-android" : "field-android";
        const otherKey = await deviceKey();
        const [other] =
          await h.db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,org_unit_id)
          values(${seller.profile.id},${otherApp},'android','Other app phone',${otherKey.publicKeySpki},${otherKey.keyId},${seller.profile.orgUnitId}) returning id`;
        await nativeSignIn(
          h,
          seller.email,
          "test-only-waiting-password",
          otherApp,
          await deviceKey(),
        );
        const next = await nativeSignIn(
          h,
          seller.email,
          "test-only-waiting-password",
          app,
          nextKey,
        );
        expect(next.res.status).toBe(200);
        const before = await me(h, next, app, nextKey);
        expect(before.handoverRequired).toBe(false);
        expect(before.device).toBeNull();
        const waiting = (await admin.fleet()).waiting.find(
          (/** @type {any} */ w) => w.app === app,
        );
        expect(waiting.replaces).toContain("Old sales phone");
        expect(waiting.replaces).toContain("Older paused phone");
        expect(waiting.replaces).not.toContain("Other app phone");
        expect(
          (
            await h.db`select status from registered_devices where id=${oldId}`
          )[0].status,
        ).toBe("active");
        const approved = await admin.post("register", {
          requestId: waiting.id,
        });
        expect(approved.status).toBe(200);
        const nextId = (await approved.json()).deviceId;
        const after = await me(h, next, app, nextKey);
        expect(after.device.id).toBe(nextId);
        expect(after.device.status).toBe("active");
        expect(after.handoverRequired).toBe(false);
        expect(
          (
            await h.db`select id from registered_devices where profile_id=${seller.profile.id} and app=${app} and status='active'`
          ).map((/** @type {any} */ r) => r.id),
        ).toEqual([nextId]);
        expect(
          (
            await h.db`select status from registered_devices where id in ${h.db([oldId, paused.id])}`
          ).map((/** @type {any} */ r) => r.status),
        ).toEqual(["revoked", "revoked"]);
        expect(
          (
            await h.db`select status from registered_devices where id=${other.id}`
          )[0].status,
        ).toBe("active");
        expect(
          (await admin.fleet()).waiting.map((/** @type {any} */ w) => w.app),
        ).toEqual([otherApp]);
        expect(
          (
            await h.db`select ack from op_receipts where client_op_id=${requestId}`
          )[0].ack,
        ).toEqual({ kept: true });
        expect(
          (
            await h.db`select status from device_controls where id=${control.id}`
          )[0].status,
        ).toBe("pending");
        expect(
          (
            await h.db`select effective_to from company_phone_assignments where device_id=${oldId}`
          )[0].effective_to,
        ).not.toBeNull();
        const oldMe = await h.fetch("/api/me", {
          headers: { authorization: `Bearer ${old.body.accessToken}` },
        });
        expect(oldMe.status).toBe(401);
        expect(
          (
            await nativeSignIn(
              h,
              seller.email,
              "test-only-waiting-password",
              app,
              pausedKey,
            )
          ).res.status,
        ).toBe(403);
        // Existing app request shape: supply the phone's assessment, then prove possession normally.
        const ch = await h.fetch("/api/devices/challenge", {
          method: "POST",
          headers: {
            authorization: `Bearer ${next.body.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            version: 2,
            deviceId: nextId,
            integrity: { rooted: false, tampered: false },
          }),
        });
        expect(ch.status).toBe(200);
        expect(
          (await bind(h, next.body.accessToken, nextId, nextKey)).res.status,
        ).toBe(200);
        expect((await me(h, next, app, nextKey)).device.bound).toBe(true);
        const report = await admin.get(
          `/api/v1/people/devices/report?deviceId=${oldId}`,
        );
        expect(report.status).toBe(200);
        expect(
          (await report.json()).history.some(
            (/** @type {any} */ e) =>
              e.action === "device.revoked" && e.reason === "replacement",
          ),
        ).toBe(true);
        expect((await admin.get("/api/v1/people/devices/list")).status).toBe(
          200,
        );
        for (const action of ["suspend", "reinstate"]) {
          const r = await admin.request(`/api/v1/people/devices/${action}`, {
            deviceId: nextId,
            reason: action === "suspend" ? "other" : "found",
          });
          expect(r.status).toBe(200);
          expect(
            (
              await h.db`select status from registered_devices where id=${nextId}`
            )[0].status,
          ).toBe(action === "suspend" ? "suspended" : "active");
        }
        // Phone management must not grant Operations unrelated administration.
        if (role === "operations")
          expect(
            (await admin.get("/api/v1/people/invitations/list")).status,
          ).toBe(403);
      } finally {
        await h.close();
      }
    });
  }
  test(`SP-0234 ${app} a person with only a revoked phone waits and can register`, async () => {
    const { h, person, office } = await setup();
    try {
      const seller = await person("retired-sales@example.test", "sales");
      await person("retired-admin@example.test", "admin");
      const oldKey = await deviceKey();
      await h.db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,org_unit_id,status)
        values(${seller.profile.id},${app},'android','Retired phone',${oldKey.publicKeySpki},${oldKey.keyId},${seller.profile.orgUnitId},'revoked')`;
      const key = await deviceKey();
      const phone = await nativeSignIn(
        h,
        seller.email,
        "test-only-waiting-password",
        app,
        key,
      );
      expect((await me(h, phone, app, key)).handoverRequired).toBe(false);
      const admin = await office("retired-admin@example.test");
      const [waiting] = (await admin.fleet()).waiting;
      expect(waiting.replaces).toBeNull();
      expect(
        (await admin.post("register", { requestId: waiting.id })).status,
      ).toBe(200);
      expect((await me(h, phone, app, key)).device.status).toBe("active");
      expect(
        (
          await nativeSignIn(
            h,
            seller.email,
            "test-only-waiting-password",
            app,
            oldKey,
          )
        ).res.status,
      ).toBe(403);
    } finally {
      await h.close();
    }
  });

  test(`SP-0234 ${app} copied-code replacements need no label, including when an older phone is labelled Phone`, async () => {
    const { h, person, office } = await setup();
    try {
      const seller = await person("no-label-sales@example.test", "sales");
      await person("no-label-office@example.test", "operations");
      const admin = await office("no-label-office@example.test");
      const ids = [];
      for (const inventoryTag of ["Phone", "", "   "]) {
        const key = await deviceKey();
        const response = await admin.request(
          "/api/v1/people/devices/register",
          {
            profileId: seller.profile.id,
            app,
            publicKeySpki: key.publicKeySpki,
            inventoryTag,
          },
        );
        expect(response.status).toBe(200);
        ids.push((await response.json()).deviceId);
      }
      const rows =
        await h.db`select id,status,inventory_tag from registered_devices
        where profile_id=${seller.profile.id} and app=${app}`;
      expect(rows).toHaveLength(3);
      expect(
        new Set(rows.map((/** @type {any} */ r) => r.inventory_tag)).size,
      ).toBe(3);
      expect(
        rows
          .filter((/** @type {any} */ r) => r.status === "active")
          .map((/** @type {any} */ r) => r.id),
      ).toEqual([ids[2]]);
      expect(
        rows.filter((/** @type {any} */ r) => r.status === "revoked"),
      ).toHaveLength(2);
    } finally {
      await h.close();
    }
  });
}

test("SP-0234 simultaneous office approvals choose one phone without deadlock; failed registration rolls back", async () => {
  const { h, person, office } = await setup();
  try {
    const seller = await person("race-sales@example.test", "sales");
    const other = await person("race-other@example.test", "sales");
    await person("race-admin@example.test", "admin");
    const admin = await office("race-admin@example.test");
    const key = await deviceKey();
    const old = await admin.request("/api/v1/people/devices/register", {
      profileId: seller.profile.id,
      app: "field-android",
      publicKeySpki: key.publicKeySpki,
    });
    expect(old.status).toBe(200);
    const oldId = (await old.json()).deviceId;
    const otherKey = await deviceKey();
    expect(
      (
        await admin.request("/api/v1/people/devices/register", {
          profileId: other.profile.id,
          app: "field-android",
          inventoryTag: "Already used label",
          publicKeySpki: otherKey.publicKeySpki,
        })
      ).status,
    ).toBe(200);
    const candidate = await deviceKey();
    expect(
      (
        await admin.request("/api/v1/people/devices/register", {
          profileId: seller.profile.id,
          app: "field-android",
          inventoryTag: "Already used label",
          publicKeySpki: candidate.publicKeySpki,
        })
      ).status,
    ).toBe(409);
    expect(
      (await h.db`select status from registered_devices where id=${oldId}`)[0]
        .status,
    ).toBe("active");
    expect(
      await h.db`select 1 from audit_logs where action='device.revoked' and entity_id=${oldId}`,
    ).toHaveLength(0);
    await nativeSignIn(
      h,
      seller.email,
      "test-only-waiting-password",
      "field-android",
      candidate,
    );
    await nativeSignIn(
      h,
      seller.email,
      "test-only-waiting-password",
      "field-android",
      await deviceKey(),
    );
    const requests = (await admin.fleet()).waiting;
    expect(requests).toHaveLength(2);
    const results = await Promise.all(
      requests.map((/** @type {any} */ w) =>
        admin.post("register", { requestId: w.id }),
      ),
    );
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(
      await h.db`select 1 from registered_devices where profile_id=${seller.profile.id} and status='active'`,
    ).toHaveLength(1);
    expect((await admin.fleet()).waiting).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test("SP-0231 an accepted account invitation is not a phone approval; registering the matching phone lets the same session bind", async () => {
  const { h, person, office } = await setup();
  try {
    const salesman = await person("sample-taborada@example.test", "sales");
    await person("sample-taborada-admin@example.test", "admin");
    await h.db`insert into access_invitations(email,name,role,status,invited_by,invited_at,accepted_at,profile_id)
      values(${salesman.email},'SAMPLE TABORADA','sales','accepted','SAMPLE',now(),now(),${salesman.profile.id})`;
    const key = await deviceKey();
    const phone = await nativeSignIn(
      h,
      salesman.email,
      "test-only-waiting-password",
      "field-android",
      key,
    );
    expect(phone.res.status).toBe(200);
    const me = async () => {
      const response = await h.fetch("/api/me", {
        headers: {
          authorization: `Bearer ${phone.body.accessToken}`,
          "x-app": "field-android",
          "x-device-key-id": key.keyId,
        },
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const before = await me();
    expect(before.device).toBeNull();
    expect(before.handoverRequired).toBe(false);
    const admin = await office("sample-taborada-admin@example.test");
    const waiting = (await admin.fleet()).waiting;
    expect(waiting).toHaveLength(1);
    expect(waiting[0].phoneCode.replaceAll(" ", "")).toBe(
      key.keyId.slice(0, 16).toUpperCase(),
    );
    const approved = await admin.post("register", { requestId: waiting[0].id });
    expect(approved.status).toBe(200);
    const { deviceId } = await approved.json();
    const registered = await me();
    expect(registered.device.id).toBe(deviceId);
    expect(registered.device.status).toBe("active");
    expect(registered.device.bound).toBe(false);
    // Match NativeApi.post: a newly registered phone reports its OS assessment
    // with the first challenge; sign-in happened before a device row existed.
    const assessed = await h.fetch("/api/devices/challenge", {
      method: "POST",
      headers: {
        authorization: `Bearer ${phone.body.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: 2,
        deviceId,
        integrity: { rooted: false, tampered: false },
      }),
    });
    expect(assessed.status).toBe(200);
    const bound = await bind(h, phone.body.accessToken, deviceId, key);
    expect(bound.res.status).toBe(200);
    expect(bound.body.bindingStatus).toBe("bound");
    const ready = await me();
    expect(ready.device.id).toBe(deviceId);
    expect(ready.device.bound).toBe(true);
    expect(ready.handoverRequired).toBe(false);
    expect((await admin.fleet()).waiting).toHaveLength(0);
    const [invitation] =
      await h.db`select status from access_invitations where profile_id=${salesman.profile.id}`;
    expect(invitation.status).toBe("accepted");
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
    // A person who already has a phone waits here too, with their old phone labelled.
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
    expect(after).toHaveLength(1);
    expect(
      (await admin.fleet()).waiting.find(
        (/** @type {any} */ w) => w.person === a.email,
      ).replaces,
    ).toBe("SAMPLE old");
  } finally {
    await h.close();
  }
});
