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

const PASSWORD = "test-only-superadmin-password";

/** SP-0193: the system owner's phones register themselves; every other role still waits for the office. */
async function setup() {
  const h = await startHarness({ installers: [install] });
  const people = profileStore(h),
    root = crypto.randomUUID();
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${root},'sunpride','SUNPRIDE','SUNPRIDE','national','active',now()-interval '1 day')`;
  /** @param {string} email @param {string} role */
  const person = async (email, role) => {
    const userId = await createUser(h, email, PASSWORD);
    const p = people.set(userId, { role, orgUnitId: root, name: email });
    await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${userId},${userId},${p.name},${email},${role},'active',${root})`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${root},${role},now()-interval '1 day','SAMPLE','SAMPLE')`;
    return { userId, email, profile: p };
  };
  /** @param {string} email @param {string} app */
  const phone = async (email, app = "field-android") => {
    const key = await deviceKey();
    const r = await nativeSignIn(h, email, PASSWORD, app, {
      keyId: key.keyId,
      publicKeySpki: key.publicKeySpki,
    });
    expect(r.res.status, JSON.stringify(r.body)).toBe(200);
    return { key, app, access: /** @type {string} */ (r.body.accessToken) };
  };
  /** The phone's own status check (what "Check again" and the auto-poll call). @param {any} p */
  const me = async (p) => {
    const r = await h.fetch("/api/me", {
      headers: {
        authorization: `Bearer ${p.access}`,
        "x-app": p.app,
        "x-device-key-id": p.key.keyId,
      },
    });
    expect(r.status).toBe(200);
    return /** @type {any} */ (await r.json());
  };
  return { h, people, person, phone, me };
}

test("SP-0193 a super_admin signing in on the Field app is registered at once, audited as their own approval, and sells", async () => {
  const { h, person, phone, me } = await setup();
  try {
    const owner = await person("sa-owner@example.test", "super_admin");
    const p = await phone(owner.email);
    const [device] =
      await h.db`select * from registered_devices where profile_id=${owner.profile.id} and key_id=${p.key.keyId}`;
    expect(device.status).toBe("active");
    expect(device.app).toBe("field-android");
    expect(device.superadmin_auto).toBe(true);
    const [log] =
      await h.db`select subject,details from audit_logs where action='device.registered_from_waiting' and entity_id=${device.id}`;
    expect(log.subject).toBe(owner.userId);
    const details = JSON.parse(log.details);
    expect(details.reason).toBe("superadmin_auto_approval");
    expect(details.note).toBe("superadmin auto-approval");
    // Nothing is left waiting on Setup > Phones.
    const waiting =
      await h.db`select status,device_id from phone_registration_requests where profile_id=${owner.profile.id}`;
    expect(waiting.map((/** @type {any} */ w) => w.status)).toEqual([
      "registered",
    ]);
    expect(waiting[0].device_id).toBe(device.id);
    const mine = await me(p);
    expect(mine.device).toMatchObject({ id: device.id, status: "active" });
    expect(mine.handoverRequired).toBe(false);
    expect(mine.profile.selling).toBe(true);
    // The phone then binds by itself, exactly as an office-registered phone does.
    const bound = await bind(h, p.access, device.id, p.key);
    expect(bound.body.bindingStatus).toBe("bound");
    expect((await me(p)).device.bound).toBe(true);
  } finally {
    await h.close();
  }
});

test("SP-0193 a super_admin keeps several phones active at once (no revocation, no handover)", async () => {
  const { h, person, phone, me } = await setup();
  try {
    const owner = await person("sa-multi@example.test", "super_admin");
    const s24 = await phone(owner.email);
    const xiaomi = await phone(owner.email);
    const h10 = await phone(owner.email, "van-android");
    const rows =
      await h.db`select key_id,app,status from registered_devices where profile_id=${owner.profile.id} order by created_at`;
    expect(
      rows.map((/** @type {any} */ r) => [r.key_id, r.app, r.status]),
    ).toEqual([
      [s24.key.keyId, "field-android", "active"],
      [xiaomi.key.keyId, "field-android", "active"],
      [h10.key.keyId, "van-android", "active"],
    ]);
    for (const p of [s24, xiaomi, h10]) {
      const mine = await me(p);
      expect(mine.device.status).toBe("active");
      expect(mine.handoverRequired).toBe(false);
    }
    // Signing in again on the same phone neither duplicates nor disturbs it.
    await nativeSignIn(h, owner.email, PASSWORD, "field-android", {
      keyId: s24.key.keyId,
      publicKeySpki: s24.key.publicKeySpki,
    });
    const [{ n }] =
      await h.db`select count(*)::int as n from registered_devices where profile_id=${owner.profile.id}`;
    expect(n).toBe(3);
  } finally {
    await h.close();
  }
});

test("SP-0193 a super_admin phone already waiting (before this change) is approved on its next check, with no app update", async () => {
  const { h, people, person, phone, me } = await setup();
  try {
    // The state the old server left jc's phone in: signed in, one waiting request, no phone row.
    const owner = await person("sa-waiting@example.test", "admin");
    const p = await phone(owner.email);
    await h.db`update profiles set role='super_admin' where id=${owner.profile.id}`;
    await h.db`update employee_assignments set role='super_admin' where profile_id=${owner.profile.id}`;
    people.set(owner.userId, {
      role: "super_admin",
      orgUnitId: owner.profile.orgUnitId,
      name: owner.email,
    });
    expect(
      await h.db`select 1 from registered_devices where profile_id=${owner.profile.id}`,
    ).toHaveLength(0);
    const [before] =
      await h.db`select status from phone_registration_requests where profile_id=${owner.profile.id}`;
    expect(before.status).toBe("waiting");
    const mine = await me(p);
    expect(mine.device?.status).toBe("active");
    expect(mine.profile.selling).toBe(true);
    const [device] =
      await h.db`select id,superadmin_auto from registered_devices where profile_id=${owner.profile.id} and key_id=${p.key.keyId} and status='active'`;
    expect(mine.device.id).toBe(device.id);
    expect(device.superadmin_auto).toBe(true);
    const [req] =
      await h.db`select status,device_id,decided_by from phone_registration_requests where profile_id=${owner.profile.id}`;
    expect(req).toMatchObject({
      status: "registered",
      device_id: device.id,
      decided_by: owner.userId,
    });
    const [log] =
      await h.db`select details from audit_logs where action='device.registered_from_waiting' and entity_id=${device.id}`;
    expect(JSON.parse(log.details).reason).toBe("superadmin_auto_approval");
    // The phone's challenge carries its integrity report, then it binds as usual.
    const ch = await h.fetch("/api/devices/challenge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${p.access}`,
      },
      body: JSON.stringify({
        version: 2,
        deviceId: device.id,
        integrity: { rooted: false, tampered: false },
      }),
    });
    expect(ch.status).toBe(200);
    expect((await bind(h, p.access, device.id, p.key)).body.bindingStatus).toBe(
      "bound",
    );
    // Another key header on the same session never registers anything.
    const other = await deviceKey();
    const foreign = await me({ ...p, key: other });
    expect(foreign.device).toBeNull();
  } finally {
    await h.close();
  }
});

