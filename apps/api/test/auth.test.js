import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createUser,
  deviceKey,
  nativeSignIn,
  profileStore,
  startHarness,
} from "./harness.js";

/** @type {import('./harness.js').Harness} */
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

/** @param {Response} res */
const cookieOf = (res) => {
  const raw = res.headers.get("set-cookie") ?? "";
  const m = /sp_session=([^;]*)/.exec(raw);
  return m ? `sp_session=${m[1]}` : "";
};

/** @param {string} path @param {unknown} body @param {Record<string,string>} [headers] */
const post = (path, body, headers = {}) =>
  h.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("health", () => {
  test("/healthz", async () => {
    const res = await h.fetch("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: true });
  });
  test("unknown route uses the error envelope", async () => {
    const res = await h.fetch("/api/v1/nothing/here");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "Not found", retryable: false },
    });
  });
  test("JSON body over 1 MB is refused", async () => {
    // The server answers before reading the body and closes; keep this off the shared keep-alive pool.
    const res = await post(
      "/api/auth/sign-in",
      { email: "x@example.com", password: "a".repeat(1024 * 1024) },
      { connection: "close" },
    );
    expect(res.headers.get("connection")).toBe("close");
    expect(res.status).toBe(413);
  });
});

describe("sign-up", () => {
  test("refused when not invited", async () => {
    const res = await post("/api/auth/sign-up", {
      email: "stranger@example.com",
      password: "long enough pw",
    });
    expect(res.status).toBe(403);
    const body = /** @type {any} */ (await res.json());
    expect(body.error.code).toBe("not_invited");
    const rows =
      await h.db`select 1 from users where email = 'stranger@example.com'`;
    expect(rows.length).toBe(0);
  });

  test("allowed for a bootstrap email (case-insensitive), duplicate refused", async () => {
    const res = await post("/api/auth/sign-up", {
      email: " Boss@Example.com ",
      password: "long enough pw",
    });
    expect(res.status).toBe(201);
    const body = /** @type {any} */ (await res.json());
    expect(body.user.email).toBe("boss@example.com");
    expect(cookieOf(res)).toMatch(/^sp_session=sps_/);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(res.headers.get("set-cookie")).toContain("SameSite=Lax");
    const [row] =
      await h.db`select password_hash from users where email = 'boss@example.com'`;
    expect(String(row.password_hash)).toStartWith("$argon2id$");
    const again = await post("/api/auth/sign-up", {
      email: "boss@example.com",
      password: "long enough pw",
    });
    expect(again.status).toBe(409);
  });

  test("allowed through the isEmailInvited hook", async () => {
    h.setHooks({
      isEmailInvited: async (_db, email) => email === "invited@example.com",
    });
    const res = await post("/api/auth/sign-up", {
      email: "invited@example.com",
      password: "long enough pw",
    });
    expect(res.status).toBe(201);
    h.setHooks({ isEmailInvited: async () => false });
  });
});

describe("web cookie flow", () => {
  test("sign-in, /api/me, sign-out revokes", async () => {
    const userId = await createUser(h, "web@example.com", "web password 1");
    const bad = await post("/api/auth/sign-in", {
      email: "web@example.com",
      password: "wrong password",
    });
    expect(bad.status).toBe(401);
    const res = await post("/api/auth/sign-in", {
      email: "web@example.com",
      password: "web password 1",
    });
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/^sp_session=sps_/);
    const [s] =
      await h.db`select token_hash from sessions where user_id = ${userId}`;
    expect(cookie).not.toContain(s.token_hash); // only the hash is stored

    let me = await h.fetch("/api/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    let body = /** @type {any} */ (await me.json());
    expect(body).toEqual({
      user: { id: userId, email: "web@example.com" },
      profile: null,
      capabilities: [],
    });

    const profile = profiles.set(userId, { role: "viewer" });
    me = await h.fetch("/api/me", { headers: { cookie } });
    body = await me.json();
    expect(body.profile).toEqual({
      id: profile.id,
      name: "Test Person",
      role: "viewer",
      orgUnitId: profile.orgUnitId,
      status: "active",
    });
    expect(body.capabilities).toContain("org.read");
    expect(body.capabilities).not.toContain("admin.manage");

    const out = await h.fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie },
    });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    me = await h.fetch("/api/me", { headers: { cookie } });
    expect(me.status).toBe(401);
    expect(/** @type {any} */ (await me.json()).error.code).toBe(
      "unauthenticated",
    );
  });

  test("a native session token is not accepted as a web cookie", async () => {
    await createUser(h, "mix@example.com", "mix password 1");
    const { body } = await nativeSignIn(h, "mix@example.com", "mix password 1");
    const me = await h.fetch("/api/me", {
      headers: { cookie: `sp_session=${body.sessionToken}` },
    });
    expect(me.status).toBe(401);
  });
});

