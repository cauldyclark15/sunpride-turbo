import { test, expect } from "bun:test";
import {
  startHarness,
  profileStore,
  createUser,
  deviceKey,
  nativeSignIn,
  bind,
} from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as integrity } from "../src/domains/integrity/index.js";

// Real HTTP + PostgreSQL, with explicitly invented local people/phone keys; no physical-phone claim.
async function fixture(officeRole = "operations") {
  const h = await startHarness({ installers: [org, integrity] });
  const people = profileStore(h),
    unit = crypto.randomUUID(),
    other = crypto.randomUUID();
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','Sample national','national','active',now()-interval '1 day')`;
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from,parent_id) values(${other},'sunpride','OTHER','Sample other region','region','active',now()-interval '1 day',${unit})`;
  /** @param {string} email @param {string} [role] @param {string} [at] */
  async function person(email, role = "sales", at = unit) {
    const userId = await createUser(h, email, "sample-phone-controls-password");
    const p = people.set(userId, { role, orgUnitId: at, name: email });
    await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${userId},${userId},${email},${email},${role},'active',${at})`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${at},${role},now()-interval '1 day','SAMPLE','SAMPLE')`;
    return p;
  }
  const seller = await person("seller@example.test");
  await person("ops@example.test", officeRole);
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "ops@example.test",
      password: "sample-phone-controls-password",
    }),
  });
  expect(login.status).toBe(200);
  const cookie = /** @type {string} */ (login.headers.get("set-cookie")).split(
    ";",
  )[0];
  /** @param {string} action @param {Record<string, any>} [extra] @param {string} [key] */
  const command = (action, extra = {}, key = crypto.randomUUID()) =>
    h.fetch("/api/v1/people/phone-controls", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({ profileId: seller.id, action, ...extra }),
    });
  /** @returns {Promise<any>} */
  const read = () =>
    h
      .fetch(`/api/v1/people/phone-controls?profileId=${seller.id}`, {
        headers: { cookie },
      })
      .then((r) => r.json());
  async function phone(app = "field-android", register = true) {
    const key = await deviceKey();
    let login = await nativeSignIn(
      h,
      seller.name,
      "sample-phone-controls-password",
      app,
      key,
    );
    expect(login.res.status).toBe(200);
    let id = null;
    if (register) {
      const [w] =
        await h.db`select id from phone_registration_requests where profile_id=${seller.id} and key_id=${key.keyId}`;
      const r = await command("register", { requestId: w.id });
      expect(r.status).toBe(200);
      id = (await r.json()).deviceId;
      login = await nativeSignIn(
        h,
        seller.name,
        "sample-phone-controls-password",
        app,
        key,
      );
      expect((await bind(h, login.body.accessToken, id, key)).res.status).toBe(
        200,
      );
    }
    /** @param {string[]} [acks] @param {Record<string, any>} [overrides] */
    const check = (acks = [], overrides = {}) =>
      h.fetch("/api/auth/phone-check", {
        method: "POST",
        headers: {
          authorization: `Bearer ${login.body.sessionToken}`,
          "content-type": "application/json",
          "x-device-model": "phone",
          "x-device-manufacturer": "SAMPLE",
        },
        body: JSON.stringify({
          version: 2,
          app,
          keyId: key.keyId,
          appVersion: "1.0.0-sample",
          unsentCount: 3,
          acks,
          ...overrides,
        }),
      });
    return { key, id, check, ...login.body };
  }
  return { h, seller, person, command, read, phone, other, cookie };
}

for (const app of ["field-android", "van-android", "field-ios"]) {
  test(`SP-0249 ${app}: immediate sign-out, retained registration, exact-phone delivery/ack and fresh sign-in`, async () => {
    const f = await fixture();
    try {
      const phone = await f.phone(app);
      expect((await phone.check()).status).toBe(200);
      const requested = await f.command(
        "sign_out",
        { deviceId: phone.id },
        "sample-signout",
      );
      expect(requested.status).toBe(200);
      const id = (await requested.json()).id;
      expect(
        (await f.command("sign_out", { deviceId: phone.id }, "sample-signout"))
          .status,
      ).toBe(200);
      expect(
        (
          await f.h
            .db`select id from phone_commands where device_id=${phone.id}`
        ).length,
      ).toBe(1);
      expect(
        (
          await f.h.fetch("/api/me", {
            headers: {
              authorization: `Bearer ${phone.accessToken}`,
              "x-app": app,
              "x-device-key-id": phone.key.keyId,
            },
          })
        ).status,
      ).toBe(401);
      let view = await f.read();
      expect(view.phones[0].signedIn).toBe(false);
      expect(view.phones[0].unsentCount).toBe(3);
      expect(view.phones[0].status).toBe("registered");
      expect(view.phones[0].history[0].doneAt).toBeNull();
      const delivered = await (await phone.check()).json();
      expect(delivered.commands).toEqual([{ id, kind: "sign_out" }]);
      expect((await phone.check([id])).status).toBe(200);
      expect((await phone.check([id])).status).toBe(200); // Lost acknowledgement reply is retry-safe.
      view = await f.read();
      expect(view.phones[0].history[0].doneAt).toBeTruthy();
      expect(view.phones[0].history[0].who).toBe("ops@example.test");
      const fresh = await nativeSignIn(
        f.h,
        f.seller.name,
        "sample-phone-controls-password",
        app,
        phone.key,
      );
      expect(fresh.res.status).toBe(200);
      const freshCheck = await f.h.fetch("/api/auth/phone-check", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fresh.body.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: 2,
          app,
          keyId: phone.key.keyId,
          unsentCount: 3,
          acks: [],
        }),
      });
      expect((await freshCheck.json()).commands).toEqual([]);
      expect(
        (
          await f.h
            .db`select status from registered_devices where id=${phone.id}`
        )[0].status,
      ).toBe("active");
    } finally {
      await f.h.close();
    }
  });
}

test("SP-0249 refresh/resend/update wait for completion, reject forged acknowledgements and keep sessions", async () => {
  const f = await fixture();
  try {
    const phone = await f.phone();
    const foreign = await f.phone("van-android");
    /** @type {string[]} */ const ids = [];
    for (const action of ["refresh", "resend", "update"]) {
      const r = await f.command(action, { deviceId: phone.id });
      expect(r.status).toBe(200);
      ids.push((await r.json()).id);
    }
    expect((await phone.check([ids[0]])).status).toBe(400); // Cannot say done before pickup.
    expect((await foreign.check([ids[0]])).status).toBe(400);
    const a = await (await phone.check()).json(),
      b = await (await phone.check()).json();
    expect(a.commands).toEqual(b.commands);
    expect(a.commands.map((/** @type {any} */ x) => x.id)).toEqual(ids);
    expect(
      (await f.read()).phones
        .find((/** @type {any} */ p) => p.deviceId === phone.id)
        .history.filter((/** @type {any} */ x) => ids.includes(x.id))
        .every((/** @type {any} */ x) => !x.doneAt),
    ).toBe(true);
    expect((await phone.check(ids)).status).toBe(200);
    const view = await f.read();
    const p = view.phones.find(
      (/** @type {any} */ p) => p.deviceId === phone.id,
    );
    expect(p.history.every((/** @type {any} */ x) => !!x.doneAt)).toBe(true);
    expect(p.signedIn).toBe(true);
    expect(p.appVersion).toBe("1.0.0-sample");
    expect(p.model).toBe("SAMPLE phone");
    expect(p.lastSeenAt).toBeTruthy();
    expect((await phone.check([], { keyId: foreign.key.keyId })).status).toBe(
      401,
    );
  } finally {
    await f.h.close();
  }
});

test("SP-0249 sign out all covers waiting and registered phones, not web; remove refuses later sign-in", async () => {
  const f = await fixture();
  try {
    const phone = await f.phone(),
      waiting = await f.phone("van-android", false);
    expect((await f.command("sign_out_all")).status).toBe(200);
    for (const p of [phone, waiting])
      expect((await (await p.check()).json()).commands[0].kind).toBe(
        "sign_out",
      );
    expect(
      (await f.h.fetch("/api/me", { headers: { cookie: f.cookie } })).status,
    ).toBe(200);
    const fresh = await nativeSignIn(
      f.h,
      f.seller.name,
      "sample-phone-controls-password",
      "field-android",
      phone.key,
    );
    expect(fresh.res.status).toBe(200);
    const removed = await f.command("remove", { deviceId: phone.id });
    expect(removed.status).toBe(200);
    expect(
      (
        await nativeSignIn(
          f.h,
          f.seller.name,
          "sample-phone-controls-password",
          "field-android",
          phone.key,
        )
      ).res.status,
    ).toBe(403);
    expect(
      (await f.read()).phones.find(
        (/** @type {any} */ p) => p.deviceId === phone.id,
      ).status,
    ).toBe("removed");
  } finally {
    await f.h.close();
  }
});

test("SP-0249 auto-accept replaces same-app phones only; disabling affects only future new phones", async () => {
  const f = await fixture();
  try {
    const old = await f.phone(),
      van = await f.phone("van-android");
    expect((await f.command("auto_accept", { enabled: true })).status).toBe(
      200,
    );
    const next = await f.phone("field-android", false);
    const [d] = await f.h
      .db`select * from registered_devices where key_id=${next.key.keyId}`;
    expect(d.status).toBe("active");
    expect(d.superadmin_auto).toBe(false);
    expect(
      (
        await f.h.db`select status from registered_devices where id=${old.id}`
      )[0].status,
    ).toBe("revoked");
    expect(
      (
        await f.h.db`select status from registered_devices where id=${van.id}`
      )[0].status,
    ).toBe("active");
    expect((await f.command("auto_accept", { enabled: false })).status).toBe(
      200,
    );
    expect((await next.check()).status).toBe(200);
    const third = await f.phone("field-android", false);
    expect(
      (
        await f.h
          .db`select 1 from registered_devices where key_id=${third.key.keyId}`
      ).length,
    ).toBe(0);
    expect((await (await old.check()).json()).commands[0].kind).toBe("remove");
  } finally {
    await f.h.close();
  }
});

test("SP-0249 registration and auto-accept changes show who made them in each phone's history", async () => {
  const f = await fixture();
  try {
    const phone = await f.phone();
    expect((await f.command("auto_accept", { enabled: true })).status).toBe(
      200,
    );
    expect((await f.command("auto_accept", { enabled: false })).status).toBe(
      200,
    );
    const p = (await f.read()).phones.find(
      (/** @type {any} */ p) => p.deviceId === phone.id,
    );
    for (const kind of ["register", "auto_accept_on", "auto_accept_off"]) {
      const entry = p.history.find((/** @type {any} */ e) => e.kind === kind);
      expect(entry).toBeTruthy();
      expect(entry.who).toBe("ops@example.test");
      expect(entry.doneAt).toBeTruthy();
    }
  } finally {
    await f.h.close();
  }
});

test("SP-0249 a lost terminal acknowledgement still works after session expiry but grants no business access", async () => {
  const f = await fixture();
  try {
    const phone = await f.phone();
    const r = await f.command("sign_out", { deviceId: phone.id });
    const id = (await r.json()).id;
    expect((await phone.check()).status).toBe(200);
    await f.h
      .db`update sessions set expires_at=now()-interval '1 day' where device_key_id=${phone.key.keyId}`;
    expect((await phone.check([id], { unsentCount: 0 })).status).toBe(200);
    expect((await phone.check([id])).status).toBe(200);
    expect(
      (await f.read()).phones.find(
        (/** @type {any} */ p) => p.deviceId === phone.id,
      ).unsentCount,
    ).toBe(3);
    expect((await phone.check()).status).toBe(401);
    expect(
      (
        await f.h.fetch("/api/me", {
          headers: {
            authorization: `Bearer ${phone.accessToken}`,
            "x-app": "field-android",
            "x-device-key-id": phone.key.keyId,
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (await f.h.db`select completed_at from phone_commands where id=${id}`)[0]
        .completed_at,
    ).toBeTruthy();
  } finally {
    await f.h.close();
  }
});

test("SP-0249 completed acknowledgements do not fall out of a busy phone's bounded queue", async () => {
  const f = await fixture();
  try {
    const phone = await f.phone();
    const r = await f.command("refresh", { deviceId: phone.id });
    const id = (await r.json()).id;
    expect((await phone.check()).status).toBe(200);
    expect((await phone.check([id])).status).toBe(200);
    // Explicit local queue-boundary fixture, not a load/volume claim.
    await f.h
      .db`insert into phone_commands(profile_id,device_id,app,key_id,kind,requested_by)
      select ${f.seller.id},${phone.id},'field-android',${phone.key.keyId},'resend','SAMPLE' from generate_series(1,45)`;
    expect((await phone.check([id])).status).toBe(200);
  } finally {
    await f.h.close();
  }
});

test("SP-0249 an administrator can open phone controls and end a phone sign-in", async () => {
  const f = await fixture("admin");
  try {
    const phone = await f.phone();
    expect((await f.read()).person.id).toBe(f.seller.id);
    expect((await f.command("sign_out", { deviceId: phone.id })).status).toBe(
      200,
    );
    expect((await (await phone.check()).json()).commands[0].kind).toBe(
      "sign_out",
    );
  } finally {
    await f.h.close();
  }
});

test("SP-0249 sales cannot issue controls; office keeps company-wide access and exact-person matching", async () => {
  const f = await fixture();
  try {
    const phone = await f.phone();
    expect(
      (
        await f.h.fetch(
          `/api/v1/people/phone-controls?profileId=${f.seller.id}`,
          { headers: { authorization: `Bearer ${phone.accessToken}` } },
        )
      ).status,
    ).toBe(403);
    const outsider = await f.person("outsider@example.test", "sales", f.other);
    const scoped = await f.person(
      "regional@example.test",
      "operations",
      f.other,
    );
    const r = await f.h.fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: scoped.name,
        password: "sample-phone-controls-password",
      }),
    });
    const cookie = /** @type {string} */ (r.headers.get("set-cookie")).split(
      ";",
    )[0];
    expect(
      (
        await f.h.fetch(
          `/api/v1/people/phone-controls?profileId=${f.seller.id}`,
          { headers: { cookie } },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.command("remove", {
          profileId: outsider.id,
          deviceId: phone.id,
        })
      ).status,
    ).toBe(422);
  } finally {
    await f.h.close();
  }
});