test("SP-0193 sales, admin and manager phones still wait for the office; Selling still needs the switch for sales only", async () => {
  const { h, person, phone, me } = await setup();
  try {
    for (const role of ["sales", "admin", "manager"]) {
      const who = await person(`sa-${role}@example.test`, role);
      const p = await phone(who.email);
      expect(
        await h.db`select 1 from registered_devices where profile_id=${who.profile.id}`,
      ).toHaveLength(0);
      const [req] =
        await h.db`select status from phone_registration_requests where profile_id=${who.profile.id}`;
      expect(req.status).toBe("waiting");
      const mine = await me(p);
      expect(mine.device).toBeNull();
      expect(mine.handoverRequired).toBe(false);
      expect(mine.profile.selling).toBe(false);
      // Checking again changes nothing for them.
      expect((await me(p)).device).toBeNull();
      await h.db`update profiles set selling=true where id=${who.profile.id}`;
      expect((await me(p)).profile.selling).toBe(role === "sales");
    }
    // A sales person with a phone already: a new phone still needs a controlled handover.
    const seller = await person("sa-seller2@example.test", "sales");
    await h.db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,org_unit_id,status) values(${seller.profile.id},'field-android','android','SAMPLE old','x',${"b".repeat(64)},${seller.profile.orgUnitId},'active')`;
    const second = await phone(seller.email);
    expect((await me(second)).handoverRequired).toBe(true);
    // The one-active-phone rule still holds for everyone else at the database level.
    let refused = /** @type {any} */ (null);
    try {
      await h.db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,org_unit_id,status) values(${seller.profile.id},'van-android','android','SAMPLE other','x',${"c".repeat(64)},${seller.profile.orgUnitId},'active')`;
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeTruthy();
  } finally {
    await h.close();
  }
});

test("SP-0193 an auto-approved phone lapses if its owner stops being super_admin, and a phone the office removed is never revived", async () => {
  const { h, people, person, phone } = await setup();
  try {
    const owner = await person("sa-demoted@example.test", "super_admin");
    const p = await phone(owner.email);
    const [device] =
      await h.db`select id from registered_devices where profile_id=${owner.profile.id}`;
    await h.db`update profiles set role='admin' where id=${owner.profile.id}`;
    await h.db`update employee_assignments set role='admin' where profile_id=${owner.profile.id}`;
    people.set(owner.userId, {
      role: "admin",
      orgUnitId: owner.profile.orgUnitId,
      name: owner.email,
    });
    const ch = await h.fetch("/api/devices/challenge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${p.access}`,
      },
      body: JSON.stringify({ version: 2, deviceId: device.id }),
    });
    expect(ch.status).toBe(403);
    expect(/** @type {any} */ (await ch.json()).error.code).toBe(
      "device_unavailable",
    );
    // Back to super_admin: a phone the office paused stays paused (not re-approved, not duplicated).
    await h.db`update profiles set role='super_admin' where id=${owner.profile.id}`;
    await h.db`update employee_assignments set role='super_admin' where profile_id=${owner.profile.id}`;
    people.set(owner.userId, {
      role: "super_admin",
      orgUnitId: owner.profile.orgUnitId,
      name: owner.email,
    });
    await h.db`update registered_devices set status='suspended' where id=${device.id}`;
    await nativeSignIn(h, owner.email, PASSWORD, "field-android", {
      keyId: p.key.keyId,
      publicKeySpki: p.key.publicKeySpki,
    });
    const rows =
      await h.db`select status from registered_devices where profile_id=${owner.profile.id}`;
    expect(rows.map((/** @type {any} */ r) => r.status)).toEqual(["suspended"]);
  } finally {
    await h.close();
  }
});
