import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerOp } from "../src/core/sync.js";
import {
  bind,
  boundDevice,
  challenge,
  createUser,
  deviceKey,
  nativeSignIn,
  profileStore,
  registerDevice,
  signedPost,
  startHarness,
} from "./harness.js";

/** @type {import('./harness.js').Harness} */
let h;
/** @type {ReturnType<typeof profileStore>} */
let profiles;

beforeAll(async () => {
  h = await startHarness();
  profiles = profileStore(h);
  registerOp("test.noop", () => ({ entityId: null }));
});
afterAll(async () => {
  await h?.close();
});

/** @param {string} deviceId @param {string|null} scopeId */
const noopBatch = (deviceId, scopeId) => ({
  version: 2,
  app: "field-android",
  deviceId,
  scopeId,
  operations: [
    {
      clientOpId: crypto.randomUUID(),
      opType: "test.noop",
      clientTime: Date.now(),
      dependsOn: [],
      payload: {},
    },
  ],
});

describe("device challenge and bind", () => {
  test("challenge shape; bind binds once; /api/me reports the device", async () => {
    const userId = await createUser(h, "dev1@example.com", "device password");
    const profile = profiles.set(userId, { role: "sales" });
    const key = await deviceKey();
    const deviceId = await registerDevice(h, {
      profileId: profile.id,
      orgUnitId: profile.orgUnitId,
      key,
    });
    const { body: tokens } = await nativeSignIn(
      h,
      "dev1@example.com",
      "device password",
      "field-android",
      { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
    );

    const ch = await challenge(h, tokens.accessToken, deviceId);
    expect(ch.res.status).toBe(200);
    expect(Object.keys(ch.body).sort()).toEqual([
      "expiresAt",
      "nonce",
      "serverTime",
      "version",
    ]);
    expect(ch.body.expiresAt - ch.body.serverTime).toBe(60_000);

    let me = await h.fetch("/api/me", {
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        "x-app": "field-android",
        "x-device-key-id": key.keyId,
      },
    });
    let mb = /** @type {any} */ (await me.json());
    expect(mb.device).toEqual({
      id: deviceId,
      status: "active",
      bound: false,
      allowedApp: "field-android",
      credentialId: null,
    });

    // A signature by another key is rejected (and burns the nonce).
    const other = await deviceKey();
    const badBind = await bind(h, tokens.accessToken, deviceId, other);
    expect(badBind.body).toEqual({ version: 2, bindingStatus: "rejected" });

    const credentialId = crypto.randomUUID();
    const ok = await bind(h, tokens.accessToken, deviceId, key, credentialId);
    expect(ok.body).toEqual({ version: 2, bindingStatus: "bound" });
    me = await h.fetch("/api/me", {
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        "x-app": "field-android",
        "x-device-key-id": key.keyId,
      },
    });
    mb = await me.json();
    expect(mb.device).toEqual({
      id: deviceId,
      status: "active",
      bound: true,
      allowedApp: "field-android",
      credentialId,
    });

    const again = await bind(h, tokens.accessToken, deviceId, key);
    expect(again.res.status).toBe(409);
  });

  test("another person's device is unavailable", async () => {
    const a = await boundDevice(h, profiles);
    const b = await boundDevice(h, profiles);
    const ch = await challenge(h, a.access, b.deviceId);
    expect(ch.res.status).toBe(403);
    expect(ch.body.error.code).toBe("device_unavailable");
  });
});

describe("signed request proof", () => {
  test("valid signed request, replayed nonce rejected, skew rejected, tampered body rejected", async () => {
    const d = await boundDevice(h, profiles);
    const scopeId = d.profile.orgUnitId;
    const who = { access: d.access, deviceId: d.deviceId, key: d.key };

    const ok = await signedPost(
      h,
      who,
      "/api/sync/push",
      noopBatch(d.deviceId, scopeId),
    );
    expect(ok.res.status).toBe(200);
    expect(ok.body.results[0].status).toBe("applied");

    const replay = await signedPost(
      h,
      who,
      "/api/sync/push",
      noopBatch(d.deviceId, scopeId),
      { nonce: ok.nonce },
    );
    expect(replay.res.status).toBe(401);
    expect(replay.body.error.code).toBe("device_proof_invalid");

    const skewed = await signedPost(
      h,
      who,
      "/api/sync/push",
      noopBatch(d.deviceId, scopeId),
      { timestamp: Date.now() - 61_000 },
    );
    expect(skewed.res.status).toBe(401);
    expect(skewed.body.error.code).toBe("device_proof_invalid");
    const future = await signedPost(
      h,
      who,
      "/api/sync/push",
      noopBatch(d.deviceId, scopeId),
      { timestamp: Date.now() + 61_000 },
    );
    expect(future.res.status).toBe(401);

    const tampered = await signedPost(
      h,
      who,
      "/api/sync/push",
      noopBatch(d.deviceId, scopeId),
      { signedBody: "{}" },
    );
    expect(tampered.res.status).toBe(401);

    // A skew-rejected nonce was not consumed; one used after a failed signature was not either.
    const reuse = await signedPost(
      h,
      who,
      "/api/sync/push",
      noopBatch(d.deviceId, scopeId),
      { nonce: skewed.nonce },
    );
    expect(reuse.res.status).toBe(200);
  });

  test("missing headers, foreign key, suspended and revoked devices", async () => {
    const d = await boundDevice(h, profiles);
    const scopeId = d.profile.orgUnitId;
    const res = await h.fetch("/api/sync/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${d.access}`,
      },
      body: JSON.stringify(noopBatch(d.deviceId, scopeId)),
    });
    expect(res.status).toBe(400);

    const stranger = await deviceKey();
    const forged = await signedPost(
      h,
      { access: d.access, deviceId: d.deviceId, key: stranger },
      "/api/sync/push",
      noopBatch(d.deviceId, scopeId),
    );
    expect(forged.res.status).toBe(401);

    await h.db`update registered_devices set status = 'suspended' where id = ${d.deviceId}`;
    const susp = await h.fetch("/api/devices/challenge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${d.access}`,
      },
      body: JSON.stringify({ version: 2, deviceId: d.deviceId }),
    });
    expect(susp.status).toBe(403);
    expect(/** @type {any} */ (await susp.json()).error).toEqual({
      code: "device_suspended",
      retryable: false,
      retryAfterMs: null,
      action: "hold",
    });
    await h.db`update registered_devices set status = 'revoked' where id = ${d.deviceId}`;
    const rev = await challenge(h, d.access, d.deviceId);
    expect(rev.body.error.code).toBe("device_revoked");
  });

  test("scope change after enrolment withdraws the device", async () => {
    const d = await boundDevice(h, profiles);
    profiles.set(d.userId, { role: "sales", orgUnitId: crypto.randomUUID() });
    const ch = await challenge(h, d.access, d.deviceId);
    expect(ch.res.status).toBe(403);
    expect(ch.body.error.code).toBe("scope_withdrawn");
  });

  test("invalid-attempt budget returns 429 after repeated bad proofs", async () => {
    const d = await boundDevice(h, profiles);
    const stranger = await deviceKey();
    const scopeId = d.profile.orgUnitId;
    /** @type {number[]} */
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const r = await signedPost(
        h,
        { access: d.access, deviceId: d.deviceId, key: stranger },
        "/api/sync/push",
        noopBatch(d.deviceId, scopeId),
      ).catch(() => ({ res: { status: 0 } }));
      statuses.push(r.res.status);
    }
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(10);
  });
});

