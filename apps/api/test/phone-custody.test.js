import { afterAll, beforeAll, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  createUser,
  deviceKey,
  nativeSignIn,
  registerDevice,
  bind,
  challenge,
  signedPost,
} from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as fieldsync } from "../src/domains/fieldsync/index.js";
import { manilaDate } from "../src/domains/fieldsync/model.js";
import { lockPhoneKey } from "../src/core/phone-custody.js";
import { actorFor } from "../src/core/context.js";
import { bundle as vanBundle } from "../src/domains/van/projection.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let boss;
/** @type {any} */ let office;
let root = "",
  region = "",
  other = "";
const password = "SAMPLE-custody-password";

/** @param {string} name @param {string} [role] @param {string} [unit] */
async function person(name, role = "sales", unit = region) {
  const email = `${crypto.randomUUID()}@example.test`;
  const userId = await createUser(h, email, password);
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,effective_from)
    values(${userId},${userId},${name},${email},${role},'active',${unit},now()-interval '1 day') returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)
    values(${p.id},${unit},${role},now()-interval '1 day','SAMPLE','SAMPLE')`;
  const res = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return {
    userId,
    profileId: p.id,
    email,
    cookie: (res.headers.get("set-cookie") ?? "").split(";")[0],
  };
}
/** @param {string} path @param {any} who @param {any} [body] @param {string} [key] */
async function call(path, who, body, key) {
  const res = await h.fetch(`/api/v1/people/devices/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      cookie: who.cookie,
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}
/** @param {any} owner @param {string} [app] */
async function phone(owner, app = "field-android") {
  const key = await deviceKey();
  const deviceId = await registerDevice(h, {
    profileId: owner.profileId,
    orgUnitId: region,
    app,
    key,
  });
  const login = await nativeSignIn(h, owner.email, password, app, key);
  expect(login.res.status).toBe(200);
  const b = await bind(h, login.body.accessToken, deviceId, key);
  expect(b.body.bindingStatus).toBe("bound");
  return {
    key,
    deviceId,
    access: login.body.accessToken,
    session: login.body.sessionToken,
    app,
  };
}
/** @param {any} who */
async function refresh(who) {
  return h.fetch("/api/auth/refresh", {
    method: "POST",
    headers: {
      authorization: `Bearer ${who.session}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      version: 2,
      app: who.app,
      deviceKeyId: who.key.keyId,
    }),
  });
}
/** @param {any} who */
async function me(who) {
  const res = await h.fetch("/api/me", {
    headers: {
      authorization: `Bearer ${who.access}`,
      "x-app": who.app,
      "x-device-key-id": who.key.keyId,
    },
  });
  return { status: res.status, body: await res.json() };
}
/** @param {any} who */
async function bundle(who) {
  return signedPost(h, who, "/api/sync/pull", {
    version: 2,
    app: who.app,
    deviceId: who.deviceId,
    since: null,
    pageCursor: null,
    scopes: [
      {
        scopeId: region,
        projection: "field.bundle",
        params: { dayFrom: manilaDate(Date.now()) },
      },
    ],
    limit: 100,
  });
}

beforeAll(async () => {
  h = await startHarness({ installers: [org, fieldsync] });
  await createUser(h, "boss@example.com", password);
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "boss@example.com", password }),
  });
  boss = {
    email: "boss@example.com",
    cookie: (login.headers.get("set-cookie") ?? "").split(";")[0],
  };
  const mine = await h.fetch("/api/me", { headers: { cookie: boss.cookie } });
  const value = await mine.json();
  root = value.profile.orgUnitId;
  for (const code of ["CUSTODY", "OTHER"]) {
    const [unit] =
      await h.db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from)
      values('sunpride',${code},${code},'REGION',${root},'active',now()-interval '1 day') returning id`;
    await h.db`insert into org_unit_parent_edges(unit_id,parent_id,effective_from,actor_subject,reason)
      values(${unit.id},${root},now()-interval '1 day','SAMPLE','SAMPLE')`;
    if (code === "CUSTODY") region = unit.id;
    else other = unit.id;
  }
  office = await person("SAMPLE office", "admin");
}, 30000);
afterAll(async () => {
  if (h) await h.close();
});

test("SP-0221 same phone moves to replacement, ends old sessions, requires new binding, downloads only replacement data and keeps dated history", async () => {
  const old = await person("SAMPLE resigned person");
  const replacement = await person("SAMPLE replacement");
  const who = await phone(old);
  const before = await bundle(who);
  expect(before.res.status).toBe(200);
  expect(JSON.stringify(before.body)).toContain(old.profileId);
  const nonce = await challenge(h, who.access, who.deviceId);
  // Historical received work remains attributed to the original person.
  const opId = crypto.randomUUID();
  await h.db`insert into op_receipts(client_op_id,device_id,subject,op_type,payload_hash,status,ack)
    values(${opId},${who.deviceId},${old.userId},'visit.checkIn',${"a".repeat(64)},'applied',${{ result: "SAMPLE received work" }})`;
  const input = { deviceId: who.deviceId, profileId: replacement.profileId };
  expect((await call("reassign", office, input, "handoff-once")).status).toBe(
    200,
  );
  expect((await call("reassign", office, input, "handoff-once")).status).toBe(
    200,
  );
  expect((await me(who)).status).toBe(401);
  expect((await refresh(who)).status).toBe(401);
  expect((await challenge(h, who.access, who.deviceId)).res.status).not.toBe(
    200,
  );
  expect((await bundle(who)).res.status).not.toBe(200);
  expect(
    (await nativeSignIn(h, old.email, password, who.app, who.key)).res.status,
  ).toBe(403);
  const [invalidated] =
    await h.db`select consumed_at from device_challenges where nonce=${nonce.body.nonce}`;
  expect(invalidated.consumed_at).not.toBeNull();
  const login = await nativeSignIn(
    h,
    replacement.email,
    password,
    who.app,
    who.key,
  );
  expect(login.res.status).toBe(200);
  const next = {
    ...who,
    access: login.body.accessToken,
    session: login.body.sessionToken,
  };
  const state = await me(next);
  expect(state.body.device.id).toBe(who.deviceId);
  expect(state.body.device.bound).toBe(false);
  expect((await bundle(next)).res.status).toBe(403);
  expect(
    (await bind(h, next.access, next.deviceId, next.key)).body.bindingStatus,
  ).toBe("bound");
  const downloaded = await bundle(next);
  expect(downloaded.res.status).toBe(200);
  expect(JSON.stringify(downloaded.body)).toContain(replacement.profileId);
  expect(JSON.stringify(downloaded.body)).not.toContain(old.profileId);
  const report = await call(`report?deviceId=${who.deviceId}`, office);
  expect(report.status).toBe(200);
  expect(report.body.assignments).toHaveLength(2);
  expect(
    report.body.assignments.find(
      (/** @type {any} */ a) => a.personName === "SAMPLE resigned person",
    ).to,
  ).not.toBeNull();
  expect(
    report.body.assignments.find(
      (/** @type {any} */ a) => a.personName === "SAMPLE replacement",
    ).to,
  ).toBeNull();
  expect(
    report.body.acknowledged.some(
      (/** @type {any} */ a) => a.clientRequestId === opId,
    ),
  ).toBe(true);
  expect(
    report.body.history.some(
      (/** @type {any} */ e) => e.action === "people.devices.reassign",
    ),
  ).toBe(true);
  const [receipt] =
    await h.db`select subject from op_receipts where client_op_id=${opId}`;
  expect(receipt.subject).toBe(old.userId);
  const [active] =
    await h.db`select count(*)::int as n from company_phone_assignments where device_id=${who.deviceId} and effective_to is null`;
  expect(active.n).toBe(1);
}, 15000);

test("SP-0221 lost blocks existing and new sign-in/sync across accounts and apps; only scoped admin can register again", async () => {
  const owner = await person("SAMPLE lost owner");
  const stranger = await person("SAMPLE stranger");
  const who = await phone(owner);
  expect((await call("lost", owner, { deviceId: who.deviceId })).status).toBe(
    403,
  );
  expect((await call("lost", office, { deviceId: who.deviceId })).status).toBe(
    200,
  );
  expect((await me(who)).status).toBe(401);
  expect((await refresh(who)).status).toBe(401);
  expect((await bundle(who)).res.status).not.toBe(200);
  for (const email of [owner.email, stranger.email, boss.email]) {
    for (const app of ["field-android", "van-android"]) {
      const result = await nativeSignIn(h, email, password, app, who.key);
      expect(result.res.status).toBe(403);
      expect(result.body.error.code).toBe("device_revoked");
    }
  }
  const lostReport = await call(`report?deviceId=${who.deviceId}`, office);
  expect(lostReport.body.device.lost).toBe(true);
  expect(lostReport.body.assignments[0].to).not.toBeNull();
  const listed = await call("list", office);
  expect(
    listed.body.page.find((/** @type {any} */ d) => d.deviceId === who.deviceId)
      .lost,
  ).toBe(true);
  expect(
    (await call("reregister", owner, { deviceId: who.deviceId })).status,
  ).toBe(403);
  expect(
    (
      await call("reinstate", office, {
        deviceId: who.deviceId,
        reason: "found",
      })
    ).status,
  ).toBe(422);
  expect(
    (await call("reregister", office, { deviceId: who.deviceId })).status,
  ).toBe(200);
  const restored = await call(`report?deviceId=${who.deviceId}`, office);
  expect(restored.body.device.lost).toBe(false);
  expect(restored.body.assignments).toHaveLength(2);
  expect((await me(who)).status).toBe(401);
  const login = await nativeSignIn(h, owner.email, password, who.app, who.key);
  expect(login.res.status).toBe(200);
  expect(
    (await bind(h, login.body.accessToken, who.deviceId, who.key)).body
      .bindingStatus,
  ).toBe("bound");
}, 15000);

test("SP-0221 validates both people's scope and existing phone, preserves history on refusals, serializes concurrent transfers", async () => {
  const owner = await person("SAMPLE scope old");
  const far = await person("SAMPLE out of area", "sales", other);
  const a = await person("SAMPLE next A");
  const b = await person("SAMPLE next B");
  const who = await phone(owner);
  expect(
    (
      await call("reassign", office, {
        deviceId: who.deviceId,
        profileId: far.profileId,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call("reassign", owner, {
        deviceId: who.deviceId,
        profileId: a.profileId,
      })
    ).status,
  ).toBe(403);
  const already = await phone(a);
  expect(
    (
      await call("reassign", office, {
        deviceId: who.deviceId,
        profileId: a.profileId,
      })
    ).status,
  ).toBe(422);
  expect(
    (await call(`report?deviceId=${who.deviceId}`, office)).body.assignments,
  ).toHaveLength(1);
  // Release A's separate phone, then two office requests still leave exactly one current owner/interval.
  expect(
    (await call("lost", office, { deviceId: already.deviceId })).status,
  ).toBe(200);
  const outcomes = await Promise.all(
    [a, b].map((p) =>
      call("reassign", office, {
        deviceId: who.deviceId,
        profileId: p.profileId,
      }),
    ),
  );
  expect(outcomes.every((r) => r.status === 200)).toBe(true);
  const history = await call(`report?deviceId=${who.deviceId}`, office);
  expect(history.body.assignments).toHaveLength(3);
  expect(
    history.body.assignments.filter((/** @type {any} */ r) => r.to === null),
  ).toHaveLength(1);
});

test("SP-0221 a sign-in waiting behind an office lost-phone change cannot issue a new session", async () => {
  const owner = await person("SAMPLE concurrent sign-in");
  const who = await phone(owner);
  /** @type {() => void} */ let release = () => {};
  /** @type {() => void} */ let locked = () => {};
  const held = new Promise(
    /** @param {(value?: any) => void} resolve */ (resolve) => {
      release = resolve;
    },
  );
  const hasLock = new Promise(
    /** @param {(value?: any) => void} resolve */ (resolve) => {
      locked = resolve;
    },
  );
  const change = tx(h.db, async (db) => {
    await lockPhoneKey(db, who.key.keyId);
    await db`update registered_devices set status='revoked' where id=${who.deviceId}`;
    await db`insert into company_phone_custody(key_id,device_id,state) values(${who.key.keyId},${who.deviceId},'lost')`;
    locked();
    await held;
  });
  await hasLock;
  const login = nativeSignIn(h, owner.email, password, who.app, who.key);
  release();
  await change;
  expect((await login).res.status).toBe(403);
  const [sessions] =
    await h.db`select count(*)::int as n from sessions where user_id=${owner.userId} and app=${who.app}`;
  expect(sessions.n).toBe(1); // only the pre-existing session, never a fresh one
});

test("SP-0221 van replacement does not inherit the old crew, truck binding or previous seller’s trip", async () => {
  const owner = await person("SAMPLE old van seller");
  const replacement = await person("SAMPLE new van seller");
  const who = await phone(owner, "van-android");
  const [location] =
    await h.db`insert into inventory_locations(organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production)
    values('sunpride',${region},'SAMPLE','CUSTODY-TRUCK','SAMPLE truck','truck',true,true,true,true,false) returning id`;
  const [vehicle] =
    await h.db`insert into vehicles(organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by)
    values('sunpride',${region},'SAMPLE-CUSTODY','SAMPLE-OLD-PLATE',${location.id},${location.id},'active','SAMPLE') returning id`;
  const [trip] =
    await h.db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,started_device_id,created_by)
    values('sunpride',${region},'SAMPLE-CUSTODY',${vehicle.id},${location.id},${location.id},${manilaDate(Date.now())},${owner.profileId},${owner.userId},'active',${who.deviceId},'SAMPLE') returning id`;
  await h.db`insert into van_device_bindings(device_id,vehicle_id,bound_by) values(${who.deviceId},${vehicle.id},'SAMPLE')`;
  await h.db`insert into van_crew_sessions(device_id,vehicle_id,trip_id,profile_id,role,method,started_at,recorded_by)
    values(${who.deviceId},${vehicle.id},${trip.id},${owner.profileId},'seller','start',now(),'SAMPLE')`;
  expect(
    (
      await call("reassign", office, {
        deviceId: who.deviceId,
        profileId: replacement.profileId,
      })
    ).status,
  ).toBe(200);
  const login = await nativeSignIn(
    h,
    replacement.email,
    password,
    who.app,
    who.key,
  );
  expect(login.res.status).toBe(200);
  expect(
    (await bind(h, login.body.accessToken, who.deviceId, who.key)).body
      .bindingStatus,
  ).toBe("bound");
  /** @type {any} */ const downloaded = await vanBundle(
    {
      db: h.db,
      actor: await actorFor(h.db, replacement.userId),
      device: { id: who.deviceId },
      params: {
        serviceDate: manilaDate(Date.now()),
        handheld: true,
        vanDay: true,
      },
    },
    h.env,
  );
  expect(downloaded.seller.profileId).toBe(replacement.profileId);
  expect(downloaded.trip).toBeNull();
  expect(downloaded.policy.handheld.vehicleCode).toBeNull();
  expect(JSON.stringify(downloaded)).not.toContain(owner.profileId);
  expect(JSON.stringify(downloaded)).not.toContain("SAMPLE-OLD-PLATE");
  const [crew] =
    await h.db`select ended_at from van_crew_sessions where device_id=${who.deviceId}`;
  const [binding] =
    await h.db`select released_at from van_device_bindings where device_id=${who.deviceId}`;
  expect(crew.ended_at).not.toBeNull();
  expect(binding.released_at).not.toBeNull();
  const [kept] =
    await h.db`select salesperson_profile_id from van_trips where id=${trip.id}`;
  expect(kept.salesperson_profile_id).toBe(owner.profileId);
});

test("SP-0221 a recovered phone may go straight to a new person; owner multi-phone access stays intact", async () => {
  const owner = await person("SAMPLE multiple phone owner", "super_admin");
  const replacement = await person("SAMPLE recovered phone replacement");
  const keys = [await deviceKey(), await deviceKey()];
  for (const key of keys) {
    expect(
      (await nativeSignIn(h, owner.email, password, "field-android", key)).res
        .status,
    ).toBe(200);
  }
  const [d] =
    await h.db`select id from registered_devices where key_id=${keys[0].keyId} and profile_id=${owner.profileId}`;
  expect((await call("lost", office, { deviceId: d.id })).status).toBe(200);
  expect((await call("reregister", office, { deviceId: d.id })).status).toBe(
    200,
  );
  const [keptOwner] =
    await h.db`select superadmin_auto from registered_devices where id=${d.id}`;
  expect(keptOwner.superadmin_auto).toBe(true);
  expect((await call("lost", office, { deviceId: d.id })).status).toBe(200);
  await h.db`update profiles set status='disabled' where id=${owner.profileId}`;
  expect(
    (
      await call("reregister", office, {
        deviceId: d.id,
        profileId: replacement.profileId,
      })
    ).status,
  ).toBe(200);
  const [moved] =
    await h.db`select profile_id,superadmin_auto from registered_devices where id=${d.id}`;
  expect(moved.profile_id).toBe(replacement.profileId);
  expect(moved.superadmin_auto).toBe(false);
  const login = await nativeSignIn(
    h,
    replacement.email,
    password,
    "field-android",
    keys[0],
  );
  expect(login.res.status).toBe(200);
  expect(
    (await bind(h, login.body.accessToken, d.id, keys[0])).body.bindingStatus,
  ).toBe("bound");
  const [otherPhone] =
    await h.db`select status from registered_devices where key_id=${keys[1].keyId}`;
  expect(otherPhone.status).toBe("active");
});
