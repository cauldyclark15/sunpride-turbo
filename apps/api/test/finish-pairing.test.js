import { test, expect } from "bun:test";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  deviceKey,
  nativeSignIn,
} from "./harness.js";
import { install } from "../src/domains/integrity/index.js";
import { sha256Hex } from "../src/core/util.js";

test("F-007 same-person expiring phone code starts controlled handover without activating a second device", async () => {
  const h = await startHarness({ installers: [install] });
  try {
    const people = profileStore(h),
      unit = crypto.randomUUID();
    h.setHooks({ unitInScope: async () => true });
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SAMPLE','SAMPLE','national','active',now()-interval '1 day')`;
    const old = await boundDevice(h, people, {
      app: "field-android",
      orgUnitId: unit,
    });
    const adminId = await createUser(
      h,
      "pairing-admin@example.test",
      "test-only-pairing-password",
    );
    const admin = {
      userId: adminId,
      email: "pairing-admin@example.test",
      profile: people.set(adminId, {
        role: "super_admin",
        orgUnitId: unit,
        name: "SAMPLE admin",
      }),
    };
    for (const user of [old, admin]) {
      const p = user.profile;
      await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user.userId},${user.userId},${p.name},${user.email},${p.role},'active',${unit})`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','SAMPLE','SAMPLE')`;
    }
    const key = await deviceKey();
    const session = await nativeSignIn(
      h,
      old.email,
      old.password,
      "field-android",
      key,
    );
    expect(session.res.status).toBe(200);
    const timestamp = Date.now();
    const proof = {
      publicKeySpki: key.publicKeySpki,
      timestamp,
      signature: await key.sign(`PAIR|field-android|${key.keyId}|${timestamp}`),
    };
    const response = await h.fetch("/api/v1/integrity/devices/pairing/start", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.body.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(proof),
    });
    expect(response.status).toBe(200);
    const pair = await response.json();
    expect(pair.code).toMatch(/^SP-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const [stored] =
      await h.db`select * from device_pairing_requests where code_hash=${sha256Hex(pair.code)}`;
    expect(stored.profile_id).toBe(old.profile.id);
    expect(stored.public_key_spki).toBe(key.publicKeySpki);
    const login = await h.fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: admin.email,
        password: "test-only-pairing-password",
      }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const handover = () =>
      h.fetch("/api/v1/integrity/devices/handover", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: old.deviceId,
          pairingCode: pair.code,
          inventoryTag: "SAMPLE replacement",
          reasonCode: "replacement",
        }),
      });
    const accepted = await handover();
    expect(accepted.status).toBe(200);
    const data = await accepted.json();
    const [handoff] =
      await h.db`select * from device_handovers where id=${data.handoverId}`;
    expect(handoff.key_id).toBe(key.keyId);
    expect(handoff.status).toBe("reconciling");
    expect(
      await h.db`select id from registered_devices where key_id=${key.keyId}`,
    ).toHaveLength(0);
    expect((await handover()).status).toBe(400);
    const [consumed] =
      await h.db`select consumed_at from device_pairing_requests where id=${stored.id}`;
    expect(consumed.consumed_at).not.toBeNull();
  } finally {
    await h.close();
  }
});