describe("an old removed phone row never overrules the current one", () => {
  /** @param {string} access @param {string} keyId */
  const me = async (access, keyId) =>
    /** @type {any} */ (
      await (
        await h.fetch("/api/me", {
          headers: {
            authorization: `Bearer ${access}`,
            "x-app": "field-android",
            "x-device-key-id": keyId,
          },
        })
      ).json()
    );
  /** @param {string} sessionToken @param {string} keyId */
  const refresh = (sessionToken, keyId) =>
    h.fetch("/api/auth/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        version: 2,
        app: "field-android",
        deviceKeyId: keyId,
        integrity: { rooted: false, tampered: false, source: "TEST fixture" },
      }),
    });
  /** @param {string} profileId @param {any} key @param {string} status @param {string|null} orgUnitId */
  const extraRow = (profileId, key, status, orgUnitId) =>
    h.db`insert into registered_devices (profile_id, app, platform, inventory_tag, public_key_spki, key_id, org_unit_id, status, created_at)
      values (${profileId}, 'field-android', 'android', ${`TAG-${crypto.randomUUID().slice(0, 8)}`}, ${key.publicKeySpki}, ${key.keyId}, ${orgUnitId}, ${status}, now() + interval '1 hour')`;

  test("newer revoked and suspended rows lose to the live row on /api/me and refresh", async () => {
    const userId = await createUser(h, "live1@example.com", "device password");
    const profile = profiles.set(userId, { role: "sales" });
    const key = await deviceKey();
    const liveId = await registerDevice(h, {
      profileId: profile.id,
      orgUnitId: profile.orgUnitId,
      key,
    });
    const { body: tokens } = await nativeSignIn(
      h,
      "live1@example.com",
      "device password",
      "field-android",
      { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
    );
    await extraRow(profile.id, key, "revoked", profile.orgUnitId);
    await extraRow(profile.id, key, "suspended", profile.orgUnitId);

    const body = await me(tokens.accessToken, key.keyId);
    expect(body.device).toMatchObject({ id: liveId, status: "active" });
    const ok = await refresh(tokens.sessionToken, key.keyId);
    expect(ok.status).toBe(200);
  });

  test("when the only row is removed the handheld is refused with the old machine code and the plain words", async () => {
    const userId = await createUser(h, "gone1@example.com", "device password");
    const profile = profiles.set(userId, { role: "sales" });
    const key = await deviceKey();
    const deviceId = await registerDevice(h, {
      profileId: profile.id,
      orgUnitId: profile.orgUnitId,
      key,
    });
    const { body: tokens } = await nativeSignIn(
      h,
      "gone1@example.com",
      "device password",
      "field-android",
      { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
    );
    await h.db`update registered_devices set status='revoked' where id=${deviceId}`;

    const body = await me(tokens.accessToken, key.keyId);
    expect(body.device).toMatchObject({ id: deviceId, status: "revoked" });
    const refused = await refresh(tokens.sessionToken, key.keyId);
    expect(refused.status).toBe(403);
    const refusal = /** @type {any} */ (await refused.json()).error;
    // field-android and older van builds key on this exact machine code; only the words are new.
    expect(refusal.code).toBe("device_revoked");
    expect(refusal.code).not.toBe("device_not_set_up_for_you");
    const ch = await challenge(h, tokens.accessToken, deviceId);
    expect(ch.res.status).toBe(403);
    expect(ch.body.error.code).toBe("device_revoked");
    // The native envelope carries no text; the server's own refusal has the plain words.
    const { devicePerson } = await import("../src/core/devices.js");
    const thrown = await devicePerson(
      h.db,
      /** @type {any} */ ({
        profileId: profile.id,
        orgUnitId: profile.orgUnitId,
      }),
      deviceId,
    ).catch((/** @type {any} */ e) => e);
    expect(thrown.code).toBe("device_revoked");
    expect(thrown.message).toBe(
      "This handheld is not set up for you. Ask your supervisor to hand it over.",
    );
  });
});