describe("native D3 flow", () => {
  test("sign-in shape, /api/me, refresh, expiry and sign-out", async () => {
    const userId = await createUser(h, "rep@example.com", "rep password 1");
    const profile = profiles.set(userId, { role: "sales", name: "Rep One" });
    const key = await deviceKey();
    const { res, body } = await nativeSignIn(
      h,
      "rep@example.com",
      "rep password 1",
      "field-android",
      {
        keyId: key.keyId,
        publicKeySpki: key.publicKeySpki,
      },
    );
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(
      [
        "accessExpiresAt",
        "accessToken",
        "serverTime",
        "sessionExpiresAt",
        "sessionToken",
        "version",
      ].sort(),
    );
    expect(body.version).toBe(2);
    expect(body.sessionToken).toStartWith("sps_");
    expect(body.accessToken).toStartWith("spa_");
    expect(body.accessExpiresAt - body.serverTime).toBeGreaterThan(
      14 * 60 * 1000,
    );
    expect(body.accessExpiresAt - body.serverTime).toBeLessThanOrEqual(
      15 * 60 * 1000 + 1000,
    );
    expect(res.headers.get("set-cookie")).toBeNull();

    const me = await h.fetch("/api/me", {
      headers: {
        authorization: `Bearer ${body.accessToken}`,
        "x-app": "field-android",
        "x-device-key-id": key.keyId,
      },
    });
    expect(me.status).toBe(200);
    const mb = /** @type {any} */ (await me.json());
    expect(Object.keys(mb).sort()).toEqual([
      "device",
      "permissions",
      "profile",
      "scope",
      "serverTime",
      "version",
    ]);
    expect(mb.profile).toEqual({
      id: profile.id,
      subject: userId,
      name: "Rep One",
      role: "sales",
      orgUnitId: profile.orgUnitId,
      active: true,
    });
    expect(Object.keys(mb.scope).sort()).toEqual([
      "epoch",
      "fingerprint",
      "id",
      "orgUnitIds",
    ]);
    expect(mb.scope.orgUnitIds).toEqual([profile.orgUnitId]);
    expect(mb.permissions).toContain("visit.record");
    expect(mb.device).toBeNull(); // key not admin-registered

    // Session bearer is not an access credential.
    const viaSession = await h.fetch("/api/me", {
      headers: {
        authorization: `Bearer ${body.sessionToken}`,
        "x-app": "field-android",
      },
    });
    expect(viaSession.status).toBe(401);

    const ref = await h.fetch("/api/auth/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${body.sessionToken}`,
      },
      body: JSON.stringify({
        version: 2,
        app: "field-android",
        deviceKeyId: key.keyId,
      }),
    });
    expect(ref.status).toBe(200);
    const rb = /** @type {any} */ (await ref.json());
    expect(Object.keys(rb).sort()).toEqual([
      "accessExpiresAt",
      "accessToken",
      "serverTime",
      "sessionExpiresAt",
      "version",
    ]);
    expect(rb.sessionExpiresAt).toBe(body.sessionExpiresAt);
    expect(rb.accessToken).not.toBe(body.accessToken);

    const wrongKey = await h.fetch("/api/auth/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${body.sessionToken}`,
      },
      body: JSON.stringify({
        version: 2,
        app: "field-android",
        deviceKeyId: "0".repeat(64),
      }),
    });
    expect(wrongKey.status).toBe(401);

    // Expire the new access token in the database: 401 with the v2 envelope.
    await h.db`update access_tokens set expires_at = now() - interval '1 second'`;
    const expired = await h.fetch("/api/me", {
      headers: {
        authorization: `Bearer ${rb.accessToken}`,
        "x-app": "field-android",
      },
    });
    expect(expired.status).toBe(401);
    const eb = /** @type {any} */ (await expired.json());
    expect(eb.version).toBe(2);
    expect(Object.keys(eb.error).sort()).toEqual([
      "action",
      "code",
      "retryAfterMs",
      "retryable",
    ]);
    expect(eb.error.action).toBe("reauthenticate");

    const out = await h.fetch("/api/auth/sign-out", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${body.sessionToken}`,
      },
      body: JSON.stringify({ version: 2 }),
    });
    expect(await out.json()).toEqual({ version: 2, revoked: true });
    const again = await h.fetch("/api/auth/sign-out", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${body.sessionToken}`,
      },
      body: JSON.stringify({ version: 2 }),
    });
    expect(await again.json()).toEqual({ version: 2, revoked: true });
    const after = await h.fetch("/api/auth/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${body.sessionToken}`,
      },
      body: JSON.stringify({
        version: 2,
        app: "field-android",
        deviceKeyId: key.keyId,
      }),
    });
    expect(after.status).toBe(401);
  });

  test("version other than 2 is told to update; mismatched key id refused", async () => {
    await createUser(h, "old@example.com", "old password 1");
    const res = await post("/api/auth/sign-in", {
      version: 1,
      app: "field-ios",
      email: "old@example.com",
      password: "old password 1",
    });
    expect(res.status).toBe(426);
    expect(/** @type {any} */ (await res.json()).error.action).toBe("update");
    const key = await deviceKey();
    const bad = await post("/api/auth/sign-in", {
      version: 2,
      app: "field-ios",
      email: "old@example.com",
      password: "old password 1",
      deviceKey: { keyId: "a".repeat(64), publicKeySpki: key.publicKeySpki },
    });
    expect(bad.status).toBe(400);
  });

  test("native /api/me without an active profile is a typed refusal", async () => {
    await createUser(h, "noprof@example.com", "noprof password");
    const { body } = await nativeSignIn(
      h,
      "noprof@example.com",
      "noprof password",
      "van-android",
    );
    const me = await h.fetch("/api/me", {
      headers: {
        authorization: `Bearer ${body.accessToken}`,
        "x-app": "van-android",
      },
    });
    expect(me.status).toBe(403);
    expect(/** @type {any} */ (await me.json()).error.code).toBe(
      "profile_unavailable",
    );
  });
});
